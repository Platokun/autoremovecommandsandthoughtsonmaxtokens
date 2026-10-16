import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  DUPLICATE_MARKER,
  fileFromArguments,
  fileIdentity,
  fileLabel,
  findFileOccurrences,
  isDuplicateContent,
  planFileDedupe,
  resolveConfig,
  stubDuplicateContent,
} from '../lib/memory.js'

/** One assistant message carrying tool calls. */
function assistant({ id = 'a1', content }) {
  return { id, role: 'assistant', source: { kind: 'model', provider: 'p', model: 'm' }, content }
}

/** One tool-role message answering `callId`. */
function toolResult({ id = 'r1', callId = 'c1', content }) {
  return {
    id,
    role: 'tool',
    source: { kind: 'tool', callId },
    toolCallId: callId,
    content,
  }
}

/** One user message. */
function user({ id = 'u1' }) {
  return { id, role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'hi' }] }
}

/** One system message. */
function system({ id = 's1' }) {
  return { id, role: 'system', source: { kind: 'system-prompt' }, content: [{ type: 'text', text: 'prompt' }] }
}

/** A read tool call naming one file. */
const readCall = (id, filePath) => ({
  type: 'tool-call',
  id,
  name: 'read',
  arguments: JSON.stringify({ file_path: filePath }),
})

/** A bash call, which names no file and must never be deduped. */
const bashCall = id => ({ type: 'tool-call', id, name: 'bash', arguments: '{"command":"ls"}' })

/** Text of the first block of a content array. */
const textOf = content => content[0].text

describe('fileIdentity', () => {
  it('collapses dot segments and separators onto one identity', () => {
    assert.equal(fileIdentity('./lib/../lib/memory.js'), 'lib/memory.js')
    assert.equal(fileIdentity('lib\\memory.js'), 'lib/memory.js')
    assert.equal(fileIdentity('/a/b/c.js'), 'a/b/c.js')
  })

  it('is case-insensitive and empty for nothing usable', () => {
    assert.equal(fileIdentity('Lib/MEMORY.js'), fileIdentity('lib/memory.js'))
    assert.equal(fileIdentity(''), '')
    assert.equal(fileIdentity('   '), '')
  })
})

describe('fileLabel', () => {
  it('keeps only the last path segment', () => {
    assert.equal(fileLabel('/a/b/c.js'), 'c.js')
    assert.equal(fileLabel('lib/memory.js'), 'memory.js')
  })
})

describe('fileFromArguments', () => {
  it('reads the first recognised path key', () => {
    assert.equal(fileFromArguments('{"file_path":"/a/b.js"}'), '/a/b.js')
    assert.equal(fileFromArguments('{"path":"p.js","file_path":"f.js"}'), 'f.js')
  })

  it('is empty for unparsable arguments or no path key', () => {
    assert.equal(fileFromArguments('not json'), '')
    assert.equal(fileFromArguments('{"command":"ls"}'), '')
    assert.equal(fileFromArguments(undefined), '')
  })
})

describe('findFileOccurrences', () => {
  it('pairs a read result with the call that named its file', () => {
    const entries = [
      { seq: 0, message: system({}) },
      { seq: 1, message: assistant({ content: [readCall('c1', 'a.js')] }) },
      { seq: 2, message: toolResult({ callId: 'c1', content: [{ type: 'text', text: 'body' }] }) },
    ]
    const found = findFileOccurrences(entries)
    assert.equal(found.length, 1)
    assert.equal(found[0].file, 'a.js')
    assert.equal(found[0].index, 2)
    assert.equal(found[0].callId, 'c1')
  })

  it('ignores a call that names no file', () => {
    const entries = [
      { seq: 1, message: assistant({ content: [bashCall('c1')] }) },
      { seq: 2, message: toolResult({ callId: 'c1', content: [{ type: 'text', text: 'out' }] }) },
    ]
    assert.deepEqual(findFileOccurrences(entries), [])
  })

  it('ignores a result whose call is not on the surface', () => {
    const entries = [
      { seq: 2, message: toolResult({ callId: 'gone', content: [{ type: 'text', text: 'out' }] }) },
    ]
    assert.deepEqual(findFileOccurrences(entries), [])
  })
})

