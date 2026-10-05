import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  buildIndex,
  chunkText,
  citedNumbers,
  judge,
  parseCitations,
  parseMemory,
  reasoningLock,
  renderIndex,
  resolveCitations,
  salientTokens,
} from '../lib/history.js'
import { buildMemoryMessage } from '../lib/memory.js'

const user = (seq, text) => ({ type: 'user/message', seq, time: 0, data: { id: `u${seq}`, role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text }] } })
const agent = (seq, blocks) => ({
  type: 'assistant/message',
  seq,
  time: 0,
  data: {
    message: { id: `a${seq}`, role: 'assistant', source: { kind: 'model', provider: 'p', model: 'm' }, content: blocks },
  },
})
const call = (seq, callId, name, args) => ({ type: 'tool/call', seq, time: 0, data: { turn: 1, step: 1, callId, name, arguments: args } })
const result = (seq, callId, text) => ({
  type: 'tool/result',
  seq,
  time: 0,
  data: { turn: 1, step: 1, message: { id: `r${seq}`, role: 'tool', source: { kind: 'tool', callId }, toolCallId: callId, content: [{ type: 'text', text }] } },
})
const memory = (seq, n, context) => ({ type: 'user/message', seq, time: 0, data: buildMemoryMessage(context, n, `m${seq}`) })

describe('parseMemory', () => {
  it('reads the number and context', () => {
    assert.deepEqual(parseMemory('rwm-3-did the thing'), { number: 3, context: 'did the thing' })
  })

  it('rejects anything else', () => {
    assert.equal(parseMemory('rwm-abc-x'), null)
    assert.equal(parseMemory('see rwm-3-x'), null)
    assert.equal(parseMemory(''), null)
  })
})

describe('chunkText', () => {
  it('splits paragraphs on blank lines', () => {
    assert.deepEqual(chunkText('one\n\ntwo\n\n\nthree'), ['one', 'two', 'three'])
  })

  it('splits a list into individually citable items', () => {
    assert.deepEqual(chunkText('- first thing\n- second thing\n- third thing'), ['- first thing', '- second thing', '- third thing'])
  })

  it('splits on every newline, one chunk per line', () => {
    assert.deepEqual(chunkText('a sentence\nthat continues'), ['a sentence', 'that continues'])
  })

  it('turns a line-per-thought bubble into one chunk per thought', () => {
    /* The real case: a plan written as one action per line, no blank lines. */
    const thought = [
      'The user wants a clone and build.',
      'First let me check git log and status.',
      'Read the README.',
      'Check global.json for the dotnet version.',
      'Let me run these in parallel.',
    ].join('\n')
    assert.deepEqual(chunkText(thought), [
      'The user wants a clone and build.',
      'First let me check git log and status.',
      'Read the README.',
      'Check global.json for the dotnet version.',
      'Let me run these in parallel.',
    ])
  })

  it('drops blank lines rather than emitting empty chunks', () => {
    assert.deepEqual(chunkText('one\n\n\ntwo\n   \nthree'), ['one', 'two', 'three'])
  })
})

describe('buildIndex', () => {
  const events = [
    user(0, 'go'),
    agent(1, [{ type: 'reasoning', text: 'thinking\n\nmore thinking' }, { type: 'text', text: 'answer' }]),
    call(2, 'c1', 'bash', '{"command":"ls"}'),
    result(3, 'c1', 'output'),
    memory(4, 1, 'note'),
    user(5, 'again'),
    { type: 'tool/result', seq: 6, time: 0, surfaceOp: { op: 'replace', startSeq: 3, endSeq: 3 }, sourceEventSeqs: [3], data: { turn: 1, step: 1, message: { toolCallId: 'c1', content: [{ type: 'text', text: 'stub' }] } } },
  ]

  it('numbers user, agent, and tool-call events in log order', () => {
    const index = buildIndex(events)
    assert.deepEqual(index.entries.map(entry => [entry.number, entry.kind]), [
      [1, 'user'], [2, 'agent'], [3, 'tool'], [4, 'user'],
    ])
  })

  it('gives memory nodes their own namespace, outside the plain numbering', () => {
    const index = buildIndex(events)
    assert.equal(index.memories.length, 1)
    assert.equal(index.memoryByNumber.get(1).context, 'note')
    assert.equal(index.entries.some(entry => entry.seq === 4), false)
  })

  it('chunks thoughts and text separately', () => {
    const index = buildIndex(events)
    const entry = index.byNumber.get(2)
    assert.deepEqual(entry.chunks.map(chunk => [chunk.index, chunk.kind, chunk.text]), [
      [1, 'thought', 'thinking'],
      [2, 'thought', 'more thinking'],
      [3, 'text', 'answer'],
    ])
  })

  it('skips replacement copies so originals keep their number', () => {
    const index = buildIndex(events)
    assert.equal(index.entries.some(entry => entry.seq === 6), false)
  })
})

describe('parseCitations', () => {
  it('reads numbers, ranges, chunks, and memories', () => {
    const parsed = parseCitations('1, 4-7, rwm-6, 12.3, rwm-2-full')
    assert.deepEqual(parsed.numbers, [1])
    assert.deepEqual(parsed.ranges, [{ start: 4, end: 7 }])
    assert.deepEqual(parsed.chunks, [{ number: 12, index: 3 }])
    assert.deepEqual(parsed.memories, [6, 2])
    assert.deepEqual(citedNumbers(parsed), [1, 4, 5, 6, 7, 12])
  })

  it('accepts an array form', () => {
    assert.deepEqual(parseCitations([1, 'rwm-6', '300', '321-323']).numbers, [1, 300])
  })

  it('reports an unusable token and a backwards range', () => {
    assert.match(parseCitations('1, banana').error, /not a citation/)
    assert.match(parseCitations('9-3').error, /runs backwards/)
  })
})

