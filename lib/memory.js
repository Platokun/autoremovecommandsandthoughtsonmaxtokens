/**
 * Pure planning logic for `@local/dsh-autotrim-context`.
 *
 * Nothing here imports from the harness, touches the network, or mutates its
 * inputs: every exported function is a deterministic transform over plain
 * message/log values, so the rules stay unit-testable with `node --test` and
 * `../index.js` stays a thin Cordis adapter.
 *
 * Vocabulary (mirrors `@deepseek-ai/dsh-llm`):
 *   - a message is `{ id, role, source, content[] }` where `role` is one of
 *     `system | developer | user | assistant | tool`;
 *   - a block is `{ type: 'text' | 'reasoning' | 'tool-call' | ... }`;
 *   - an assistant tool call is `{ type: 'tool-call', id, name, arguments }`
 *     answered by a `tool`-role message whose `toolCallId` equals the call id.
 *
 * The one convention this plugin establishes is the memory prefix: a piece of
 * context beginning with {@link MEMORY_PREFIX} is a memory the model wrote
 * itself to replace history it chose to forget.
 *
 * @module @local/dsh-autotrim-context/memory
 */

import { salientTokens } from './history.js'

/** Tool the model calls to replace older history with its own memory text. */
export const REWRITE_TOOL = 'rewrite_memory'

/** Tool the model calls to read content its context no longer shows. */
export const RECALL_TOOL = 'context_recall'

/** Prefix marking a node as model-authored replacement memory. */
export const MEMORY_PREFIX = 'rwm-'

/** Prefix marking a node as a console-output memory: always accessible via `rwm-c-<n>`. */
export const CONSOLE_MEMORY_PREFIX = 'rwm-c-'

/** `rwm-c-<digits>-` at the start of a console-memory node's text. */
const CONSOLE_MEMORY_PATTERN = /^rwm-c-(\d+)-(.*)$/s

/** Kind for a console-output memory node. */
export const CONSOLE_MEMORY_KIND = 'console'

/** Marker substituted for a stubbed tool output. */
export const OUTPUT_MARKER = 'tool output omitted'

/** Marker substituted for a file copy retired because a newer copy of that file exists. */
export const DUPLICATE_MARKER = 'earlier copy of this file retired'

/**
 * Tool-name fragments that mean "this call put a file's content into context".
 *
 * Matched as substrings against the registered tool name so `read`, `read_file`
 * and `str_replace_editor` all count, without importing anything from the harness.
 */
const FILE_TOOLS = Object.freeze(['read', 'view', 'cat', 'edit', 'write', 'replace'])

/** Tool-name fragments that mean a call only *reads* a file. */
const FILE_READ_TOOLS = Object.freeze(['read', 'view', 'cat'])

/** Argument keys that name the file a tool call is about, most specific first. */
const PATH_KEYS = Object.freeze(['file_path', 'filePath', 'filepath', 'path', 'target', 'file', 'filename'])

/** Low-friction defaults for a coding agent near its context limit. */
export const DEFAULTS = Object.freeze({
  /** Force the automatic passes on without /rwm enable; it never gates the agent's own tools. */
  enabledByDefault: false,
  retainRecentMessages: 8,
  autoStubToolResults: true,
  /** Retire older copies of a file once a newer copy is in context (forced mode only). */
  dedupeFileReads: true,
  keepErrorResults: true,
  toolResultPreviewChars: 0,
  exposePolicySection: true,
  sectionOrder: 2550,
  indexLimit: 40,
  accessMaxChars: 8000,
  dereferenceMaxChars: 20000,
  /** Whether the autoruns fold thoughts and console output into rwm-c- memories. */
  autorunAfterThoughts: true,
  autorunAfterConsole: true,
  /** Max salient tokens a condensation summary may list. */
  condenseSummaryTokens: 8,
  /** `/rwm compact`: how many of the newest surface nodes it always leaves intact. */
  compactKeepRecent: 1,
  /** `/rwm compact`: prefer a model-authored summary over the deterministic one. */
  compactUseModel: false,
  /** `/rwm compact`: provider route for the model-authored summary. */
  compactProvider: '',
  /** `/rwm compact`: model id for the model-authored summary. */
  compactModel: '',
  /** `/rwm compact`: output-token cap for the model-authored summary. */
  compactMaxTokens: 700,
  /** `/rwm compact`: end-to-end deadline in milliseconds for that call. */
  compactTimeoutMs: 30000,
  /** `/rwm compact`: how much of a file's content a memory keeps (`reference`/`partial`/`full`). */
  compactFileShrink: 'partial',
  /** Provider fragments that must never be chosen implicitly (paid/frontier routes). */
  compactDenyProviders: 'deepseek,dsk',
  /** Exact provider ids that are allowed even when they match a denied fragment. */
  compactAllowProviders: '',
})

/** Every accepted configuration key. */
export const CONFIG_KEYS = Object.freeze([
  'enabledByDefault',
  'retainRecentMessages',
  'autoStubToolResults',
  'dedupeFileReads',
  'keepErrorResults',
  'toolResultPreviewChars',
  'exposePolicySection',
  'sectionOrder',
  'indexLimit',
  'accessMaxChars',
  'dereferenceMaxChars',
  'autorunAfterThoughts',
  'autorunAfterConsole',
  'condenseSummaryTokens',
  'compactKeepRecent',
  'compactUseModel',
  'compactProvider',
  'compactModel',
  'compactMaxTokens',
  'compactTimeoutMs',
  'compactFileShrink',
  'compactDenyProviders',
  'compactAllowProviders',
])

/** Booleans accepted by {@link resolveConfig}. */
const BOOLEAN_KEYS = Object.freeze([
  'enabledByDefault',
  'autoStubToolResults',
  'dedupeFileReads',
  'keepErrorResults',
  'exposePolicySection',
  'autorunAfterThoughts',
  'autorunAfterConsole',
  'compactUseModel',
])

/** String-valued keys, accepted as-is. */
const STRING_KEYS = Object.freeze([
  'compactProvider',
  'compactModel',
  'compactFileShrink',
  'compactDenyProviders',
  'compactAllowProviders',
])

/** Non-negative integer bounds for numeric keys. */
const INTEGER_BOUNDS = Object.freeze({
  retainRecentMessages: [1, 10_000],
  toolResultPreviewChars: [0, 100_000],
  sectionOrder: [-1_000_000, 1_000_000],
  indexLimit: [0, 500],
  accessMaxChars: [500, 1_000_000],
  dereferenceMaxChars: [500, 5_000_000],
  condenseSummaryTokens: [0, 50],
  compactKeepRecent: [0, 10_000],
  compactMaxTokens: [1, 100_000],
  compactTimeoutMs: [1_000, 600_000],
})

/** @returns true for a non-array object. */
function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Validate a plugin row's `config` and fill defaults.
 * @param raw - the row config, or undefined.
 * @returns a frozen, detached configuration.
 * @throws when an unknown key or an out-of-range value is supplied.
 */