describe('planFileDedupe', () => {
  /** A surface of `count` sequential read/result groups over `path`. */
  const reads = (path, count) => {
    const entries = []
    let seq = 0
    for (let index = 0; index < count; index += 1) {
      entries.push({ seq: seq++, message: assistant({ id: `a${index}`, content: [readCall(`c${index}`, path)] }) })
      entries.push({ seq: seq++, message: toolResult({ id: `r${index}`, callId: `c${index}`, content: [{ type: 'text', text: `body-${index}` }] }) })
      entries.push({ seq: seq++, message: user({ id: `u${index}` }) })
    }
    return entries
  }

  it('retires every older copy and keeps the newest', () => {
    const entries = reads('a.js', 3)
    /* retainRecentMessages 1 leaves the final user message untouched. */
    const { retire, survivors } = planFileDedupe(entries, 1)
    assert.equal(retire.length, 2)
    assert.deepEqual(retire.map(occurrence => occurrence.seq), [1, 4])
    assert.equal(survivors.get('a.js').seq, 7)
  })

  it('leaves a single occurrence alone', () => {
    const { retire } = planFileDedupe(reads('a.js', 1), 1)
    assert.deepEqual(retire, [])
  })

  it('never touches a copy inside the retained tail', () => {
    const entries = reads('a.js', 2)
    /* Keeping the last two messages protects the newest result. */
    const { retire } = planFileDedupe(entries, 2)
    assert.deepEqual(retire.map(occurrence => occurrence.seq), [1])
  })

  it('does not split a call away from its result', () => {
    const entries = [
      { seq: 0, message: system({}) },
      { seq: 1, message: assistant({ content: [readCall('c1', 'a.js')] }) },
      { seq: 2, message: toolResult({ callId: 'c1', content: [{ type: 'text', text: 'old' }] }) },
      { seq: 3, message: user({ id: 'u1' }) },
      { seq: 4, message: assistant({ content: [readCall('c2', 'a.js')] }) },
      { seq: 5, message: toolResult({ id: 'r2', callId: 'c2', content: [{ type: 'text', text: 'new' }] }) },
      { seq: 6, message: user({ id: 'u2' }) },
    ]
    const { retire } = planFileDedupe(entries, 2)
    /* The older entry is retired at its result index (2), and its span is index 1-2. */
    assert.equal(retire.length, 1)
    assert.equal(retire[0].index, 2)
    assert.deepEqual(retire[0].span, { start: 1, end: 2 })
    assert.equal(retire[0].survivorSeq, 5)
  })

  it('keeps distinct files independent', () => {
    const entries = [
      { seq: 0, message: assistant({ content: [readCall('c1', 'a.js'), readCall('c2', 'b.js')] }) },
      { seq: 1, message: toolResult({ callId: 'c1', content: [{ type: 'text', text: 'A' }] }) },
      { seq: 2, message: toolResult({ id: 'r2', callId: 'c2', content: [{ type: 'text', text: 'B' }] }) },
      { seq: 3, message: user({ id: 'u1' }) },
    ]
    assert.deepEqual(planFileDedupe(entries, 1).retire, [])
  })
})

describe('stubDuplicateContent', () => {
  it('names the file and the surviving copy', () => {
    const built = stubDuplicateContent([{ type: 'text', text: 'x'.repeat(400) }], 'a.js', 'a.js')
    assert.equal(built.omittedChars, 400)
    assert.match(textOf(built.content), new RegExp(DUPLICATE_MARKER))
    assert.match(textOf(built.content), /a\.js/)
  })

  it('preserves non-text blocks', () => {
    const built = stubDuplicateContent(
      [{ type: 'text', text: 'body' }, { type: 'image', attachment: { id: 'i' } }],
      'a.js',
      'a.js',
    )
    assert.equal(built.content[1].type, 'image')
  })

  it('is idempotent', () => {
    const first = stubDuplicateContent([{ type: 'text', text: 'body' }], 'a.js', 'a.js')
    assert.equal(isDuplicateContent(first.content), true)
    assert.equal(stubDuplicateContent(first.content, 'a.js', 'a.js'), null)
  })

  it('leaves an already-marker output to the duplicate check, not the stub check', () => {
    const built = stubDuplicateContent([{ type: 'text', text: '' }], 'a.js', 'a.js')
    assert.equal(built, null)
  })
})

describe('resolveConfig dedupe key', () => {
  it('defaults on and must be boolean', () => {
    assert.equal(resolveConfig({}).dedupeFileReads, true)
    assert.equal(resolveConfig({ dedupeFileReads: false }).dedupeFileReads, false)
    assert.throws(() => resolveConfig({ dedupeFileReads: 'yes' }), /"dedupeFileReads" must be a boolean/)
  })
})
