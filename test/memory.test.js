import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  DEFAULTS,
  MEMORY_PREFIX,
  buildMemoryMessage,
  nextMemoryNumber,
  collectSurfaceEntries,
  findPendingRewrite,
  groupSpans,
  isReplacementCopy,
  isRewriteApplied,
  isStubbedContent,
  messageText,
  planMemoryFold,
  resolveConfig,
  selectFoldRange,
  stubToolResultContent,
} from '../lib/memory.js'

/** One assistant message carrying a thought and a command. */
function assistant({ id = 'a1', content }) {
  return { id, role: 'assistant', source: { kind: 'model', provider: 'p', model: 'm' }, content }
}

/** One tool-role message answering `callId`. */
function toolResult({ id = 'r1', callId = 'c1', content, isError }) {
  return {
    id,
    role: 'tool',
    source: { kind: 'tool', callId },
    toolCallId: callId,
    ...(isError === undefined ? {} : { isError }),
    content,
  }
}

/** One user message. */
function user({ id = 'u1', content = [{ type: 'text', text: 'hi' }] }) {
  return { id, role: 'user', source: { kind: 'user' }, content }
}

/** One system message. */
function system({ id = 's1', content = [{ type: 'text', text: 'prompt' }] }) {
  return { id, role: 'system', source: { kind: 'system-prompt' }, content }
}

const call = (id) => ({ type: 'tool-call', id, name: 'bash', arguments: '{"command":"ls"}' })

describe('nextMemoryNumber', () => {
  const node = (seq, n) => ({ type: 'user/message', seq, time: 0, data: buildMemoryMessage('x', n, `id-${seq}`) })

  it('starts at one and follows the highest number in the log', () => {
    assert.equal(nextMemoryNumber([]), 1)
    assert.equal(nextMemoryNumber([node(0, 1)]), 2)
    assert.equal(nextMemoryNumber([node(0, 1), node(5, 4), node(9, 2)]), 5)
  })

  it('ignores ordinary user messages', () => {
    assert.equal(nextMemoryNumber([{ type: 'user/message', seq: 0, time: 0, data: user({}) }]), 1)
  })
})

describe('resolveConfig', () => {
  it('fills every default', () => {
    assert.deepEqual(resolveConfig(undefined), DEFAULTS)
  })

  it('rejects unknown keys and out-of-range values', () => {
    assert.throws(() => resolveConfig({ nope: 1 }), /unknown config key "nope"/)
    assert.throws(() => resolveConfig({ retainRecentMessages: 0 }), /"retainRecentMessages" must be/)
    assert.throws(() => resolveConfig({ autoStubToolResults: 'yes' }), /"autoStubToolResults" must be a boolean/)
  })
})

describe('buildMemoryMessage', () => {
  it('produces a numbered user message carrying the rwm- prefix', () => {
    const message = buildMemoryMessage('did the thing', 3, 'id-1')
    assert.equal(message.id, 'id-1')
    assert.equal(message.role, 'user')
    assert.deepEqual(message.source, { kind: 'user' })
    assert.equal(messageText(message), `${MEMORY_PREFIX}3-did the thing`)
  })
})

describe('stubToolResultContent', () => {
  it('replaces output text with a recall marker', () => {
    const built = stubToolResultContent([{ type: 'text', text: 'x'.repeat(500) }], resolveConfig())
    assert.equal(built.omittedChars, 500)
    assert.match(built.content[0].text, /tool output omitted: 500 chars/)
  })

  it('preserves non-text blocks', () => {
    const built = stubToolResultContent(
      [{ type: 'text', text: 'y'.repeat(100) }, { type: 'image', attachment: { id: 'i' } }],
      resolveConfig(),
    )
    assert.equal(built.content[1].type, 'image')
  })

  it('is idempotent: an already-stubbed output is left alone', () => {
    const config = resolveConfig()
    const first = stubToolResultContent([{ type: 'text', text: 'z'.repeat(300) }], config)
    assert.equal(isStubbedContent(first.content), true)
    assert.equal(stubToolResultContent(first.content, config), null)
  })
})

describe('groupSpans', () => {
  it('fuses an assistant call with every result that answers it', () => {
    const entries = [
      { seq: 0, message: user({}) },
      { seq: 1, message: assistant({ content: [call('c1'), call('c2')] }) },
      { seq: 2, message: toolResult({ callId: 'c1' }) },
      { seq: 3, message: toolResult({ callId: 'c2' }) },
      { seq: 4, message: assistant({ content: [{ type: 'text', text: 'done' }] }) },
    ]
    assert.deepEqual(groupSpans(entries), [
      { start: 0, end: 0 },
      { start: 1, end: 3 },
      { start: 4, end: 4 },
    ])
  })
})

describe('selectFoldRange', () => {
  const spans = [{ start: 0, end: 0 }, { start: 1, end: 3 }, { start: 4, end: 5 }, { start: 6, end: 6 }]

  it('returns only whole spans inside the bounds', () => {
    assert.deepEqual(selectFoldRange(spans, 0, 5), { startIndex: 0, endIndex: 5 })
  })

  it('never splits the span straddling the left bound', () => {
    assert.deepEqual(selectFoldRange(spans, 1, 5), { startIndex: 1, endIndex: 5 })
  })

  it('never splits the span straddling the right bound', () => {
    assert.deepEqual(selectFoldRange(spans, 0, 4), { startIndex: 0, endIndex: 3 })
  })

  it('returns null when no whole span fits', () => {
    assert.equal(selectFoldRange(spans, 2, 3), null)
  })
})

