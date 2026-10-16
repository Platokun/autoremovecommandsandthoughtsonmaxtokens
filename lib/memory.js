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

/** Low-friction defaults for a coding agent near its context limit. */
export const DEFAULTS = Object.freeze({
  enabledByDefault: false,
  retainRecentMessages: 8,
  autoStubToolResults: true,
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
})

/** Every accepted configuration key. */
export const CONFIG_KEYS = Object.freeze([
  'enabledByDefault',
  'retainRecentMessages',
  'autoStubToolResults',
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
])

/** Booleans accepted by {@link resolveConfig}. */
const BOOLEAN_KEYS = Object.freeze([
  'enabledByDefault',
  'autoStubToolResults',
  'keepErrorResults',
  'exposePolicySection',
  'autorunAfterThoughts',
  'autorunAfterConsole',
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
