/**
 * `@local/dsh-autotrim-context` — a gateable, citable rewritten memory.
 *
 * Disabled by default. `/rwm enable` turns it on for the session; `/rwm disable`
 * turns it off again. While it is on:
 *
 *   - `rewrite_memory` folds everything older than the retained tail into one
 *     numbered memory node, `rwm-<n>-<context>`, replacing the model's own
 *     history with a memory it wrote itself.
 *   - Retired tool output is replaced by a short recall marker.
 *   - Every user message, agent message, and tool call carries a **stable
 *     number**, and an agent message's thoughts and paragraphs are split into
 *     citable **chunks**. Replies carry a compact index of what the model can no
 *     longer see, so it can cite `[12, 15-17, rwm-3]`.
 *   - `rwm_access` resolves those citations. Each request states its reasoning,
 *     which is judged against the derived **reasoning lock** of the content —
 *     the "I need 2022 data, but this is all 2023" check.
 *   - `$rwm-<n>-full` in the agent's own reply pulls a memory's originals back in.
 *
 * Every rewrite is a durable surface replacement preceded by its
 * `compaction/prune` shadow price, so the context meter, the composition
 * breakdown, and `/compact`'s pressure gate all measure what will really be
 * sent. Nothing is hidden from them because nothing is hidden from the surface.
 *
 * Originals are never destroyed: a replacement shadows a log entry. Access goes
 * through the lock, not through deletion.
 *
 * This module imports nothing from the harness: it is a plain ESM host plugin
 * that runs from any directory without a build step or a node_modules link.
 *
 * @module @local/dsh-autotrim-context
 */

import {
  MEMORY_PREFIX,
  REWRITE_TOOL,
  buildMemoryMessage,
  collectSurfaceEntries,
  findPendingRewrite,
  isRewriteApplied,
  nextMemoryNumber,
  planMemoryFold,
  resolveConfig,
  stubToolResultContent,
} from './lib/memory.js'
import {
  buildIndex,
  judge,
  parseCitations,
  renderIndex,
  resolveCitations,
} from './lib/history.js'

export const name = 'dsh-autotrim-context'
export const inject = ['tools', 'sessions', 'llm']

/** Tool that resolves citations under a reasoning lock. */
export const ACCESS_TOOL = 'rwm_access'

/** Command that gates the whole feature. */
export const COMMAND = 'rwm'

/** `$rwm-<n>-full` written by the agent to pull a memory back in. */
const DEREFERENCE = /\$rwm-(\d+)(?:-full)?\b/g

/**
 * Activate the plugin.
 * @param ctx - Cordis context.
 * @param rawConfig - the loader row's `config`.
 */
export function apply(ctx, rawConfig) {
  const config = resolveConfig(rawConfig)
  /** Explicit per-session overrides; absent means the configured default. */
  const overrides = new Map()
  const isOn = session => overrides.get(String(session?.id)) ?? config.enabledByDefault
  const setOn = (session, on) => { overrides.set(String(session?.id), on) }

  const warn = (message) => {
    try {
      ctx.logger?.warn?.(`dsh-autotrim-context: ${message}`)
    } catch { /* Logging must never break a turn. */ }
  }

  registerTools(ctx, config, isOn)
  registerCommand(ctx, isOn, setOn, warn)
  registerDurableTrim(ctx, config, warn, isOn)
  registerDereference(ctx, config, warn, isOn)
  registerPrompt(ctx, config, warn, isOn)
}

/** Human-readable form of an unknown thrown value. */
function describe(error) {
  return error instanceof Error ? error.message : String(error)
}

/* ------------------------------------------------------------------- tools */

