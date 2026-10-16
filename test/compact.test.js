/**
 * Tests for `/rwm compact`: the whole-conversation pass, its file records, and
 * the model-route guard that keeps a costly route from being used implicitly.
 */

import assert from 'node:assert/strict'
import { test, describe } from 'node:test'

import {
  buildCompactMemory,
  buildFileRecord,
  chooseCompactRoute,
  collectFileRecords,
  collectToolRecords,
  compactSystemPrompt,
  compactUserPrompt,
  isContiguousTail,
  isMemoryText,
  planCompact,
  planMemoryFold,
  planWipe,
  resolveConfig,
  setCompactionClock,
} from '../lib/memory.js'

/** One assistant message carrying a single tool call. */
function callMessage(id, name, args) {
  return {
    role: 'assistant',
    content: [{ type: 'tool-call', id, name, arguments: JSON.stringify(args) }],
  }
}

/** One tool result message. */
function resultMessage(id, text, options = {}) {
  return {
    role: 'tool',
    toolCallId: id,
    content: [{ type: 'text', text }],
    ...(options.isError === true ? { isError: true } : {}),
  }
}

/** A user message. */
function userMessage(text) {
  return { role: 'user', content: [{ type: 'text', text }] }
}

/** Build `{ seq, message }` pairs from bare messages. */
function entries(messages) {
  return messages.map((message, index) => ({ seq: index + 1, message }))
}

const FILE_TOOL = 'read'

describe('file records', () => {
  test('a record names the path, the action, and a timestamp — never the bytes', () => {
    setCompactionClock(() => new Date('2026-10-16T03:21:10.123Z'))
    const record = buildFileRecord('/repo/src/index.js', { action: 'write', bytes: 1204 })
    assert.equal(record, 'file /repo/src/index.js written 2026-10-16T03:21:10Z 1204b')
    setCompactionClock(() => new Date())
  })

  test('a record carries no file content even when the tool output was huge', () => {
    const body = 'const secret = "x".repeat(10)'.repeat(5000)
    const records = collectFileRecords(
      entries([callMessage('c1', FILE_TOOL, { file_path: 'src/big.js' }), resultMessage('c1', body)]),
      [],
    )
    const only = [...records.values()][0]
    const record = buildFileRecord(only.file, { action: only.action, bytes: only.bytes })
    assert.ok(record.length < 200, 'the record stays terse')
    assert.ok(!record.includes('const secret'), 'no file bytes leak into the record')
  })

  test('a read and a write of one file collapse to one record, and the write wins', () => {
    const records = collectFileRecords(entries([
      callMessage('c1', 'read', { file_path: 'src/a.js' }),
      resultMessage('c1', 'old body'),
      callMessage('c2', 'edit', { file_path: 'src/a.js' }),
      resultMessage('c2', 'new body'),
    ]), [])
    assert.equal(records.size, 1, 'one file is one record')
    const only = [...records.values()][0]
    assert.equal(only.action, 'write', 'the write is what persists')
    assert.equal(only.seqs.length, 2, 'both occurrences are covered by the record')
  })

  test('two different files stay two records', () => {
    const records = collectFileRecords(entries([
      callMessage('c1', 'read', { file_path: 'src/a.js' }),
      resultMessage('c1', 'a'),
      callMessage('c2', 'read', { file_path: 'src/b.js' }),
      resultMessage('c2', 'b'),
    ]), [])
    assert.equal(records.size, 2)
  })

  test('a tool that names no file contributes no record', () => {
    const records = collectFileRecords(entries([
      callMessage('c1', 'read', {}),
      resultMessage('c1', 'anything'),
    ]), [])
    assert.equal(records.size, 0)
  })
})

