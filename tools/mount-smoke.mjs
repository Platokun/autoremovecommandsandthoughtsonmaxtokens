/**
 * Mount `@local/dsh-autotrim-context` into a real Cordis runtime and run its
 * `agent/pre-step` hook against real `@deepseek-ai/dsh-session` Sessions, so
 * DSH's own surface validator — not a stub — judges every replacement.
 *
 * The plugin imports nothing from DSH, so this smoke test supplies both the
 * runtime and the harness services from a local checkout:
 *
 *   node tools/mount-smoke.mjs
 *   DSH_CHECKOUT=/path/to/deepseek-harness node tools/mount-smoke.mjs
 *
 * Exit 0 means: the plugin activated, registered both tools with complete
 * contracts, published the policy section and its variable, landed a
 * `compaction/prune` shadow price plus its surface replacement for both the
 * model-authored `rwm-` memory and an automatically stubbed tool output, kept
 * tool calls paired with their results, and reproduced the identical surface by
 * replaying the log from scratch.
 */

import { pathToFileURL } from 'node:url'
import path from 'node:path'

const checkout = process.env.DSH_CHECKOUT ?? '/home/naruzkurai/deepseek-harness'
const load = relative => import(pathToFileURL(path.join(checkout, relative)).href)

const { Context } = await load('vendor/cordis/lib/index.js')
const { Session, SessionId, foldSurface } = await load('packages/core/session/lib/index.js')
const plugin = await import('../index.js')

const failures = []
const check = (condition, message) => { if (!condition) failures.push(message) }
const text = value => [{ type: 'text', text: value }]

/** A realistic log: the `tool/call` the loop appends never joins the surface. */
function buildSession(id, { rewrite } = {}) {
  const session = Session.create(SessionId(id))
  session.append('system/message',
    {
      turn: 0,
      step: 0,
      message: { id: `${id}-s1`, role: 'system', source: { kind: 'system-prompt' }, content: text('prompt') },
    },
    { surfaceOp: 'append' })
  session.append('user/message',
    { id: `${id}-u1`, role: 'user', source: { kind: 'user' }, content: text('go') },
    { surfaceOp: 'append' })
  session.append('assistant/message', {
    turn: 1,
    step: 1,
    message: {
      id: `${id}-a1`,
      role: 'assistant',
      source: { kind: 'model', provider: 'p', model: 'm' },
      content: [{ type: 'tool-call', id: 'c1', name: 'bash', arguments: '{"command":"ls"}' }],
    },
    stream: [],
  }, { surfaceOp: 'append' })
  const callSeq = session.append('tool/call',
    { turn: 1, step: 1, callId: 'c1', name: 'bash', arguments: '{"command":"ls"}' }).seq
  session.append('tool/result', {
    turn: 1,
    step: 1,
    message: {
      id: `${id}-r1`,
      role: 'tool',
      source: { kind: 'tool', callId: 'c1' },
      toolCallId: 'c1',
      content: text('listing output '.repeat(40)),
    },
  }, { surfaceOp: 'append', sourceEventSeqs: [callSeq] })
  session.append('assistant/message', {
    turn: 1,
    step: 2,
    message: {
      id: `${id}-a2`,
      role: 'assistant',
      source: { kind: 'model', provider: 'p', model: 'm' },
      content: text('done'),
    },
    stream: [],
  }, { surfaceOp: 'append' })
  session.append('user/message',
    { id: `${id}-u2`, role: 'user', source: { kind: 'user' }, content: text('next') },
    { surfaceOp: 'append' })
  if (rewrite !== undefined) {
    session.append('tool/call', {
      turn: 2,
      step: 1,
      callId: 'rc1',
      name: 'rewrite_memory',
      arguments: JSON.stringify(rewrite),
    })
  }
  return session
}

/** Mount the plugin on a fresh Context wired to one session. */
async function mount(session, config) {
  const tools = new Map()
  const sections = []
  const variables = new Map()
  const ctx = new Context()
  ctx.provide('tools', {
    register: definition => { tools.set(definition.name, definition); return () => {} },
  })
  ctx.provide('llm', { stream: () => ({ kind: 'fake-stream' }) })
  ctx.provide('sessions', { get: id => (id === String(session.id) ? session : undefined) })
  ctx.provide('systemPrompt', {
    variable: (key, provider) => { variables.set(key, provider); return () => {} },
    section: section => { sections.push(section); return () => {} },
  })
  ctx.provide('tokenMeter', {
    measure: () => ({ nodes: [...session.surface.nodes].map(seq => ({ seq, heuristicTokens: 10 })) }),
  })
  await ctx.plugin({
    name: plugin.name,
    inject: plugin.inject,
    apply: fiberCtx => plugin.apply(fiberCtx, { enabledByDefault: true, ...config }),
  })
  await new Promise(resolve => setTimeout(resolve, 200))
  const hooks = ctx.events?._hooks?.['agent/pre-step']
  check(Array.isArray(hooks) && hooks.length >= 1, 'no agent/pre-step listener was registered')
  const preStep = hooks[0].callback
  return {
    ctx, tools, sections, variables,
    run: () => preStep({ agent: { session }, signal: { aborted: false } }, () => Promise.resolve({ kind: 'enter' })),
  }
}

/** Replaying the log must reproduce the live surface exactly. */
function checkReplay(session, label) {
  const replayed = foldSurface(session.snapshotEvents())
  check(
    JSON.stringify(replayed.nodes.map(Number)) === JSON.stringify(session.surface.nodes.map(Number)),
    `${label}: replay diverged (${replayed.nodes} vs ${session.surface.nodes})`,
  )
}

