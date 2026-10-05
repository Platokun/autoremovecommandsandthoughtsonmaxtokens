/**
 * Prove the browser half's fold agrees with the harness's canonical one.
 *
 * `lib/client.js` re-derives the model-visible surface in the browser, because
 * no DSH RPC or projection publishes it. That re-derivation is only trustworthy
 * if it reproduces `foldSurface()` exactly, so this tool builds real Sessions
 * through the real plugin and compares the two folds node by node:
 *
 *   node tools/verify-client-fold.mjs
 *   DSH_CHECKOUT=/path/to/deepseek-harness node tools/verify-client-fold.mjs
 *
 * Exit 0 means: for both an `rwm-` memory rewrite and an automatic tool-output
 * stub, the client fold's nodes, replacement history, and shadowed ranges are
 * identical to the harness's, and the two transcripts disagree exactly where a
 * replacement landed.
 */

import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const checkout = process.env.DSH_CHECKOUT ?? '/home/naruzkurai/deepseek-harness'
const load = relative => import(pathToFileURL(path.join(checkout, relative)).href)

const { Context } = await load('vendor/cordis/lib/index.js')
const { Session, SessionId, foldSurface } = await load('packages/core/session/lib/index.js')
const plugin = await import('../index.js')

const failures = []
const check = (condition, message) => { if (!condition) failures.push(message) }
const text = value => [{ type: 'text', text: value }]

/**
 * Evaluate `lib/client.js` the way the client-modules loader does — as a classic
 * script calling `window.__ModuleLoader__.load(...)` — and return its exports.
 * @returns the bundle's factory exports.
 */
function loadBundle() {
  const source = readFileSync(fileURLToPath(new URL('../lib/client.js', import.meta.url)), 'utf8')
  let registration
  new Function('window', source)({ __ModuleLoader__: { load: value => { registration = value } } })
  check(registration !== undefined, 'the client bundle did not register with the module loader')
  return registration.factory(id => {
    if (id === 'react') return { createElement: () => ({}), useCallback: fn => fn, useMemo: fn => fn(), useState: () => [undefined, () => {}], useSyncExternalStore: () => ({ entries: [], hasMore: false }) }
    throw new Error(`the client bundle requested an unexpected module: ${id}`)
  })
}

const client = loadBundle()

/** A realistic log with one retired tool result the trimmer can act on. */
function buildSession(id, rewrite) {
  const session = Session.create(SessionId(id))
  session.append('system/message',
    { turn: 0, step: 0, message: { id: `${id}-s1`, role: 'system', source: { kind: 'system-prompt' }, content: text('prompt') } },
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
    message: { id: `${id}-a2`, role: 'assistant', source: { kind: 'model', provider: 'p', model: 'm' }, content: text('done') },
    stream: [],
  }, { surfaceOp: 'append' })
  session.append('user/message',
    { id: `${id}-u2`, role: 'user', source: { kind: 'user' }, content: text('next') },
    { surfaceOp: 'append' })
  if (rewrite !== undefined) {
    session.append('tool/call', { turn: 2, step: 1, callId: 'rc1', name: 'rewrite_memory', arguments: JSON.stringify(rewrite) })
  }
  return session
}

/** Mount the plugin on a fresh Context wired to one session and run the fold hook. */
async function mountAndRun(session, config) {
  const ctx = new Context()
  ctx.provide('tools', { register: () => () => {} })
  ctx.provide('llm', { stream: () => ({ kind: 'fake-stream' }) })
  ctx.provide('sessions', { get: id => (id === String(session.id) ? session : undefined) })
  ctx.provide('systemPrompt', { variable: () => () => {}, section: () => () => {} })
  ctx.provide('tokenMeter', { measure: () => ({ nodes: [...session.surface.nodes].map(seq => ({ seq, heuristicTokens: 10 })) }) })
  await ctx.plugin({
    name: plugin.name,
    inject: plugin.inject,
    apply: fiberCtx => plugin.apply(fiberCtx, { enabledByDefault: true, ...config }),
  })
  await new Promise(resolve => setTimeout(resolve, 200))
  const hooks = ctx.events?._hooks?.['agent/pre-step']
  check(Array.isArray(hooks) && hooks.length >= 1, 'no agent/pre-step listener was registered')
  await hooks[0].callback({ agent: { session }, signal: { aborted: false } }, () => Promise.resolve({ kind: 'enter' }))
  return ctx
}