export function resolveConfig(raw) {
  const input = raw === undefined || raw === null ? {} : raw
  if (!isRecord(input)) throw new TypeError('dsh-autotrim-context: config must be an object')
  for (const key of Object.keys(input)) {
    if (!CONFIG_KEYS.includes(key)) {
      throw new TypeError(
        `dsh-autotrim-context: unknown config key "${key}" (allowed: ${CONFIG_KEYS.join(', ')})`,
      )
    }
  }
  const config = { ...DEFAULTS, ...input }
  for (const key of BOOLEAN_KEYS) {
    if (typeof config[key] !== 'boolean') {
      throw new TypeError(`dsh-autotrim-context: config "${key}" must be a boolean`)
    }
  }
  for (const key of STRING_KEYS) {
    if (typeof config[key] !== 'string') {
      throw new TypeError(`dsh-autotrim-context: config "${key}" must be a string`)
    }
  }
  if (!SHRINK_MODES.includes(config.compactFileShrink)) {
    throw new TypeError(
      `dsh-autotrim-context: config "compactFileShrink" must be one of ${SHRINK_MODES.join(', ')}`,
    )
  }
  for (const [key, [min, max]] of Object.entries(INTEGER_BOUNDS)) {
    const value = config[key]
    if (!Number.isInteger(value) || value < min || value > max) {
      throw new TypeError(
        `dsh-autotrim-context: config "${key}" must be an integer in [${min}, ${max}]`,
      )
    }
  }
  return Object.freeze(config)
}

/**
 * Concatenate the textual content of one block array.
 * @param blocks - content blocks, possibly not an array.
 * @returns the joined text.
 */
export function textFromBlocks(blocks) {
  if (!Array.isArray(blocks)) return ''
  const parts = []
  for (const block of blocks) {
    if (!isRecord(block)) continue
    if (block.type === 'text' && typeof block.text === 'string') parts.push(block.text)
    else if (block.type === 'reasoning' && typeof block.text === 'string') parts.push(block.text)
    else if (block.type === 'tool-call' && typeof block.arguments === 'string') parts.push(block.arguments)
  }
  return parts.join('\n')
}

/** Visible text of a user or system message value. */
export function messageText(message) {
  return textFromBlocks(message?.content)
}


/**
 * One runtime-unique message id. `MessageId` is a branded string, so any
 * collision-free string satisfies the durable log.
 * @returns a fresh id.
 */
export function createMessageId() {
  const crypto = globalThis.crypto
  if (crypto !== undefined && typeof crypto.randomUUID === 'function') return crypto.randomUUID()
  return `rwm-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e9).toString(36)}`
}

/**
 * Build the replacement node for a model-authored memory.
 * @param memory - the model's terse replacement text.
 * @param number - the memory's stable number, cited as `rwm-<number>`.
 * @param id - optional message id; a fresh one is created otherwise.
 * @returns a `user/message` value carrying `rwm-<number>-<memory>`.
 */
export function buildMemoryMessage(memory, number, id = createMessageId()) {
  return {
    id,
    role: 'user',
    source: { kind: 'user' },
    content: [{ type: 'text', text: `${MEMORY_PREFIX}${number}-${memory}` }],
  }
}

/**
 * First sentence of a text value, trimmed to a readable length.
 *
 * Used by condensation: the first sentence is the key point a thought is about,
 * so it becomes the core of the condensed memory.
 */
function firstSentence(text) {
  const flat = String(text ?? '').replace(/\s+/g, ' ').trim()
  if (flat.length === 0) return ''
  const stop = flat.search(/[.;!?]\s/)
  const sentence = stop === -1 ? flat : flat.slice(0, stop + 1)
  return sentence.length > 120 ? `${sentence.slice(0, 117)}...` : sentence
}

/**
 * One-line summary of the salient tokens of a text, for use inside a condensed
 * memory. Lists the most salient tokens, so the essential context stays visible
 * without the full wording.
 */
function summarizeTokens(text, maxTokens) {
  const tokens = salientTokens(text)
  if (tokens.length === 0) return ''
  return tokens.slice(0, maxTokens).join(', ')
}

/**
 * Condense a thought or console output into a less-wordy form that keeps the
 * essential context.
 *
 * The first sentence is the core (the key point the thought is about); any
 * further content is reduced to a one-line summary of its salient tokens, so
 * the memory stays short while the essential context is preserved.
 *
 * @param text - the full thought or console output.
 * @param maxTokens - maximum salient tokens a summary may list (default from DEFAULTS).
 * @returns the condensed text, or '' when the input is empty.
 */
export function condenseText(text, maxTokens = DEFAULTS.condenseSummaryTokens) {
  if (typeof text !== 'string' || text.trim().length === 0) return ''
  const flat = text.replace(/\s+/g, ' ').trim()
  const first = firstSentence(flat)
  if (first.length === 0) return flat
  const rest = flat.slice(first.length).replace(/^,?\s*/m, '').trim()
  if (rest.length === 0) return first
  const summary = summarizeTokens(rest, maxTokens)
  return `${first}${summary ? `\n${summary}` : ''}`
}

/**
 * Build the replacement node for a console-output memory.
 *
 * Console output is always folded into a `rwm-c-<n>` memory so every past
 * console output stays accessible via `rwm-c-<n>`.
 * @param memory - the condensed console-output text.
 * @param number - the memory's stable number, cited as `rwm-c-<number>`.
 * @param id - optional message id; a fresh one is created otherwise.
 * @returns a `user/message` value carrying `rwm-c-<number>-<memory>`.
 */
export function buildConsoleMemoryMessage(memory, number, id = createMessageId()) {
  return {
    id,
    role: 'user',
    source: { kind: 'user' },
    content: [{ type: 'text', text: `${CONSOLE_MEMORY_PREFIX}${number}-${memory}` }],
  }
}

/**
 * Whether a text value is a console-memory node, and its number and context.
 * @param text - a node's text, or any other value.
 * @returns `{ number, context }`, or null when it is not a console memory.
 */
export function parseConsoleMemory(text) {
  if (typeof text !== 'string') return null
  const match = CONSOLE_MEMORY_PATTERN.exec(text)
  if (match === null) return null
  return { number: Number(match[1]), context: match[2] }
}

/**
 * The next unused console-memory number.
 *
 * Derived from the log rather than counted in plugin memory, so restarts and
 * replays assign the same number to the same fold.
 * @param events - all committed session events.
 * @returns the next number, starting at 1.
 */
export function nextConsoleMemoryNumber(events) {
  let highest = 0
  for (const event of events ?? []) {
    if (event?.type !== 'user/message') continue
    const match = /^rwm-c-(\d+)-/s.exec(messageText(event.data))
    if (match !== null) highest = Math.max(highest, Number(match[1]))
  }
  return highest + 1
}