function registerTools(ctx, config, isOn) {
  ctx.tools.register({
    name: REWRITE_TOOL,
    description: [
      'Replace older history in your context with a memory you write.',
      `Everything older than the last keep_recent_messages messages becomes one numbered node, "${MEMORY_PREFIX}<n>-<memory>",`,
      'and the tool call that asked for it is forgotten along with the rest.',
      'Write whatever is worth keeping - decisions, file paths, open threads - as tersely as you can.',
      `Cite it later as ${MEMORY_PREFIX}<n>; ${ACCESS_TOOL} resolves it, and $rwm-<n>-full pulls it back in.`,
    ].join(' '),
    parameters: {
      type: 'object',
      properties: {
        memory: { type: 'string', description: 'The replacement text, as terse as possible.' },
        keep_recent_messages: {
          type: 'integer',
          description: `Newest messages kept verbatim (default ${config.retainRecentMessages}, minimum 1).`,
        },
      },
      required: ['memory'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: { applied: { type: 'boolean' }, summary: { type: 'string' } },
        required: ['applied', 'summary'],
        additionalProperties: false,
      },
      render: (_args, value) => [{ type: 'text', text: value.summary }],
    },
    async execute(args, exec) {
      const session = exec?.agent?.session
      if (!isOn(session)) {
        throw new Error(`${REWRITE_TOOL}: rewritten memory is off for this session; the user enables it with /${COMMAND} enable`)
      }
      const memory = typeof args?.memory === 'string' ? args.memory : ''
      if (memory.length === 0) throw new Error(`${REWRITE_TOOL}: "memory" must be a non-empty string`)
      const requested = args?.keep_recent_messages
      if (requested !== undefined && (!Number.isInteger(requested) || requested < 1)) {
        throw new Error(`${REWRITE_TOOL}: "keep_recent_messages" must be an integer of at least 1`)
      }
      const keep = requested ?? config.retainRecentMessages
      const plan = planMemoryFold(collectSurfaceEntries(session), keep)
      if (plan === null) {
        return {
          applied: false,
          summary: `Nothing to replace: the conversation already fits inside the last ${keep} message(s). `
            + 'Retry with a smaller keep_recent_messages to forget more.',
        }
      }
      return {
        applied: true,
        summary: `Recorded. On your next request, ${plan.shadowedSeqs.length} older message(s) become one memory node. `
          + `It will be numbered; cite it as ${MEMORY_PREFIX}<n> and resolve it with ${ACCESS_TOOL}.`,
      }
    },
  })

  ctx.tools.register({
    name: ACCESS_TOOL,
    description: [
      'Resolve citations into the exact content they name.',
      'Cite a message number (12), a range (15-17), one chunk of a message (12.3), or a whole memory (rwm-3).',
      'State your reasoning: it is checked against the content\u2019s reasoning lock, and a request whose terms',
      'contradict the content is refused with the lock as the explanation.',
      'Chunks are paragraphs and list items, so cite the smallest thing that answers your question.',
    ].join(' '),
    parameters: {
      type: 'object',
      properties: {
        citations: { type: 'string', description: 'e.g. "12, 15-17, rwm-3".' },
        reason: { type: 'string', description: 'Why you need this content. Required; it is what gets judged.' },
        max_chars: { type: 'integer', description: `Budget for the whole answer (default ${config.accessMaxChars}).` },
      },
      required: ['citations', 'reason'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          granted: { type: 'boolean' },
          text: { type: 'string' },
          lock: { type: 'string' },
          chars: { type: 'integer' },
        },
        required: ['granted', 'text', 'lock', 'chars'],
        additionalProperties: false,
      },
      render: (_args, value) => [{ type: 'text', text: value.text }],
    },
    async execute(args, exec) {
      const session = exec?.agent?.session
      if (session === undefined) throw new Error(`${ACCESS_TOOL}: no live session`)
      const reason = typeof args?.reason === 'string' ? args.reason.trim() : ''
      if (reason.length === 0) throw new Error(`${ACCESS_TOOL}: "reason" must be non-empty; the lock is judged against it`)
      const maxChars = Number.isInteger(args?.max_chars) && args.max_chars > 0 ? args.max_chars : config.accessMaxChars
      return access(session, String(args?.citations ?? ''), reason, maxChars)
    },
  })
}

