/**
 * `@local/dsh-autotrim-context` — a self-rewriting, citable memory.
 *
 * The agent is never gated: `rewrite_memory`, `rwm_access`, and `$rwm-<n>-full`
 * work in every session, whether or not the feature was enabled in chat. What
 * `/rwm enable` does is *force* the feature on for the session — the automatic
 * passes then run at every tool call (`agent/pre-step`) and at every message end
 * (`session/event`) — and `/rwm disable` returns the session to agent-initiated
 * rewrites only. `/rwm status` reports which mode a session is in, `/rwm version`
 * reports the version and the profile source this copy was installed from, and
 * `/rwm updateplugin` reinstalls it from that source.
 *
 *   - `rewrite_memory` (never gated) folds everything older than the retained
 *     tail into one numbered memory node, `rwm-<n>-<context>`, replacing the
 *     model's own history with a memory it wrote itself.
 *   - `rwm_access` resolves citations. Each request states its reasoning,
 *     which is judged against the derived **reasoning lock** of the content —
 *     the "I need 2022 data, but this is all 2023" check.
 *   - `$rwm-<n>-full` in the agent's own reply pulls a memory's originals back in.
 *   - Every user message, agent message, and tool call carries a **stable
 *     number**, and an agent message's thoughts and paragraphs are split into
 *     citable **chunks**. Replies carry a compact index of what the model can no
 *     longer see, so it can cite `[12, 15-17, rwm-3]`.
 *   - **Forced mode only:** retired tool output is replaced by a short recall
 *     marker, and the autoruns fold every thought and console output into a
 *     `rwm-c-<n>` memory at message end.
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

import { readFileSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  MEMORY_PREFIX,
  REWRITE_TOOL,
  buildMemoryMessage,
  buildConsoleMemoryMessage,
  buildCompactMemory,
  buildFileRecord,
  chooseCompactRoute,
  collectFileRecords,
  collectSurfaceEntries,
  compactSystemPrompt,
  compactUserPrompt,
  condenseText,
  CONSOLE_MEMORY_KIND,
  CONSOLE_MEMORY_PREFIX,
  findPendingRewrite,
  isDuplicateContent,
  isMemoryText,
  isRewriteApplied,
  nextConsoleMemoryNumber,
  nextMemoryNumber,
  planCompact,
  planFileDedupe,
  planMemoryFold,
  planWipe,
  resolveConfig,
  stubDuplicateContent,
  stubToolResultContent,
  verifyFileRecords,
} from './lib/memory.js'
import {
  buildIndex,
  eventText,
  judge,
  parseCitations,
  parseConsoleMemory,
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

/** This package's own manifest, read once at activation; an unreadable or unparsable one reports as unknown. */
const OWN_MANIFEST = (() => {
  try {
    return JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'))
  } catch {
    return {}
  }
})()

/** The version this copy declares; `unknown` when its own manifest cannot be read. */
export const VERSION = typeof OWN_MANIFEST.version === 'string' ? OWN_MANIFEST.version : 'unknown'

/** The package name this copy declares, used to find the profile dependency that installed it. */
const PACKAGE_NAME = typeof OWN_MANIFEST.name === 'string' ? OWN_MANIFEST.name : 'dsh-autotrim-context'

/** The directory this copy runs from: the profile's `node_modules/<name>` when it was installed, the checkout otherwise. */
const PACKAGE_DIR = fileURLToPath(new URL('.', import.meta.url))

/**
 * Activate the plugin.
 * @param ctx - Cordis context.
 * @param rawConfig - the loader row's `config`.
 */
export function apply(ctx, rawConfig) {
  const config = resolveConfig(rawConfig)
  /**
   * Explicit per-session forced-mode overrides; absent means the configured
   * default. Forced mode is what `/rwm enable` sets: the automatic passes run at
   * every tool call and every message end. It is never a precondition for the
   * agent's own `rewrite_memory`, `rwm_access`, or `$rwm-<n>-full` request.
   */
  const overrides = new Map()
  const isForced = session => overrides.get(String(session?.id)) ?? config.enabledByDefault
  const setForced = (session, on) => { overrides.set(String(session?.id), on) }

  const warn = (message) => {
    try {
      ctx.logger?.warn?.(`dsh-autotrim-context: ${message}`)
    } catch { /* Logging must never break a turn. */ }
  }

  registerTools(ctx, config)
  registerCommand(ctx, config, isForced, setForced, warn)
  registerDurableTrim(ctx, config, warn, isForced)
  registerAutoruns(ctx, config, warn, isForced)
  registerDereference(ctx, config, warn)
  registerPrompt(ctx, config, warn)
}