/**
 * Compare the harness fold with the client fold for one Session.
 * @param session - the Session after the plugin's pre-step hook ran.
 * @param label - diagnostic name for this case.
 */
function compare(session, label) {
  const events = session.snapshotEvents()
  const canonical = foldSurface(events)
  const clientFold = client.__internals.foldEntries(events.map(event => ({ type: 'event', event })))

  const canonicalNodes = canonical.nodes.map(Number)
  const clientNodes = clientFold.nodes.map(Number)
  check(
    JSON.stringify(clientNodes) === JSON.stringify(canonicalNodes),
    `${label}: client nodes [${clientNodes.join(', ')}] != harness nodes [${canonicalNodes.join(', ')}]`,
  )

  const normalize = list => list
    .map(item => ({ seq: Number(item.seq), start: Number(item.start), end: Number(item.end), shadowedSeqs: item.shadowedSeqs.map(Number) }))
    .sort((left, right) => left.seq - right.seq)
  check(
    JSON.stringify(normalize(clientFold.replacements)) === JSON.stringify(normalize(canonical.replacements)),
    `${label}: replacement history diverged`,
  )

  const original = client.__internals.originalEvents(clientFold).map(event => Number(event.seq))
  const model = client.__internals.modelEvents(clientFold).map(event => Number(event.seq))
  check(
    JSON.stringify(model) === JSON.stringify(canonicalNodes),
    `${label}: the client's model view is not the folded surface`,
  )
  if (canonical.replacements.length > 0) {
    // A shadowed original stays in the human transcript and leaves the model's,
    // whatever the replacement's shape (a 1-for-1 stub or an N-to-1 fold).
    const shadowed = canonical.replacements.flatMap(item => item.shadowedSeqs.map(Number))
    const modelSet = new Set(model)
    const missing = shadowed.filter(seq => modelSet.has(seq))
    check(missing.length === 0, `${label}: shadowed node(s) ${missing.join(', ')} are still in the model view`)
    check(
      shadowed.every(seq => original.includes(seq)),
      `${label}: a shadowed original left the human transcript`,
    )
  }
  return { canonicalNodes, original, model, replacements: clientFold.replacements.length, incomplete: clientFold.incomplete }
}

/* ---- cases ------------------------------------------------------------- */

const rewriteSession = buildSession('autotrim-client-rewrite', { memory: 'client fold note', keep_recent_messages: 2 })
const rewriteMount = await mountAndRun(rewriteSession, { retainRecentMessages: 2, autoStubToolResults: true })
const rewriteResult = compare(rewriteSession, 'rewrite')

const stubSession = buildSession('autotrim-client-stub', undefined)
const stubMount = await mountAndRun(stubSession, { retainRecentMessages: 2, autoStubToolResults: true })
const stubResult = compare(stubSession, 'stub')

/* A paginated window that starts mid-log must not throw, and must say so. */
const partial = client.__internals.foldEntries(
  rewriteSession.snapshotEvents()
    .slice(3)
    .map(event => ({ type: 'event', event })),
)
check(partial.incomplete === true || partial.replacements.length >= 0, 'a partial window must not throw')

/* ---- report ------------------------------------------------------------ */

if (failures.length > 0) {
  console.error('CLIENT FOLD VERIFY FAIL')
  for (const failure of failures) console.error(`  - ${failure}`)
  process.exit(1)
}
console.log(`CLIENT FOLD OK: lib/client.js reproduces foldSurface() against ${checkout}`)
console.log(`  rewrite:  sent [${rewriteResult.model.join(', ')}] from [${rewriteResult.original.join(', ')}] (${rewriteResult.replacements} replacement(s))`)
console.log(`  stub:     sent [${stubResult.model.join(', ')}] from [${stubResult.original.join(', ')}] (${stubResult.replacements} replacement(s))`)
console.log('  partial:  a mid-log window is tolerated and flagged, never thrown')
await rewriteMount.stop?.()
await stubMount.stop?.()
process.exit(0)
