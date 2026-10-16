/**
 * Prove the write-through invariant against real DSH sessions.
 *
 * The claim under test:
 *
 *   While the automatic passes are forced on, one file's content occupies the
 *   model-visible surface exactly once, however many times it was read.
 *
 * This is checked the same way `mount-smoke.mjs` checks its rewrites: a real
 * Cordis `Context`, real `@deepseek-ai/dsh-session` Sessions, the plugin's real
 * `agent/pre-step` hook, and DSH's own `foldSurface()` for the final surface —
 * so the surface validator, not a stub, judges every replacement.
 *
 *   node tools/verify-file-dedupe.mjs
 *   DSH_CHECKOUT=/path/to/deepseek-harness node tools/verify-file-dedupe.mjs
 *
 * Exit 0 means the surface ends with exactly one full copy of each file, the
 * other copies are recall markers, an `rwm-<n>-` altered-memory note explains
 * the retirement without claiming the agent called it, the original bytes stay
 * recoverable from the log, replay reproduces the surface, and no tool result is
 * orphaned.
 */

import { pathToFileURL } from 'node:url'
import path from 'node:path'

const checkout = process.env.DSH_CHECKOUT ?? '/home/naruzkurai/deepseek-harness'
const load = relative => import(pathToFileURL(path.join(checkout, relative)).href)

const { Context } = await load('vendor/cordis/lib/index.js')
const { Session, SessionId, foldSurface } = await load('packages/core/session/lib/index.js')
const plugin = await import('../index.js')
const { DUPLICATE_MARKER } = await import('../lib/memory.js')

const failures = []
const check = (condition, message) => { if (!condition) failures.push(message) }
const text = value => [{ type: 'text', text: value }]

const FILE = '/repo/src/memory.js'
const BODY = 'export const answer = 42\n'.repeat(20)

/**
 * A real session that reads one file `reads` times, with filler between reads so
 * every read is old by the time the passes run.
 */
function buildSession(id, { reads = 2, file = FILE, body = BODY, tailMessages = 3 } = {}) {
  const session = Session.create(SessionId(id))
  session.append('system/message',
    { turn: 0, step: 0, message: { id: `${id}-s`, role: 'system', source: { kind: 'system-prompt' }, content: text('prompt') } },
    { surfaceOp: 'append' })

  for (let index = 0; index < reads; index += 1) {
    const callId = `c${index}`
    session.append('assistant/message', {
      turn: index + 1,
      step: 1,
      message: {
        id: `${id}-a${index}`,
        role: 'assistant',
        source: { kind: 'model', provider: 'p', model: 'm' },
        content: [{ type: 'tool-call', id: callId, name: 'read', arguments: JSON.stringify({ file_path: file }) }],
      },
      stream: [],
    }, { surfaceOp: 'append' })
    const callSeq = session.append('tool/call', {
      turn: index + 1,
      step: 1,
      callId,
      name: 'read',
      arguments: JSON.stringify({ file_path: file }),
    }).seq
    session.append('tool/result', {
      turn: index + 1,
      step: 1,
      message: {
        id: `${id}-r${index}`,
        role: 'tool',
        source: { kind: 'tool', callId },
        toolCallId: callId,
        content: text(body),
      },
    }, { surfaceOp: 'append', sourceEventSeqs: [callSeq] })
    session.append('assistant/message', {
      turn: index + 1,
      step: 2,
      message: {
        id: `${id}-n${index}`,
        role: 'assistant',
        source: { kind: 'model', provider: 'p', model: 'm' },
        content: text(`read ${index} done`),
      },
      stream: [],
    }, { surfaceOp: 'append' })
  }

  for (let index = 0; index < tailMessages; index += 1) {
    session.append('user/message',
      { id: `${id}-t${index}`, role: 'user', source: { kind: 'user' }, content: text(`tail ${index}`) },
      { surfaceOp: 'append' })
  }
  return session
}