/**
 * The next unused memory number.
 *
 * Derived from the log rather than counted in plugin memory, so restarts and
 * replays assign the same number to the same fold.
 * @param events - all committed session events.
 * @returns the next number, starting at 1.
 */
export function nextMemoryNumber(events) {
  let highest = 0
  for (const event of events ?? []) {
    if (event?.type !== 'user/message') continue
    const match = /^rwm-(\d+)-/s.exec(messageText(event.data))
    if (match !== null) highest = Math.max(highest, Number(match[1]))
  }
  return highest + 1
}

/** Whether a tool output already carries this plugin's omission marker. */
export function isStubbedContent(content) {
  if (!Array.isArray(content)) return false
  return content.some(block => isRecord(block) && block.type === 'text'
    && typeof block.text === 'string' && block.text.includes(OUTPUT_MARKER))
}

/** Build the stub text for one omitted output. */
function buildOutputStub(originalText, config) {
  const preview = config.toolResultPreviewChars
  const head = preview > 0 ? originalText.slice(0, preview) : ''
  const note = `[${OUTPUT_MARKER}: ${originalText.length} chars - call ${RECALL_TOOL} to read it]`
  return head.length > 0 ? `${head}\n${note}` : note
}

/**
 * Replace the text of one tool output with a bounded recall marker while
 * preserving every other block and all pairing metadata.
 * @param content - the tool result message content.
 * @param config - resolved configuration.
 * @returns `{ content, omittedChars }`, or null when nothing should change.
 */
export function stubToolResultContent(content, config) {
  if (!Array.isArray(content)) return null
  if (isStubbedContent(content)) return null
  const kept = []
  let changed = false
  let omittedChars = 0
  for (const block of content) {
    if (isRecord(block) && block.type === 'text' && typeof block.text === 'string'
      && block.text.length > config.toolResultPreviewChars) {
      changed = true
      omittedChars += block.text.length
      kept.push({ type: 'text', text: buildOutputStub(block.text, config) })
      continue
    }
    kept.push(block)
  }
  if (!changed) return null
  return { content: kept, omittedChars }
}

/* -------------------------------------------------- file-content dedupe */

/** Whether a registered tool name means this call touched a file. */
export function isFileTool(name, readOnly = false) {
  const flat = String(name ?? '').toLowerCase()
  if (flat.length === 0) return false
  const bank = readOnly ? FILE_READ_TOOLS : FILE_TOOLS
  return bank.some(fragment => flat.includes(fragment))
}

/** The file a tool call's arguments name, or '' when none is legible. */
export function fileFromArguments(argumentsText) {
  if (typeof argumentsText !== 'string' || argumentsText.length === 0) return ''
  let args
  try {
    args = JSON.parse(argumentsText)
  } catch {
    return ''
  }
  if (!isRecord(args)) return ''
  for (const key of PATH_KEYS) {
    const value = args[key]
    if (typeof value === 'string' && value.trim().length > 0) return value.trim()
  }
  return ''
}

/**
 * Normalise a file argument into a stable identity.
 *
 * Two reads of `./a/b.js`, `a/b.js` and `a\\b.js` from one working directory are
 * the same file, so they must collapse onto one identity; anything more clever
 * (symlinks, case-insensitive volumes) would need to touch the disk, which this
 * module never does.
 * @param path - the path a tool call named.
 * @returns the identity string, or '' when nothing usable was named.
 */
export function fileIdentity(path) {
  const flat = String(path ?? '').trim().replace(/\\/g, '/')
  if (flat.length === 0) return ''
  const parts = []
  for (const segment of flat.split('/')) {
    if (segment.length === 0 || segment === '.') continue
    if (segment === '..') { parts.pop(); continue }
    parts.push(segment)
  }
  return parts.join('/').toLowerCase()
}

/** The identifying stem of a file identity, used in a note. */
export function fileLabel(path) {
  const flat = String(path ?? '').trim().replace(/\\/g, '/')
  const parts = flat.split('/').filter(segment => segment.length > 0 && segment !== '.' && segment !== '..')
  return parts.length === 0 ? flat : parts[parts.length - 1]
}

/** Build the stub text for a retired duplicate. */
function buildDuplicateStub(label, survivorLabel, originalText) {
  return `[${DUPLICATE_MARKER}: ${label} - ${originalText.length} chars already in context from `
    + `${survivorLabel}; call ${RECALL_TOOL} to read this copy]`
}

/**
 * Replace the text of a retired duplicate with a bounded recall marker, keeping
 * every other block and all pairing metadata.
 * @param content - the tool result message content.
 * @param label - the file this copy is of.
 * @param survivorLabel - the copy that stays in context.
 * @returns `{ content, omittedChars }`, or null when nothing should change.
 */
export function stubDuplicateContent(content, label, survivorLabel) {
  if (!Array.isArray(content)) return null
  if (isStubbedContent(content) || isDuplicateContent(content)) return null
  const kept = []
  let changed = false
  let omittedChars = 0
  for (const block of content) {
    if (isRecord(block) && block.type === 'text' && typeof block.text === 'string' && block.text.length > 0) {
      changed = true
      omittedChars += block.text.length
      kept.push({ type: 'text', text: buildDuplicateStub(label, survivorLabel, block.text) })
      continue
    }
    kept.push(block)
  }
  if (!changed) return null
  return { content: kept, omittedChars }
}

/** Whether a tool output is already a retired-duplicate marker. */
export function isDuplicateContent(content) {
  if (!Array.isArray(content)) return false
  return content.some(block => isRecord(block) && block.type === 'text'
    && typeof block.text === 'string' && block.text.includes(DUPLICATE_MARKER))
}

/**
 * Every surface position whose message carries a file's content.
 *
 * A position is a `tool/result` whose paired `tool/call` named a file, so the
 * call/result pair is what gets retired as a unit. The call's own arguments are
 * not content (they are a few hundred bytes of JSON), but the result is.
 *
 * @param entries - `{ seq, message }` pairs from {@link collectSurfaceEntries}.
 * @returns `{ index, seq, file, identity, callId, content }` per occurrence.
 */
export function findFileOccurrences(entries) {
  const callById = new Map()
  for (const entry of entries) {
    const message = entry.message
    if (message?.role !== 'assistant' || !Array.isArray(message.content)) continue
    for (const block of message.content) {
      if (isRecord(block) && block.type === 'tool-call' && typeof block.id === 'string') {
        callById.set(block.id, { name: block.name, arguments: block.arguments })
      }
    }
  }
  const occurrences = []
  for (let index = 0; index < entries.length; index += 1) {
    const message = entries[index].message
    if (message?.role !== 'tool') continue
    const call = callById.get(String(message.toolCallId))
    if (call === undefined) continue
    if (call.arguments !== undefined && !isFileTool(call.name)) continue
    /* A file read or edit names its file; a call that names none is not ours. */
    const file = fileFromArguments(call.arguments)
    if (file.length === 0) continue
    if (isDuplicateContent(message.content)) continue
    occurrences.push({
      index,
      seq: entries[index].seq,
      file,
      identity: fileIdentity(file),
      callId: String(message.toolCallId),
      content: message.content,
    })
  }
  return occurrences
}

