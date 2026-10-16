/**
 * End-to-end coverage for the forced-mode file dedupe: a session that reads one
 * file twice must end up carrying that file's content exactly once.
 *
 * The harness stub is the same shape `plugin.test.js` uses: a FakeSession that
 * really performs the `replace` surface op, so range selection, call/result
 * pairing, and the appended events are all exercised for real.
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { COMMAND, apply } from '../index.js'
import { DUPLICATE_MARKER, messageText } from '../lib/memory.js'

/**
 * A session stub performing the real surface operation a replacement asks for.
 */
class FakeSession {
  constructor(surface = [], { prices = {} } = {}) {
    this.nodes = []
    this.events = []
    this.messages = new Map()
    this.prices = prices
    this.appended = []
    for (const entry of surface) {
      this.nodes.push(entry.seq)
      this.events.push({ type: entry.type, seq: entry.seq, time: 0, data: entry.data, ...(entry.options ?? {}) })
      this.messages.set(entry.seq, entry.message)
    }
    const seqs = this.events.map(event => event.seq)
    this.nextSeq = seqs.length === 0 ? 0 : Math.max(...seqs) + 1
  }

  get surface() {
    return { nodes: this.nodes }
  }

  deriveEventMessage(event) {
    return this.messages.get(event.seq) ?? null
  }

  eventAt(seq) {
    return this.events.find(event => event.seq === seq)
  }

  snapshotEvents() {
    return [...this.events].sort((left, right) => left.seq - right.seq)
  }

  append(type, data, options) {
    const seq = this.nextSeq++
    const event = { type, seq, time: 0, data, ...(options ?? {}) }
    this.events.push(event)
    this.appended.push(event)
    const op = options?.surfaceOp
    if (op === 'append') {
      this.nodes.push(seq)
    } else if (op !== undefined && op.op === 'replace') {
      const start = this.nodes.indexOf(op.startSeq)
      const end = this.nodes.indexOf(op.endSeq)
      this.nodes.splice(start, end - start + 1, seq)
    }
    const derived = type === 'user/message' ? data : data?.message
    if (derived !== undefined) this.messages.set(seq, derived)
    return event
  }
}

/** The token meter stub: one fixed price per surface seq. */
const meterFor = session => ({
  measure: () => ({
    nodes: [...session.nodes, ...session.appended.map(event => event.seq)]
      .map(seq => ({ seq, heuristicTokens: session.prices[seq] ?? 10 })),
  }),
})

/** A minimal Cordis context stand-in. */
function fakeHarness({ session } = {}) {
  const listeners = new Map()
  const commands = new Map()
  const ctx = {
    tools: { register: () => () => {} },
    commands: { register: definition => { commands.set(definition.name, definition); return () => {} } },
    on: (event, callback) => {
      const set = listeners.get(event) ?? new Set()
      set.add(callback)
      listeners.set(event, set)
      return () => set.delete(callback)
    },
    inject: (_deps, callback) => callback(ctx),
    get: key => (key === 'tokenMeter'
      ? (session === undefined ? undefined : meterFor(session))
      : undefined),
    sessions: { get: () => session },
    llm: { stream: () => ({}) },
    systemPrompt: { variable: () => () => {}, section: () => () => {} },
    logger: { warn: () => {} },
  }
  return { ctx, commands, listeners }
}

/** Run the plugin's `agent/pre-step` listener once. */
async function runPreStep(listeners, session) {
  const callbacks = listeners.get('agent/pre-step')
  assert.ok(callbacks instanceof Set, 'the plugin registered an agent/pre-step listener')
  return callbacks.values().next().value(
    { agent: { session }, signal: { aborted: false } },
    () => Promise.resolve({ kind: 'enter' }),
  )
}

const block = (text) => [{ type: 'text', text }]
const systemMessage = (id, text) => ({ id, role: 'system', source: { kind: 'system-prompt' }, content: block(text) })
const userMessage = (id, text) => ({ id, role: 'user', source: { kind: 'user' }, content: block(text) })
const assistantRead = (id, callId, path) => ({
  id,
  role: 'assistant',
  source: { kind: 'model', provider: 'p', model: 'm' },
  content: [{ type: 'tool-call', id: callId, name: 'read', arguments: JSON.stringify({ file_path: path }) }],
})
const assistantText = (id, text) => ({
  id,
  role: 'assistant',
  source: { kind: 'model', provider: 'p', model: 'm' },
  content: block(text),
})
const toolMessage = (id, callId, text) => ({
  id,
  role: 'tool',
  source: { kind: 'tool', callId },
  toolCallId: callId,
  content: block(text),
})