/** Every tool result in the derived history must have its call before it. */
function checkPairing(session, label) {
  const calls = new Set()
  for (const message of session.deriveMessages()) {
    if (message.role === 'assistant') {
      for (const block of message.content ?? []) if (block.type === 'tool-call') calls.add(block.id)
    } else if (message.role === 'tool') {
      check(calls.has(message.toolCallId), `${label}: orphaned tool result ${message.toolCallId}`)
    }
  }
}

/* ---- 1. the model-authored memory rewrite ------------------------------ */

const rewriteSession = buildSession('autotrim-rewrite', { rewrite: { memory: 'smoke note', keep_recent_messages: 2 } })
const before = rewriteSession.surface.nodes.map(Number)
const rewriteMount = await mount(rewriteSession, { retainRecentMessages: 2, autoStubToolResults: true })

const names = [...rewriteMount.tools.keys()].sort()
check(names.join(',') === 'rewrite_memory,rwm_access', `registered tools = [${names.join(', ')}]`)
for (const tool of rewriteMount.tools.values()) {
  check(typeof tool.description === 'string' && tool.description.length > 20, `${tool.name}: weak description`)
  check(typeof tool.parameters === 'object', `${tool.name}: missing parameters schema`)
  check(typeof tool.execute === 'function', `${tool.name}: missing execute()`)
  check(typeof tool.output?.render === 'function', `${tool.name}: missing output.render()`)
}
check(rewriteMount.sections.length === 1 && rewriteMount.sections[0]?.name === 'autotrim:policy', 'policy section missing')
check(rewriteMount.sections[0]?.text?.includes('rwm-<n>-') === true, 'policy section does not explain the rwm- prefix')

await rewriteMount.run()

const prune = rewriteSession.snapshotEvents().find(event => event.type === 'compaction/prune')
check(prune !== undefined, 'no compaction/prune shadow price was appended')
if (prune !== undefined) {
  check(prune.data.shadowedSeqs.length > 0, 'the shadow price named no nodes')
  check(prune.data.shadowedTokenCount > 0, `shadowedTokenCount = ${prune.data.shadowedTokenCount}`)
}
const memoryNode = rewriteSession.surface.nodes
  .map(seq => rewriteSession.eventAt(seq))
  .find(event => event?.type === 'user/message' && event.data.content?.[0]?.text === 'rwm-1-smoke note')
check(memoryNode !== undefined, 'the rwm- replacement node is not on the surface')
check(rewriteSession.surface.nodes.map(Number).includes(before[0]), 'the system prompt left the surface')
check(rewriteSession.deriveMessages().some(message => message.content?.[0]?.text === 'rwm-1-smoke note'),
  'deriveMessages() does not show the memory')
check(rewriteSession.deriveMessages()[0]?.role === 'system', 'the system prompt is no longer first')
checkReplay(rewriteSession, 'rewrite')
checkPairing(rewriteSession, 'rewrite')

/* Running the hook again must not land a second replacement. */
const eventCount = rewriteSession.snapshotEvents().length
await rewriteMount.run()
check(rewriteSession.snapshotEvents().length === eventCount, 'a repeated pre-step appended a duplicate replacement')

/* ---- 2. the automatic tool-output trim --------------------------------- */

const stubSession = buildSession('autotrim-stub')
const stubMount = await mount(stubSession, { retainRecentMessages: 2, autoStubToolResults: true })
const surfaceBeforeStub = stubSession.surface.nodes.map(Number)
await stubMount.run()

const replacement = stubSession.snapshotEvents()
  .find(event => event.type === 'tool/result' && event.surfaceOp?.op === 'replace')
check(replacement !== undefined, 'no tool/result replacement was appended')
if (replacement !== undefined) {
  const original = stubSession.eventAt(replacement.surfaceOp.startSeq)
  check(original?.type === 'tool/result', 'the replacement did not target a tool result')
  check(JSON.stringify(replacement.data.message.content).includes('tool output omitted'),
    'the replacement content is not the recall marker')
  check(JSON.stringify({ ...replacement.data, message: null }) === JSON.stringify({ ...original.data, message: null }),
    'the replacement changed more than the message content')
}
check(stubSession.deriveMessages().some(message => message.role === 'tool'
  && JSON.stringify(message.content).includes('tool output omitted')), 'the model view does not show the stub')
check(stubSession.deriveMessages().some(message => message.role === 'assistant'
  && (message.content ?? []).some(block => block.type === 'tool-call')), 'the tool call was dropped with its result')
checkReplay(stubSession, 'stub')
checkPairing(stubSession, 'stub')

/* ---- report ------------------------------------------------------------ */

if (failures.length > 0) {
  console.error('MOUNT SMOKE FAIL')
  for (const failure of failures) console.error(`  - ${failure}`)
  process.exit(1)
}
console.log(`MOUNT SMOKE OK: ${plugin.name} activated against ${checkout}`)
console.log(`  tools:    ${names.join(', ')}`)
console.log(`  section:  ${rewriteMount.sections[0].name}`)
console.log(`  rewrite:  [${before.join(', ')}] -> [${rewriteSession.surface.nodes.map(Number).join(', ')}]`)
console.log(`  shadow:   ${prune.data.shadowedSeqs.length} node(s), ${prune.data.shadowedTokenCount} tokens claimed`)
console.log(`  memory:   rwm-smoke note`)
console.log(`  stub:     [${surfaceBeforeStub.join(', ')}] -> [${stubSession.surface.nodes.map(Number).join(', ')}]`)
console.log('  replay:   both sessions replay to the identical surface')
console.log('  pairing:  no orphaned tool results in either session')
await rewriteMount.ctx.stop?.()
await stubMount.ctx.stop?.()
process.exit(0)