describe('tool records', () => {
  test('non-file tool output becomes one clipped line each', () => {
    const records = collectToolRecords(entries([
      callMessage('c1', 'bash', { command: 'ls' }),
      resultMessage('c1', 'line one\nline two\nline three'),
    ]))
    assert.equal(records.length, 1)
    assert.equal(records[0].name, 'bash')
    assert.ok(!records[0].text.includes('\n'), 'a record is one line')
  })

  test('errors survive by default and are dropped only when told to', () => {
    const messages = [
      callMessage('c1', 'bash', { command: 'false' }),
      resultMessage('c1', 'boom', { isError: true }),
    ]
    assert.equal(collectToolRecords(entries(messages), true).length, 1)
    assert.equal(collectToolRecords(entries(messages), false).length, 0)
  })

  test('file tools are excluded: they are already file records', () => {
    const records = collectToolRecords(entries([
      callMessage('c1', 'read', { file_path: 'a.js' }),
      resultMessage('c1', 'body'),
    ]))
    assert.equal(records.length, 0)
  })

  test('repeated identical calls collapse into one line with a count', () => {
    const messages = []
    for (let index = 0; index < 12; index += 1) {
      messages.push(callMessage(`c${index}`, 'bash', { command: 'npm test' }))
      messages.push(resultMessage(`c${index}`, 'all tests passed'))
    }
    const plan = planCompact(entries([...messages, userMessage('tail')]), { keepRecent: 1 })
    assert.equal(plan.tools.length, 1, `twelve identical runs should be one line, got ${plan.tools.length}`)
    assert.match(plan.tools[0], /x12/, 'the line states how many times it ran')
  })

  test('a clipped line never ends mid-word', () => {
    const plan = planCompact(entries([
      callMessage('c1', 'bash', { command: 'x' }),
      resultMessage('c1', 'alpha bravo charlie delta echo foxtrot golf hotel india juliet'),
      userMessage('tail'),
    ]), { keepRecent: 1, toolLineChars: 30 })
    const line = plan.tools[0]
    assert.ok(line.endsWith('...'), 'a clipped line is marked')
    const body = line.replace(/^tool \S+: /, '').replace(/\.\.\.$/, '')
    assert.ok(!body.endsWith(' '), 'no trailing space before the mark')
    // The last retained word must be a whole word from the source.
    const lastWord = body.split(' ').pop()
    assert.ok(
      'alpha bravo charlie delta echo foxtrot golf hotel india juliet'.split(' ').includes(lastWord),
      `the cut landed mid-word: ${JSON.stringify(body)}`,
    )
  })

  test('the tool list is bounded, and says what it dropped', () => {
    const messages = []
    for (let index = 0; index < 60; index += 1) {
      messages.push(callMessage(`c${index}`, 'bash', { command: `run ${index}` }))
      messages.push(resultMessage(`c${index}`, `distinct output number ${index}`))
    }
    const plan = planCompact(entries([...messages, userMessage('tail')]), { keepRecent: 1, toolLineLimit: 10 })
    assert.equal(plan.tools.length, 11, 'ten lines plus the omission note')
    assert.match(plan.tools[10], /50 more distinct tool result/)
  })
})

describe('planCompact', () => {
  test('covers from the start to the retained tail', () => {
    const plan = planCompact(entries([
      userMessage('first'),
      userMessage('second'),
      userMessage('third'),
      userMessage('tail'),
    ]), { keepRecent: 1 })
    assert.equal(plan.coveredCount, 3, 'the newest message is kept')
    assert.equal(plan.startSeq, 1)
    assert.equal(plan.endSeq, 3)
  })

  test('skips the system node and never folds a memory into a memory', () => {
    const plan = planCompact(entries([
      { role: 'system', content: [{ type: 'text', text: 'you are a helper' }] },
      userMessage('rwm-3-an earlier memory'),
      userMessage('real request'),
      userMessage('tail'),
    ]), { keepRecent: 1 })
    assert.ok(plan.startSeq > 1, 'the system node is not covered')
    assert.ok(!plan.asks.includes('rwm-3-an earlier memory'), 'memory text is not re-condensed')
  })

  test('returns null rather than an empty plan when nothing may fold', () => {
    assert.equal(planCompact(entries([userMessage('only')]), { keepRecent: 5 }), null)
    assert.equal(planCompact([], {}), null)
  })
})