/**
 * A log where one file is read twice, with filler afterwards so both reads have
 * aged out of the retained tail.
 */
function twoReads({ path = '/repo/a.js', first = 'A'.repeat(300), second = 'A'.repeat(300) } = {}) {
  return [
    { seq: 0, type: 'system/message', message: systemMessage('s1', 'prompt'), data: systemMessage('s1', 'prompt') },
    { seq: 1, type: 'user/message', message: userMessage('u1', 'go'), data: userMessage('u1', 'go') },
    { seq: 2, type: 'assistant/message', message: assistantRead('a1', 'c1', path), data: { turn: 1, step: 1, message: assistantRead('a1', 'c1', path) } },
    { seq: 3, type: 'tool/result', message: toolMessage('r1', 'c1', first), data: { turn: 1, step: 1, message: toolMessage('r1', 'c1', first) } },
    { seq: 4, type: 'assistant/message', message: assistantText('a2', 'again'), data: { message: assistantText('a2', 'again') } },
    { seq: 5, type: 'assistant/message', message: assistantRead('a3', 'c2', path), data: { turn: 1, step: 2, message: assistantRead('a3', 'c2', path) } },
    { seq: 6, type: 'tool/result', message: toolMessage('r2', 'c2', second), data: { turn: 1, step: 2, message: toolMessage('r2', 'c2', second) } },
    { seq: 7, type: 'assistant/message', message: assistantText('a4', 'done'), data: { message: assistantText('a4', 'done') } },
    { seq: 8, type: 'user/message', message: userMessage('u2', 'next'), data: userMessage('u2', 'next') },
  ]
}

/** Build a session from the two-read fixture. */
const twoReadSession = (options) => new FakeSession(twoReads(options))

/**
 * Every message the model would actually see, in surface order.
 *
 * Read through the session's own derivation rather than the raw event data: a
 * replacement node carries its content in a new event, so the event that is on
 * the surface now is the one that counts.
 */
function surfaceMessages(session) {
  const derived = []
  for (const seq of session.nodes) {
    const event = session.eventAt(seq)
    if (event === undefined) continue
    const message = session.deriveEventMessage(event)
    if (message !== null && message !== undefined) derived.push({ seq, event, message })
  }
  return derived
}

/** Every tool result the model would see, oldest first. */
function surfaceResults(session) {
  return surfaceMessages(session).filter(entry => entry.message.role === 'tool')
}