describe('planMemoryFold', () => {
  /** system, user, assistant+result, assistant, user */
  const entries = [
    { seq: 0, message: system({}) },
    { seq: 1, message: user({}) },
    { seq: 2, message: assistant({ content: [call('c1')] }) },
    { seq: 3, message: toolResult({ callId: 'c1' }) },
    { seq: 4, message: assistant({ content: [{ type: 'text', text: 'done' }] }) },
    { seq: 5, message: user({ id: 'u2' }) },
  ]

  it('keeps the system head and the requested tail', () => {
    /* keep 3 leaves the last three messages; the call/result group at 2-3 straddles the bound. */
    const plan = planMemoryFold(entries, 3)
    assert.deepEqual(plan.shadowedSeqs, [1])
  })

  it('keeps a call and its result together', () => {
    /* keep 2 puts the bound inside the group, so the group joins the fold whole. */
    const plan = planMemoryFold(entries, 2)
    assert.deepEqual(plan.shadowedSeqs, [1, 2, 3])
  })

  it('returns null when the tail already covers everything foldable', () => {
    assert.equal(planMemoryFold(entries, 6), null)
  })

  it('never folds a leading system prompt', () => {
    const plan = planMemoryFold(entries, 1)
    assert.equal(plan.shadowedSeqs.includes(0), false)
  })
})

describe('findPendingRewrite', () => {
  const rewriteCall = (callId, args) => ({
    type: 'tool/call',
    seq: 1,
    time: 0,
    data: { turn: 1, step: 1, callId, name: 'rewrite_memory', arguments: JSON.stringify(args) },
  })
  const rewriteResult = (callId, isError) => ({
    type: 'tool/result',
    seq: 2,
    time: 0,
    data: { turn: 1, step: 1, message: { toolCallId: callId, isError: isError === true } },
  })
  const session = events => ({ snapshotEvents: () => events })

  it('takes the newest valid intent', () => {
    const events = [
      rewriteCall('c1', { memory: 'first' }), rewriteResult('c1', false),
      rewriteCall('c2', { memory: 'second', keep_recent_messages: 3 }), rewriteResult('c2', false),
    ]
    const pending = findPendingRewrite(session(events))
    assert.equal(pending.memory, 'second')
    assert.equal(pending.keepRecent, 3)
  })

  it('ignores failed calls, empty memory, and other tools', () => {
    assert.equal(findPendingRewrite(session([rewriteCall('c1', { memory: 'x' }), rewriteResult('c1', true)])), null)
    assert.equal(findPendingRewrite(session([rewriteCall('c1', { memory: '' })])), null)
    assert.equal(findPendingRewrite(session([{
      type: 'tool/call', seq: 1, time: 0,
      data: { callId: 'c1', name: 'bash', arguments: '{"memory":"x"}' },
    }])), null)
  })
})

describe('isRewriteApplied', () => {
  const replacement = (seq, text) => ({ type: 'user/message', seq, time: 0, data: buildMemoryMessage(text, 9, `id-${seq}`) })
  const session = (events, nodes) => ({
    surface: { nodes },
    eventAt: seq => events.find(event => event.seq === seq),
  })

  it('detects a checkpoint appended after the call, whatever number it took', () => {
    const events = [replacement(9, 'note')]
    assert.equal(isRewriteApplied(session(events, [9]), 5, 'note'), true)
  })

  it('ignores a checkpoint that predates the call', () => {
    const events = [replacement(3, 'note')]
    assert.equal(isRewriteApplied(session(events, [3]), 5, 'note'), false)
  })

  it('ignores a checkpoint with different text', () => {
    const events = [replacement(9, 'other')]
    assert.equal(isRewriteApplied(session(events, [9]), 5, 'note'), false)
  })

  it('treats regex metacharacters in a memory as literals', () => {
    const events = [replacement(9, 'a.b(c)')]
    assert.equal(isRewriteApplied(session(events, [9]), 5, 'a.b(c)'), true)
    assert.equal(isRewriteApplied(session(events, [9]), 5, 'axb(c)'), false)
  })
})

describe('collectSurfaceEntries', () => {
  it('keeps sequence numbers in model-visible order', () => {
    const events = new Map([
      [4, { type: 'user/message', seq: 4, time: 0, data: user({ id: 'dropped' }) }],
      [7, { type: 'user/message', seq: 7, time: 0, data: user({ id: 'x' }) }],
    ])
    const entries = collectSurfaceEntries({
      surface: { nodes: [4, 7] },
      eventAt: seq => events.get(seq),
      deriveEventMessage: event => (event.seq === 4 ? null : event.data),
    })
    assert.deepEqual(entries, [{ seq: 7, message: user({ id: 'x' }) }])
  })

  it('returns nothing when the session cannot derive its own surface', () => {
    assert.deepEqual(collectSurfaceEntries({ surface: { nodes: [0] } }), [])
  })
})