/** Mount the plugin on a fresh Context wired to one session. */
async function mount(session, config) {
  const ctx = new Context()
  ctx.provide('tools', { register: () => () => {} })
  ctx.provide('llm', { stream: () => ({ kind: 'fake-stream' }) })
  ctx.provide('sessions', { get: id => (id === String(session.id) ? session : undefined) })
  ctx.provide('systemPrompt', { variable: () => () => {}, section: () => () => {} })
  ctx.provide('tokenMeter', {
    measure: () => ({ nodes: [...session.surface.nodes].map(seq => ({ seq, heuristicTokens: 10 })) }),
  })
  await ctx.plugin({
    name: plugin.name,
    inject: plugin.inject,
    apply: fiberCtx => plugin.apply(fiberCtx, config),
  })
  await new Promise(resolve => setTimeout(resolve, 200))
  const hooks = ctx.events?._hooks?.['agent/pre-step']
  check(Array.isArray(hooks) && hooks.length >= 1, 'no agent/pre-step listener was registered')
  const preStep = hooks[0].callback
  return () => preStep({ agent: { session }, signal: { aborted: false } }, () => Promise.resolve({ kind: 'enter' }))
}

/** The messages the surface actually resolves to, in order. */
const surfaceTexts = session => session.deriveMessages().map(message =>
  (message.content ?? []).filter(block => typeof block.text === 'string').map(block => block.text).join('\n'))

/** How many surface messages carry the file's full body verbatim. */
const fullCopies = (session, body) => surfaceTexts(session).filter(value => value === body).length

/** How many surface messages are this plugin's duplicate marker. */
const markers = session => surfaceTexts(session).filter(value => value.includes(DUPLICATE_MARKER)).length

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

/**
 * The whole point: while forced, one file is on the surface once.
 *
 * Run enough passes for the plugin to converge — a copy created inside the
 * current step becomes foldable only on the next pass.
 */
async function converges(id, reads, config) {
  const session = buildSession(id, { reads })
  const run = await mount(session, { enabledByDefault: true, retainRecentMessages: 3, ...config })
  for (let pass = 0; pass < 4; pass += 1) await run()
  return session
}

/* ---- 1. two reads of one file collapse to one --------------------------- */

const twoReads = await converges('dedupe-two', 2)
check(fullCopies(twoReads, BODY) === 1, `two reads left ${fullCopies(twoReads, BODY)} full copies, expected 1`)
check(markers(twoReads) === 1, `two reads left ${markers(twoReads)} markers, expected 1`)
check(twoReads.deriveMessages().filter(message => message.role === 'tool').length === 2,
  'a read must never disappear from history, only lose its body')
checkReplay(twoReads, 'two reads')
checkPairing(twoReads, 'two reads')

/* ---- 2. five reads of one file collapse to one -------------------------- */

const fiveReads = await converges('dedupe-five', 5)
check(fullCopies(fiveReads, BODY) === 1, `five reads left ${fullCopies(fiveReads, BODY)} full copies, expected 1`)
check(markers(fiveReads) === 4, `five reads left ${markers(fiveReads)} markers, expected 4`)
checkReplay(fiveReads, 'five reads')
checkPairing(fiveReads, 'five reads')

/* ---- 3. the altered-memory note ----------------------------------------- */

const notes = surfaceTexts(twoReads).filter(value => /^rwm-\d+-/.test(value))
check(notes.length >= 1, 'no altered-memory note was published')
if (notes.length >= 1) {
  const note = notes[0]
  check(!/^rwm-c-/.test(note), 'the note is not a console memory')
  check(note.includes('memory.js'), `the note does not name the file: ${note.slice(0, 80)}`)
  check(/not a tool call you made/.test(note), 'the note does not disclaim the retirement as an agent action')
  const numbered = /^rwm-(\d+)-/.exec(note)
  check(numbered !== null && Number(numbered[1]) >= 1, 'the note carries no usable number')
}

/* ---- 4. nothing is destroyed: the originals stay in the log ------------- */

const shadowed = twoReads.snapshotEvents()
  .filter(event => event.surfaceOp?.op === 'replace')
  .flatMap(event => event.sourceEventSeqs ?? [])
check(shadowed.length >= 1, 'no replacement recorded what it shadowed')
check(
  shadowed.some(seq => (twoReads.eventAt(seq)?.data?.message?.content ?? [])
    .some(block => block.text === BODY)),
  'the retired copy is not recoverable from the log',
)

