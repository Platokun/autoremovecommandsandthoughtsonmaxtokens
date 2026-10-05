/**
 * Tests for the browser half (`lib/client.js`).
 *
 * The bundle is evaluated exactly as the browser evaluates it — as a classic
 * script calling `window.__ModuleLoader__.load(...)` — so the registration
 * wrapper and the factory contract are covered, not just the pure helpers.
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const BUNDLE = fileURLToPath(new URL('../lib/client.js', import.meta.url))
const MANIFEST = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))

/** The smallest React the bundle's registration path touches. */
const reactStub = {
  createElement: () => ({}),
  useCallback: fn => fn,
  useMemo: fn => fn(),
  useState: () => [undefined, () => {}],
  useSyncExternalStore: () => ({ entries: [], hasMore: false, revision: 0 }),
}

/**
 * Evaluate the bundle the way the client-modules loader does.
 * @returns the captured registration and the materialized factory exports.
 */
function loadBundle() {
  let registration
  const sandbox = { __ModuleLoader__: { load: value => { registration = value } } }
  // The loader injects the bundle as a classic script; `new Function` gives the
  // top-level `window` reference and nothing else from this module's scope.
  new Function('window', readFileSync(BUNDLE, 'utf8'))(sandbox)
  assert.ok(registration !== undefined, 'bundle must call window.__ModuleLoader__.load')
  const exports = registration.factory(id => {
    if (id === 'react') return reactStub
    throw new Error(`bundle requested an undeclared module: ${id}`)
  })
  return { registration, exports }
}

/** One surface event. */
function event(seq, type, data, extra = {}) {
  return { seq, type, time: seq, data, ...extra }
}

/** One client event window entry. */
function entry(event_) {
  return { type: 'event', event: event_ }
}

/** A user message event. */
function user(seq, text, extra) {
  return event(seq, 'user/message', { role: 'user', content: [{ type: 'text', text }] }, extra)
}

/** An assistant message event. */
function assistant(seq, text, extra) {
  return event(seq, 'assistant/message', { message: { role: 'assistant', content: [{ type: 'text', text }] } }, extra)
}

test('registers under the package name in the closure-factory form', () => {
  const { registration, exports } = loadBundle()
  assert.equal(registration.id, MANIFEST.name)
  assert.equal(typeof registration.factory, 'function')
  assert.equal(typeof exports.apply, 'function')
  assert.deepEqual(exports.inject, ['slots', 'sessions', 'sidebarRightTabs'])
})

test('manifest declares a web client face', () => {
  assert.equal(MANIFEST.dsh.client.platform, 'web')
  assert.equal(MANIFEST.exports['./client'], './lib/client.js')
  // The bundle must not request non-baseline modules; `react` is the only one.
  assert.equal(MANIFEST.dsh.client.external, undefined)
})

test('an append-only log folds to the surface events in log order', () => {
  const { exports } = loadBundle()
  const fold = exports.__internals.foldEntries([
    entry(user(0, 'hello', { surfaceOp: 'append' })),
    entry(event(1, 'turn/start', {})),
    entry(assistant(2, 'hi', { surfaceOp: 'append' })),
  ])
  assert.deepEqual(fold.nodes, [0, 2])
  assert.deepEqual(fold.replacements, [])
  assert.equal(fold.incomplete, false)
})

test('a replacement shadows its range and becomes the visible node', () => {
  const { exports } = loadBundle()
  const fold = exports.__internals.foldEntries([
    entry(user(0, 'one', { surfaceOp: 'append' })),
    entry(assistant(1, 'two', { surfaceOp: 'append' })),
    entry(user(2, 'three', { surfaceOp: 'append' })),
    entry(user(3, 'summary', {
      surfaceOp: { op: 'replace', startSeq: 0, endSeq: 1 },
      sourceEventSeqs: [0, 1],
    })),
  ])
  assert.deepEqual(fold.nodes, [3, 2])
  assert.deepEqual(fold.replacements, [
    { seq: 3, start: 0, end: 1, shadowedSeqs: [0, 1] },
  ])
})

test('a replacement outside a paginated window is skipped, not thrown', () => {
  const { exports } = loadBundle()
  const fold = exports.__internals.foldEntries([
    entry(assistant(7, 'later', { surfaceOp: 'append' })),
    entry(user(8, 'summary', {
      surfaceOp: { op: 'replace', startSeq: 0, endSeq: 5 },
      sourceEventSeqs: [0, 5],
    })),
  ])
  assert.deepEqual(fold.nodes, [7])
  assert.deepEqual(fold.replacements, [])
  assert.equal(fold.incomplete, true)
})