/**
 * Resolve one citation request and judge it against the content's lock.
 * @returns the canonical access result.
 */
function access(session, citations, reason, maxChars) {
  const parsed = parseCitations(citations)
  if (parsed.error !== undefined) return { granted: false, text: parsed.error, lock: '', chars: 0 }

  const events = session.snapshotEvents()
  const index = buildIndex(events)
  const resolved = resolveCitations(index, events, parsed, { maxChars })
  if (resolved.error !== undefined) {
    return { granted: false, text: resolved.error, lock: '', chars: resolved.chars ?? 0 }
  }
  if (resolved.items.length === 0) {
    const detail = resolved.warnings.length > 0 ? ` ${resolved.warnings.join('; ')}.` : ''
    return { granted: false, text: `Nothing matched those citations.${detail}`, lock: '', chars: 0 }
  }
  const body = resolved.items.map(item => `--- ${item.label} (${item.kind}) ---\n${item.text}`).join('\n\n')
  const verdict = judge(reason, body)
  if (verdict.verdict === 'deny') {
    /*
     * The refusal is a warning for this one call, never durable context: what
     * was asked and what was refused stay in the log through the tool call, so
     * an independent review can weigh them again later.
     */
    return {
      granted: false,
      lock: verdict.lock,
      chars: 0,
      text: `Refused. Your reasoning names ${verdict.missing.join(', ')}, which this content does not contain.\n`
        + `Reasoning lock: ${verdict.lock}\n`
        + 'Nothing was sent, and this refusal will not appear in your context again. '
        + 'If you still need it, cite the specific chunks you want and say why that content answers your question.',
    }
  }
  return { granted: true, text: body, lock: verdict.lock, chars: resolved.chars }
}

/* ----------------------------------------------------------------- command */

function registerCommand(ctx, isOn, setOn, warn) {
  ctx.inject(['commands'], (scope) => {
    try {
      scope.commands.register({
        name: COMMAND,
        description: 'Turn rewritten memory on or off for this session',
        input: { hint: 'enable | disable | status' },
        handler: (invocation) => {
          const session = invocation.agent?.session
          const verb = invocation.rawInput.trim().toLowerCase()
          if (verb === 'enable') {
            setOn(session, true)
            return { kind: 'success', text: 'Rewritten memory enabled for this session.' }
          }
          if (verb === 'disable') {
            setOn(session, false)
            return { kind: 'success', text: 'Rewritten memory disabled for this session.' }
          }
          if (verb === '' || verb === 'status') {
            return {
              kind: 'success',
              text: `Rewritten memory is ${isOn(session) ? 'enabled' : 'disabled'} for this session.`,
            }
          }
          return { kind: 'error', text: `Usage: /${COMMAND} enable | disable | status` }
        },
      })
    } catch (error) {
      warn(`could not register /${COMMAND}: ${describe(error)}`)
    }
  })
}

/* -------------------------------------------------------- durable trimming */

function registerDurableTrim(ctx, config, warn, isOn) {
  ctx.on('agent/pre-step', async ({ agent, signal }, next) => {
    const session = agent?.session
    if (session !== undefined && isOn(session) && signal?.aborted !== true) {
      try {
        applyMemoryRewrite(ctx, config, session, warn)
      } catch (error) {
        warn(`memory rewrite failed: ${describe(error)}; continuing the turn`)
      }
      if (config.autoStubToolResults) {
        try {
          stubRetiredToolResults(ctx, config, session, warn)
        } catch (error) {
          warn(`tool-output trimming failed: ${describe(error)}; continuing the turn`)
        }
      }
    }
    return next()
  })
}

