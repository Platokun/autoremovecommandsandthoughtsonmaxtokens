/**
 * The citable history index: stable numbering, thought chunking, citations, and
 * the reasoning lock.
 *
 * Every user message, agent message, and tool call gets one **stable number**,
 * assigned in log order so folds never renumber anything. An assistant message's
 * text and thoughts are additionally split into **chunks** — paragraphs, and
 * list items inside them — because a few paragraphs are rarely useful as one
 * indivisible unit. Chunks are cited as `<message>.<chunk>`, e.g. `12.3`.
 *
 * A memory node is written `rwm-<n>-<context>` and is cited as `rwm-<n>`; those
 * live in their own namespace and are excluded from the plain numbering.
 *
 * Every citable item carries a **reasoning lock**: a derived, one-line statement
 * of what the content actually is. `judge()` compares the reasoning a requester
 * supplies against that lock, which is how a request for 2022 data gets refused
 * by content that is entirely 2023.
 *
 * Nothing here imports from the harness or touches the network.
 *
 * @module @local/dsh-autotrim-context/history
 */

import { MEMORY_PREFIX, isReplacementCopy } from './memory.js'

/** Event types that receive a stable history number. */
const NUMBERED_TYPES = new Set(['user/message', 'assistant/message', 'tool/call'])

/** `rwm-<digits>-` at the very start of a node's text. */
const MEMORY_PATTERN = /^rwm-(\d+)-(.*)$/s

/** A citation list: `1, 4-7, rwm-6, 12.3`. */
const CITATION_SPLIT = /[,\s]+/

/** @returns true for a non-array object. */
function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Whether one text value is a memory node, and its number and context. */
export function parseMemory(text) {
  if (typeof text !== 'string') return null
  const match = MEMORY_PATTERN.exec(text)
  if (match === null) return null
  return { number: Number(match[1]), context: match[2] }
}

/** Visible text of any event that carries model-facing content. */
export function eventText(event) {
  if (!isRecord(event)) return ''
  const data = event.data
  if (event.type === 'user/message') return textOfBlocks(data?.content)
  if (event.type === 'tool/call') return typeof data?.arguments === 'string' ? data.arguments : ''
  if (event.type === 'tool/result') return textOfBlocks(data?.message?.content)
  if (event.type === 'assistant/message' || event.type === 'system/message' || event.type === 'developer/message') {
    return textOfBlocks(data?.message?.content)
  }
  return ''
}

/** Join the textual blocks of a content array. */
function textOfBlocks(blocks) {
  if (!Array.isArray(blocks)) return ''
  const parts = []
  for (const block of blocks) {
    if (isRecord(block) && typeof block.text === 'string') parts.push(block.text)
  }
  return parts.join('\n')
}

/** One block's role in the model's own output. */
function blockKind(block) {
  return block?.type === 'reasoning' ? 'thought' : 'text'
}

/**
 * Split one text value into citable chunks.
 *
 * Paragraphs first (blank lines), then list items inside a paragraph, so a
 * bulleted block becomes individually citable without losing its neighbours.
 * @param text - the text to split.
 * @returns the chunk texts, in order.
 */
export function chunkText(text) {
  if (typeof text !== 'string' || text.length === 0) return []
  const chunks = []
  for (const paragraph of text.split(/\n\s*\n/)) {
    const trimmed = paragraph.trim()
    if (trimmed.length === 0) continue
    const lines = trimmed.split('\n')
    const isList = lines.length > 1 && lines.every(line => /^\s*([-*+]|\d+[.)])\s+/.test(line))
    if (isList) chunks.push(...lines.map(line => line.trim()).filter(Boolean))
    else chunks.push(trimmed)
  }
  return chunks
}

/**
 * Build the citable index over one session log.
 * @param events - all committed session events, in seq order.
 * @returns `{ entries, byNumber, memories, memoryByNumber }`.
 */