test('original and model views part at the replacement', () => {
  const { exports } = loadBundle()
  const helpers = exports.__internals
  const fold = helpers.foldEntries([
    entry(user(0, 'one', { surfaceOp: 'append' })),
    entry(assistant(1, 'two', { surfaceOp: 'append' })),
    entry(user(2, 'summary', {
      surfaceOp: { op: 'replace', startSeq: 0, endSeq: 1 },
      sourceEventSeqs: [0, 1],
    })),
  ])
  assert.deepEqual(helpers.originalEvents(fold).map(e => e.seq), [0, 1])
  assert.deepEqual(helpers.modelEvents(fold).map(e => e.seq), [2])
})

test('renders message text for every surface event type', () => {
  const { exports } = loadBundle()
  const helpers = exports.__internals
  assert.equal(helpers.eventText(user(0, 'hello')), 'hello')
  assert.equal(helpers.eventText(assistant(1, 'a\nb')), 'a\nb')
  assert.equal(helpers.eventText(event(2, 'tool/result', {
    message: { role: 'tool', content: [{ type: 'text', text: 'out' }] },
  })), 'out')
  assert.equal(helpers.eventText(event(3, 'assistant/message', {
    message: { role: 'assistant', content: [{ type: 'thinking', text: 'why' }] },
  })), '(thought) why')
})

test('transcript lines carry the citable seq and any replacement badge', () => {
  const { exports } = loadBundle()
  const helpers = exports.__internals
  const marks = new Map([[2, '«rewritten»']])
  const lines = helpers.transcriptLines([user(2, 'summary')], marks)
  assert.deepEqual(lines, ['[2] user «rewritten»: summary'])
})

test('diffLines reports same, removed and added lines', () => {
  const { exports } = loadBundle()
  const diff = exports.__internals.diffLines(['a', 'b', 'c'], ['a', 'c', 'd'])
  assert.deepEqual(diff, [
    { type: 'same', text: 'a' },
    { type: 'del', text: 'b' },
    { type: 'same', text: 'c' },
    { type: 'add', text: 'd' },
  ])
})

test('summarize counts what is sent, logged and rewritten', () => {
  const { exports } = loadBundle()
  const helpers = exports.__internals
  const fold = helpers.foldEntries([
    entry(user(0, 'one', { surfaceOp: 'append' })),
    entry(assistant(1, 'two', { surfaceOp: 'append' })),
    entry(user(2, 'summary', {
      surfaceOp: { op: 'replace', startSeq: 0, endSeq: 0 },
      sourceEventSeqs: [0],
    })),
  ])
  const stats = helpers.summarize(fold)
  assert.equal(stats.model, 2)
  assert.equal(stats.original, 2)
  assert.equal(stats.rewritten, 1)
  assert.equal(stats.marks.get(2), '«rewritten»')
})

test('apply registers both the tab type and its body', () => {
  const { exports } = loadBundle()
  const tabs = []
  const bodies = []
  const effects = []
  const ctx = {
    effect: (fn, label) => { effects.push(label); return fn() },
    sidebarRightTabs: { register: definition => { tabs.push(definition); return () => {} } },
    slots: { register: (options, component) => { bodies.push({ options, component }); return () => {} } },
  }
  exports.apply(ctx)
  assert.equal(tabs.length, 1)
  assert.equal(tabs[0].id, exports.__internals.ID)
  assert.equal(tabs[0].kind, exports.__internals.KIND)
  assert.equal(tabs[0].title(), 'Model context')
  assert.equal(tabs[0].guide.length, 1)
  assert.equal(bodies.length, 1)
  assert.equal(bodies[0].options.name, 'sidebar.right.pane.tab')
  assert.equal(bodies[0].options.key, exports.__internals.ID)
  // The body must be keyed by the tab definition's own id, or the pane shows
  // the "nothing can view this" notice.
  assert.equal(bodies[0].options.key, tabs[0].id)
  assert.equal(typeof bodies[0].component, 'function')
})

test('the body renders without a session binding', () => {
  const { exports } = loadBundle()
  const helpers = exports.__internals
  const React = reactStub
  const ctx = { sessions: { binding: () => undefined } }
  assert.doesNotThrow(() => helpers.Panel({ ctx, sessionId: 's1', ...React }))
})