function applyMemoryRewrite(ctx, config, session, warn) {
  const pending = findPendingRewrite(session, REWRITE_TOOL)
  if (pending === null) return null
  if (isRewriteApplied(session, pending.seq, pending.memory)) return null
  const number = nextMemoryNumber(session.snapshotEvents())

  const plan = planMemoryFold(collectSurfaceEntries(session), pending.keepRecent ?? config.retainRecentMessages)
  if (plan === null) return null
  appendReplacement(ctx, session, {
    type: 'user/message',
    data: buildMemoryMessage(pending.memory, number),
    shadowedSeqs: plan.shadowedSeqs,
    warn,
  })
  return plan
}

function stubRetiredToolResults(ctx, config, session, warn) {
  const entries = collectSurfaceEntries(session)
  const cutoff = entries.length - config.retainRecentMessages
  if (cutoff <= 0) return 0
  let stubbed = 0
  for (let index = 0; index < cutoff; index += 1) {
    const { seq, message } = entries[index]
    if (message.role !== 'tool') continue
    if (config.keepErrorResults && message.isError === true) continue
    const built = stubToolResultContent(message.content, config)
    if (built === null) continue
    const event = typeof session.eventAt === 'function' ? session.eventAt(seq) : undefined
    if (event === undefined || event.type !== 'tool/result') continue
    appendReplacement(ctx, session, {
      type: 'tool/result',
      data: { ...event.data, message: { ...event.data.message, content: built.content } },
      shadowedSeqs: [seq],
      warn,
    })
    stubbed += 1
  }
  return stubbed
}

/**
 * Append one durable surface replacement, preceded by its shadow price.
 *
 * The `compaction/prune` event and the replacement must be adjacent: the O(1)
 * pressure fold keeps bounded state, so it can only subtract a range that the
 * immediately preceding event prices.
 */
function appendReplacement(ctx, session, { type, data, shadowedSeqs, warn }) {
  const startSeq = shadowedSeqs[0]
  const endSeq = shadowedSeqs[shadowedSeqs.length - 1]
  const price = shadowPrice(ctx, session, shadowedSeqs)
  if (price === undefined) {
    warn('no usable token measurement; the context meter may drift above the real prompt size')
  } else {
    session.append('compaction/prune', {
      shadowedRange: { start: startSeq, end: endSeq },
      shadowedSeqs: [...shadowedSeqs],
      shadowedTokenCount: price,
    })
  }
  session.append(type, data, {
    surfaceOp: { op: 'replace', startSeq, endSeq },
    sourceEventSeqs: [...shadowedSeqs],
  })
  return price
}

function shadowPrice(ctx, session, shadowedSeqs) {
  const meter = ctx.get?.('tokenMeter')
  if (meter === undefined || typeof meter.measure !== 'function') return undefined
  let measurement
  try {
    measurement = meter.measure(session)
  } catch {
    return undefined
  }
  const prices = new Map()
  for (const node of measurement?.nodes ?? []) prices.set(node.seq, node.heuristicTokens)
  let total = 0
  for (const seq of shadowedSeqs) {
    const price = prices.get(seq)
    if (typeof price !== 'number') return undefined
    total += price
  }
  return total
}

/* ------------------------------------------------------------ dereference */

/**
 * Resolve `$rwm-<n>-full` the agent writes in its own reply.
 *
 * The agent's reasoning for the request is the reply text itself, so the same
 * lock applies here as in `rwm_access`: a memory that contradicts what the
 * agent says it is looking for is refused, and the refusal is a one-off note.
 */
function registerDereference(ctx, config, warn, isOn) {
  ctx.on('session/event', (session, event) => {
    if (event?.type !== 'assistant/message') return
    if (!isOn(session)) return
    const reply = replyText(event)
    const wanted = new Set()
    for (const match of reply.matchAll(DEREFERENCE)) wanted.add(Number(match[1]))
    if (wanted.size === 0) return
    try {
      for (const number of wanted) injectMemory(config, session, number, reply)
    } catch (error) {
      warn(`could not resolve $rwm-<n>-full: ${describe(error)}`)
    }
  })
}