describe('salientTokens and the reasoning lock', () => {
  it('pulls years, file names, flags, and constants out of text', () => {
    const tokens = salientTokens('the 2023 run of build.ts used --verbose and FOO_BAR')
    assert.deepEqual(tokens, ['--verbose', '2023', 'build.ts', 'foo_bar'])
  })

  it('derives a lock that states what the content is', () => {
    assert.match(reasoningLock('records only for the 9th of September 2023.', 'rwm-2'),
      /^rwm-2: only mentions 2023; records only for the 9th of September 2023\./)
  })
})

describe('judge', () => {
  /* The case from the spec: asked for 2022, the content is all 2023. */
  const content = 'Row for 2023-09-09: naruzkurai started the stream at 18:00 UTC. Only 2023 rows exist here.'
  const lockText = `${content} Also 2023-09-10 and 2023-09-11.`

  it('refuses a request whose terms the content does not contain', () => {
    const verdict = judge('I need the data for 2022-09-09 and 2022-09-10', lockText)
    assert.equal(verdict.verdict, 'deny')
    assert.deepEqual(verdict.missing, ['2022'])
  })

  it('allows a request whose terms are present', () => {
    assert.equal(judge('I need the 2023-09-09 stream start', lockText).verdict, 'allow')
  })

  it('allows a request with no checkable terms', () => {
    const verdict = judge('I want to double check what happened', lockText)
    assert.equal(verdict.verdict, 'allow')
    assert.deepEqual(verdict.missing, [])
  })

  it('tolerates a single new term that the content simply does not mention', () => {
    assert.equal(judge('check the 2023 rows with --verbose', lockText).verdict, 'allow')
  })
})

describe('resolveCitations', () => {
  const events = [
    user(0, 'go'),
    agent(1, [{ type: 'text', text: 'para one\n\npara two' }]),
    call(2, 'c1', 'bash', '{"command":"ls"}'),
    result(3, 'c1', 'file list'),
    memory(4, 1, 'the answer'),
  ]
  const index = buildIndex(events)
  const asMemory = (seq) => buildMemoryMessage('the answer', 1, 'm')
  const withSources = [...events.slice(0, 4), { type: 'user/message', seq: 4, time: 0, sourceEventSeqs: [0, 1], surfaceOp: { op: 'replace', startSeq: 0, endSeq: 1 }, data: asMemory(4) }]

  it('resolves a message number', () => {
    const resolved = resolveCitations(index, events, parseCitations('1'))
    assert.deepEqual(resolved.items.map(item => item.text), ['go'])
  })

  it('returns a whole multi-chunk message chunk by chunk, so the agent can narrow', () => {
    const resolved = resolveCitations(index, events, parseCitations('2'))
    assert.deepEqual(resolved.items.map(item => item.label), ['2.1', '2.2'])
    assert.deepEqual(resolved.items.map(item => item.text), ['para one', 'para two'])
  })

  it('resolves one chunk', () => {
    const resolved = resolveCitations(index, events, parseCitations('2.2'))
    assert.deepEqual(resolved.items.map(item => item.text), ['para two'])
  })

  it('resolves a tool call together with the output that answered it', () => {
    const resolved = resolveCitations(index, events, parseCitations('3'))
    assert.deepEqual(resolved.items.map(item => item.kind), ['tool', 'output'])
    assert.match(resolved.items[1].text, /file list/)
  })

  it('resolves a memory to the originals it shadowed', () => {
    const memoryIndex = buildIndex(withSources)
    const resolved = resolveCitations(memoryIndex, withSources, parseCitations('rwm-1'))
    assert.deepEqual(resolved.items.map(item => item.label), ['rwm-1', 'rwm-1@0', 'rwm-1@1'])
    assert.match(resolved.items[1].text, /go/)
  })

  it('refuses a request over budget instead of truncating silently', () => {
    const resolved = resolveCitations(index, events, parseCitations('2'), { maxChars: 5 })
    assert.match(resolved.error, /over the 5 budget/)
  })

  it('warns about numbers that do not exist', () => {
    const resolved = resolveCitations(index, events, parseCitations('99'))
    assert.equal(resolved.items.length, 0)
    assert.match(resolved.warnings[0], /not a number in this history/)
  })
})

describe('renderIndex', () => {
  it('lists only what the model can no longer see', () => {
    const events = [user(0, 'visible'), user(1, 'retired'), memory(2, 1, 'note')]
    const index = buildIndex(events)
    const lines = renderIndex(index, new Set([1, 2]), 10)
    assert.deepEqual(lines, ['rwm-1 note'])
  })

  it('reports the chunk count so a line can be cited instead of the whole message', () => {
    const events = [agent(0, [{ type: 'reasoning', text: 'one\ntwo\nthree' }])]
    const index = buildIndex(events)
    assert.deepEqual(renderIndex(index, new Set(), 10), ['1 [agent] (3 chunks) one'])
  })

  it('keeps the newest entries when the limit is reached', () => {
    const events = [user(0, 'a'), user(1, 'b'), user(2, 'c')]
    const index = buildIndex(events)
    const lines = renderIndex(index, new Set(), 2)
    assert.match(lines[0], /^2 \[user\] b$/)
    assert.match(lines[1], /^3 \[user\] c$/)
  })
})