describe('buildCompactMemory', () => {
  test('is terse, bounded, and lists files first', () => {
    setCompactionClock(() => new Date('2026-10-16T03:21:10.000Z'))
    const plan = planCompact(entries([
      callMessage('c1', 'read', { file_path: 'src/a.js' }),
      resultMessage('c1', 'x'.repeat(9000)),
      callMessage('c2', 'bash', { command: 'make' }),
      resultMessage('c2', 'ok'),
      userMessage('please fix the build'),
      userMessage('tail'),
    ]), { keepRecent: 1 })
    const memory = buildCompactMemory(plan)
    assert.match(memory, /^earlier work compacted/, 'it opens with what it is')
    assert.match(memory, /file src\/a\.js read 2026-10-16T03:21:10Z/, 'the file record is present')
    assert.ok(memory.length < 600, `the memory is bounded (was ${memory.length} chars)`)
    /*
     * The default `partial` shape keeps the record plus a short opening hint of
     * the file — never the document. 9000 identical characters must not survive
     * as anything like 9000 characters of memory.
     */
    assert.ok(!memory.includes('x'.repeat(200)), 'the body of the file is not carried')
    assert.match(memory, /->\d+/, 'the record carries a reference to the real bytes')
    setCompactionClock(() => new Date())
  })

  test('a reference-shaped record carries no file content at all', () => {
    setCompactionClock(() => new Date('2026-10-16T03:21:10.000Z'))
    const plan = planCompact(entries([
      callMessage('c1', 'read', { file_path: 'src/a.js' }),
      resultMessage('c1', 'secret-body-content'),
      userMessage('tail'),
    ]), { keepRecent: 1, fileShrink: 'reference' })
    const memory = buildCompactMemory(plan)
    assert.match(memory, /file src\/a\.js read 2026-10-16T03:21:10Z \d+b ->2/)
    assert.ok(!memory.includes('secret-body-content'), 'a pure reference must not quote the file')
    setCompactionClock(() => new Date())
  })

  test('a full-shaped record carries the whole document', () => {
    setCompactionClock(() => new Date('2026-10-16T03:21:10.000Z'))
    const plan = planCompact(entries([
      callMessage('c1', 'read', { file_path: 'src/a.js' }),
      resultMessage('c1', 'line one\nline two\nline three\nline four'),
      userMessage('tail'),
    ]), { keepRecent: 1, fileShrink: 'full' })
    const memory = buildCompactMemory(plan)
    assert.ok(memory.includes('line four'), 'full keeps the document')
    setCompactionClock(() => new Date())
  })
})

describe('wipe', () => {
  test('covers everything after the system prompt', () => {
    const plan = planWipe(entries([
      { role: 'system', content: [{ type: 'text', text: 'system' }] },
      userMessage('a'),
      userMessage('b'),
    ]))
    assert.equal(plan.startIndex, 1, 'node 0 is the system prompt and stays')
    assert.deepEqual(plan.shadowedSeqs, [2, 3])
  })

  test('refuses when only the system prompt exists', () => {
    assert.equal(planWipe(entries([{ role: 'system', content: [] }])), null)
    assert.equal(planWipe([]), null)
  })
})

describe('model route guard', () => {
  const config = resolveConfig({})

  test('never picks a denied provider implicitly', () => {
    const chosen = chooseCompactRoute(
      config,
      ['deepseek', 'local-spark'],
      undefined,
      { 'local-spark': ['spark-x-t-4b'] },
    )
    assert.equal(chosen.provider, 'local-spark', 'the denied route is skipped')
    assert.equal(chosen.reason, 'implicit')
  })

  test('refuses rather than falling back to a denied provider', () => {
    const chosen = chooseCompactRoute(config, ['deepseek'])
    assert.ok(chosen.error, 'it explains instead of guessing')
    assert.match(chosen.error, /compactProvider/)
  })

  test('an explicit pair always wins, including an allowed deepseek route', () => {
    const explicit = resolveConfig({ compactProvider: 'deepseek', compactModel: 'deepseek-chat' })
    const chosen = chooseCompactRoute(explicit, ['deepseek', 'local-spark'])
    assert.equal(chosen.provider, 'deepseek')
    assert.equal(chosen.model, 'deepseek-chat')
    assert.equal(chosen.reason, 'configured', 'explicit configuration is honoured')
  })

  test('an allow list overrides the deny fragments', () => {
    const allowing = resolveConfig({ compactAllowProviders: 'deepseek' })
    const chosen = chooseCompactRoute(
      allowing,
      ['deepseek', 'local-spark'],
      undefined,
      { deepseek: ['deepseek-chat'] },
    )
    assert.equal(chosen.provider, 'deepseek')
    assert.equal(chosen.model, 'deepseek-chat')
  })

  test('the deny list is configurable', () => {
    const custom = resolveConfig({ compactDenyProviders: 'expensive' })
    assert.equal(chooseCompactRoute(custom, ['expensive-model']).error !== undefined, true)
    assert.equal(
      chooseCompactRoute(custom, ['deepseek'], undefined, { deepseek: ['deepseek-chat'] }).provider,
      'deepseek',
    )
  })

  test('an implicit pick names a real model from the provider advertisement', () => {
    const chosen = chooseCompactRoute(
      resolveConfig({}),
      ['local-spark'],
      undefined,
      { 'local-spark': ['spark-x-t-4b', 'spark-mini'] },
    )
    assert.equal(chosen.provider, 'local-spark')
    assert.equal(chosen.model, 'spark-x-t-4b', 'an empty model would be an uncallable route')
    assert.equal(chosen.reason, 'implicit')
  })

  test("an implicit pick reuses the session's own model when the provider matches", () => {
    const chosen = chooseCompactRoute(
      resolveConfig({}),
      ['local-spark'],
      { provider: 'local-spark', model: 'spark-x-t-4b' },
      { 'local-spark': ['spark-mini'] },
    )
    assert.equal(chosen.model, 'spark-x-t-4b', 'the session model wins over the first advertised one')
  })

  test('a permitted provider that advertises no model is refused, never called empty', () => {
    const chosen = chooseCompactRoute(resolveConfig({}), ['local-spark'], undefined, {})
    assert.ok(chosen.error, 'it must explain rather than call an empty route')
    assert.match(chosen.error, /advertises no model/)
  })

  test('a session model is not borrowed across providers', () => {
    const chosen = chooseCompactRoute(
      resolveConfig({}),
      ['local-spark'],
      { provider: 'deepseek', model: 'deepseek-chat' },
      { 'local-spark': ['spark-x-t-4b'] },
    )
    assert.equal(chosen.model, 'spark-x-t-4b', "another provider's model must not be sent to this one")
  })
})