/* ---- 5. the retirement is priced for the context meter ------------------ */

const prunes = twoReads.snapshotEvents().filter(event => event.type === 'compaction/prune')
check(prunes.length >= 1, 'no compaction/prune shadow price was appended')
check(prunes.every(prune => prune.data.shadowedTokenCount > 0), 'a shadow price claimed zero tokens')

/* ---- 6. a session that is not forced is untouched ---------------------- */

const unforced = buildSession('dedupe-unforced', { reads: 2 })
const runUnforced = await mount(unforced, { retainRecentMessages: 3 })
for (let pass = 0; pass < 3; pass += 1) await runUnforced()
check(fullCopies(unforced, BODY) === 2, `an unforced session lost a copy (${fullCopies(unforced, BODY)} of 2)`)
check(markers(unforced) === 0, 'an unforced session was rewritten')
check(unforced.snapshotEvents().filter(event => event.type === 'compaction/prune').length === 0,
  'an unforced session had events appended')

/* ---- 7. two different files both survive ------------------------------- */

const twoFiles = Session.create(SessionId('dedupe-two-files'))
{
  const build = (id, kind, file, body) => {
    const session = twoFiles
    session.append('assistant/message', {
      turn: 1, step: 1,
      message: {
        id, role: 'assistant', source: { kind: 'model', provider: 'p', model: 'm' },
        content: [{ type: 'tool-call', id: `${id}-c`, name: kind, arguments: JSON.stringify({ file_path: file }) }],
      },
      stream: [],
    }, { surfaceOp: 'append' })
    const callSeq = session.append('tool/call', { turn: 1, step: 1, callId: `${id}-c`, name: kind, arguments: JSON.stringify({ file_path: file }) }).seq
    session.append('tool/result', {
      turn: 1, step: 1,
      message: { id: `${id}-r`, role: 'tool', source: { kind: 'tool', callId: `${id}-c` }, toolCallId: `${id}-c`, content: text(body) },
    }, { surfaceOp: 'append', sourceEventSeqs: [callSeq] })
  }
  twoFiles.append('system/message',
    { turn: 0, step: 0, message: { id: 'tf-s', role: 'system', source: { kind: 'system-prompt' }, content: text('prompt') } },
    { surfaceOp: 'append' })
  build('tf-a', 'read', '/repo/a.js', 'A'.repeat(400))
  build('tf-b', 'read', '/repo/b.js', 'B'.repeat(400))
  for (let index = 0; index < 3; index += 1) {
    twoFiles.append('user/message', { id: `tf-t${index}`, role: 'user', source: { kind: 'user' }, content: text(`tail ${index}`) }, { surfaceOp: 'append' })
  }
  const run = await mount(twoFiles, { enabledByDefault: true, retainRecentMessages: 2 })
  for (let pass = 0; pass < 3; pass += 1) await run()
  check(fullCopies(twoFiles, 'A'.repeat(400)) === 1, 'the first file lost its only copy')
  check(fullCopies(twoFiles, 'B'.repeat(400)) === 1, 'the second file lost its only copy')
  check(markers(twoFiles) === 0, 'two distinct files were treated as duplicates')
  checkPairing(twoFiles, 'two files')
}

/* ---- report ------------------------------------------------------------ */

if (failures.length > 0) {
  console.error(`FILE DEDUPE FAILED against ${checkout}`)
  for (const failure of failures) console.error(`  - ${failure}`)
  process.exit(1)
}
console.log(`FILE DEDUPE OK: one copy per file against ${checkout}`)
console.log(`  two reads:   ${fullCopies(twoReads, BODY)} full copy, ${markers(twoReads)} marker`)
console.log(`  five reads:  ${fullCopies(fiveReads, BODY)} full copy, ${markers(fiveReads)} markers`)
console.log(`  note:        ${notes[0]?.slice(0, 72)}...`)
console.log(`  recovery:    ${shadowed.length} original seq(s) named by replacements`)
console.log('  unforced:    2 copies kept, no events appended')
console.log('  two files:   both kept, no false duplicate')
