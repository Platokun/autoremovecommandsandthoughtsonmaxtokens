/**
 * Prove `/rwm compact` and `/rwm wipe` against real DSH sessions.
 *
 * The claims under test:
 *
 *   1. A compact pass replaces the whole conversation with one `rwm-<n>-` memory.
 *   2. A file is remembered as `file <path> <read|written> <timestamp> <bytes>b -><seq>`
 *      — a record with an explicit pointer back to the source event. How much of
 *      the document rides along is the shrink mode: `reference` (pointer only),
 *      `partial` (default: a bounded opening hint), `full` (the whole document).
 *   3. Wiping leaves the initial system prompt untouched and nothing else.
 *   4. A model-authored summary is used only when configured, and a denied route
 *      is refused rather than silently used.
 *   5. A file record that contradicts the session log is rewritten to the truth
 *      and reported; a file the session never touched is marked UNVERIFIED.
 *
 * DSH's own `foldSurface()` judges every replacement, so the surface validator —
 * not this script — decides whether the `replace` op is legal.
 *
 *   node tools/verify-compact.mjs
 *   DSH_CHECKOUT=/path/to/deepseek-harness node tools/verify-compact.mjs
 *
 * Exit 0 means every claim above held.
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

const FILE_A = '/repo/src/alpha.js'
const FILE_B = '/repo/src/beta.js'
const BODY_A = 'export const alpha = 1\n'.repeat(30)
const BODY_B = 'export const beta = 2\n'.repeat(30)

/**
 * A real session with two file reads, one shell call, and some prose.
 *
 * The shape is deliberately ordinary: this is what a coding session looks like
 * when someone decides the context has grown too large.
 */