export function buildIndex(events) {
  const entries = []
  const byNumber = new Map()
  const memories = []
  const memoryByNumber = new Map()
  let next = 1

  for (const event of events) {
    /*
     * A memory node is itself a replacement copy, so the memory check has to
     * come before the replacement skip: memory nodes are citable, and only
     * append-origin records take a plain history number.
     */
    if (event.type === 'user/message') {
      const text = eventText(event)
      const memory = parseMemory(text)
      if (memory !== null) {
        const record = { ...memory, seq: event.seq, text }
        memories.push(record)
        memoryByNumber.set(memory.number, record)
        continue
      }
    }
    if (isReplacementCopy(event)) continue
    if (!NUMBERED_TYPES.has(event.type)) continue

    const number = next
    next += 1
    const entry = {
      number,
      seq: event.seq,
      type: event.type,
      kind: event.type === 'tool/call'
        ? 'tool'
        : (event.type === 'user/message' ? 'user' : 'agent'),
      tool: event.type === 'tool/call' ? String(event.data?.name ?? '') : '',
      chunks: buildChunks(event),
    }
    entries.push(entry)
    byNumber.set(number, entry)
  }
  return { entries, byNumber, memories, memoryByNumber }
}

/** The citable chunks of one numbered event. */
function buildChunks(event) {
  const chunks = []
  const push = (kind, text) => {
    for (const piece of chunkText(text)) {
      chunks.push({ id: `${chunks.length + 1}`, index: chunks.length + 1, kind, text: piece })
    }
  }
  if (event.type === 'tool/call') {
    push('call', eventText(event))
  } else if (event.type === 'user/message') {
    push('text', eventText(event))
  } else {
    const content = event.data?.message?.content
    if (Array.isArray(content)) {
      for (const block of content) {
        if (isRecord(block) && typeof block.text === 'string' && block.text.length > 0) {
          push(blockKind(block), block.text)
        }
      }
    }
  }
  return chunks
}

/**
 * Parse a citation list into resolved ranges.
 *
 * Accepts `1`, `4-7`, `12.3` (one chunk) and `rwm-6` (a whole memory).
 * @param input - a string or array of citation tokens.
 * @returns `{ numbers, ranges, chunks, memories }`, or an error string.
 */
export function parseCitations(input) {
  const tokens = Array.isArray(input)
    ? input.flatMap(item => String(item).split(CITATION_SPLIT))
    : String(input ?? '').split(CITATION_SPLIT)
  const numbers = []
  const ranges = []
  const chunks = []
  const memories = []
  for (const token of tokens) {
    if (token.length === 0) continue
    const memory = /^rwm-(\d+)(?:-(full))?$/.exec(token)
    if (memory !== null) {
      memories.push(Number(memory[1]))
      continue
    }
    const range = /^(\d+)\s*-\s*(\d+)$/.exec(token)
    if (range !== null) {
      const start = Number(range[1])
      const end = Number(range[2])
      if (start > end) return { error: `citation "${token}" runs backwards` }
      ranges.push({ start, end })
      continue
    }
    const chunk = /^(\d+)\.(\d+)$/.exec(token)
    if (chunk !== null) {
      chunks.push({ number: Number(chunk[1]), index: Number(chunk[2]) })
      continue
    }
    if (/^\d+$/.test(token)) {
      numbers.push(Number(token))
      continue
    }
    return { error: `"${token}" is not a citation (use 12, 12-14, 12.3, or rwm-4)` }
  }
  return { numbers, ranges, chunks, memories }
}

/** Every message number one citation list names. */
export function citedNumbers(parsed) {
  const numbers = new Set(parsed.numbers ?? [])
  for (const range of parsed.ranges ?? []) {
    for (let value = range.start; value <= range.end; value += 1) numbers.add(value)
  }
  for (const chunk of parsed.chunks ?? []) numbers.add(chunk.number)
  return [...numbers].sort((left, right) => left - right)
}

/* ------------------------------------------------------------------ locks */

/**
 * Identifiers that must be present for a request to be about this content.
 *
 * Years, long numbers, and constants are *strong*: a request naming a year the
 * content never mentions is asking about something else, which is exactly the
 * 2022-versus-2023 case. Flags and file names are *weak*: a request may
 * legitimately name a flag or a file the older content did not.
 */