describe('config surface', () => {
  test('new keys default safely and reject wrong types', () => {
    const config = resolveConfig({})
    assert.equal(config.compactUseModel, false, 'no model call unless asked for')
    assert.equal(config.compactKeepRecent, 1)
    assert.equal(config.compactMaxTokens, 700)
    assert.throws(() => resolveConfig({ compactKeepRecent: 1.5 }), /integer/)
    assert.throws(() => resolveConfig({ compactUseModel: 'yes' }), /boolean/)
    assert.throws(() => resolveConfig({ compactProvider: 7 }), /string/)
    assert.throws(() => resolveConfig({ nope: 1 }), /unknown config key/)
  })

  test('the model instruction forbids inventing file contents', () => {
    const prompt = compactSystemPrompt()
    assert.match(prompt, /never invent/i)
    assert.match(prompt, /re-reads files from disk/)
  })

  test('the user prompt frames the plan without adding commentary', () => {
    const plan = planCompact(entries([userMessage('a'), userMessage('b')]), { keepRecent: 1 })
    assert.match(compactUserPrompt(plan), /^Rewrite this into one terse memory:/)
  })
})

describe('isMemoryText', () => {
  test('recognises memory nodes and ordinary text alike', () => {
    assert.equal(isMemoryText('rwm-1-something'), true)
    assert.equal(isMemoryText('rwm-c-2-console'), true)
    assert.equal(isMemoryText('  rwm-4-indented'), true)
    assert.equal(isMemoryText('a normal request'), false)
    assert.equal(isMemoryText(''), false)
  })
})