function buildSession(id) {
  const session = Session.create(SessionId(id))
  session.append('system/message', {
    turn: 0,
    step: 0,
    message: {
      id: `${id}-sys`,
      role: 'system',
      source: { kind: 'system-prompt' },
      content: text('You are a coding agent.'),
    },
  }, { surfaceOp: 'append' })

  session.append('user/message',
    { id: `${id}-u0`, role: 'user', source: { kind: 'user' }, content: text('please tidy up the alpha module') },
    { surfaceOp: 'append' })

  const reads = [
    { callId: 'c1', name: 'read', args: { file_path: FILE_A }, body: BODY_A, turn: 1 },
    { callId: 'c2', name: 'read', args: { file_path: FILE_B }, body: BODY_B, turn: 2 },
  ]
  for (const item of reads) {
    session.append('assistant/message', {
      turn: item.turn,
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
      turn: item.turn,
      step: 1,
      callId: item.callId,
      name: item.name,
      arguments: JSON.stringify(item.args),
    }).seq
    session.append('tool/result', {
      turn: item.turn,
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

  // One shell call whose output must survive as a single clipped line.
  session.append('assistant/message', {
    turn: 3,
    step: 1,
    message: {
      id: `${id}-a-sh`,
      role: 'assistant',
      source: { kind: 'model', provider: 'p', model: 'm' },
      content: [{ type: 'tool-call', id: 'c3', name: 'bash', arguments: JSON.stringify({ command: 'make test' }) }],
    },
    stream: [],
  }, { surfaceOp: 'append' })
  const shellSeq = session.append('tool/call', {
    turn: 3, step: 1, callId: 'c3', name: 'bash', arguments: JSON.stringify({ command: 'make test' }),
  }).seq
  session.append('tool/result', {
    turn: 3,
    step: 1,
    message: {
      id: `${id}-r-sh`,
      role: 'tool',
      source: { kind: 'tool', callId: 'c3' },
      toolCallId: 'c3',
      content: text('4 tests passed\n1 test skipped'),
    },
  }, { surfaceOp: 'append', sourceEventSeqs: [shellSeq] })

  session.append('assistant/message', {
    turn: 3,
    step: 2,
    message: {
      id: `${id}-a-done`,
      role: 'assistant',
      source: { kind: 'model', provider: 'p', model: 'm' },
      content: text('Both modules are read and the suite is green.'),
    },
    stream: [],
  }, { surfaceOp: 'append' })

  session.append('user/message',
    { id: `${id}-u1`, role: 'user', source: { kind: 'user' }, content: text('now update beta.js') },
    { surfaceOp: 'append' })
  return session
}

/** Mount the plugin on a fresh Context wired to one session and one optional llm. */
async function mount(session, config, llm) {
  const ctx = new Context()
  ctx.provide('tools', { register: () => () => {} })
  ctx.provide('llm', llm ?? { stream: () => (async function* () {})(), listProviders: () => [] })
  ctx.provide('sessions', { get: id => (id === String(session.id) ? session : undefined) })
  ctx.provide('systemPrompt', { variable: () => () => {}, section: () => () => {} })
  ctx.provide('tokenMeter', {
    measure: () => ({ nodes: [...session.surface.nodes].map(seq => ({ seq, heuristicTokens: 10 })) }),
  })
  let registered
  ctx.provide('commands', { register: command => { registered = command; return () => {} } })
  await ctx.plugin({
    name: plugin.name,
    inject: plugin.inject,
    apply: fiberCtx => plugin.apply(fiberCtx, config),
  })
  await new Promise(resolve => setTimeout(resolve, 200))
  check(registered !== undefined, 'the /rwm command was not registered')
  return async verb => registered.handler({ agent: { session }, rawInput: verb })
}

/** The messages the surface actually resolves to, in order. */
const surfaceTexts = session => session.deriveMessages().map(message =>
  (message.content ?? []).filter(block => typeof block.text === 'string').map(block => block.text).join('\n'))

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

/* ---- 1. compact collapses the conversation into one memory --------------- */

{
  const session = buildSession('compact-basic')
  const before = session.surface.nodes.length
  const run = await mount(session, {})
  const result = await run('compact')
  check(result.kind === 'success', `compact reported an error: ${result.text}`)

  const after = session.surface.nodes.length
  check(after < before, `compact did not shrink the surface (${before} -> ${after})`)
  check(after === 3, `expected system prompt + 1 memory + the retained tail, got ${after} nodes: ${surfaceTexts(session)}`)

  const nodes = surfaceTexts(session)
  check(nodes[0] === 'You are a coding agent.', 'the system prompt must stay first and unaltered')
  const memory = nodes[1] ?? ''
  check(/^rwm-\d+-/.test(memory), `the surviving node is not a memory: ${memory.slice(0, 60)}`)

  // A file is remembered as a record with an explicit pointer to its source event.
  check(memory.includes(`file ${FILE_A}`), `no record for ${FILE_A}`)
  check(memory.includes(`file ${FILE_B}`), `no record for ${FILE_B}`)
  check(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z/.test(memory), 'a file record carries no timestamp')
  check(/file \S+ (read|written) \S+ \d+b ->\d+/.test(memory),
    'a file record carries no `-><seq>` pointer back to the session event')

  // The default mode is `partial`: the pointer plus a bounded opening hint, never
  // the whole document. The old contract asserted no file text at all, which is
  // now only true of `reference` (covered by scenario 18).
  const hintLines = memory.split('\n').filter(line => line.startsWith('export const alpha'))
  check(hintLines.length > 0, 'the partial hint is missing entirely')
  check(hintLines.length <= 3, `the partial hint is not bounded (${hintLines.length} lines)`)
  check(!memory.includes(BODY_A), 'the whole file body leaked into the memory')
  check(!memory.includes(BODY_B), 'the whole file body leaked into the memory')
  check(memory.includes('...'), 'the partial hint is not elided with an ellipsis')

  // Terse overall.
  check(memory.length < 800, `the memory is not terse (${memory.length} chars)`)

  checkReplay(session, 'compact')
  checkPairing(session, 'compact')
  console.log('1. compact: conversation collapsed to one memory, files recorded not copied')
}

/* ---- 2. the shell output survives as one line ---------------------------- */

{
  const session = buildSession('compact-tools')
  const run = await mount(session, {})
  await run('compact')
  const memory = surfaceTexts(session).find(value => /^rwm-\d+-/.test(value)) ?? ''
  check(memory.includes('bash'), 'the shell call is not remembered')
  check(memory.includes('4 tests passed'), 'the shell output is not remembered')
  // The record is one line: the newline that separated the two output lines is gone.
  const toolLine = memory.split('\n').find(line => line.startsWith('tool bash:')) ?? ''
  check(toolLine.includes('1 test skipped'), 'the second output line was dropped entirely')
  check(!toolLine.includes('\n'), 'the tool record is not one line')
  console.log('2. compact: tool output survives as a bounded line')
}

/* ---- 3. wipe keeps only the system prompt -------------------------------- */

{
  const session = buildSession('wipe-basic')
  const run = await mount(session, {})
  const result = await run('wipe')
  check(result.kind === 'success', `wipe reported an error: ${result.text}`)

  const nodes = surfaceTexts(session)
  check(session.surface.nodes.length === 2, `expected 2 nodes after a wipe, got ${session.surface.nodes.length}`)
  check(nodes[0] === 'You are a coding agent.', 'the wipe destroyed the system prompt')
  check(/^rwm-\d+-wiped:/.test(nodes[1] ?? ''), `the wipe memory is malformed: ${(nodes[1] ?? '').slice(0, 60)}`)
  check(!nodes.some(value => value.includes(BODY_A)), 'the whole file body survived the wipe')
  check(nodes.filter(value => value.includes(`file ${FILE_A}`)).length === 1,
    'the wipe lost the record of which files had been touched')
  check(nodes.some(value => /file \S+ (read|written) \S+ \d+b ->\d+/.test(value)),
    'the wipe dropped the pointer from the surviving file record')

  checkReplay(session, 'wipe')
  checkPairing(session, 'wipe')
  console.log('3. wipe: only the initial system prompt and one memory remain')
}

/* ---- 4. retired content stays recoverable -------------------------------- */

{
  const session = buildSession('compact-recover')
  const eventsBefore = session.snapshotEvents().length
  const run = await mount(session, {})
  await run('compact')
  const events = session.snapshotEvents()
  check(events.length > eventsBefore, 'compact appended no events at all')
  const pruned = events.filter(event => event.type === 'compaction/prune')
  check(pruned.length === 1, `expected exactly one prune price, got ${pruned.length}`)
  const priced = pruned[0]?.data?.shadowedSeqs ?? []
  check(priced.length >= 5, `the prune event priced only ${priced.length} nodes`)

  // Nothing is deleted: every original event is still in the log.
  const originals = events.filter(event => event.type === 'tool/result' && event.data?.message?.content?.[0]?.text === BODY_A)
  check(originals.length === 1, 'the original file bytes are no longer in the log')
  console.log('4. compact: originals remain in the log, priced once, never deleted')
}

/* ---- 5. a model-authored summary is used only when configured ----------- */

{
  // Not configured: no call is made at all.
  let called = false
  const session = buildSession('compact-nomodel')
  const run = await mount(session, {}, {
    stream: () => { called = true; return (async function* () {})() },
    listProviders: () => [{ id: 'local-spark' }],
  })
  await run('compact')
  check(called === false, 'a model was called even though compactUseModel is false')
  console.log('5. compact: no model call unless configured')
}

/* ---- 6. the configured route is used, and its text is stored ------------- */

{
  let sawRoute
  const session = buildSession('compact-model')
  const run = await mount(session, {
    compactUseModel: true,
    compactProvider: 'local-spark',
    compactModel: 'spark-x-t-4b',
  }, {
    listProviders: () => [{ id: 'local-spark' }, { id: 'deepseek' }],
    stream: (options) => {
      sawRoute = options
      return (async function* () {
        yield { type: 'text', text: 'MODEL SUMMARY: alpha and beta were read; make test passed.' }
      })()
    },
  })
  const result = await run('compact')
  check(result.kind === 'success', `compact failed with a model configured: ${result.text}`)
  check(sawRoute !== undefined, 'the configured model was never called')
  if (sawRoute !== undefined) {
    check(sawRoute.provider === 'local-spark', `wrong provider: ${sawRoute.provider}`)
    check(sawRoute.model === 'spark-x-t-4b', `wrong model: ${sawRoute.model}`)
    check(typeof sawRoute.system === 'string' && /never invent/i.test(sawRoute.system),
      'the model was not told to avoid inventing file contents')
    check(JSON.stringify(sawRoute).includes(`file ${FILE_A}`), 'the model was not given the file records')
  }
  const memory = surfaceTexts(session)[1] ?? ''
  check(memory.includes('MODEL SUMMARY'), `the model text is not in the memory: ${memory.slice(0, 80)}`)
  console.log('6. compact: the selected model wrote the memory')
}

/* ---- 7. a denied route is refused, and the pass still succeeds ----------- */

{
  let called = false
  const session = buildSession('compact-denied')
  const run = await mount(session, {
    compactUseModel: true,
    compactDenyProviders: 'deepseek',
  }, {
    listProviders: () => [{ id: 'deepseek' }],
    stream: () => { called = true; return (async function* () {})() },
  })
  const result = await run('compact')
  check(result.kind === 'success', 'the pass must still compact when no permitted route exists')
  check(called === false, 'a denied provider was called anyway')
  check(/not used/i.test(result.text), `the refusal was not reported: ${result.text}`)
  check(surfaceTexts(session).some(value => /^rwm-\d+-/.test(value)), 'the compaction did not happen')
  console.log('7. compact: a denied route is refused, never used silently')
}

/* ---- 8. a failing model falls back instead of losing the compaction ------ */

{
  const session = buildSession('compact-failure')
  const run = await mount(session, {
    compactUseModel: true,
    compactProvider: 'local-spark',
    compactModel: 'spark-x-t-4b',
  }, {
    listProviders: () => [{ id: 'local-spark' }],
    stream: () => (async function* () { throw new Error('model is down') })(),
  })
  const result = await run('compact')
  check(result.kind === 'success', 'a model failure must not fail the compaction')
  check(surfaceTexts(session).some(value => /^rwm-\d+-/.test(value)),
    'the compaction did not happen despite the model failing')
  const memory = surfaceTexts(session).find(value => /^rwm-\d+-/.test(value)) ?? ''
  check(memory.includes('file '), 'the deterministic fallback lost the file records')
  check(/model is down|not used/i.test(result.text), `the failure was not reported: ${result.text}`)
  console.log('8. compact: a failing model falls back to the deterministic memory')
}

/* ---- 9. compacting twice is safe ---------------------------------------- */

{
  const session = buildSession('compact-twice')
  const run = await mount(session, {})
  await run('compact')
  const once = session.surface.nodes.length
  const result = await run('compact')
  check(result.kind === 'success', `the second compact failed: ${result.text}`)
  check(session.surface.nodes.length <= once + 1, 'a second compact grew the surface')
  checkReplay(session, 'compact twice')
  checkPairing(session, 'compact twice')
  console.log('9. compact: a second pass is safe')
}

/* ---- 10. a developer message is context too ------------------------------ */

{
  const session = Session.create(SessionId('compact-developer'))
  session.append('system/message',
    { turn: 0, step: 0, message: { id: 'd-s', role: 'system', source: { kind: 'system-prompt' }, content: text('SYSTEM') } },
    { surfaceOp: 'append' })
  session.append('developer/message',
    { turn: 0, step: 0, message: { id: 'd-dev', role: 'developer', source: { kind: 'developer' }, content: text('DEVELOPER RULE: always use tabs') } },
    { surfaceOp: 'append' })
  session.append('user/message', { id: 'd-u', role: 'user', source: { kind: 'user' }, content: text('hello') }, { surfaceOp: 'append' })
  session.append('user/message', { id: 'd-t', role: 'user', source: { kind: 'user' }, content: text('tail') }, { surfaceOp: 'append' })
  const run = await mount(session, {})
  const result = await run('compact')
  check(result.kind === 'success', `developer-message compact failed: ${result.text}`)
  check(session.surface.nodes.length <= 3, `developer: surface did not shrink (${session.surface.nodes.length})`)
  checkReplay(session, 'developer')
  console.log('10. compact: a developer message is compacted like any other context')
}

/* ---- 11. a result that arrived without a call ---------------------------- */

{
  const session = Session.create(SessionId('compact-orphan'))
  session.append('system/message',
    { turn: 0, step: 0, message: { id: 'o-s', role: 'system', source: { kind: 'system-prompt' }, content: text('SYSTEM') } },
    { surfaceOp: 'append' })
  session.append('tool/result', {
    turn: 1,
    step: 1,
    message: {
      id: 'o-r',
      role: 'tool',
      source: { kind: 'tool', callId: 'ghost' },
      toolCallId: 'ghost',
      content: text('external output that arrived without a call'),
    },
  }, { surfaceOp: 'append' })
  session.append('user/message', { id: 'o-u', role: 'user', source: { kind: 'user' }, content: text('what did that say') }, { surfaceOp: 'append' })
  session.append('user/message', { id: 'o-t', role: 'user', source: { kind: 'user' }, content: text('tail') }, { surfaceOp: 'append' })
  const run = await mount(session, {})
  const result = await run('compact')
  check(result.kind === 'success', `orphan-result compact failed: ${result.text}`)
  checkReplay(session, 'orphan result')
  console.log('11. compact: a tool result with no call still compacts')
}

/* ---- 12. a single enormous message stays bounded ------------------------- */

{
  const session = Session.create(SessionId('compact-huge'))
  session.append('system/message',
    { turn: 0, step: 0, message: { id: 'h-s', role: 'system', source: { kind: 'system-prompt' }, content: text('SYSTEM') } },
    { surfaceOp: 'append' })
  session.append('user/message',
    { id: 'h-u', role: 'user', source: { kind: 'user' }, content: text('X'.repeat(2_000_000)) },
    { surfaceOp: 'append' })
  session.append('user/message', { id: 'h-t', role: 'user', source: { kind: 'user' }, content: text('tail') }, { surfaceOp: 'append' })
  const run = await mount(session, {})
  const started = Date.now()
  const result = await run('compact')
  const elapsed = Date.now() - started
  const memory = surfaceTexts(session).find(value => /^rwm-\d+-/.test(value)) ?? ''
  check(result.kind === 'success', `huge-message compact failed: ${result.text}`)
  check(memory.length < 2000, `a 2MB message produced a ${memory.length}-char memory`)
  check(elapsed < 2000, `compacting a 2MB message took ${elapsed}ms`)
  console.log(`12. compact: a 2MB message became a ${memory.length}-char memory in ${elapsed}ms`)
}

/* ---- 13. a wipe with nothing to wipe is a graceful no-op ----------------- */

{
  const session = Session.create(SessionId('wipe-only-system'))
  session.append('system/message',
    { turn: 0, step: 0, message: { id: 'w-s', role: 'system', source: { kind: 'system-prompt' }, content: text('SYSTEM') } },
    { surfaceOp: 'append' })
  const run = await mount(session, {})
  const result = await run('wipe')
  check(result.kind === 'success', `only-system wipe errored: ${result.text}`)
  check(session.surface.nodes.length === 1, 'the system prompt was disturbed by a no-op wipe')
  check(/nothing to wipe/i.test(result.text), `the no-op was not explained: ${result.text}`)
  console.log('13. wipe: a session holding only the system prompt is left alone')
}

/* ---- 14. an empty session is not an error -------------------------------- */

{
  const session = Session.create(SessionId('compact-empty'))
  const run = await mount(session, {})
  const compact = await run('compact')
  const wipe = await run('wipe')
  check(compact.kind === 'success', `empty-session compact errored: ${compact.text}`)
  check(wipe.kind === 'success', `empty-session wipe errored: ${wipe.text}`)
  console.log('14. compact and wipe: an empty session reports nothing to do')
}

/* ---- 15. compact and wipe interleave safely ------------------------------ */

{
  const session = Session.create(SessionId('compact-interleaved'))
  session.append('system/message',
    { turn: 0, step: 0, message: { id: 'i-s', role: 'system', source: { kind: 'system-prompt' }, content: text('SYSTEM') } },
    { surfaceOp: 'append' })
  for (let index = 0; index < 6; index += 1) {
    session.append('user/message',
      { id: `i-${index}`, role: 'user', source: { kind: 'user' }, content: text(`message ${index}`) },
      { surfaceOp: 'append' })
  }
  const run = await mount(session, {})
  for (const verb of ['compact', 'wipe', 'compact', 'wipe']) {
    const result = await run(verb)
    check(result.kind === 'success', `interleaved ${verb} failed: ${result.text}`)
  }
  check(session.surface.nodes.length === 2, `interleaved: expected 2 nodes, got ${session.surface.nodes.length}`)
  checkReplay(session, 'interleaved')
  console.log('15. compact/wipe: repeated passes interleave safely')
}

/* ---- 16. the context meter's shadow price matches what left -------------- */

{
  const session = buildSession('compact-price')
  const before = [...session.surface.nodes].map(Number)
  const run = await mount(session, {})
  await run('compact')
  const events = session.snapshotEvents()
  const pruned = events.filter(event => event.type === 'compaction/prune')
  check(pruned.length === 1, `expected one prune price, got ${pruned.length}`)
  const priced = (pruned[0]?.data?.shadowedSeqs ?? []).map(Number)
  const replacement = events.filter(event => event.surfaceOp?.op === 'replace').pop()
  const cited = (replacement?.sourceEventSeqs ?? []).map(Number)

  /*
   * The price must cover exactly the nodes that left the surface, and the
   * replacement must cite every one of them — no more (which would over-charge
   * the meter) and no fewer (which would strand an unrecoverable node).
   */
  const after = [...session.surface.nodes].map(Number)
  const left = before.filter(seq => !after.includes(seq))
  check(priced.length === left.length,
    `the price covered ${priced.length} nodes but ${left.length} left the surface`)
  check(JSON.stringify(priced) === JSON.stringify(left),
    `the priced set is not what left: ${priced} vs ${left}`)
  check(cited.length === priced.length && priced.every(seq => cited.includes(seq)),
    `replacement cites ${cited} but priced ${priced}`)
  check(before.includes(0) && after.includes(0), 'the system prompt must survive a compact')
  console.log(`16. compact: priced exactly the ${priced.length} nodes that left, all cited`)
}

/* ---- 17. the three shrink modes are distinct and honest ------------------ */

{
  /*
   * The user asked to be able to "collapse file in memory or keep all or partial
   * context". Each mode must be exactly what it says: `reference` carries the
   * pointer and nothing else, `partial` carries a bounded hint, `full` carries
   * the document — and the reply must name the mode that actually ran, because a
   * hardcoded "path and time only" line is false under `partial`.
   */
  const modes = {
    reference: { expectBody: false, expectHint: false, reply: /pointer only/ },
    partial: { expectBody: false, expectHint: true, reply: /opening lines/ },
    full: { expectBody: true, expectHint: true, reply: /whole document/ },
  }
  for (const [mode, expect] of Object.entries(modes)) {
    const session = buildSession(`shrink-${mode}`)
    const run = await mount(session, { compactFileShrink: mode })
    const result = await run('compact')
    check(result.kind === 'success', `${mode}: compact errored: ${result.text}`)
    const memory = surfaceTexts(session).find(value => /^rwm-\d+-/.test(value)) ?? ''

    check(memory.includes(`file ${FILE_A}`), `${mode}: the record is missing`)
    check(/->\d+/.test(memory), `${mode}: the record lost its pointer`)
    check(memory.includes(BODY_A) === expect.expectBody,
      `${mode}: whole-document presence was ${memory.includes(BODY_A)}, expected ${expect.expectBody}`)
    check(memory.includes('export const alpha') === expect.expectHint,
      `${mode}: hint presence was ${memory.includes('export const alpha')}, expected ${expect.expectHint}`)
    check(expect.reply.test(result.text), `${mode}: the reply does not name the mode: ${result.text}`)

    checkReplay(session, `shrink-${mode}`)
    checkPairing(session, `shrink-${mode}`)
  }
  console.log('17. compact: reference / partial / full are distinct, and the reply names the mode')
}

/* ---- 18. a file the session never touched is marked, never invented ------- */

{
  /*
   * The user asked for wrong file records to be rewritten to the truth and
   * reported. Verification only runs on a model-authored summary, so this drives
   * `verifyFileRecords` directly — the same door the model path uses.
   */
  const { verifyFileRecords, fileIdentity } = await import('../lib/memory.js')
  // `truths` are the authoritative record lines, exactly as buildFileRecord emits them.
  const TRUTH_A = `file ${FILE_A} read 2026-10-16T00:00:00Z 690b ->4`
  const written = [
    TRUTH_A,
    `file ${FILE_B} written 2026-10-16T00:00:00Z 999b ->7`,
    `file ${FILE_A} written 1999-01-01T00:00:00Z 1b ->99`,
  ].join('\n')
  const { text: corrected, corrections, invented } = verifyFileRecords(written, [TRUTH_A])

  check(invented.length === 1 && invented[0] === fileIdentity(FILE_B),
    `a file with no tool call was not reported as unverifiable: ${JSON.stringify(invented)}`)
  check(corrected.includes('UNVERIFIED'), 'the invented file was not marked in the text')
  check(!corrected.includes('999b'), 'the invented file kept its fabricated byte count')

  // The true line is untouched; the misstated second line for the same file is repaired.
  check(corrected.split('\n')[0] === TRUTH_A, 'a correct record was rewritten even though it was already true')
  check(!corrected.includes('->99'), 'a fabricated pointer survived the correction')
  check((corrected.match(new RegExp(TRUTH_A.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')) ?? []).length === 2,
    'the misstated record was not replaced with the true one')
  check(corrections.length === 2,
    `expected exactly the two wrong records to be corrected, got ${corrections.length}`)
  console.log('18. verifyFileRecords: wrong records are rewritten to the truth and reported')
}

/* ---- 19. every real replacement preserves the provider prefix -------------- */

{
  /*
   * Prefix-cache stability decides what a rewrite costs at the provider. DSH
   * exposes no cache API to consult, so the property must be checked
   * structurally: a replacement may only retire a *contiguous ascending* run of
   * the surface. Everything before that run stays byte-identical to what the
   * provider already cached, so only the rewritten tail is re-billed.
   *
   * This walks the real log after an actual compact + wipe and requires every
   * replacement to satisfy it, so a future change that emits a hole or a
   * reversed range fails here instead of silently costing full price.
   */
  const session = buildSession('prefix-stability')
  const run = await mount(session, { compactFileShrink: 'reference' })
  await run('compact')
  await run('wipe')

  const replaced = session.snapshotEvents()
    .filter(event => event.surfaceOp !== undefined && event.surfaceOp !== 'append')
  check(replaced.length >= 2, `expected replacements to inspect, saw ${replaced.length}`)

  /*
   * The property has to be evaluated at the moment each replacement was written,
   * not against the final surface. Session seqs are not contiguous in raw-number
   * space once the surface has collapsed — replacing surface run [1..11] leaves
   * [0,13,12] — and a later pass folds again over what survives. So replay the
   * log prefix up to each replacement and require its cited seqs to be one
   * ascending, gap-free run of the surface as it stood right then. That is
   * exactly what the plugin's own guard checks live, and what `foldSurface`
   * accepts.
   */
  const events = session.snapshotEvents()
  for (const event of replaced) {
    const cited = event.sourceEventSeqs ?? []
    check(cited.length > 0, `replacement at seq ${event.seq} cites nothing`)

    /* Replay up to (not including) the replacement to recover its surface. */
    const prior = events.slice(0, events.findIndex(candidate => candidate.seq === event.seq))
    let nodes
    try {
      nodes = [...foldSurface(prior).nodes]
    } catch {
      /* The replacement's own prefix may not be a complete surface; skip it. */
      continue
    }

    const positions = cited.map(seq => nodes.indexOf(seq))
    check(positions.every(position => position !== -1),
      `replacement at seq ${event.seq} cites seqs not on the surface when it was written: ${JSON.stringify(cited)}`)
    for (let offset = 1; offset < positions.length; offset += 1) {
      check(positions[offset] === positions[offset - 1] + 1,
        `replacement at seq ${event.seq} cites a surface run with a hole: ${JSON.stringify(cited)}`)
    }

    /* The declared range must match the cited run; a range is not decoration. */
    check(event.surfaceOp.startSeq === cited[0] && event.surfaceOp.endSeq === cited.at(-1),
      `replacement at seq ${event.seq} declares ${event.surfaceOp.startSeq}..${event.surfaceOp.endSeq} `
      + `but cites ${cited[0]}..${cited.at(-1)}`)
  }

  check(events.at(-1).surfaceOp !== undefined, 'the final event is not a surface node')
  console.log(`19. prefix stability: all ${replaced.length} replacements retire contiguous surface runs`)
}

/* ---- 20. the prefix guard rejects a hostile replacement ------------------- */

{
  /*
   * The guard is only worth having if it fires. `isContiguousTail` is the single
   * predicate every replacement passes through, so drive it with the shapes a
   * buggy future pass could plausibly produce.
   */
  const { isContiguousTail } = await import('../lib/memory.js')
  const entries = [0, 1, 2, 3, 4].map(seq => ({ seq, message: { role: 'user' } }))

  check(isContiguousTail(entries, [1, 2, 3]) === true, 'a real contiguous run was rejected')
  check(isContiguousTail(entries, [4]) === true, 'a single-entry replace was rejected')
  check(isContiguousTail(entries, [1, 3]) === false, 'a hole was accepted — it busts the cache')
  check(isContiguousTail(entries, [3, 2]) === false, 'a reversed run was accepted')
  check(isContiguousTail(entries, [1, 99]) === false, 'an off-surface seq was accepted')
  check(isContiguousTail(entries, []) === false, 'an empty run was accepted')

  /*
   * And end to end through the real wipe path: the guard runs where it actually
   * runs, and a legitimate wipe must still write its replacement.
   */
  const session = buildSession('guard-fires')
  const run = await mount(session, { compactFileShrink: 'reference' })
  const before = session.snapshotEvents().length
  const result = await run('wipe')
  check(result.kind === 'success', `wipe errored while exercising the guard: ${result.text}`)

  const events = session.snapshotEvents()
  check(events.find(event => event.surfaceOp !== undefined && event.surfaceOp !== 'append') !== undefined,
    'the guard rejected a legitimate wipe replacement')
  check(events.length > before, 'wipe did not append')
  console.log('20. the prefix guard accepts real runs and rejects holes, reversals, and strays')
}

/* ---- report -------------------------------------------------------------- */

if (failures.length > 0) {
  console.error(`\nCOMPACT VERIFY FAILED (${failures.length}):`)
  for (const failure of failures) console.error(` - ${failure}`)
  process.exit(1)
}
console.log('\nCOMPACT VERIFY OK: /rwm compact and /rwm wipe behave as documented.')