/**
 * Plan the retirements that leave each file's content in context exactly once.
 *
 * Newest copy wins: the last occurrence of a file survives and every earlier one
 * is retired. Occurrences that a whole-group fold cannot reach — inside the
 * retained tail, or sharing a span with one that is — are left alone; the next
 * pass picks them up once they age out.
 *
 * @param entries - `{ seq, message }` pairs from {@link collectSurfaceEntries}.
 * @param keepRecent - newest messages left untouched.
 * @returns `{ retire, survivors }`; `retire` is ordered oldest first.
 */
export function planFileDedupe(entries, keepRecent) {
  const occurrences = findFileOccurrences(entries)
  if (occurrences.length === 0) return { retire: [], survivors: new Map() }

  const newest = new Map()
  for (const occurrence of occurrences) newest.set(occurrence.identity, occurrence)

  const keep = Math.max(1, Math.min(entries.length, keepRecent))
  const maxEnd = entries.length - keep - 1
  /* index 0 is the system prompt; nothing may be folded from it. */
  const minStart = headStartIndex(entries)

  const spans = groupSpans(entries)
  const retire = []
  for (const occurrence of occurrences) {
    const survivor = newest.get(occurrence.identity)
    if (survivor === occurrence) continue
    const span = spans.find(candidate => candidate.start <= occurrence.index && occurrence.index <= candidate.end)
    if (span === undefined) continue
    if (span.start < minStart || span.end > maxEnd) continue
    retire.push({
      ...occurrence,
      survivorSeq: survivor.seq,
      survivorLabel: fileLabel(survivor.file),
      span,
    })
  }
  retire.sort((left, right) => left.index - right.index)
  return { retire, survivors: newest }
}

/**
 * Build the altered-memory note for one retired duplicate.
 *
 * The note is written as a memory the agent reads, not as something the agent
 * ran: it states that a copy was retired, names what replaced it, and never
 * frames the retirement as a call the agent made.
 *
 * @param memory - the condensed note text.
 * @param number - the note's stable number, cited as `rwm-<number>`.
 * @param id - optional message id.
 * @returns a `user/message` value carrying `rwm-<number>-<memory>`.
 */
export function buildAlteredMemoryNote(memory, number, id = createMessageId()) {
  return buildMemoryMessage(memory, number, id)
}

/** Union-find over message indices, used to keep tool calls with their results. */
function createGroupFinder(length, entries) {
  const parent = Array.from({ length }, (_, index) => index)
  const find = (index) => {
    let root = index
    while (parent[root] !== root) root = parent[root]
    let cursor = index
    while (parent[cursor] !== cursor) {
      const next = parent[cursor]
      parent[cursor] = root
      cursor = next
    }
    return root
  }
  const callOwner = new Map()
  for (let index = 0; index < length; index += 1) {
    const message = entries[index].message
    if (message.role !== 'assistant' || !Array.isArray(message.content)) continue
    for (const block of message.content) {
      if (isRecord(block) && block.type === 'tool-call' && typeof block.id === 'string') {
        callOwner.set(block.id, index)
      }
    }
  }
  for (let index = 0; index < length; index += 1) {
    const message = entries[index].message
    if (message.role !== 'tool') continue
    const owner = callOwner.get(message.toolCallId)
    if (owner !== undefined && owner !== index) {
      const rootA = find(owner)
      const rootB = find(index)
      if (rootA !== rootB) parent[rootB] = rootA
    }
  }
  return find
}

/**
 * Contiguous index spans pairing every assistant tool call with its results.
 *
 * A fold must consume whole spans or none of them: shadowing a call while
 * leaving its result on the surface produces an orphaned tool result, which
 * providers reject.
 * @param entries - `{ seq, message }` pairs in model-visible order.
 * @returns ordered, non-overlapping `{ start, end }` index spans.
 */
export function groupSpans(entries) {
  const length = entries.length
  if (length === 0) return []
  const find = createGroupFinder(length, entries)
  const bounds = new Map()
  for (let index = 0; index < length; index += 1) {
    const root = find(index)
    const current = bounds.get(root)
    if (current === undefined) bounds.set(root, { start: index, end: index })
    else current.end = index
  }
  return [...bounds.values()].sort((left, right) => left.start - right.start)
}

/**
 * Choose the contiguous run of whole spans a memory rewrite may consume.
 *
 * Skips any span reaching left of `minStartIndex` (so the protected head stays
 * intact) and any span reaching past `maxEndIndex` (so the retained tail stays
 * intact).
 * @param spans - spans from {@link groupSpans}.
 * @param minStartIndex - first index the fold may touch.
 * @param maxEndIndex - last index the fold may touch.
 * @returns `{ startIndex, endIndex }`, or null when no whole span fits.
 */
export function selectFoldRange(spans, minStartIndex, maxEndIndex) {
  let first
  let last
  for (const span of spans) {
    if (span.end < minStartIndex) continue
    /* A span reaching left of the bound stays whole on the surface; later spans are still eligible. */
    if (span.start < minStartIndex) continue
    /* Spans are ordered and disjoint, so nothing later can fit either. */
    if (span.end > maxEndIndex) break
    if (first === undefined) first = span.start
    last = span.end
  }
  if (first === undefined || last === undefined) return null
  return { startIndex: first, endIndex: last }
}

/** Index of the first foldable position: after a leading system prompt. */
export function headStartIndex(entries) {
  return entries.length > 0 && entries[0]?.message?.role === 'system' ? 1 : 0
}

/**
 * Rebuild the model-visible transcript as `{ seq, message }` pairs.
 *
 * The harness derives request messages by walking the session surface, so this
 * reproduces that order and additionally keeps each message's sequence number —
 * the only stable handle a durable rewrite has on history.
 * @param session - live harness session.
 * @returns ordered pairs, skipping events that derive no message.
 */
export function collectSurfaceEntries(session) {
  const nodes = session?.surface?.nodes
  if (nodes === undefined || typeof nodes[Symbol.iterator] !== 'function') return []
  if (typeof session.eventAt !== 'function' || typeof session.deriveEventMessage !== 'function') return []
  const entries = []
  try {
    for (const seq of nodes) {
      const event = session.eventAt(seq)
      if (event === undefined) continue
      const message = session.deriveEventMessage(event)
      if (message !== null && message !== undefined) entries.push({ seq, message })
    }
  } catch {
    /* A session this plugin cannot derive is not ours to rewrite. */
    return []
  }
  return entries
}