describe('forced-mode file dedupe', () => {
  it('retires the older copy and keeps the newest', async () => {
    const session = twoReadSession()
    const { ctx, listeners } = fakeHarness({ session })
    apply(ctx, { enabledByDefault: true, retainRecentMessages: 3 })
    await runPreStep(listeners, session)

    const results = surfaceResults(session)
    assert.equal(results.length, 2, 'both results are still on the surface, one of them as a marker')
    const marked = results.filter(entry => messageText(entry.message).includes(DUPLICATE_MARKER))
    assert.equal(marked.length, 1, 'exactly one copy became a marker')
    const kept = results.filter(entry => !messageText(entry.message).includes(DUPLICATE_MARKER))
    assert.equal(kept.length, 1)
    assert.equal(messageText(kept[0].message), 'A'.repeat(300), 'the newest copy is intact')

    /*
     * The retirement names the copy it shadowed: durable seq 3 is the older read,
     * the marker node now standing in its place. The survivor keeps its own seq.
     */
    const prune = session.appended.filter(event => event.type === 'compaction/prune')
    assert.equal(prune.length, 1, 'the retirement is priced for the context meter')
    assert.deepEqual(prune[0].data.shadowedSeqs, [3])
    assert.equal(kept[0].seq, 6, 'the newest copy keeps its own node')
  })

  it('leaves the call/result pair intact', async () => {
    const session = twoReadSession()
    const { ctx, listeners } = fakeHarness({ session })
    apply(ctx, { enabledByDefault: true, retainRecentMessages: 3 })
    await runPreStep(listeners, session)

    /* The assistant call that asked for the retired copy is still visible, directly before it. */
    const visible = surfaceMessages(session)
    const retiredAt = visible.findIndex(entry => messageText(entry.message).includes(DUPLICATE_MARKER))
    assert.ok(retiredAt > 0, 'the retired copy is on the surface')
    const call = visible[retiredAt - 1].message
    assert.equal(call.role, 'assistant')
    assert.ok(
      call.content.some(part => part.type === 'tool-call' && part.id === 'c1'),
      'the call for the retired result is still on the surface',
    )
  })

  it('appends one altered-memory note that does not claim the agent called it', async () => {
    const session = twoReadSession()
    const { ctx, listeners } = fakeHarness({ session })
    apply(ctx, { enabledByDefault: true, retainRecentMessages: 3 })
    await runPreStep(listeners, session)

    const notes = session.appended.filter(event => event.type === 'user/message')
    assert.equal(notes.length, 1, 'exactly one note')
    const text = messageText(notes[0].data)
    assert.match(text, /^rwm-\d+-/, 'the note is a citable rwm- memory')
    assert.match(text, /a\.js/, 'the note names the file')
    assert.match(text, /not a tool call you made/, 'the note does not frame the retirement as the agent\u2019s own call')
    assert.deepEqual(notes[0].surfaceOp, 'append')
  })

  it('is idempotent across repeated passes', async () => {
    const session = twoReadSession()
    const { ctx, listeners } = fakeHarness({ session })
    apply(ctx, { enabledByDefault: true, retainRecentMessages: 3 })
    await runPreStep(listeners, session)
    const after = session.appended.length
    await runPreStep(listeners, session)
    await runPreStep(listeners, session)
    assert.equal(session.appended.length, after, 'later passes change nothing')
  })

  it('does nothing while the session is not forced', async () => {
    const session = twoReadSession()
    const { ctx, listeners } = fakeHarness({ session })
    apply(ctx, { retainRecentMessages: 3 })
    await runPreStep(listeners, session)
    assert.equal(session.appended.length, 0, 'no automatic pass without forced mode')
  })

  it('starts working when /rwm enable turns the pass on', async () => {
    const session = twoReadSession()
    const { ctx, listeners, commands } = fakeHarness({ session })
    apply(ctx, { retainRecentMessages: 3 })
    await runPreStep(listeners, session)
    assert.equal(session.appended.length, 0)

    await commands.get(COMMAND).handler({ agent: { session }, rawInput: 'enable' })
    await runPreStep(listeners, session)
    assert.ok(session.appended.length > 0, 'forced mode retires the duplicate')
  })

  it('stops when /rwm disable turns the pass off', async () => {
    const session = twoReadSession()
    const { ctx, listeners, commands } = fakeHarness({ session })
    apply(ctx, { enabledByDefault: true, retainRecentMessages: 3 })
    await commands.get(COMMAND).handler({ agent: { session }, rawInput: 'disable' })
    await runPreStep(listeners, session)
    assert.equal(session.appended.length, 0)
  })

  it('can be turned off by configuration', async () => {
    const session = twoReadSession()
    const { ctx, listeners } = fakeHarness({ session })
    apply(ctx, { enabledByDefault: true, retainRecentMessages: 3, dedupeFileReads: false })
    await runPreStep(listeners, session)
    /* The generic trimming still runs; nothing is retired as a duplicate. */
    const marked = surfaceResults(session).filter(entry => messageText(entry.message).includes(DUPLICATE_MARKER))
    assert.equal(marked.length, 0)
    assert.equal(session.appended.filter(event => event.type === 'user/message').length, 0)
  })

  it('keeps two distinct files on the surface', async () => {
    const entries = twoReads({ path: '/repo/a.js' })
    entries[5] = {
      seq: 5,
      type: 'assistant/message',
      message: assistantRead('a3', 'c2', '/repo/other.js'),
      data: { turn: 1, step: 2, message: assistantRead('a3', 'c2', '/repo/other.js') },
    }
    const session = new FakeSession(entries)
    const { ctx, listeners } = fakeHarness({ session })
    apply(ctx, { enabledByDefault: true, retainRecentMessages: 3 })
    await runPreStep(listeners, session)

    const marked = surfaceResults(session).filter(entry => messageText(entry.message).includes(DUPLICATE_MARKER))
    assert.equal(marked.length, 0, 'a read of another file is not a duplicate')
  })
})
