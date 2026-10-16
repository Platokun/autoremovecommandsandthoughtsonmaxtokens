/**
 * Adversarial check: `/rwm compact` and `/rwm wipe` must never touch the disk.
 *
 * The rule under test is "files unaltered". A verifier that only inspects the
 * memory text cannot prove that, so this one wraps every `node:fs` mutator and
 * fails if a compaction or a wipe calls one. Reads are allowed (the plugin never
 * performs them either, but reading is not a violation of the rule).
 *
 *   node tools/verify-no-write.mjs
 *   DSH_CHECKOUT=/path/to/deepseek-harness node tools/verify-no-write.mjs
 *
 * Exit 0 means neither pass wrote to the filesystem.
 */

import fs from 'node:fs'
import { pathToFileURL } from 'node:url'
import path from 'node:path'

const checkout = process.env.DSH_CHECKOUT ?? '/home/naruzkurai/deepseek-harness'
const load = relative => import(pathToFileURL(path.join(checkout, relative)).href)

const { Context } = await load('vendor/cordis/lib/index.js')
const { Session, SessionId } = await load('packages/core/session/lib/index.js')
const plugin = await import('../index.js')

const text = value => [{ type: 'text', text: value }]

/** Every fs entry point that can change bytes on disk. */
const MUTATORS = [
  'writeFileSync', 'appendFileSync', 'unlinkSync', 'rmSync', 'renameSync', 'mkdirSync',
  'rmdirSync', 'copyFileSync', 'truncateSync', 'chmodSync', 'chownSync', 'symlinkSync',
  'linkSync', 'utimesSync', 'writeFile', 'appendFile', 'unlink', 'rm', 'rename', 'mkdir',
  'rmdir', 'copyFile', 'truncate', 'chmod', 'openSync', 'open',
]

const touched = []
for (const name of MUTATORS) {
  const original = fs[name]
  if (typeof original !== 'function') continue
  fs[name] = (...args) => {
    touched.push(`${name}(${String(args[0]).slice(0, 90)})`)
    return original(...args)
  }
}

/** A session that read a file, edited it, and asked one more thing. */
function buildSession(id) {
  const session = Session.create(SessionId(id))
  session.append('system/message', {
    turn: 0,
    step: 0,
    message: { id: `${id}-s`, role: 'system', source: { kind: 'system-prompt' }, content: text('sys') },
  }, { surfaceOp: 'append' })
  session.append('user/message',
    { id: `${id}-u`, role: 'user', source: { kind: 'user' }, content: text('read alpha please') },
    { surfaceOp: 'append' })

  for (const item of [
    { callId: 'c1', name: 'read', args: { file_path: '/repo/alpha.js' }, body: 'export const a = 1\n'.repeat(20) },
    { callId: 'c2', name: 'edit', args: { file_path: '/repo/alpha.js', old_string: '1', new_string: '2' }, body: 'edited alpha.js' },
  ]) {
    session.append('assistant/message', {
      turn: 1,
      step: 1,
      message: {
        id: `${id}-a-${item.callId}`,
        role: 'assistant',
        source: { kind: 'model', provider: 'p', model: 'm' },
        content: [{ type: 'tool-call', id: item.callId, name: item.name, arguments: JSON.stringify(item.args) }],
      },
      stream: [],
    }, { surfaceOp: 'append' })
    const callSeq = session.append('tool/call', {
      turn: 1, step: 1, callId: item.callId, name: item.name, arguments: JSON.stringify(item.args),
    }).seq
    session.append('tool/result', {
      turn: 1,
      step: 1,
      message: {
        id: `${id}-r-${item.callId}`,
        role: 'tool',
        source: { kind: 'tool', callId: item.callId },
        toolCallId: item.callId,
        content: text(item.body),
      },
    }, { surfaceOp: 'append', sourceEventSeqs: [callSeq] })
  }

  session.append('user/message',
    { id: `${id}-u2`, role: 'user', source: { kind: 'user' }, content: text('tail') },
    { surfaceOp: 'append' })
  return session
}

/** Mount the plugin, run compact then wipe, and report what happened. */
async function drive(config, useModel) {
  const session = buildSession(`nowrite-${Math.random().toString(36).slice(2, 8)}`)
  const ctx = new Context()
  ctx.provide('tools', { register: () => () => {} })
  ctx.provide('llm', {
    stream: () => (async function* () { yield { type: 'text', text: 'MODEL SUMMARY' } })(),
    listProviders: () => [{ id: 'local-spark' }],
  })
  ctx.provide('sessions', { get: () => session })
  ctx.provide('systemPrompt', { variable: () => () => {}, section: () => () => {} })
  ctx.provide('tokenMeter', {
    measure: () => ({ nodes: [...session.surface.nodes].map(seq => ({ seq, heuristicTokens: 10 })) }),
  })
  let command
  ctx.provide('commands', { register: registered => { command = registered; return () => {} } })
  await ctx.plugin({ name: plugin.name, inject: plugin.inject, apply: fiberCtx => plugin.apply(fiberCtx, config) })
  await new Promise(resolve => setTimeout(resolve, 200))
  const compact = await command.handler({ agent: { session }, rawInput: 'compact' })
  const wipe = await command.handler({ agent: { session }, rawInput: 'wipe' })
  return {
    compact,
    wipe,
    label: useModel ? 'with a model' : 'deterministic',
  }
}

const withModel = await drive({ compactUseModel: true, compactProvider: 'local-spark', compactModel: 'spark-x-t-4b' }, true)
const deterministic = await drive({}, false)

console.log(`compact ${withModel.label}: ${withModel.compact.kind}; wipe: ${withModel.wipe.kind}`)
console.log(`compact ${deterministic.label}: ${deterministic.compact.kind}`)

const failures = []
if (withModel.compact.kind !== 'success') failures.push(`compact (model) was not successful: ${withModel.compact.text}`)
if (withModel.wipe.kind !== 'success') failures.push(`wipe was not successful: ${withModel.wipe.text}`)
if (deterministic.compact.kind !== 'success') failures.push(`compact (deterministic) was not successful: ${deterministic.compact.text}`)

// `open` may be a read; everything else in the list is unambiguously a mutation.
const mutations = touched.filter(entry => !entry.startsWith('open('))
for (const mutation of mutations) failures.push(`the plugin touched the filesystem: ${mutation}`)

if (failures.length > 0) {
  console.error(`\nNO-WRITE VERIFY FAILED (${failures.length}):`)
  for (const failure of failures) console.error(` - ${failure}`)
  process.exit(1)
}
console.log(`\nNO-WRITE VERIFY OK: neither compact nor wipe wrote to disk (${touched.length} fs opens, 0 mutations).`)