/**
 * Whether a shadowed seq list is a contiguous, ascending run of the surface.
 *
 * This is the prefix-stability invariant, and it is the whole reason a rewrite
 * is cheap at the provider. A replacement may only retire a contiguous run of
 * the surface: everything before the run then stays byte-identical to what the
 * provider already cached, so only the rewritten tail is re-billed. A hole or a
 * reversed run would rewrite bytes the provider had already cached, silently
 * charging full price from that point on.
 *
 * It is asserted by the planners, which derive the run from real surface
 * entries — the one place a bug could actually introduce a gap. Checking it at
 * the append site would be vacuous, because by then the seqs come from the same
 * contiguous slice they are checked against.
 *
 * @param entries - pairs from {@link collectSurfaceEntries}, in surface order.
 * @param shadowedSeqs - the seqs a replacement intends to shadow.
 * @returns true when the seqs form one ascending contiguous run of `entries`.
 */
export function isContiguousTail(entries, shadowedSeqs) {
  if (!Array.isArray(shadowedSeqs) || shadowedSeqs.length === 0) return false
  const positions = new Map()
  entries.forEach((entry, index) => positions.set(entry.seq, index))
  const indexes = []
  for (const seq of shadowedSeqs) {
    const index = positions.get(seq)
    if (index === undefined) return false
    indexes.push(index)
  }
  for (let offset = 1; offset < indexes.length; offset += 1) {
    if (indexes[offset] !== indexes[offset - 1] + 1) return false
  }
  return true
}

/** The single contiguous run an index range covers, as seqs. */
function runSeqs(entries, startIndex, endIndex) {
  const seqs = entries.slice(startIndex, endIndex + 1).map(entry => entry.seq)
  /* Refuse to hand back a run that would not preserve the cached prefix. */
  if (!isContiguousTail(entries, seqs)) return null
  return seqs
}

/**
 * Plan one memory fold against the current surface.
 * @param entries - pairs from {@link collectSurfaceEntries}.
 * @param keepRecent - newest messages to leave untouched (at least 1).
 * @returns `{ startIndex, endIndex, shadowedSeqs }`, or null when nothing fits.
 */
export function planMemoryFold(entries, keepRecent) {
  if (entries.length === 0) return null
  const keep = Math.max(1, Math.min(entries.length, keepRecent))
  const minStart = headStartIndex(entries)
  const maxEnd = entries.length - keep - 1
  if (maxEnd < minStart) return null
  const range = selectFoldRange(groupSpans(entries), minStart, maxEnd)
  if (range === null) return null
  const shadowedSeqs = entries.slice(range.startIndex, range.endIndex + 1).map(entry => entry.seq)
  if (shadowedSeqs.length === 0) return null
  /* Never plan a fold that would rewrite bytes outside one contiguous run. */
  if (!isContiguousTail(entries, shadowedSeqs)) return null
  return { ...range, shadowedSeqs }
}

/**
 * Read the newest unapplied `rewrite_memory` intent out of the session log.
 *
 * The intent is durable by construction: the model's tool call is a logged
 * `tool/call`, so no bespoke event type is needed. Calls whose result was an
 * error are ignored, and the newest call wins.
 * @param session - live harness session.
 * @param toolName - the rewrite tool's registered name.
 * @returns `{ seq, memory, keepRecent }`, or null when none is pending.
 */
export function findPendingRewrite(session, toolName = REWRITE_TOOL) {
  const events = typeof session?.snapshotEvents === 'function' ? session.snapshotEvents() : []
  const failed = new Set()
  for (const event of events) {
    if (event?.type !== 'tool/result') continue
    if (event.data?.message?.isError === true) failed.add(String(event.data.message.toolCallId))
  }
  let pending = null
  for (const event of events) {
    if (event?.type !== 'tool/call' || event.data?.name !== toolName) continue
    if (failed.has(String(event.data.callId))) continue
    let args
    try {
      args = JSON.parse(event.data.arguments)
    } catch {
      continue
    }
    if (!isRecord(args) || typeof args.memory !== 'string' || args.memory.length === 0) continue
    pending = {
      seq: event.seq,
      memory: args.memory,
      keepRecent: Number.isInteger(args.keep_recent_messages) ? args.keep_recent_messages : undefined,
    }
  }
  return pending
}

/**
 * Whether a rewrite intent already landed on the surface.
 *
 * The checkpoint is appended after the call it answers, so a visible
 * `user/message` with the exact expected text at a later seq proves the fold
 * happened. That makes repeated pre-step passes idempotent across restarts.
 * @param session - live harness session.
 * @param callSeq - seq of the rewrite tool call.
 * @param memory - the memory text that fold would produce; the number is ignored.
 * @returns true when the fold is already on the surface.
 */
export function isRewriteApplied(session, callSeq, memory) {
  const nodes = session?.surface?.nodes
  if (nodes === undefined || typeof nodes[Symbol.iterator] !== 'function') return false
  /*
   * Match on the memory text, not on its number: a later pass computes the next
   * number, so comparing numbered text would re-fold the same intent forever.
   */
  const expected = new RegExp(`^rwm-\\d+-${escapeForRegExp(memory)}$`, 's')
  for (const seq of nodes) {
    if (typeof seq !== 'number' || seq <= callSeq) continue
    const event = session.eventAt?.(seq)
    if (event?.type !== 'user/message') continue
    if (expected.test(messageText(event.data))) return true
  }
  return false
}

/** Escape one literal string for use inside a RegExp. */
function escapeForRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}


/** Whether an event is a replacement copy rather than an append-origin record. */
export function isReplacementCopy(event) {
  const op = event?.surfaceOp
  return isRecord(op) && op.op === 'replace'
}

/* ---------------------------------------------------------- rwm compact */

/** Marker prefix for a file record: the terse stand-in for a file's bytes. */
export const FILE_RECORD_PREFIX = 'file'

/** Marker prefix for a console/tool condensation inside a compact memory. */
export const TOOL_RECORD_PREFIX = 'tool'

/**
 * The reference arrow in a file record: `file src/a.js written ... 1204b ->214`.
 *
 * This is the "symlink": the record is a pointer, not a copy. The number after
 * the arrow is a real session seq, so the existing citation tools resolve it and
 * pull back the actual bytes that were in context. Nothing is written to disk to
 * make it work — it is a citation, not a filesystem link.
 */
export const REFERENCE_ARROW = '->'

/** How much of a file's content a memory keeps. */
export const SHRINK_MODES = Object.freeze(['reference', 'partial', 'full'])

/**
 * Default shrink policy: point at the file, keep its first line as a hint.
 *
 * `partial` is the balance point. A bare `reference` saves the most bytes but
 * costs a recall round-trip to learn even the file's shape; `full` re-emits the
 * whole document, which is what the reference exists to avoid.
 */
export const DEFAULT_FILE_SHRINK = 'partial'

/** Lines of a file kept by `partial`, and the longest first line that is useful as a hint. */
export const PARTIAL_HINT_LINES = 3
const PARTIAL_LINE_CHARS = 120

/** Clock used by {@link buildFileRecord}; overridable so tests are deterministic. */
let clock = () => new Date()