/** Plain text of one assistant settlement event. */
function replyText(event) {
  const content = event.data?.message?.content
  if (!Array.isArray(content)) return ''
  return content
    .filter(block => block?.type === 'text' && typeof block.text === 'string')
    .map(block => block.text)
    .join('\n')
}

/** Append the originals of one memory, judged against the reply that asked. */
function injectMemory(config, session, number, reason) {
  const events = session.snapshotEvents()
  const index = buildIndex(events)
  if (!index.memoryByNumber.has(number)) {
    appendNote(session, `[rwm-${number}-full] No memory with that number exists.`)
    return
  }
  const resolved = resolveCitations(
    index,
    events,
    { numbers: [], ranges: [], chunks: [], memories: [number] },
    { maxChars: config.dereferenceMaxChars },
  )
  if (resolved.error !== undefined) {
    appendNote(session, `[rwm-${number}-full] ${resolved.error}`)
    return
  }
  const body = resolved.items.map(item => `--- ${item.label} (${item.kind}) ---\n${item.text}`).join('\n\n')
  const verdict = judge(reason, body, `rwm-${number}`)
  if (verdict.verdict === 'deny') {
    appendNote(session, `[rwm-${number}-full] Refused. Your reasoning names ${verdict.missing.join(', ')}, `
      + `which this memory does not contain. Reasoning lock: ${verdict.lock}`)
    return
  }
  appendNote(session, `[rwm-${number}-full] Reasoning lock: ${verdict.lock}\n\n${body}`)
}

/** Append one plugin-authored note the model reads on its next request. */
function appendNote(session, text) {
  session.append('user/message', {
    id: `rwm-note-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`,
    role: 'user',
    source: { kind: 'user' },
    content: [{ type: 'text', text }],
  }, { surfaceOp: 'append' })
}

/* ----------------------------------------------------------------- prompt */

function registerPrompt(ctx, config, warn, isOn) {
  ctx.inject(['systemPrompt'], (scope) => {
    const service = scope.systemPrompt
    if (service === undefined) return
    try {
      if (config.exposePolicySection) {
        service.section({
          name: 'autotrim:policy',
          order: config.sectionOrder,
          text: [
            '## Rewritten memory',
            `When active, context beginning "${MEMORY_PREFIX}<n>-" is a memory you wrote yourself to replace history you chose to forget,`,
            'and the numbered index below is what you can no longer see.',
            `- Cite it with ${ACCESS_TOOL}: "12, 15-17, rwm-3", plus your reasoning. The reasoning is checked against a derived lock,`,
            '  so asking for something the content does not contain is refused.',
            '- Write $rwm-<n>-full in a reply to pull a memory\u2019s originals back in.',
            `- ${REWRITE_TOOL} folds older history into a new numbered memory.`,
          ].join('\n'),
        })
      }
      if (typeof service.context === 'function') {
        service.context({
          name: 'autotrim:index',
          order: config.sectionOrder + 10,
          text: context => indexText(config, isOn, context?.agent?.session),
        })
      }
    } catch (error) {
      warn(`could not publish the prompt contributions: ${describe(error)}`)
    }
  })
}

/** The numbered list of everything the model can no longer see. */
function indexText(config, isOn, session) {
  if (session === undefined || !isOn(session)) return ''
  try {
    const index = buildIndex(session.snapshotEvents())
    const visible = new Set()
    const surface = session.surface?.nodes
    if (surface !== undefined && typeof surface[Symbol.iterator] === 'function') {
      const seqs = new Set([...surface])
      for (const entry of index.entries) if (seqs.has(entry.seq)) visible.add(entry.number)
    }
    const lines = renderIndex(index, visible, config.indexLimit)
    if (lines.length === 0) return ''
    return `Rewritten-memory index (citable, oldest first):\n${lines.join('\n')}`
  } catch {
    return ''
  }
}