/** Human-readable form of an unknown thrown value. */
function describe(error) {
  return error instanceof Error ? error.message : String(error)
}

/* ------------------------------------------------------------------- tools */

function registerTools(ctx, config) {
  ctx.tools.register({
    name: REWRITE_TOOL,
    description: [
      'Replace older history in your context with a memory you write.',
      'Available in every session: this never needs a user command.',
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

function registerCommand(ctx, config, isForced, setForced, warn) {
  ctx.inject(['commands'], (scope) => {
    try {
      scope.commands.register({
        name: COMMAND,
        description: 'Force rewritten memory on or off for the session, compact or wipe the context, report this build, or update the plugin',
        input: { hint: 'enable | disable | status | compact | wipe | version | updateplugin' },
        async handler(invocation) {
          const session = invocation.agent?.session
          const verb = invocation.rawInput.trim().toLowerCase()
          if (verb === 'enable') {
            setForced(session, true)
            return {
              kind: 'success',
              text: 'Rewritten memory forced on for this session: the automatic passes run at every tool call '
                + 'and every message end. The agent could always rewrite on its own, and still can.',
            }
          }
          if (verb === 'disable') {
            setForced(session, false)
            return {
              kind: 'success',
              text: 'Rewritten memory forced mode off for this session: the automatic passes stop, and the agent '
                + 'can still rewrite, cite, and dereference on demand.',
            }
          }
          if (verb === '' || verb === 'status') {
            return {
              kind: 'success',
              text: isForced(session)
                ? 'Rewritten memory is forced on for this session: automatic passes at every tool call and message end.'
                : 'Rewritten memory is agent-initiated only for this session: no automatic passes, and rewrite_memory '
                  + 'is available to the agent at any time.',
            }
          }
          if (verb === 'version') return { kind: 'success', text: versionText(ctx) }
          if (verb === 'compact') {
            try {
              const report = await compactSession(ctx, config, session, warn)
              return { kind: 'success', text: describeCompact(report) }
            } catch (error) {
              return { kind: 'error', text: `Compact failed: ${describe(error)}` }
            }
          }
          if (verb === 'wipe') {
            try {
              const report = wipeSession(ctx, config, session, warn)
              return { kind: 'success', text: describeWipe(report) }
            } catch (error) {
              return { kind: 'error', text: `Wipe failed: ${describe(error)}` }
            }
          }
          if (verb === 'updateplugin') {
            try {
              return await updatePlugin(ctx)
            } catch (error) {
              return { kind: 'error', text: `Update failed: ${describe(error)}` }
            }
          }
          return {
            kind: 'error',
            text: `Usage: /${COMMAND} enable | disable | status | version | compact | wipe | updateplugin`,
          }
        },
      })
    } catch (error) {
      warn(`could not register /${COMMAND}: ${describe(error)}`)
    }
  })
}

/**
 * How a shrink mode describes itself in a reply.
 *
 * The record always carries `file <path> <read|written> <timestamp> <bytes>b -><seq>`;
 * what varies is how much of the document rides along behind it, and the reply must
 * say which, because "recorded by path and time only" is a lie under `partial`.
 */
const SHRINK_SUMMARY = {
  reference: 'pointer only — the record cites the source event, no file text',
  partial: 'pointer plus the opening lines of each file',
  full: 'pointer plus the whole document',
}

/**
 * One line summarising a compact pass, for the command's reply.
 *
 * Everything printed here is derived from the report: the shrink sentence follows
 * the mode that actually ran, and corrections are surfaced rather than swallowed.
 *
 * @param report - the report from {@link compactSession}.
 * @returns human-readable text.
 */
function describeCompact(report) {
  if (report.compacted === 0) return `Nothing compacted: ${report.reason}.`
  const route = report.route === undefined
    ? 'deterministic wording'
    : `${report.route.provider}/${report.route.model} (${report.route.reason})`
  const fallback = report.error === undefined ? '' : ` The model was not used: ${report.error}.`
  const shrink = SHRINK_SUMMARY[report.fileShrink] ?? report.fileShrink
  const records = report.files === 0
    ? 'no file records'
    : `${report.files} file record${report.files === 1 ? '' : 's'} (${shrink})`
  const corrections = report.corrections ?? []
  const invented = report.invented ?? []
  let verified = ''
  if (corrections.length > 0) {
    verified += ` Corrected ${corrections.length} inaccurate file record${corrections.length === 1 ? '' : 's'}`
      + ` against the session log: ${corrections.slice(0, 3).join('; ')}${corrections.length > 3 ? '; …' : ''}.`
  }
  if (invented.length > 0) {
    verified += ` Marked ${invented.length} unverifiable file${invented.length === 1 ? '' : 's'}`
      + ` as UNVERIFIED: ${invented.slice(0, 3).join(', ')}${invented.length > 3 ? ', …' : ''}.`
  }
  return `Compacted ${report.compacted} entries into rwm-${report.number}: ${report.before} surface nodes `
    + `became ${report.after}, carrying ${records} and `
    + `${report.tools} tool line${report.tools === 1 ? '' : 's'} (${route}).${fallback}${verified}`
    + ' Retired content is still readable with rwm_access.'
}

/**
 * One line summarising a wipe, for the command's reply.
 *
 * @param report - the report from {@link wipeSession}.
 * @returns human-readable text.
 */
function describeWipe(report) {
  if (report.wiped === 0) return `Nothing wiped: ${report.reason}.`
  const shrink = SHRINK_SUMMARY[report.fileShrink] ?? report.fileShrink
  const records = report.files > 0
    ? `, and ${report.files} file record${report.files === 1 ? '' : 's'} survive (${shrink})`
    : ''
  return `Wiped ${report.wiped} surface nodes into rwm-${report.number}; the initial system prompt is intact`
    + `${records}. Retired content is still readable with rwm_access.`
}

/* -------------------------------------------------------------- self-info */
/**
 * The running profile's dependency entry for this package.
 *
 * The entry is found by package name, and for an install recorded under another
 * name by resolving `node_modules/<name>` to this copy's own directory.
 *
 * @param ctx - Cordis context, for the profile the copy runs in.
 * @returns the dependency name, its recorded spec, and the profile it belongs to, or undefined.
 */
function installedDependency(ctx) {
  const profile = ctx.get?.('profileContext')
  const dir = profile?.dir
  if (typeof dir !== 'string' || dir.length === 0) return undefined
  let manifest
  try {
    manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
  } catch {
    return undefined
  }
  const recorded = manifest?.dependencies
  if (recorded === null || typeof recorded !== 'object') return undefined
  const name = Object.keys(recorded).find(candidate => candidate === PACKAGE_NAME || resolvesToThisCopy(dir, candidate))
  if (name === undefined || typeof recorded[name] !== 'string') return undefined
  return { name, recorded: recorded[name], dir, profile: typeof profile?.name === 'string' ? profile.name : dir }
}

/** Whether this profile's `node_modules/<name>` really is the directory this copy runs from. */
function resolvesToThisCopy(dir, name) {
  try {
    return realpathSync(join(dir, 'node_modules', name)) === realpathSync(PACKAGE_DIR)
  } catch {
    return false
  }
}

/** What this build is, and which source the running profile installed it from. */
function versionText(ctx) {
  const lines = [`Rewritten Memory ${VERSION}`]
  const installed = installedDependency(ctx)
  if (installed === undefined) {
    lines.push(`No profile dependency holds this copy; it runs from ${PACKAGE_DIR}.`)
  } else {
    lines.push(`Installed as ${installed.name} from ${installed.recorded} in profile ${installed.profile}.`)
  }
  return lines.join('\n')
}

/**
 * Reinstall this package from the source the running profile recorded for it.
 *
 * The spec names the dependency explicitly, `<name>@<source>`. The plugin
 * manager identifies an installation by the dependency it changed, and a git
 * source that is already recorded reinstalls to the very same value: an
 * unnamed spec changes nothing, so the manager could not tell which package it
 * had just installed and refuses the result as ambiguous. Naming it is what
 * makes an update of an already-installed plugin legible to the manager.
 *
 * @param ctx - Cordis context, for the plugin manager and the profile manifest.
 * @returns a command result naming the version the reinstall landed.
 */
async function updatePlugin(ctx) {
  const manager = ctx.get?.('pluginManager')
  if (manager === undefined || typeof manager.installBundle !== 'function') {
    return {
      kind: 'error',
      text: `Update unavailable: this session has no DSH plugin manager. Update the copy at ${PACKAGE_DIR} where it is installed.`,
    }
  }
  const installed = installedDependency(ctx)
  if (installed === undefined) {
    return {
      kind: 'error',
      text: `Update unavailable: profile ${ctx.get?.('profileContext')?.name ?? 'this profile'} records no dependency for `
        + `${PACKAGE_NAME}; this copy runs from ${PACKAGE_DIR}. Update it where it is installed.`,
    }
  }
  const result = await manager.installBundle(`${installed.name}@${installed.recorded}`, { enabled: false })
  if (result?.application === 'failed') {
    return { kind: 'error', text: `Update failed: ${result.error?.message ?? 'the package manager reported no reason'}` }
  }
  if (result?.application === 'cancelled') return { kind: 'error', text: 'Update cancelled; nothing was reloaded.' }
  const landed = typeof result?.version === 'string' ? result.version : undefined
  const version = landed === undefined || landed === VERSION ? VERSION : `${landed} (running ${VERSION})`
  return {
    kind: 'success',
    text: `Reinstalled ${installed.name} from ${installed.recorded}: now ${version}. Restart DSH to load the new code.`,
  }
}

/* -------------------------------------------------------- durable trimming */

function registerDurableTrim(ctx, config, warn, isForced) {
  ctx.on('agent/pre-step', async ({ agent, signal }, next) => {
    const session = agent?.session
    if (session !== undefined && signal?.aborted !== true) {
      /*
       * An agent-initiated rewrite lands whether or not forced mode is on: the
       * logged tool call is the request, and this is where the surface is
       * quiescent. With no pending call this is a no-op.
       */
      try {
        applyMemoryRewrite(ctx, config, session, warn)
      } catch (error) {
        warn(`memory rewrite failed: ${describe(error)}; continuing the turn`)
      }
      /*
       * Forced-only as well: leave each file's content in context exactly once.
       * This runs before the generic stub so a duplicate is retired by its own
       * file-specific marker rather than being swallowed as generic retired
       * output, and so the survivor can be protected from that generic stub.
       */
      let fileSurvivors = new Set()
      if (isForced(session) && config.dedupeFileReads) {
        try {
          fileSurvivors = dedupeFileDuplicates(ctx, config, session, warn)
        } catch (error) {
          warn(`duplicate-file retirement failed: ${describe(error)}; continuing the turn`)
        }
      }
      /* Automatic trimming is forced-only: it retires output nobody asked about. */
      if (isForced(session) && config.autoStubToolResults) {
        try {
          stubRetiredToolResults(ctx, config, session, warn, fileSurvivors)
        } catch (error) {
          warn(`tool-output trimming failed: ${describe(error)}; continuing the turn`)
        }
      }
    }
    return next()
  })
}

/**
 * Register the two autoruns: after thoughts and after console output.
 *
 * Both fold the produced thought or console output into a `rwm-c-<n>` memory so
 * every past thought and console output stays accessible via `rwm-c-<n>`. The
 * condensation is deterministic, so the same input always yields the same
 * memory text; a memory with the same condensed text is never re-created.
 *
 * Each autorun runs on `session/event` and appends the condensed memory as a
 * replacement copy of the original event. The memory itself is already a
 * `rwm-c-` node, so its own `session/event` pass is skipped — this makes the
 * autoruns idempotent without a separate pending state.
 *
 * Autoruns are forced-only: they are the automatic message-end pass, so they run
 * when the session was enabled with `/rwm enable` and stay out of the way
 * otherwise. The agent's own rewrite, access, and dereference are never gated.
 */
function registerAutoruns(ctx, config, warn, isForced) {
  ctx.on('session/event', (session, event) => {
    if (!isForced(session)) return
    const text = eventText(event)
    if (text.length === 0) return
    if (parseConsoleMemory(text) !== null) return

    const hasReasoning = event.type === 'assistant/message' && hasReasoningBlocks(event)
    const isConsole =
      (event.type === 'user/message' || event.type === 'assistant/message') &&
      !hasReasoning &&
      !text.startsWith(CONSOLE_MEMORY_PREFIX)
    if (!hasReasoning && !isConsole) return

    const condensed = condenseText(text, config.condenseSummaryTokens)
    if (condensed.length === 0) return

    const existing = findExistingConsoleMemory(session, condensed)
    if (existing !== null) return

    const number = nextConsoleMemoryNumber(session.snapshotEvents())
    const memoryMessage = buildConsoleMemoryMessage(condensed, number)
    appendConsoleMemory(ctx, session, event, memoryMessage, warn)
  })
}

/** Whether an assistant message carries reasoning blocks. */
function hasReasoningBlocks(event) {
  const content = event.data?.message?.content
  if (!Array.isArray(content)) return false
  return content.some(block => isRecord(block) && block.type === 'reasoning')
}

/** Whether a session already holds a memory with the same condensed text. */
function findExistingConsoleMemory(session, condensed) {
  const events = session?.events ?? []
  for (const event of events) {
    if (event?.type !== 'user/message') continue
    const memory = parseConsoleMemory(eventText(event))
    if (memory !== null && memory.context === condensed) return event.seq
  }
  return null
}

/** Append a `rwm-c-<n>-<condensed>` memory node to the session. */
function appendConsoleMemory(ctx, session, event, memoryMessage, warn) {
  try {
    session.append('user/message', memoryMessage, {
      surfaceOp: { op: 'replace', startSeq: event.seq, endSeq: event.seq },
      sourceEventSeqs: [event.seq],
    })
  } catch (error) {
    warn(`could not append console memory: ${describe(error)}`)
  }
}

/** Whether a value is a non-array object. */
function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
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

function stubRetiredToolResults(ctx, config, session, warn, protectedSeqs = new Set()) {
  const entries = collectSurfaceEntries(session)
  const cutoff = entries.length - config.retainRecentMessages
  if (cutoff <= 0) return 0
  let stubbed = 0
  for (let index = 0; index < cutoff; index += 1) {
    const { seq, message } = entries[index]
    if (message.role !== 'tool') continue
    if (config.keepErrorResults && message.isError === true) continue
    /*
     * Never stub the copy the file dedupe left in context: the point of that
     * pass is that the file is present exactly once, and a generic stub here
     * would leave it present zero times. A node the dedupe pass already retired
     * keeps its own duplicate marker, which says more than a generic stub does.
     */
    if (protectedSeqs.has(seq)) continue
    if (isDuplicateContent(message.content)) continue
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
 * Leave each file's content in the model's context exactly once.
 *
 * Newest copy wins. Every older copy of the same file is replaced by a bounded
 * recall marker, and one altered-memory note states what happened without
 * framing it as a call the agent made — the agent reads that its context was
 * altered, not that it altered it.
 *
 * Only whole call/result groups that sit entirely outside the retained tail are
 * retired, so a duplicate created inside the current step survives that step and
 * the next pass picks it up.
 *
 * @param ctx - Cordis context, for the token meter.
 * @param config - resolved configuration.
 * @param session - live harness session.
 * @param warn - warning sink.
 * @returns the surface seqs of the copies that survived, for the caller to protect.
 */
function dedupeFileDuplicates(ctx, config, session, warn) {
  const survivors = new Set()
  const entries = collectSurfaceEntries(session)
  if (entries.length === 0) return survivors
  const { retire, survivors: newest } = planFileDedupe(entries, config.retainRecentMessages)
  /*
   * Every file's surviving copy is protected whether or not this pass had
   * anything to retire: on the pass after a retirement the duplicate is already
   * a marker, so there is nothing left to retire, and only this set keeps the
   * generic stub from taking the single remaining copy as well.
   */
  for (const occurrence of newest.values()) survivors.add(occurrence.seq)
  if (retire.length === 0) return survivors

  const retired = []
  for (const occurrence of retire) {
    const event = typeof session.eventAt === 'function' ? session.eventAt(occurrence.seq) : undefined
    if (event === undefined || event.type !== 'tool/result') continue
    const built = stubDuplicateContent(event.data?.message?.content, occurrence.file, occurrence.survivorLabel)
    if (built === null) continue
    appendReplacement(ctx, session, {
      type: 'tool/result',
      data: { ...event.data, message: { ...event.data.message, content: built.content } },
      shadowedSeqs: [occurrence.seq],
      warn,
    })
    retired.push(occurrence)
  }
  if (retired.length === 0) return survivors

  appendAlteredMemoryNote(session, retired, warn)
  return survivors
}

/**
 * Note that context was altered, as a memory the agent reads.
 *
 * The note is written as an `rwm-<n>-` node, so the index lists it, `rwm_access`
 * resolves it, and the agent can pull the retired copies back if it needs them.
 * Nothing about it says the agent asked for the retirement.
 */
function appendAlteredMemoryNote(session, retired, warn) {
  try {
    const files = [...new Set(retired.map(occurrence => occurrence.file))]
    const listing = files.length <= 4
      ? files.join(', ')
      : `${files.slice(0, 4).join(', ')} and ${files.length - 4} more`
    const number = nextMemoryNumber(session.snapshotEvents())
    const note = `${retired.length} older cop${retired.length === 1 ? 'y' : 'ies'} of `
      + `${listing} ${retired.length === 1 ? 'was' : 'were'} replaced in this context to keep one copy of each file. `
      + `The newest copy stays; each retired copy is still readable with ${ACCESS_TOOL}, citing the retired number. `
      + 'This was not a tool call you made.'
    session.append('user/message', buildMemoryMessage(note, number), { surfaceOp: 'append' })
  } catch (error) {
    warn(`could not append the altered-memory note: ${describe(error)}`)
  }
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

/* --------------------------------------------------------------- compact */

/**
 * Ask a model to write the compact memory, falling back to the deterministic one.
 *
 * The call is deliberately optional and never fatal: if no permitted route is
 * available, the call fails, or the model returns nothing usable, the caller
 * still compacts with the deterministic wording. A compaction that silently
 * did nothing because a helper model was unreachable would be the worst
 * outcome, so the model only ever replaces the *phrasing*, never the decision.
 *
 * @param ctx - Cordis context, for the `llm` service.
 * @param config - resolved configuration.
 * @param session - live session, for the route and the model call's framing.
 * @param plan - the plan from {@link planCompact}.
 * @param warn - warning sink.
 * @returns `{ text, route, error }`; `text` is always usable.
 */
async function condenseWithModel(ctx, config, session, plan, warn) {
  const fallback = buildCompactMemory(plan)
  if (!config.compactUseModel) return { text: fallback, route: undefined }
  const llm = ctx.get?.('llm')
  if (llm === undefined || typeof llm.stream !== 'function') {
    return { text: fallback, route: undefined, error: 'the llm service is unavailable' }
  }
  let available = []
  try {
    available = (llm.listProviders?.() ?? []).map(provider => provider?.id).filter(id => typeof id === 'string')
  } catch (error) {
    return { text: fallback, route: undefined, error: `could not list providers: ${describe(error)}` }
  }
  const chosen = chooseCompactRoute(config, available, sessionModelRoute(session), await modelsByProvider(llm))
  if (chosen.error !== undefined) return { text: fallback, route: undefined, error: chosen.error }
  try {
    const raw = await runCompactCall(ctx, config, session, plan, chosen)
    if (typeof raw !== 'string' || raw.trim().length === 0) {
      return { text: fallback, route: chosen, error: 'the model returned no text' }
    }
    /*
     * The model was told to copy file records verbatim and invent nothing. That
     * is a request, not a guarantee, so every record it wrote is checked against
     * what the session actually holds before the summary is allowed to land.
     */
    const verified = verifyFileRecords(raw.trim(), plan.files)
    return {
      text: verified.text,
      route: chosen,
      corrections: verified.corrections,
      invented: verified.invented,
    }
  } catch (error) {
    warn(`compact: the model call failed, using the deterministic memory: ${describe(error)}`)
    return { text: fallback, route: chosen, error: describe(error) }
  }
}

/** The session's own provider/model route, when the session exposes one. */
function sessionModelRoute(session) {
  const selection = session?.model ?? session?.modelSelection ?? session?.requestHeader?.model
  if (selection === undefined || selection === null || typeof selection !== 'object') return undefined
  const provider = selection.provider
  const model = selection.model
  if (typeof provider !== 'string' || typeof model !== 'string') return undefined
  return { provider, model }
}

/**
 * Ask each advertised provider which models it offers.
 *
 * Used only to name a real model on an implicit pick. A provider that refuses or
 * hangs must not break the compaction, so every lookup is bounded and a failure
 * simply leaves that provider without a model — which the route guard then
 * reports as "advertises no model" instead of calling an empty route.
 */
async function modelsByProvider(llm) {
  const listed = {}
  if (typeof llm.listModels !== 'function') return listed
  let providers = []
  try {
    providers = (llm.listProviders?.() ?? []).map(provider => provider?.id).filter(id => typeof id === 'string')
  } catch {
    return listed
  }
  await Promise.all(providers.map(async (id) => {
    try {
      const models = await llm.listModels(id)
      const ids = (models ?? []).map(model => (typeof model === 'string' ? model : model?.id)).filter(entry => typeof entry === 'string')
      if (ids.length > 0) listed[id] = ids
    } catch {
      /* A provider that cannot be interrogated simply contributes no models. */
    }
  }))
  return listed
}

/**
 * Stream one auxiliary compaction call and assemble its text.
 *
 * The `llm/stream` surface is the same one the harness's own auxiliary features
 * use, so no provider-specific code lives here: the plugin names a route and
 * reads text back.
 */
async function runCompactCall(ctx, config, session, plan, route) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), config.compactTimeoutMs)
  try {
    const chunks = []
    const stream = ctx.llm.stream({
      provider: route.provider,
      model: route.model,
      system: compactSystemPrompt(),
      messages: [{ role: 'user', content: [{ type: 'text', text: compactUserPrompt(plan) }] }],
      maxTokens: config.compactMaxTokens,
      signal: controller.signal,
    })
    for await (const chunk of stream) {
      const text = chunkText(chunk)
      if (text.length > 0) chunks.push(text)
    }
    return chunks.join('')
  } finally {
    clearTimeout(timer)
  }
}

/** Pull text out of one streamed chunk, tolerating the several shapes the service uses. */
function chunkText(chunk) {
  if (chunk === null || chunk === undefined) return ''
  if (typeof chunk === 'string') return chunk
  if (typeof chunk.text === 'string') return chunk.text
  const delta = chunk.delta ?? chunk.content
  if (typeof delta === 'string') return delta
  if (Array.isArray(delta)) {
    let text = ''
    for (const block of delta) {
      if (block !== null && typeof block === 'object' && typeof block.text === 'string') text += block.text
    }
    return text
  }
  return ''
}

/**
 * Compact the whole conversation into one numbered memory.
 *
 * This is the start-to-finish pass: everything from the first foldable node to
 * the retained tail is replaced by a single `rwm-<n>-` node. Files are never
 * carried as bytes — each becomes one `file <path> <read|written> <timestamp>`
 * record, so the agent knows the file and its moment and re-reads the content
 * from disk when it needs it.
 *
 * @param ctx - Cordis context.
 * @param config - resolved configuration.
 * @param session - live session.
 * @param warn - warning sink.
 * @returns a report for the command to print.
 */
async function compactSession(ctx, config, session, warn) {
  const events = typeof session.snapshotEvents === 'function' ? session.snapshotEvents() : []
  const entries = collectSurfaceEntries(session)
  const plan = planCompact(entries, {
    keepRecent: config.compactKeepRecent,
    events,
    keepErrors: config.keepErrorResults,
    fileShrink: config.compactFileShrink,
  })
  if (plan === null) {
    return { compacted: 0, reason: 'nothing to compact: the conversation is already at or below the retained tail' }
  }

  const { text, route, error, corrections, invented } = await condenseWithModel(ctx, config, session, plan, warn)
  const fileShrink = config.compactFileShrink
  const before = entries.length
  const number = nextMemoryNumber(events)
  appendReplacement(ctx, session, {
    type: 'user/message',
    data: buildMemoryMessage(`compacted:${text}`, number),
    shadowedSeqs: plan.shadowedSeqs,
    warn,
  })
  return {
    compacted: plan.coveredCount,
    before,
    after: collectSurfaceEntries(session).length,
    number,
    files: plan.files.length,
    tools: plan.tools.length,
    route,
    error,
    corrections: corrections ?? [],
    invented: invented ?? [],
    fileShrink,
  }
}

/**
 * Wipe everything the model can see except the initial system prompt.
 *
 * The system prompt is the frame the agent reasons inside and the one thing the
 * user asked to keep, so node 0 is never replaced. Everything after it collapses
 * into a single memory that still carries the file records, because otherwise the
 * agent would lose track of what it had touched.
 *
 * @param ctx - Cordis context.
 * @param config - resolved configuration.
 * @param session - live session.
 * @param warn - warning sink.
 * @returns a report for the command to print.
 */
function wipeSession(ctx, config, session, warn) {
  const events = typeof session.snapshotEvents === 'function' ? session.snapshotEvents() : []
  const entries = collectSurfaceEntries(session)
  const plan = planWipe(entries)
  if (plan === null) {
    return { wiped: 0, reason: 'nothing to wipe: only the system prompt is on the surface' }
  }
  const records = collectFileRecordsFor(entries.slice(plan.startIndex, plan.endIndex + 1), events)
  const lines = ['context wiped by request; only the initial system prompt remains']
  for (const record of records) {
    lines.push(buildFileRecord(record.file, {
      action: record.action,
      bytes: record.bytes,
      seqs: [record.latestSeq ?? record.seqs[record.seqs.length - 1]],
      shrink: config.compactFileShrink,
      content: record.content,
    }))
  }
  const number = nextMemoryNumber(events)
  appendReplacement(ctx, session, {
    type: 'user/message',
    data: buildMemoryMessage(`wiped:${lines.join('\n')}`, number),
    shadowedSeqs: plan.shadowedSeqs,
    warn,
  })
  return { wiped: plan.shadowedSeqs.length, number, files: records.length, fileShrink: config.compactFileShrink }
}

/** File records for a slice of surface entries, newest write winning. */
function collectFileRecordsFor(covered, events) {
  try {
    return [...collectFileRecords(covered, events).values()]
  } catch {
    return []
  }
}

/* ------------------------------------------------------------ dereference */

/**
 * Resolve `$rwm-<n>-full` the agent writes in its own reply.
 *
 * The agent's reasoning for the request is the reply text itself, so the same
 * lock applies here as in `rwm_access`: a memory that contradicts what the
 * agent says it is looking for is refused, and the refusal is a one-off note.
 *
 * Never gated: a memory the agent can cite is a memory it can pull back, whether
 * or not the session was enabled.
 */
function registerDereference(ctx, config, warn) {
  ctx.on('session/event', (session, event) => {
    if (event?.type !== 'assistant/message') return
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

function registerPrompt(ctx, config, warn) {
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
            `"${MEMORY_PREFIX}<n>-" is a memory you wrote to replace history you forgot; the index below lists what you cannot see.`,
            `Cite [12, 15-17, rwm-3] with reasoning via ${ACCESS_TOOL}: content that contradicts your reasoning is refused.`,
            '$rwm-<n>-full recalls a memory\u2019s originals.',
            `${REWRITE_TOOL} folds older history into a new memory.`,
            `When forced, each file stays in context once (newest copy wins; older copies become recall markers, and an "${MEMORY_PREFIX}<n>-" note reports it \u2014 not a call you made).`,
            '`/rwm compact` rewrites the whole conversation into one memory; `/rwm wipe` keeps only the system prompt.',
            'A compacted file is a `file <path> <read|written> <timestamp> <bytes>b -><seq>` record; the `->` seq is the real content, recalled with `rwm_access`.',
          ].join('\n'),
        })
      }
      if (typeof service.context === 'function') {
        service.context({
          name: 'autotrim:index',
          order: config.sectionOrder + 10,
          text: context => indexText(config, context?.agent?.session),
        })
      }
    } catch (error) {
      warn(`could not publish the prompt contributions: ${describe(error)}`)
    }
  })
}

/** The numbered list of everything the model can no longer see. */
function indexText(config, session) {
  if (session === undefined) return ''
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