describe('prefix-stability (provider cache)', () => {
  const surface = (...seqs) => seqs.map(seq => ({ seq, message: { role: 'user' } }))

  /**
   * Build a surface of `count` entries after the system prompt, minus any seq in
   * `skip` — the shape a bug in the planner would have to produce to strand a
   * node outside the run it rewrites.
   */
  const buildEntries = (count, skip = []) => [
    { seq: 0, message: { role: 'system' } },
    ...Array.from({ length: count }, (_, index) => index + 1)
      .filter(seq => !skip.includes(seq))
      .map(seq => ({ seq, message: { role: 'user', content: [{ type: 'text', text: `turn ${seq}` }] } })),
  ]

  test('accepts the contiguous ascending runs a fold actually produces', () => {
    const entries = surface(0, 1, 2, 3, 4)
    assert.equal(isContiguousTail(entries, [1, 2, 3]), true)
    assert.equal(isContiguousTail(entries, [4]), true, 'a single-entry replace is contiguous')
    assert.equal(isContiguousTail(entries, [1, 2, 3, 4]), true)
  })

  test('refuses a hole, a reversal, an unknown seq, and an empty run', () => {
    const entries = surface(0, 1, 2, 3, 4)
    assert.equal(isContiguousTail(entries, [1, 3]), false, 'a hole rewrites bytes either side of it')
    assert.equal(isContiguousTail(entries, [3, 2]), false, 'a reversal breaks the run')
    assert.equal(isContiguousTail(entries, [1, 99]), false, 'a seq off the surface is not ours')
    assert.equal(isContiguousTail(entries, []), false)
    assert.equal(isContiguousTail(entries, undefined), false)
  })

  test('every fold plan is contiguous, which is what keeps the prefix byte-identical', () => {
    const entries = buildEntries(8)
    for (const keepRecent of [1, 2, 3]) {
      const plan = planMemoryFold(entries, keepRecent)
      if (plan === null) continue
      assert.equal(
        isContiguousTail(entries, plan.shadowedSeqs),
        true,
        `keepRecent=${keepRecent} produced a non-contiguous fold`,
      )
      assert.equal(plan.shadowedSeqs[0], entries[plan.startIndex].seq)
      assert.equal(plan.shadowedSeqs.at(-1), entries[plan.endIndex].seq)
    }
  })

  test('a compact plan is contiguous and starts right after the system prompt', () => {
    const entries = buildEntries(6)
    const plan = planCompact(entries, { keepRecent: 1 })
    assert.notEqual(plan, null)
    assert.equal(isContiguousTail(entries, plan.shadowedSeqs), true)
    assert.equal(plan.shadowedSeqs.includes(0), false, 'node 0 is never compacted')
    assert.equal(plan.shadowedSeqs[0], 1)
  })

  test('a wipe covers the whole surface after node 0, in one contiguous run', () => {
    const entries = buildEntries(6)
    const plan = planWipe(entries)
    assert.notEqual(plan, null)
    assert.equal(isContiguousTail(entries, plan.shadowedSeqs), true)
    assert.deepEqual(plan.shadowedSeqs, [1, 2, 3, 4, 5, 6])
  })

  test('the planners never cite a run with a real gap in it', () => {
    /*
     * A surface where seq 3 is absent while 4 and 5 survive: the visible order is
     * 0,1,2,4,5,.... Note that `isContiguousTail` is about *surface positions*,
     * not raw seq numbers — [1,2,4] is contiguous here because it occupies three
     * adjacent positions. What must never happen is a plan whose cited seqs skip
     * a node that is still between them on the surface, which is the case this
     * fixture is built to catch.
     */
    const holed = buildEntries(6, [3])
    assert.deepEqual(holed.map(entry => entry.seq), [0, 1, 2, 4, 5, 6])

    for (const plan of [planWipe(holed), planCompact(holed, { keepRecent: 1 }), planMemoryFold(holed, 1)]) {
      if (plan === null) continue
      assert.equal(
        isContiguousTail(holed, plan.shadowedSeqs),
        true,
        `a plan cited a run that is not adjacent on the surface: ${JSON.stringify(plan.shadowedSeqs)}`,
      )
      /* And the declared range really is the run it cites. */
      assert.equal(plan.startSeq ?? plan.shadowedSeqs[0], plan.shadowedSeqs[0])
      assert.equal(plan.endSeq ?? plan.shadowedSeqs.at(-1), plan.shadowedSeqs.at(-1))
    }
  })

  test('a run that skips a surviving node is refused', () => {
    /*
     * The failure mode the planners must never produce: citing seqs whose surface
     * positions are not adjacent, because a node between them survives. Removing
     * seq 4 from the cited list while it is still on the surface is exactly that.
     */
    const entries = buildEntries(6)
    assert.equal(isContiguousTail(entries, [1, 2, 4]), false, 'a skipped surviving node breaks the run')
    assert.equal(isContiguousTail(entries, [1, 2, 6]), false, 'so does a jump further along')
    assert.equal(isContiguousTail(entries, [1, 2, 3]), true, 'the adjacent run is fine')
  })

  test('the system prompt is never inside a fold, so node 0 stays stable', () => {
    const entries = buildEntries(6)
    const plan = planMemoryFold(entries, 1)
    assert.notEqual(plan, null)
    assert.equal(plan.shadowedSeqs.includes(0), false)
    assert.equal(plan.startIndex >= 1, true)
  })
})
