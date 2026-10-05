/**
 * Browser half of `@local/dsh-autotrim-context` — the "Model context" right
 * sidebar tab.
 *
 * This file is a DSH client bundle, not an ES module: the client-modules host
 * half serves it verbatim under `/plugins` and the browser evaluates it as a
 * classic script, so it hand-rolls the `window.__ModuleLoader__.load(...)`
 * wrapper tsdown would otherwise emit. The only runtime request is `react`,
 * which the shell seeds in the frozen platform module table; everything else —
 * the surface fold, the transcript rendering, the diff — is local code, so the
 * bundle declares no `dsh.client.external`.
 *
 * The tab answers three questions about one Session:
 *
 *   - **Model**   — the messages the surface actually resolves to, in order,
 *                   i.e. what the next request would carry.
 *   - **Rewritten** — every replacement copy in the log (`rwm-` memories and
 *                   stubbed tool output) next to the originals it shadowed.
 *   - **Diff**    — the append-origin transcript (what the user watched happen)
 *                   against the model-visible surface.
 *
 * Numbers are the durable Session sequence of each event, so a line here can be
 * cited to the agent the same way the prompt index cites it.
 *
 * @module @local/dsh-autotrim-context/client
 */

window.__ModuleLoader__.load({
  id: '@local/dsh-autotrim-context',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const React = require('react')

    /** Event types that can occupy a node of the model-visible surface. */
    const SURFACE_TYPES = new Set([
      'system/message',
      'developer/message',
      'user/message',
      'assistant/message',
      'tool/result',
    ])

    /** Tab type discriminator; what `ctx.sidebarRight.openTab` names. */
    const KIND = 'rwm-context'
    /** Registration identity, unique across tab types and slot keys. */
    const ID = '@local/dsh-autotrim-context'
    /** Skip a diff whose LCS table would cost more cells than this. */
    const DIFF_CELL_LIMIT = 4_000_000
    /** Render at most this many rows before truncating with a notice. */
    const ROW_LIMIT = 4000
    /** Stable empty window standing in for a Session whose events are not loaded. */
    const EMPTY_WINDOW = Object.freeze({ entries: Object.freeze([]), hasMore: false })
    /** Stable no-op unsubscribe. */
    const NOOP = () => {}

    // ---------------------------------------------------------------- contents

    /**
     * Flatten one provider content block to a single line of text.
     * @param block - one message content block, as the wire carries it.
     * @returns a readable rendering; empty when the block carries no text.
     */
    function blockText(block) {
      if (typeof block === 'string') return block
      if (block === null || typeof block !== 'object') return ''
      const type = block.type
      if (type === 'text') return typeof block.text === 'string' ? block.text : ''
      if (type === 'thinking' || type === 'reasoning') {
        const thought = typeof block.text === 'string'
          ? block.text
          : typeof block.thinking === 'string' ? block.thinking : ''
        return thought === '' ? '(thought)' : '(thought) ' + thought
      }
      if (type === 'tool-call') return '(tool call) ' + String(block.toolName ?? block.name ?? '')
      if (type === 'tool-addition') return '(tool added) ' + String(block.toolName ?? '')
      if (type === 'tool-removal') return '(tool removed) ' + String(block.toolName ?? '')
      if (type === 'image') return '(image)'
      if (typeof block.text === 'string') return block.text
      return '(' + String(type ?? 'block') + ')'
    }

    /**
     * Flatten a message's content to text.
     * @param content - string or block array.
     * @returns the joined text.
     */
    function contentText(content) {
      if (typeof content === 'string') return content
      if (!Array.isArray(content)) return ''
      return content.map(blockText).filter(part => part !== '').join('\n')
    }

    /**
     * Read the message a surface event derives to, without the projection map.
     * @param event - a session event.
     * @returns its message, or undefined for a non-message event.
     */
    function messageOf(event) {
      if (event === null || typeof event !== 'object') return undefined
      if (event.type === 'user/message') return event.data
      if (event.data !== null && typeof event.data === 'object') return event.data.message
      return undefined
    }

    /**
     * Render one event's message content as text.
     * @param event - a session event.
     * @returns the message text; empty when it carries none.
     */
    function eventText(event) {
      const message = messageOf(event)
      if (message === undefined || message === null) return ''
      return contentText(message.content)
    }

    /**
     * Short role name for one event.
     * @param event - a session event.
     * @returns the role label shown in the transcript.
     */
    function eventKind(event) {
      switch (event.type) {
        case 'system/message': return 'system'
        case 'developer/message': return 'developer'
        case 'user/message': return 'user'
        case 'assistant/message': return 'assistant'
        case 'tool/result': return 'tool'
        default: return String(event.type)
      }
    }

    /** Whether an event is an append-origin surface node (the human transcript). */
    function isAppendEvent(event) {
      return SURFACE_TYPES.has(event.type) && event.surfaceOp === 'append'
    }

    /** Whether an event is a replacement copy (model-only). */
    function isReplacementEvent(event) {
      return SURFACE_TYPES.has(event.type)
        && event.surfaceOp !== undefined
        && event.surfaceOp !== 'append'
    }

    // -------------------------------------------------------------------- fold

    /**
     * Replay the surface operations of a loaded event window, mirroring the
     * canonical fold in `@deepseek-ai/dsh-session/surface`.
     *
     * A paginated window can start mid-log, in which case a replacement's range
     * may lie outside it. Such an operation is skipped rather than throwing, and
     * reported through {@link FoldResult.incomplete} so the UI can say so.
     * @param entries - the event source's loaded entries, oldest first.
     * @returns the folded surface and the replacements that produced it.
     */
    function foldEntries(entries) {
      const events = []
      const bySeq = new Map()
      for (const entry of entries) {
        const event = entry !== null && typeof entry === 'object' ? entry.event : undefined
        if (event === null || typeof event !== 'object') continue
        events.push(event)
        bySeq.set(event.seq, event)
      }
      const nodes = []
      const replacements = []
      let incomplete = false
      for (const event of events) {
        if (!SURFACE_TYPES.has(event.type)) continue
        const op = event.surfaceOp
        if (op === undefined || op === 'append') {
          nodes.push(event.seq)
          continue
        }
        if (op === null || typeof op !== 'object') {
          incomplete = true
          continue
        }
        const startIdx = nodes.indexOf(op.startSeq)
        const endIdx = nodes.indexOf(op.endSeq)
        if (startIdx === -1 || endIdx === -1 || startIdx > endIdx) {
          incomplete = true
          continue
        }
        const shadowedSeqs = nodes.slice(startIdx, endIdx + 1)
        nodes.splice(startIdx, endIdx - startIdx + 1, event.seq)
        replacements.push({ seq: event.seq, start: op.startSeq, end: op.endSeq, shadowedSeqs })
      }
      return { events, bySeq, nodes, replacements, incomplete }
    }

    /**
     * The append-origin transcript: what the Session log shows a human.
     * @param fold - a {@link foldEntries} result.
     * @returns the append-origin message events in log order.
     */
    function originalEvents(fold) {
      return fold.events.filter(isAppendEvent)
    }

    /**
     * The model-visible messages: the folded surface resolved to events.
     * @param fold - a {@link foldEntries} result.
     * @returns the surface events in model-visible order.
     */
    function modelEvents(fold) {
      const out = []
      for (const seq of fold.nodes) {
        const event = fold.bySeq.get(seq)
        if (event !== undefined) out.push(event)
      }
      return out
    }

    // ---------------------------------------------------------------- rendering

    /**
     * Render a run of events as citable transcript lines.
     * @param events - surface events in display order.
     * @param marks - optional seq-to-badge map drawn on the header line.
     * @returns one string per physical line.
     */
    function transcriptLines(events, marks) {
      const lines = []
      for (const event of events) {
        if (event === null || typeof event !== 'object') continue
        const badge = marks === undefined ? undefined : marks.get(event.seq)
        const failed = event.type === 'tool/result'
          && event.data !== null && typeof event.data === 'object'
          && event.data.error !== undefined
        const header = '[' + String(event.seq) + '] ' + eventKind(event)
          + (failed ? ' (error)' : '')
          + (badge === undefined ? '' : ' ' + badge)
        const text = eventText(event)
        const body = text === '' ? ['(empty)'] : text.split('\n')
        lines.push(header + ': ' + body[0])
        for (let index = 1; index < body.length; index++) lines.push('    ' + body[index])
      }
      return lines
    }

    /**
     * Line diff over two transcripts (LCS, with a size guard).
     * @param before - the original lines.
     * @param after - the rewritten lines.
     * @returns one entry per output line: `same`, `del`, or `add`.
     */
    function diffLines(before, after) {
      const n = before.length
      const m = after.length
      if (n === 0 && m === 0) return []
      if (n * m > DIFF_CELL_LIMIT) {
        return [
          ...before.map(text => ({ type: 'del', text })),
          ...after.map(text => ({ type: 'add', text })),
        ]
      }
      const width = m + 1
      const table = new Int32Array((n + 1) * width)
      for (let i = n - 1; i >= 0; i--) {
        for (let j = m - 1; j >= 0; j--) {
          table[i * width + j] = before[i] === after[j]
            ? table[(i + 1) * width + (j + 1)] + 1
            : Math.max(table[(i + 1) * width + j], table[i * width + (j + 1)])
        }
      }
      const out = []
      let i = 0
      let j = 0
      while (i < n && j < m) {
        if (before[i] === after[j]) {
          out.push({ type: 'same', text: before[i] })
          i++
          j++
        } else if (table[(i + 1) * width + j] >= table[i * width + (j + 1)]) {
          out.push({ type: 'del', text: before[i] })
          i++
        } else {
          out.push({ type: 'add', text: after[j] })
          j++
        }
      }
      while (i < n) out.push({ type: 'del', text: before[i++] })
      while (j < m) out.push({ type: 'add', text: after[j++] })
      return out
    }

    /**
     * Summarize a window: how much of it is model-visible, rewritten, or gone.
     * @param fold - a {@link foldEntries} result.
     * @returns counts and the replacement badge map for transcript rendering.
     */
    function summarize(fold) {
      const marks = new Map()
      for (const replacement of fold.replacements) marks.set(replacement.seq, '«rewritten»')
      const kinds = { user: 0, assistant: 0, tool: 0, system: 0, developer: 0 }
      for (const seq of fold.nodes) {
        const event = fold.bySeq.get(seq)
        if (event === undefined) continue
        const kind = eventKind(event)
        if (Object.hasOwn(kinds, kind)) kinds[kind]++
      }
      return {
        loaded: fold.events.length,
        model: fold.nodes.length,
        original: originalEvents(fold).length,
        rewritten: fold.replacements.length,
        kinds,
        marks,
      }
    }

    // ----------------------------------------------------------------- styling

    const PANEL_STYLE = {
      display: 'flex',
      flexDirection: 'column',
      height: '100%',
      minHeight: 0,
      fontSize: 12,
      lineHeight: 1.5,
    }
    const BAR_STYLE = {
      display: 'flex',
      flexWrap: 'wrap',
      gap: 4,
      alignItems: 'center',
      padding: '6px 8px',
      borderBottom: '1px solid color-mix(in srgb, currentColor 15%, transparent)',
      flex: '0 0 auto',
    }
    const BUTTON_STYLE = {
      font: 'inherit',
      fontSize: 11,
      padding: '2px 8px',
      borderRadius: 10,
      border: '1px solid color-mix(in srgb, currentColor 25%, transparent)',
      background: 'transparent',
      color: 'inherit',
      cursor: 'pointer',
    }
    const ACTIVE_BUTTON_STYLE = {
      ...BUTTON_STYLE,
      background: 'color-mix(in srgb, currentColor 14%, transparent)',
      borderColor: 'color-mix(in srgb, currentColor 45%, transparent)',
    }
    const BODY_STYLE = {
      flex: '1 1 auto',
      minHeight: 0,
      overflow: 'auto',
      padding: '6px 8px 16px',
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
      fontSize: 11.5,
      whiteSpace: 'pre-wrap',
      wordBreak: 'break-word',
    }
    const NOTE_STYLE = {
      padding: '6px 8px',
      opacity: 0.75,
      fontStyle: 'italic',
      fontFamily: 'inherit',
    }
    const CARD_STYLE = {
      margin: '0 0 10px',
      padding: '6px 8px',
      borderRadius: 6,
      background: 'color-mix(in srgb, currentColor 6%, transparent)',
    }
    const DEL_STYLE = { color: '#d9534f' }
    const ADD_STYLE = { color: '#3fa34d' }
    const DIM_STYLE = { opacity: 0.6 }

    // --------------------------------------------------------------- component

    /**
     * Render the transcript body as a batch of rows.
     * @param lines - the lines to draw.
     * @param styleOf - per-line style resolver, or undefined.
     * @returns the body element.
     */
    function body(React_, lines, styleOf) {
      const shown = lines.slice(0, ROW_LIMIT)
      const children = shown.map((line, index) => React_.createElement(
        'div',
        { key: index, style: styleOf === undefined ? undefined : styleOf(line) },
        line,
      ))
      if (lines.length > ROW_LIMIT) {
        children.push(React_.createElement(
          'div',
          { key: 'truncated', style: NOTE_STYLE },
          '… ' + String(lines.length - ROW_LIMIT) + ' more lines not shown',
        ))
      }
      return React_.createElement('div', { style: BODY_STYLE }, children)
    }

    /**
     * One replacement copy with the originals it shadowed.
     * @param props - the fold and the replacement.
     * @returns the card element.
     */
    function replacementCard(props) {
      const { fold, replacement } = props
      const event = fold.bySeq.get(replacement.seq)
      const shadowed = replacement.shadowedSeqs
        .map(seq => fold.bySeq.get(seq))
        .filter(candidate => candidate !== undefined)
      const text = event === undefined ? '' : eventText(event)
      const children = [
        React.createElement('div', { key: 'head', style: { fontWeight: 600 } },
          'rwm at [' + String(replacement.seq) + '] replaces ['
          + String(replacement.start) + '–' + String(replacement.end) + '] ('
          + String(replacement.shadowedSeqs.length) + ' node'
          + (replacement.shadowedSeqs.length === 1 ? '' : 's') + ')'),
        React.createElement('div', { key: 'body' },
          text === '' ? '(empty)' : text),
      ]
      if (shadowed.length > 0) {
        children.push(React.createElement('div', {
          key: 'shadow-head', style: { marginTop: 6, ...DIM_STYLE },
        }, 'replaced:'))
        for (const original of shadowed) {
          const originalText = eventText(original)
          children.push(React.createElement('div', {
            key: 'shadow-' + String(original.seq), style: DIM_STYLE,
          }, '[' + String(original.seq) + '] ' + eventKind(original) + ': '
            + (originalText === '' ? '(empty)' : originalText.split('\n')[0])
            + (originalText.includes('\n') ? ' …' : '')))
        }
      }
      return React.createElement('div', { key: String(replacement.seq), style: CARD_STYLE }, children)
    }

    /**
     * The tab body: model view, rewritten view, and diff.
     * @param props - slot props, carrying `sessionId`.
     * @returns the panel element.
     */
    function Panel(props) {
      const ctx = props.ctx
      const sessionId = props.sessionId
      const [mode, setMode] = React.useState('model')

      const binding = ctx.sessions.binding(sessionId)
      const source = binding === undefined ? undefined : binding.eventSource

      // A stable empty snapshot and a stable no-op subscription: useSyncExternalStore
      // compares snapshots by identity, so returning a fresh object here would
      // re-render forever.
      const subscribe = React.useCallback(
        (listener) => (source === undefined ? NOOP : source.subscribe(listener)),
        [source],
      )
      const getSnapshot = React.useCallback(
        () => (source === undefined ? EMPTY_WINDOW : source.getSnapshot()),
        [source],
      )
      const window_ = React.useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
      const entries = window_.entries

      const fold = React.useMemo(() => foldEntries(entries), [entries])
      const stats = React.useMemo(() => summarize(fold), [fold])

      const tabs = [
        { id: 'model', label: 'Model' },
        { id: 'rewritten', label: 'Rewritten' },
        { id: 'diff', label: 'Diff' },
      ]
      const bar = React.createElement('div', { style: BAR_STYLE },
        tabs.map(tab => React.createElement('button', {
          key: tab.id,
          type: 'button',
          style: tab.id === mode ? ACTIVE_BUTTON_STYLE : BUTTON_STYLE,
          onClick: () => setMode(tab.id),
        }, tab.label)),
        React.createElement('span', { style: { marginLeft: 'auto', ...DIM_STYLE } },
          String(stats.model) + ' sent · ' + String(stats.original) + ' logged · '
          + String(stats.rewritten) + ' rewritten'),
      )

      let content
      if (source === undefined) {
        content = React.createElement('div', { style: NOTE_STYLE }, 'This Session is not loaded yet.')
      } else if (mode === 'model') {
        const lines = transcriptLines(modelEvents(fold), stats.marks)
        content = lines.length === 0
          ? React.createElement('div', { style: NOTE_STYLE }, 'No model-visible messages in the loaded window.')
          : body(React, lines)
      } else if (mode === 'rewritten') {
        content = fold.replacements.length === 0
          ? React.createElement('div', { style: NOTE_STYLE },
            'Nothing has been rewritten yet. Run /rwm enable and let the agent call rewrite_memory.')
          : React.createElement('div', { style: BODY_STYLE },
            fold.replacements.map(replacement => replacementCard({ fold, replacement })))
      } else {
        const before = transcriptLines(originalEvents(fold))
        const after = transcriptLines(modelEvents(fold), stats.marks)
        const diff = diffLines(before, after)
        content = React.createElement('div', { style: BODY_STYLE },
          React.createElement('div', { style: DIM_STYLE }, '--- session log (what you see)'),
          React.createElement('div', { style: DIM_STYLE }, '+++ model context (what the agent sees)'),
          diff.map((line, index) => React.createElement('div', {
            key: index,
            style: line.type === 'del' ? DEL_STYLE : line.type === 'add' ? ADD_STYLE : undefined,
          }, (line.type === 'del' ? '- ' : line.type === 'add' ? '+ ' : '  ') + line.text)),
        )
      }

      const notes = []
      if (fold.incomplete) {
        notes.push('Some rewrites lie outside the loaded window; scroll the conversation back to load more.')
      }
      if (window_.hasMore === true) {
        notes.push('Older history exists and is not loaded.')
      }

      return React.createElement('div', { style: PANEL_STYLE },
        bar,
        ...notes.map((note, index) => React.createElement('div', {
          key: 'note-' + String(index), style: NOTE_STYLE,
        }, note)),
        content,
      )
    }

    // ------------------------------------------------------------------ plugin

    /** Services required before the tab can be registered. */
    const inject = ['slots', 'sessions', 'sidebarRightTabs']

    /**
     * Register the Model-context tab and its Session-bound body.
     *
     * The body goes through `slots.inject('<slot>', …)`, never a bare
     * `slots.register`: the `sidebar.right.pane.tab` slot is declared by the
     * sidebar-right plugin, and registering before that declaration throws and
     * takes the tab type down with it. Every shipped tab does the same.
     * @param ctx - client plugin context.
     */
    function apply(ctx) {
      ctx.effect(() => ctx.sidebarRightTabs.register({
        id: ID,
        kind: KIND,
        title: () => 'Model context',
        guide: [{
          id: 'open',
          order: 55,
          title: () => 'Model context',
          description: () => 'What the model sees, the rewritten version, and a diff.',
        }],
      }), 'autotrim-context: sidebar tab')
      ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({
        name: 'sidebar.right.pane.tab',
        key: ID,
      }, (props) => Panel({ ...props, ctx }))), 'autotrim-context: tab body')
    }

    exports.apply = apply
    exports.inject = inject
    // Test surface: the pure fold, rendering and diff helpers, so a Node test
    // can exercise them without a browser or the module loader.
    exports.__internals = {
      SURFACE_TYPES,
      KIND,
      ID,
      blockText,
      contentText,
      eventText,
      eventKind,
      isAppendEvent,
      isReplacementEvent,
      foldEntries,
      originalEvents,
      modelEvents,
      transcriptLines,
      diffLines,
      summarize,
      Panel,
    }
    return module.exports
  },
})