const STRONG_PATTERNS = [
  /\b(?:19|20)\d{2}\b/g,                 /* years: the 2022-vs-2023 case */
  /\b\d{4,}\b/g,                          /* long numbers, ports, ids */
  /\b[A-Z][A-Z0-9_]{2,}\b/g,              /* constants */
]

const WEAK_PATTERNS = [
  /\b[\w-]+\.[a-z]{1,5}\b/g,              /* file names */
  /--[a-z][\w-]*/g,                       /* command-line flags */
]

/**
 * The distinct strong identifiers of one text value, lowercased.
 * @param text - text to scan.
 * @returns a sorted, de-duplicated token list.
 */
export function strongTokens(text) {
  if (typeof text !== 'string' || text.length === 0) return []
  const found = new Set()
  for (const pattern of STRONG_PATTERNS) {
    for (const match of text.matchAll(pattern)) found.add(match[0].toLowerCase())
  }
  return [...found].sort()
}

/**
 * The distinct salient tokens of one text value, lowercased.
 * @param text - text to scan.
 * @returns a sorted, de-duplicated token list.
 */
export function salientTokens(text) {
  if (typeof text !== 'string' || text.length === 0) return []
  return [...new Set([...strongTokens(text), ...weakTokens(text)])].sort()
}

/** The distinct weak identifiers of one text value, lowercased. */
function weakTokens(text) {
  const found = new Set()
  for (const pattern of WEAK_PATTERNS) {
    for (const match of text.matchAll(pattern)) found.add(match[0].toLowerCase())
  }
  return [...found]
}

/** First sentence of a text value, trimmed to a readable length. */
function firstSentence(text) {
  const flat = String(text ?? '').replace(/\s+/g, ' ').trim()
  if (flat.length === 0) return ''
  const stop = flat.search(/[.;!?]\s/)
  const sentence = stop === -1 ? flat : flat.slice(0, stop + 1)
  return sentence.length > 120 ? `${sentence.slice(0, 117)}...` : sentence
}

/**
 * The derived reasoning lock: a one-line statement of what the content is.
 *
 * It is derived rather than stored, so every fold, restart, and replay produces
 * the same lock without any extra durable field.
 * @param text - the content being locked.
 * @param label - optional provenance label such as `rwm-3`.
 * @returns a one-line lock statement.
 */
export function reasoningLock(text, label = '') {
  const tokens = salientTokens(text)
  const head = firstSentence(text)
  const body = tokens.length > 0 ? `only mentions ${tokens.slice(0, 8).join(', ')}` : 'carries no distinctive identifiers'
  const prefix = label.length > 0 ? `${label}: ` : ''
  return `${prefix}${body}${head.length > 0 ? `; ${head}` : ''}`
}

/**
 * Judge one access request against the lock of the content it wants.
 *
 * Any reasoning is acceptable in principle; what is refused is a request whose
 * own terms contradict the content. A reasoning naming a strong identifier the
 * content never mentions is exactly the "I need 2022 data, but this is all
 * 2023" case, and is denied with the lock as the explanation.
 *
 * This is the deterministic first cut of the independent judge: it needs no
 * model call and cannot hallucinate. A model-based reviewer is the next step.
 * @param reason - the requester's stated reasoning.
 * @param text - the content being requested.
 * @param label - optional provenance label such as `rwm-3`.
 * @returns `{ verdict: 'allow'|'deny', lock, missing }`.
 */
export function judge(reason, text, label = '') {
  const lock = reasoningLock(text, label)
  const asked = strongTokens(reason)
  if (asked.length === 0) return { verdict: 'allow', lock, missing: [] }
  const present = new Set(salientTokens(text))
  const missing = asked.filter(token => !present.has(token))
  if (missing.length > 0) return { verdict: 'deny', lock, missing }
  return { verdict: 'allow', lock, missing: [] }
}

/* -------------------------------------------------------------- resolution */

/**
 * Resolve a citation list into the exact content it names.
 *
 * A tool call resolves to its arguments plus the output that answered it; a
 * chunk citation resolves to that one chunk; an `rwm-<n>` citation resolves to
 * every original that memory fold shadowed, read back from `sourceEventSeqs`.
 *
 * @param index - from {@link buildIndex}.
 * @param events - all committed session events.
 * @param parsed - from {@link parseCitations}.
 * @param options.maxChars - total budget; a larger request is refused whole.
 * @returns `{ items, chars }` or `{ error }`.
 */
