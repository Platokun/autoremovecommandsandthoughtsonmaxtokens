import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { ACCESS_TOOL, COMMAND, apply, inject, name } from '../index.js'
import { MEMORY_PREFIX } from '../lib/memory.js'

/**
 * A session stub that performs the real surface operation a replacement asks
 * for: a `replace` shadows the named range and splices the new node into its
 * place. That is enough to exercise the plugin's range selection and its
 * call/result grouping end to end.
 */
class FakeSession {
  constructor(surface, { seedEvents = [], prices = {} } = {}) {
    this.nodes = []
    this.events = []
    this.messages = new Map()
    this.prices = prices
    this.appended = []
    for (const entry of surface) {
      this.nodes.push(entry.seq)
      this.events.push({ type: entry.type, seq: entry.seq, time: 0, data: entry.data })
      this.messages.set(entry.seq, entry.message)
    }
    for (const event of seedEvents) this.events.push(event)
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
    /* A real Session returns its log in ascending seq order; keep that true. */
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

/** The token meter stub: one fixed-heuristic price per surface seq. */
const meterFor = session => ({
  measure: () => ({
    nodes: [...session.nodes, ...session.appended.map(event => event.seq)]
      .map(seq => ({ seq, heuristicTokens: session.prices[seq] ?? 10 })),
  }),
})

/** A minimal Cordis context stand-in. */
function fakeHarness({ session, meter } = {}) {
  const tools = new Map()
  const listeners = new Map()
  const sections = []
  const variables = new Map()
  const commands = new Map()
  const ctx = {
    tools: { register: definition => { tools.set(definition.name, definition); return () => tools.delete(definition.name) } },
    commands: { register: definition => { commands.set(definition.name, definition); return () => commands.delete(definition.name) } },
    on: (event, callback) => { listeners.set(event, callback); return () => listeners.delete(event) },
    inject: (_deps, callback) => callback(ctx),
    get: key => (key === 'tokenMeter' ? (meter ?? (session === undefined ? undefined : meterFor(session))) : undefined),
    sessions: { get: () => session },
    llm: { stream: () => ({}) },
    systemPrompt: {
      variable: (key, provider) => { variables.set(key, provider); return () => {} },
      section: section => { sections.push(section); return () => {} },
    },
    logger: { warn: () => {} },
  }
  return { ctx, tools, commands, listeners, sections, variables }
}

const block = (text) => [{ type: 'text', text }]
const assistantText = (id, text) => ({ id, role: 'assistant', source: { kind: 'model', provider: 'p', model: 'm' }, content: block(text) })
const assistantCall = (id, callId) => ({
  id,
  role: 'assistant',
  source: { kind: 'model', provider: 'p', model: 'm' },
  content: [{ type: 'tool-call', id: callId, name: 'bash', arguments: '{"command":"ls"}' }],
})
const toolMessage = (id, callId, text, isError) => ({
  id,
  role: 'tool',
  source: { kind: 'tool', callId },
  toolCallId: callId,
  ...(isError === undefined ? {} : { isError }),
  content: block(text),
})
const userMessage = (id, text) => ({ id, role: 'user', source: { kind: 'user' }, content: block(text) })
const systemMessage = (id, text) => ({ id, role: 'system', source: { kind: 'system-prompt' }, content: block(text) })

/**
 * A realistic log: seq 3 is the `tool/call` the loop appends before dispatch.
 * It never joins the surface, so the surface is [0, 1, 2, 4, 5, 6].
 */
function conversation({ longOutput = 'x'.repeat(400), isError } = {}) {
  return {
    surface: [
      { seq: 0, type: 'system/message', message: systemMessage('s1', 'prompt'), data: systemMessage('s1', 'prompt') },
      { seq: 1, type: 'user/message', message: userMessage('u1', 'go'), data: userMessage('u1', 'go') },
      { seq: 2, type: 'assistant/message', message: assistantCall('a1', 'c1'), data: { message: assistantCall('a1', 'c1') } },
      {
        seq: 4,
        type: 'tool/result',
        message: toolMessage('r1', 'c1', longOutput, isError),
        data: { turn: 1, step: 1, message: toolMessage('r1', 'c1', longOutput, isError) },
      },
      { seq: 5, type: 'assistant/message', message: assistantText('a2', 'done'), data: { message: assistantText('a2', 'done') } },
      { seq: 6, type: 'user/message', message: userMessage('u2', 'next'), data: userMessage('u2', 'next') },
    ],
    logOnly: [{ type: 'tool/call', seq: 3, time: 0, data: { turn: 1, step: 1, callId: 'c1', name: 'bash', arguments: '{"command":"ls"}' } }],
  }
}

/** Build a stub session from the fixture. */
function makeSession({ longOutput, isError, seeds = [], prices } = {}) {
  const conv = conversation({ longOutput, isError })
  return new FakeSession(conv.surface, { seedEvents: [...conv.logOnly, ...seeds], prices })
}

/** Seed a durable, already-finished `rewrite_memory` call. */
function rewriteCall(memory, keep, seq = 7, callId = 'rc1') {
  return {
    type: 'tool/call',
    seq,
    time: 0,
    data: {
      turn: 1,
      step: 1,
      callId,
      name: 'rewrite_memory',
      arguments: JSON.stringify({ memory, ...(keep === undefined ? {} : { keep_recent_messages: keep }) }),
    },
  }
}

/** Run the plugin's `agent/pre-step` listener once. */
async function runPreStep(listeners, session) {
  const listener = listeners.get('agent/pre-step')
  assert.ok(listener, 'the plugin registered an agent/pre-step listener')
  return listener({ agent: { session }, signal: { aborted: false } }, () => Promise.resolve({ kind: 'enter' }))
}

describe('plugin surface', () => {
  it('declares its identity and required services', () => {
    assert.equal(name, 'dsh-autotrim-context')
    assert.deepEqual([...inject].sort(), ['llm', 'sessions', 'tools'])
  })

  it('registers both tools, the policy section, and the pre-step hook', () => {
    const { ctx, tools, sections, variables, listeners } = fakeHarness()
    apply(ctx, { enabledByDefault: true })
    assert.deepEqual([...tools.keys()].sort(), ['rewrite_memory', 'rwm_access'])
    assert.equal(sections.length, 1)
    assert.equal(sections[0].name, 'autotrim:policy')
    assert.match(sections[0].text, /rwm-<n>-/)
    assert.match(sections[0].text, /rwm_access/)
    assert.ok(listeners.has('agent/pre-step'))
  })

  it('rejects an unknown config key at activation', () => {
    const { ctx } = fakeHarness()
    assert.throws(() => apply(ctx, { nope: true }), /unknown config key/)
  })
})

describe('rewrite_memory tool', () => {
  it('previews the fold it will land', async () => {
    const session = makeSession()
    const { ctx, tools } = fakeHarness({ session })
    apply(ctx, { enabledByDefault: true })
    const value = await tools.get('rewrite_memory').execute(
      { memory: 'note', keep_recent_messages: 2 },
      { agent: { session } },
    )
    assert.equal(value.applied, true)
    assert.match(value.summary, /3 older message\(s\)/)
    assert.match(value.summary, /rwm-<n>/)
  })

  it('reports honestly when the tail already covers everything', async () => {
    const session = makeSession()
    const { ctx, tools } = fakeHarness({ session })
    apply(ctx, { enabledByDefault: true })
    const value = await tools.get('rewrite_memory').execute(
      { memory: 'note', keep_recent_messages: 99 },
      { agent: { session } },
    )
    assert.equal(value.applied, false)
    assert.match(value.summary, /Nothing to replace/)
  })

  it('rejects a missing memory and a keep below one', async () => {
    const session = makeSession()
    const { ctx, tools } = fakeHarness({ session })
    apply(ctx, { enabledByDefault: true })
    const rewrite = tools.get('rewrite_memory')
    await assert.rejects(() => rewrite.execute({ memory: '' }, { agent: { session } }), /"memory" must be/)
    await assert.rejects(
      () => rewrite.execute({ memory: 'x', keep_recent_messages: 0 }, { agent: { session } }),
      /at least 1/,
    )
  })
})

describe('durable memory rewrite', () => {
  it('replaces the retired range with one rwm- node plus its shadow price', async () => {
    const session = makeSession({ seeds: [rewriteCall('short note', 2)] })
    const { ctx, listeners } = fakeHarness({ session })
    apply(ctx, { enabledByDefault: true })
    await runPreStep(listeners, session)

    const prune = session.appended[0]
    assert.equal(prune.type, 'compaction/prune')
    assert.deepEqual(prune.data.shadowedRange, { start: 1, end: 4 })
    assert.deepEqual(prune.data.shadowedSeqs, [1, 2, 4])
    assert.equal(prune.data.shadowedTokenCount, 30)

    const replacement = session.appended[1]
    assert.equal(replacement.type, 'user/message')
    assert.deepEqual(replacement.surfaceOp, { op: 'replace', startSeq: 1, endSeq: 4 })
    assert.deepEqual(replacement.sourceEventSeqs, [1, 2, 4])
    assert.equal(replacement.data.content[0].text, `${MEMORY_PREFIX}1-short note`)

    assert.deepEqual(session.nodes, [0, 9, 5, 6], 'the system head and the retained tail survive')
  })

  it('is idempotent across repeated pre-step passes', async () => {
    const session = makeSession({ seeds: [rewriteCall('short note', 2)] })
    const { ctx, listeners } = fakeHarness({ session })
    apply(ctx, { enabledByDefault: true })
    await runPreStep(listeners, session)
    const afterFirst = session.appended.length
    await runPreStep(listeners, session)
    await runPreStep(listeners, session)
    assert.equal(session.appended.length, afterFirst, 'no second replacement is appended')
  })

  it('does nothing without a pending call', async () => {
    const session = makeSession()
    const { ctx, listeners } = fakeHarness({ session })
    apply(ctx, { enabledByDefault: true })
    await runPreStep(listeners, session)
    assert.equal(session.appended.length, 0)
  })

  it('leaves the system head out of the fold', async () => {
    const session = makeSession({ seeds: [rewriteCall('everything', 1)] })
    const { ctx, listeners } = fakeHarness({ session })
    apply(ctx, { enabledByDefault: true })
    await runPreStep(listeners, session)
    assert.equal(session.nodes.includes(0), true)
    assert.equal(session.appended[0].data.shadowedSeqs.includes(0), false)
  })
})

describe('durable tool-output trimming', () => {
  it('rewrites only the content of a retired tool result', async () => {
    const session = makeSession()
    const { ctx, listeners } = fakeHarness({ session })
    apply(ctx, { enabledByDefault: true, retainRecentMessages: 2 })
    await runPreStep(listeners, session)

    assert.equal(session.appended.length, 2)
    const [prune, replacement] = session.appended
    assert.equal(prune.type, 'compaction/prune')
    assert.deepEqual(prune.data.shadowedSeqs, [4])
    assert.equal(prune.data.shadowedTokenCount, 10)
    assert.equal(replacement.type, 'tool/result')
    assert.deepEqual(replacement.surfaceOp, { op: 'replace', startSeq: 4, endSeq: 4 })
    assert.deepEqual(replacement.sourceEventSeqs, [4])
    assert.match(replacement.data.message.content[0].text, /tool output omitted/)
    const original = session.eventAt(4)
    assert.deepEqual(
      { ...replacement.data, message: null },
      { ...original.data, message: null },
      'every field except the message content is preserved verbatim',
    )
    assert.deepEqual(session.nodes, [0, 1, 2, 8, 5, 6], 'the call and its result stay paired')
  })

  it('keeps a failed result intact', async () => {
    const session = makeSession({ isError: true })
    const { ctx, listeners } = fakeHarness({ session })
    apply(ctx, { enabledByDefault: true, retainRecentMessages: 2 })
    await runPreStep(listeners, session)
    assert.equal(session.appended.length, 0)
  })

  it('keeps the retained tail untouched', async () => {
    const session = makeSession()
    const { ctx, listeners } = fakeHarness({ session })
    apply(ctx, { enabledByDefault: true, retainRecentMessages: 4 })
    await runPreStep(listeners, session)
    assert.equal(session.appended.length, 0, 'a 6-message history with a 4-message tail retires nothing')
  })

  it('can be turned off', async () => {
    const session = makeSession()
    const { ctx, listeners } = fakeHarness({ session })
    apply(ctx, { enabledByDefault: true, retainRecentMessages: 2, autoStubToolResults: false })
    await runPreStep(listeners, session)
    assert.equal(session.appended.length, 0)
  })
})

describe('context_recall tool', () => {
  it('grants a citation whose reasoning the content supports', async () => {
    const session = makeSession()
    const { ctx, tools } = fakeHarness({ session })
    apply(ctx, { enabledByDefault: true })
    const value = await tools.get('rwm_access').execute(
      { citations: '3', reason: 'I want to see what the listing command printed' },
      { agent: { session } },
    )
    assert.equal(value.granted, true)
    assert.match(value.text, /"command":"ls"/, 'the call arguments come back')
    assert.match(value.text, /--- 3\.out \(output\) ---/, 'so does the output that answered it')
    assert.ok(value.chars > 0)
  })

  it('refuses a citation whose reasoning names something the content lacks', async () => {
    const session = makeSession()
    const { ctx, tools } = fakeHarness({ session })
    apply(ctx, { enabledByDefault: true })
    const value = await tools.get('rwm_access').execute(
      { citations: '3', reason: 'I need the 1999 archive rows' },
      { agent: { session } },
    )
    assert.equal(value.granted, false)
    assert.match(value.text, /Refused/)
    assert.match(value.text, /1999/)
    assert.match(value.lock, /reasoning lock|only mentions/i)
  })

  it('requires a reason and a usable citation list', async () => {
    const session = makeSession()
    const { ctx, tools } = fakeHarness({ session })
    apply(ctx, { enabledByDefault: true })
    const access = tools.get('rwm_access')
    await assert.rejects(() => access.execute({ citations: '2' }, { agent: { session } }), /"reason" must be non-empty/)
    const bad = await access.execute({ citations: 'banana', reason: 'need it' }, { agent: { session } })
    assert.equal(bad.granted, false)
    assert.match(bad.text, /not a citation/)
  })

  it('turns the feature off by default and back on with the command', async () => {
    const session = makeSession({ seeds: [rewriteCall('short note', 2)] })
    const { ctx, listeners, commands } = fakeHarness({ session })
    apply(ctx, {})
    const command = commands.get(COMMAND)
    assert.ok(command, 'the /rwm command is registered')
    assert.match(command.handler({ agent: { session }, rawInput: 'status' }).text, /disabled/)
    await runPreStep(listeners, session)
    assert.equal(session.appended.length, 0, 'a disabled session is left alone')

    assert.equal(command.handler({ agent: { session }, rawInput: 'enable' }).kind, 'success')
    assert.match(command.handler({ agent: { session }, rawInput: 'status' }).text, /enabled/)
    await runPreStep(listeners, session)
    assert.equal(session.appended.length, 2, 'an enabled session folds')

    assert.equal(command.handler({ agent: { session }, rawInput: 'disable' }).kind, 'success')
    assert.equal(command.handler({ agent: { session }, rawInput: 'nonsense' }).kind, 'error')
  })

  it('fails clearly without a session', async () => {
    const { ctx, tools } = fakeHarness()
    apply(ctx, { enabledByDefault: true })
    await assert.rejects(
      () => tools.get('rwm_access').execute({ citations: '1', reason: 'x' }, {}),
      /no live session/,
    )
  })
})