/**
 * Replace the process clock used to timestamp file records.
 * @param next - returns the `Date` a record should carry.
 */
export function setCompactionClock(next) {
  clock = typeof next === 'function' ? next : () => new Date()
}

/** The current timestamp in the compact `YYYY-MM-DDTHH:MM:SSZ` form. */
function compactTimestamp(date = clock()) {
  try {
    return date.toISOString().replace(/\.\d{3}Z$/, 'Z')
  } catch {
    return 'unknown'
  }
}

/**
 * Build the terse record that stands in for one file's content.
 *
 * The record is a **pointer**, not a copy. Its arrow names the session seq that
 * holds the real bytes, so the file content is one citation away and the record
 * itself stays a line. This is what makes the memory safe to keep: it cannot go
 * stale, it cannot disagree with the file, and it costs almost nothing.
 *
 * Three shapes, because the right trade-off depends on the file:
 *
 * - `reference`: `file src/a.js written 2026-01-01T00:00:00Z 1204b ->214` — a
 *   pure pointer. Cheapest, and the only shape that is stable forever.
 * - `partial`: the record plus the file's opening lines, so the agent can
 *   recognise the file without spending a recall.
 * - `full`: the record plus the whole document. Only worth it for a file the
 *   agent must reason over immediately.
 *
 * @param file - the file path a tool call named.
 * @param options - `action`, `bytes`, `at`, `shrink`, `seqs`, and `content`.
 * @returns the record, e.g. `file src/a.js read 2026-01-01T00:00:00Z 690b ->214`.
 */
export function buildFileRecord(file, options = {}) {
  const label = String(file ?? '').trim()
  if (label.length === 0) return ''
  const action = options.action === 'write' ? 'written' : 'read'
  const at = options.at ?? compactTimestamp()
  const size = Number.isFinite(options.bytes) && options.bytes >= 0 ? ` ${options.bytes}b` : ''
  const seqs = Array.isArray(options.seqs) ? options.seqs.filter(seq => Number.isInteger(seq)) : []
  const reference = seqs.length === 0 ? '' : ` ${REFERENCE_ARROW}${seqs.join(',')}`
  const head = `${FILE_RECORD_PREFIX} ${label} ${action} ${at}${size}${reference}`

  const shrink = SHRINK_MODES.includes(options.shrink) ? options.shrink : DEFAULT_FILE_SHRINK
  const content = typeof options.content === 'string' ? options.content : ''
  if (shrink === 'reference') return head
  if (content.length === 0) return head
  if (shrink === 'full') return `${head}\n${content}`

  // partial: the opening lines are a recognition hint, not the document.
  const lines = content.split('\n').slice(0, PARTIAL_HINT_LINES)
    .map(line => clipLine(line, PARTIAL_LINE_CHARS))
    .filter(line => line.length > 0)
  if (lines.length === 0) return head
  const truncated = content.split('\n').length > PARTIAL_HINT_LINES
  return `${head}\n${lines.join('\n')}${truncated ? '\n...' : ''}`
}

/** The seqs a file record points at, read back out of its arrow. */
export function fileRecordReference(record) {
  const match = String(record ?? '').match(/\s->([\d,]+)(?:\s|$)/)
  if (match === null) return []
  return match[1].split(',').map(part => Number.parseInt(part, 10)).filter(Number.isInteger)
}

/** Whether a line looks like a file record rather than prose or memory text. */
export function isFileRecordLine(line) {
  return new RegExp(`^\\s*${FILE_RECORD_PREFIX} \\S`).test(String(line ?? ''))
}

/**
 * Check a model-written memory's file records against the truth, and repair them.
 *
 * The instruction to "copy file records verbatim and invent nothing" is a
 * request, not a guarantee. This turns it into one: every `file ...` line the
 * model wrote is compared against the records actually collected from the
 * session, and any line naming a file that was never touched — or misstating a
 * touched file's action, size, or reference — is replaced with the true record.
 *
 * Model *prose* is never rewritten. A model that writes a good summary around one
 * bad path keeps the summary; only the wrong line changes, and the caller is told
 * exactly what was corrected.
 *
 * @param text - the model's summary.
 * @param truths - the authoritative records, from {@link buildFileRecord}.
 * @returns `{ text, corrections, invented }` — the repaired text and what changed.
 */
export function verifyFileRecords(text, truths) {
  const summary = String(text ?? '')
  if (summary.length === 0) return { text: summary, corrections: [], invented: [] }
  const trust = new Map()
  for (const record of truths ?? []) {
    const identity = fileRecordIdentity(record)
    if (identity.length > 0) trust.set(identity, record)
  }
  const corrections = []
  const invented = []
  const lines = summary.split('\n').map((line) => {
    if (!isFileRecordLine(line)) return line
    const identity = fileRecordIdentity(line)
    const truth = trust.get(identity)
    if (truth === undefined) {
      /*
       * A file the session never touched. Dropping the line entirely would lose
       * the model's intent, but keeping it asserts a falsehood, so it becomes an
       * explicit unverified note the agent can see through.
       */
      invented.push(identity)
      corrections.push({ identity, reason: 'not in the session', replaced: line })
      return `${FILE_RECORD_PREFIX} ${identity} UNVERIFIED (no such tool call in this session)`
    }
    if (line.trim() === truth.trim()) return line
    corrections.push({ identity, reason: 'recorded differently', replaced: line })
    return truth
  })
  return { text: lines.join('\n'), corrections, invented }
}

/** The file identity a record line names, for matching against the truth. */
function fileRecordIdentity(line) {
  const match = String(line ?? '').match(new RegExp(`^\\s*${FILE_RECORD_PREFIX} (\\S+)`))
  if (match === null) return ''
  return fileIdentity(match[1])
}

/**
 * Pair each surface node with the file it touched, newest occurrence last.
 *
 * A read and a write of one file collapse to a single record: the write is what
 * matters, because the file as it stands now is the thing worth remembering.
 *
 * @param entries - pairs from {@link collectSurfaceEntries}.
 * @param events - the session's snapshot events, for tool-call arguments.
 * @returns a map of file identity to its record and the seqs it stands for.
 */