export function resolveCitations(index, events, parsed, { maxChars = 4000 } = {}) {
  const bySeq = new Map(events.map(event => [event.seq, event]))
  const items = []
  const warnings = []

  const addEvent = (seq, label) => {
    const event = bySeq.get(seq)
    if (event === undefined) {
      warnings.push(`${label} (seq ${seq}) is no longer in the log`)
      return
    }
    items.push({ label, seq, kind: event.type, text: eventText(event) })
  }

  for (const number of citedNumbers(parsed)) {
    const entry = index.byNumber.get(number)
    if (entry === undefined) {
      warnings.push(`#${number} is not a number in this history`)
      continue
    }
    const chunks = (parsed.chunks ?? []).filter(chunk => chunk.number === number)
    if (chunks.length > 0) {
      for (const chunk of chunks) {
        const found = entry.chunks.find(candidate => candidate.index === chunk.index)
        if (found === undefined) warnings.push(`#${number}.${chunk.index} does not exist`)
        else items.push({ label: `${number}.${chunk.index}`, seq: entry.seq, kind: found.kind, text: found.text })
      }
      continue
    }
    const event = bySeq.get(entry.seq)
    if (event === undefined) {
      warnings.push(`#${number} is no longer in the log`)
      continue
    }
    items.push({ label: `${number}`, seq: entry.seq, kind: entry.kind, text: eventText(event) })
    /* A tool call is only meaningful with the output that answered it. */
    if (event.type === 'tool/call') {
      const callId = String(event.data?.callId ?? '')
      const result = events.find(candidate => candidate.type === 'tool/result'
        && String(candidate.data?.message?.toolCallId) === callId && !isReplacementCopy(candidate))
      if (result !== undefined) {
        items.push({ label: `${number}.out`, seq: result.seq, kind: 'output', text: eventText(result) })
      }
    }
  }

  for (const number of parsed.memories ?? []) {
    const memory = index.memoryByNumber.get(number)
    if (memory === undefined) {
      warnings.push(`rwm-${number} does not exist`)
      continue
    }
    const event = bySeq.get(memory.seq)
    const sources = event?.sourceEventSeqs ?? []
    if (sources.length === 0) {
      warnings.push(`rwm-${number} replaced nothing recoverable`)
      continue
    }
    items.push({ label: `rwm-${number}`, seq: memory.seq, kind: 'memory', text: memory.text })
    for (const seq of sources) addEvent(seq, `rwm-${number}@${seq}`)
  }

  const chars = items.reduce((total, item) => total + item.text.length, 0)
  if (chars > maxChars) {
    return {
      error: `That request is ${chars} characters, over the ${maxChars} budget. `
        + 'Cite fewer items, or cite single chunks like 12.3, and ask again.',
      chars,
    }
  }
  return { items, warnings, chars }
}


/**
 * Render the compact index the model cites from.
 *
 * Only what the model can no longer see is listed: retired numbers and memory
 * nodes. Listing visible items would spend the context this plugin exists to
 * save.
 * @param index - from {@link buildIndex}.
 * @param visibleNumbers - numbers still present in the model's context.
 * @param limit - maximum lines to emit.
 * @returns one line per entry, oldest first.
 */
export function renderIndex(index, visibleNumbers, limit = 40) {
  const lines = []
  for (const entry of index.entries) {
    if (visibleNumbers.has(entry.number)) continue
    const first = entry.chunks[0]?.text ?? ''
    const preview = first.replace(/\s+/g, ' ').slice(0, 70)
    lines.push(`${entry.number} [${entry.tool || entry.kind}]${preview.length > 0 ? ` ${preview}` : ''}`)
  }
  for (const memory of index.memories) {
    lines.push(`rwm-${memory.number} ${memory.context.replace(/\s+/g, ' ').slice(0, 70)}`)
  }
  return lines.slice(-limit)
}