export function collectFileRecords(entries, events = []) {
  const callsByIndex = new Map()
  for (let index = 0; index < entries.length; index += 1) {
    const message = entries[index].message
    if (message?.role === 'assistant' && Array.isArray(message.content)) {
      for (const block of message.content) {
        if (isRecord(block) && block.type === 'tool-call' && typeof block.id === 'string') {
          callsByIndex.set(block.id, { name: block.name, arguments: block.arguments })
        }
      }
    }
  }
  const records = new Map()
  for (let index = 0; index < entries.length; index += 1) {
    const { seq, message } = entries[index]
    if (message?.role !== 'tool') continue
    const callId = typeof message.toolCallId === 'string' ? message.toolCallId : ''
    const call = callsByIndex.get(callId)
    if (call === undefined) continue
    const name = String(call.name ?? '')
    if (!isFileTool(name)) continue
    const file = fileFromArguments(call.arguments)
    if (file.length === 0) continue
    const identity = fileIdentity(file)
    if (identity.length === 0) continue
    const text = textOfContent(message.content)
    const existing = records.get(identity)
    const action = isFileTool(name, true) ? 'read' : 'write'
    if (existing !== undefined) {
      existing.seqs.push(seq)
      existing.bytes += text.length
      if (action === 'write') existing.action = 'write'
      /*
       * The newest occurrence is the one a `partial` hint should quote, and the
       * one whose seq the reference should prefer: it is the version closest to
       * the file as it stands now.
       */
      existing.content = text
      existing.latestSeq = seq
      continue
    }
    records.set(identity, {
      file,
      label: fileLabel(file),
      identity,
      action,
      bytes: text.length,
      seqs: [seq],
      latestSeq: seq,
      content: text,
      event: events.find(event => event?.seq === seq),
    })
  }
  return records
}

/** Flatten message content to its text. */
function textOfContent(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  let text = ''
  for (const block of content) {
    if (isRecord(block) && block.type === 'text' && typeof block.text === 'string') text += block.text
  }
  return text
}

/**
 * Whether text is already a rewritten-memory node.
 *
 * Compaction must skip these: a memory of a memory is how a fold eats its own
 * output, and the earlier memories are separately citable anyway.
 * @param text - the message text.
 * @returns true when the text opens with a memory prefix.
 */
export function isMemoryText(text) {
  const flat = String(text ?? '').trimStart()
  return flat.startsWith(CONSOLE_MEMORY_PREFIX) || flat.startsWith(MEMORY_PREFIX)
}

/**
 * Collect every non-file tool result worth remembering as one line.
 *
 * Errors are kept because "this failed" is exactly the kind of thing a compacted
 * context must not lose.
 *
 * @param entries - pairs from {@link collectSurfaceEntries}.
 * @param keepErrors - whether error results survive compaction.
 * @returns a list of `{ seq, name, text }`, newest last.
 */
export function collectToolRecords(entries, keepErrors = true) {
  const callsByIndex = new Map()
  for (const entry of entries) {
    const message = entry.message
    if (message?.role === 'assistant' && Array.isArray(message.content)) {
      for (const block of message.content) {
        if (isRecord(block) && block.type === 'tool-call' && typeof block.id === 'string') {
          callsByIndex.set(block.id, { name: block.name, arguments: block.arguments })
        }
      }
    }
  }
  const records = []
  for (const { seq, message } of entries) {
    if (message?.role !== 'tool') continue
    const callId = typeof message.toolCallId === 'string' ? message.toolCallId : ''
    const call = callsByIndex.get(callId)
    const name = String(call?.name ?? 'tool')
    if (isFileTool(name)) continue
    if (message.isError === true && !keepErrors) continue
    const text = textOfContent(message.content).replace(/\s+/g, ' ').trim()
    records.push({ seq, name, text, isError: message.isError === true })
  }
  return records
}

/**
 * Fold repeated identical calls into one line carrying a count.
 *
 * A long session tends to run the same command many times, and forty identical
 * `bash` lines cost more than they tell: that it ran forty times is worth one
 * line, and the distinct outputs are the ones worth naming. Repetition is judged
 * on the clipped text, so near-identical output collapses too.
 *
 * @param records - rows from {@link collectToolRecords}.
 * @param clip - bound applied to each line.
 * @param repeatLimit - how many distinct repetitions are listed before summarising.
 * @returns lines in first-seen order.
 */
function summarizeToolRecords(records, clip, repeatLimit) {
  const groups = new Map()
  for (const record of records) {
    const text = clipLine(record.text, clip)
    const key = `${record.name}\u0000${record.isError ? '!' : ''}${text}`
    const existing = groups.get(key)
    if (existing === undefined) {
      groups.set(key, { name: record.name, isError: record.isError, text, count: 1 })
      continue
    }
    existing.count += 1
  }
  const lines = []
  for (const group of groups.values()) {
    const label = `${TOOL_RECORD_PREFIX} ${group.name}${group.isError ? ' FAILED' : ''}`
    const repeat = group.count > 1 ? ` x${group.count}` : ''
    lines.push(`${label}${repeat}: ${group.text}`)
    if (lines.length >= repeatLimit) break
  }
  if (groups.size > repeatLimit) lines.push(`(${groups.size - repeatLimit} more distinct tool result(s) omitted)`)
  return lines
}

/** Truncate one line to a bound, marking the cut. */
function clipLine(text, max) {
  const flat = String(text ?? '').replace(/\s+/g, ' ').trim()
  if (flat.length <= max) return flat
  /*
   * Cut at the last word boundary so a clipped log does not end in half a
   * token; the words themselves are already whitespace-collapsed, so this
   * cannot reintroduce a newline.
   */
  const cut = flat.slice(0, max)
  const boundary = cut.lastIndexOf(' ')
  const kept = boundary > max * 0.5 ? cut.slice(0, boundary) : cut
  return `${kept}...`
}

/**
 * Plan a `/rwm compact` pass over the whole conversation.
 *
 * Everything older than the retained tail is replaced by one numbered memory.
 * The plan is deterministic and never touches a file's bytes: files become
 * records, other tool output becomes one clipped line each, and agent prose
 * becomes its first sentence.
 *
 * @param entries - pairs from {@link collectSurfaceEntries}.
 * @param options - `keepRecent`, `events`, `keepErrors`, and line bounds.
 * @returns a plan, or null when there is nothing safely compactable.
 */
export function planCompact(entries, options = {}) {
  const keepRecent = Number.isInteger(options.keepRecent) ? Math.max(0, options.keepRecent) : 1
  if (!Array.isArray(entries) || entries.length === 0) return null
  const minStart = headStartIndex(entries)
  const maxEnd = entries.length - 1 - keepRecent
  if (maxEnd < minStart) return null
  const range = selectCompactRange(entries, minStart, maxEnd)
  if (range === null) return null
  const covered = entries.slice(range.startIndex, range.endIndex + 1)
  if (covered.length === 0) return null

  const events = Array.isArray(options.events) ? options.events : []
  const fileRecords = collectFileRecords(covered, events)
  const toolRecords = collectToolRecords(covered, options.keepErrors !== false)
  const prose = []
  for (const { message } of covered) {
    if (message?.role !== 'user') continue
    if (isMemoryText(textOfContent(message.content))) continue
    prose.push(textOfContent(message.content))
  }

  const files = []
  for (const record of fileRecords.values()) {
    files.push(buildFileRecord(record.file, {
      action: record.action,
      bytes: record.bytes,
      at: record.at,
      seqs: [record.latestSeq ?? record.seqs[record.seqs.length - 1]],
      shrink: options.fileShrink ?? DEFAULT_FILE_SHRINK,
      content: record.content,
    }))
  }
  const tools = summarizeToolRecords(
    toolRecords,
    options.toolLineChars ?? 120,
    options.toolLineLimit ?? 40,
  )
  const asks = prose.map(text => clipLine(text, options.userLineChars ?? 200)).filter(text => text.length > 0)

  const shadowedSeqs = covered.map(entry => entry.seq)
  if (!isContiguousTail(entries, shadowedSeqs)) return null
  return {
    startIndex: range.startIndex,
    endIndex: range.endIndex,
    startSeq: shadowedSeqs[0],
    endSeq: shadowedSeqs[shadowedSeqs.length - 1],
    shadowedSeqs,
    files,
    tools,
    asks,
    coveredCount: covered.length,
  }
}

/**
 * Choose the contiguous run to compact.
 *
 * Unlike a fold, which keeps whole call/result groups intact, a compaction is
 * allowed to end anywhere: the result is one node summarising everything, so
 * splitting a call from its result loses nothing that the summary does not
 * already carry.
 */
function selectCompactRange(entries, minStart, maxEnd) {
  if (maxEnd < minStart) return null
  return { startIndex: minStart, endIndex: maxEnd }
}

/**
 * The smallest surface span a wipe may replace, and where it starts.
 *
 * Node 0 is the system prompt and is never replaced: it is the frame the model
 * reasons inside, the one thing the user asked to keep. A wipe therefore covers
 * the second node through the tail.
 *
 * @param entries - pairs from {@link collectSurfaceEntries}.
 * @returns `{ startIndex, endIndex, shadowedSeqs }`, or null when nothing may go.
 */
export function planWipe(entries) {
  if (!Array.isArray(entries) || entries.length <= 1) return null
  const startIndex = 1
  const endIndex = entries.length - 1
  const shadowedSeqs = runSeqs(entries, startIndex, endIndex)
  if (shadowedSeqs === null) return null
  return { startIndex, endIndex, shadowedSeqs, startSeq: shadowedSeqs[0], endSeq: shadowedSeqs[shadowedSeqs.length - 1] }
}

/**
 * Build the deterministic body of a compact memory.
 *
 * The order is deliberate: what changed on disk first (the thing the agent
 * cannot recover by re-reading its own history), then what it ran, then what it
 * was asked. Every line is bounded, so the memory's size does not grow with the
 * conversation it replaces.
 *
 * @param plan - a plan from {@link planCompact}.
 * @param options - `header` text and whether to include each section.
 * @returns the memory text.
 */
export function buildCompactMemory(plan, options = {}) {
  const lines = []
  const header = options.header ?? `earlier work compacted (${plan.coveredCount} entries)`
  lines.push(header)
  if (plan.files.length > 0) {
    lines.push(`files: ${plan.files.length}`)
    for (const record of plan.files) lines.push(record)
  }
  if (plan.tools.length > 0) {
    lines.push(`tools: ${plan.tools.length}`)
    for (const record of plan.tools) lines.push(record)
  }
  if (plan.asks.length > 0) {
    lines.push('asked:')
    for (const record of plan.asks) lines.push(record)
  }
  return lines.join('\n')
}

/**
 * The instruction handed to a model asked to write the compact memory.
 *
 * It is deliberately rigid: the model rewrites the conversation into the terse
 * form, and is told to copy file records verbatim rather than invent file
 * contents, because a memory that hallucinates a file is worse than no memory.
 * @returns the system instruction.
 */
export function compactSystemPrompt() {
  return [
    'Rewrite the supplied conversation into the tersest possible memory for an AI coding agent.',
    'Keep every file path, command, error, decision, and open question.',
    'Never invent, quote, or summarise the contents of a file: copy any "file ..." line verbatim, because the agent re-reads files from disk.',
    'Drop pleasantries, restatement, and reasoning that led nowhere.',
    'Answer in plain text only, with no Markdown fences, no preamble, and no closing remarks.',
  ].join(' ')
}

/**
 * Frame a plan for a model, as plain text with the sections preserved.
 * @param plan - a plan from {@link planCompact}.
 * @returns the user message content.
 */
export function compactUserPrompt(plan) {
  return `Rewrite this into one terse memory:\n${buildCompactMemory(plan)}`
}

/**
 * Decide which model route a `/rwm compact` call may use.
 *
 * A coding session's own route is often the expensive one, so it is never used
 * implicitly: the configured pair wins, and an implicit pick must clear the deny
 * list unless the provider is explicitly allowed. Nothing here guesses at price;
 * it only refuses known-costly routes and says so.
 *
 * @param config - resolved configuration.
 * @param available - provider ids the `llm` service currently advertises.
 * @param current - the session's own route; its model is reused only when the
 *   chosen provider is the same one the session already runs.
 * @param modelsByProvider - optional map of provider id to advertised model ids.
 * @returns `{ provider, model, reason }`, or `{ error }` explaining the refusal.
 */
export function chooseCompactRoute(config, available = [], current = undefined, modelsByProvider = undefined) {
  const provider = String(config?.compactProvider ?? '').trim()
  const model = String(config?.compactModel ?? '').trim()
  if (provider.length > 0 && model.length > 0) {
    return { provider, model, reason: 'configured' }
  }
  const denied = splitList(config?.compactDenyProviders)
  const allowed = splitList(config?.compactAllowProviders)
  const permits = (id) => {
    const flat = String(id).toLowerCase()
    if (allowed.some(entry => entry === flat)) return true
    return !denied.some(fragment => fragment.length > 0 && flat.includes(fragment))
  }
  const candidates = available.filter(permits)
  if (candidates.length === 0) {
    return {
      error: `no permitted provider is available (denied: ${denied.join(', ') || 'none'}; `
        + `set compactProvider and compactModel, or allow one with compactAllowProviders)`,
    }
  }
  const chosen = candidates[0]
  /*
   * Name a real model: the session's own when the provider matches it, else the
   * first one the provider advertises. A route with an empty model cannot be
   * called, so returning '' would turn "pick a cheap model" into a silent no-op.
   */
  const own = String(current?.model ?? '').trim()
  const sameProvider = String(current?.provider ?? '').toLowerCase() === String(chosen).toLowerCase()
  const advertised = modelsByProvider?.[chosen]
  const first = Array.isArray(advertised) && typeof advertised[0] === 'string' ? advertised[0].trim() : ''
  const resolved = sameProvider && own.length > 0 ? own : first
  if (resolved.length === 0) {
    return {
      error: `provider "${chosen}" is permitted but advertises no model; `
        + 'set compactModel to name one explicitly',
    }
  }
  return { provider: chosen, model: resolved, reason: 'implicit' }
}

/** Split a comma/space separated config list into lowercased entries. */
function splitList(value) {
  return String(value ?? '')
    .split(/[,\s]+/)
    .map(entry => entry.trim().toLowerCase())
    .filter(entry => entry.length > 0)
}

