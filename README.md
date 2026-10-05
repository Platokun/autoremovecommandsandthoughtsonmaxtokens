# Rewritten Memory

A DeepSeek Harness (DSH) plugin that lets the agent **rewrite its own older
context into numbered memories it writes itself**, and keeps the context meter
honest while it does.

**Off by default.** Run `/rwm enable` in a session to turn it on;
`/rwm disable` turns it off again and `/rwm status` reports the current state.
`/rwm version` reports the build that is loaded and the profile source it was
installed from; `/rwm updateplugin` reinstalls it from that source.

While it is on:

- `rewrite_memory` folds everything older than the retained tail into one
  numbered node, `rwm-<n>-<context>` — a memory the agent wrote itself.
- Retired **tool output** is automatically replaced by a short recall marker.
- Every user message, agent message, and tool call carries a **stable number**,
  and an agent message's thoughts and paragraphs are split into citable
  **chunks**. The agent cites them as `[12, 15-17, 12.3, rwm-3]`.
- `rwm_access` resolves those citations. Each request states its reasoning, which
  is judged against the derived **reasoning lock** of the content.
- `$rwm-<n>-full` written in a reply pulls a memory's originals back in.

Nothing is ever deleted. A replacement *shadows* a log entry; access is
controlled by the lock, not by destruction.

---

## Enable it

```sh
# one-off, no install
dsh --profile web --patch "/500gb/dsh plugins/autoremovecommandsandthoughtsonmaxtokens/overlay.yml"

# or install it into a profile
dsh plugin --profile web add "/500gb/dsh plugins/autoremovecommandsandthoughtsonmaxtokens"
dsh --profile web --dump-config      # confirm the row composed
```

Then, in the session: `/rwm enable`.

Set `enabledByDefault: true` in the row's `config` if you want it on without the
command. The command's override is per session and lasts for the process.

---

## Keeping an installed copy current

```sh
/rwm version        # what is loaded, and which profile source installed it
/rwm updateplugin   # reinstall from that recorded source
```

`/rwm version` answers "which copy am I actually running?" with two facts: the
version in this module's own `package.json`, and the dependency the running
profile recorded — for example

```
Rewritten Memory 0.1.0001
Installed as @local/dsh-autotrim-context from github:Platokun/autoremovecommandsandthoughtsonmaxtokens in profile web.
```

`/rwm updateplugin` hands that source back to DSH's plugin manager as
`<name>@<source>`. Naming the dependency explicitly is the point: a git source
that is already recorded reinstalls to the very same value in `package.json`, so
the manager — which identifies an installation by *the dependency it changed* —
cannot tell which package it just installed and refuses the run as an ambiguous
install. The name-qualified spec is attributable either way.

The update goes through the plugin manager, so it obeys the same lockfile,
registry, and file-restore rules as an install from the plugin page. The new
code is on disk when the command returns, but the process still runs the old
module: **restart DSH to load it.**

A copy that no profile dependency holds (started from the `overlay.yml` one-off
patch, or a checkout run directly) has nothing to reinstall from; the command
says so and names the directory it is running from.

---

## The citation model

### Stable numbers

Numbers are assigned in **log order** over user messages, agent messages, and
tool calls, so a fold never renumbers anything. Memory nodes are excluded from
the plain numbering and live in their own namespace as `rwm-<n>`. Replacement
copies are skipped, so an original keeps the number it always had.

An agent message's text and thoughts are split into chunks **one per non-empty
line**. Chunk `3` of message `12` is cited `12.3`. Models write one thought per
line — a short paragraph, a plan, a list of next actions — and a whole thought
bubble is rarely useful as one indivisible unit. A forty-line thought becomes
forty separately citable pieces, so the agent pulls back the one line it needs
instead of the entire bubble. Citing the smallest thing that answers the
question is what keeps the total context small.

The index shows a chunk count (`12 [agent] (5 chunks) ...`) so the agent knows a
line can be cited on its own, and resolving a whole multi-chunk message returns
it chunk by chunk with the id that cites only each line — which is how the agent
learns the split exists and narrows its next request.

The prompt carries a **citable index** of what the agent can no longer see: one
line per retired number and per memory, oldest first, capped by `indexLimit`.
Visible messages are not listed, because listing them would spend the context
this plugin exists to save.

### Citations

| Form | Means |
|---|---|
| `12` | message 12 |
| `15-17` | messages 15 through 17 |
| `12.3` | chunk 3 of message 12 |
| `rwm-3` | memory 3, resolved to every original it shadowed |

A tool call resolves to its arguments **and** the output that answered it — the
call alone is not an answer.

### The reasoning lock

Every citable item carries a lock: a derived, one-line statement of what the
content actually is, e.g.

```
rwm-2: only mentions 2023, 18; rows for the 9th of September 2023.
```

The lock is derived from the content rather than stored, so every fold, restart,
and replay produces the same one with no extra durable field.

`rwm_access` requires a `reason`. Strong identifiers — years, long numbers,
constants — that appear in the reason but nowhere in the content are a
contradiction, and the request is refused with the lock as the explanation:

```
Refused. Your reasoning names 2022-09-09, which this content does not contain.
Reasoning lock: only mentions 2023; rows for the 9th of September 2023.
```

Flags and file names are treated as weak: a request may legitimately name a flag
or a file that older content never mentioned, so those never trigger a refusal.

A refusal is a **one-off warning**. It is not stored as context. What was asked
and what was refused stay in the session log through the tool call itself, so an
independent review can weigh them again later.

Any reasoning is allowed in principle. The lock only refuses a request whose own
terms contradict the content — it never judges whether the question is a *good*
one. That judgement is the next step (see below).

### `$rwm-<n>-full`

Writing `$rwm-<n>-full` in a reply pulls memory `n`'s originals back in as a
note on the next step. The reply text is used as the reasoning, so the same lock
applies: a memory that contradicts what the agent says it is looking for is
refused, and the refusal is a one-off note rather than durable context.

---

## Why the trim is durable

The harness derives every request from the durable session surface, and the
context meter replays the same log (`TokenMeter._sync` folds `session.eventAt(...)`
node by node). The GUI's `ContextMeter` renders
`projectedTokens = pressureTokens + surfaceTokens − sampledSurfaceTokens` from
the `contextPressure` projection, and `/compact`'s pressure gate reads the same
measurement.

A request-time trim is invisible to all of them, so the surface keeps growing at
its untrimmed rate while the real prompt does not — the meter drifts above what
is sent. Every rewrite here is instead an ordinary `surfaceOp: { op: 'replace' }`
event, preceded by a `compaction/prune` shadow price stating the price of the
range leaving. **Nothing is hidden from the meter, because nothing is hidden
from the surface.**

No new session event type is involved, so the log stays readable by a DSH build
that has never seen this plugin. The `compaction/prune` event and its
replacement must be appended adjacently: the pressure fold keeps only bounded
state, so it can subtract a range only when the immediately preceding event
prices that exact range.

### What is always preserved

- **Tool-call / result pairing.** A fold consumes whole call/result groups or
  none, so a request can never carry an orphaned result or an unresolved call.
- **The system prompt.** A fold never touches surface node 0.
- **The retained tail**, the newest `retainRecentMessages` messages.
- **Durable identity.** A `tool/result` replacement changes only the message
  content; turn, step, call id, error flag, and presentation metadata are copied
  verbatim because the surface validator requires it.

---

## Tools

### `rewrite_memory`

| Argument | Meaning |
|---|---|
| `memory` (required) | The replacement text, as terse as possible. |
| `keep_recent_messages` | Newest messages kept verbatim (default `retainRecentMessages`, minimum 1). |

The call is durable on its own — it is a logged `tool/call`, so no bespoke event
type is needed. The fold lands at the next `agent/pre-step`, where the surface is
quiescent and no tool result can be stranded without its call. Applying is
idempotent: the plugin matches on the memory *text*, not its number, so repeated
passes and restarts never append a duplicate.

### `rwm_access`

| Argument | Meaning |
|---|---|
| `citations` (required) | `"12, 15-17, 12.3, rwm-3"`. |
| `reason` (required) | Why it is needed; this is what the lock judges. |
| `max_chars` | Budget for the whole answer (default `accessMaxChars`). |

A request over budget is refused whole with an instruction to cite fewer or
smaller items, rather than silently truncated.

---

## Configuration

Unknown keys and out-of-range values fail the plugin at activation.

| Key | Default | Meaning |
|---|---|---|
| `enabledByDefault` | `false` | Start on without `/rwm enable`. |
| `retainRecentMessages` | `8` | Tail messages never rewritten. |
| `autoStubToolResults` | `true` | Replace retired tool output with a recall marker. |
| `keepErrorResults` | `true` | Never shorten a failed tool result. |
| `toolResultPreviewChars` | `0` | Leading characters of a stubbed output worth keeping. |
| `exposePolicySection` | `true` | Publish the policy section and the citable index. |
| `sectionOrder` | `2550` | Prompt-section order; the index sits ten after it. |
| `indexLimit` | `40` | Most recent citable entries listed. |
| `accessMaxChars` | `8000` | Budget for one `rwm_access` answer. |
| `dereferenceMaxChars` | `20000` | Budget for one `$rwm-<n>-full` expansion. |

---

## Seeing what the model sees

`lib/client.js` is the plugin's **browser half**: a DSH client bundle that adds a
**Model context** tab to the Web GUI's right sidebar's guide, next to Workspace
files and New terminal.

The whole point of a rewrite is that the model stops seeing something the user
still sees. The tab makes that gap visible, in three presentations over the same
Session:

| Presentation | Shows |
|---|---|
| **Model** | The messages the surface actually resolves to, in order — what the next request would carry. A `«rewritten»` badge marks the nodes that stand in for shadowed ranges. |
| **Rewritten** | Every replacement copy in the log, each next to the originals it shadowed. |
| **Diff** | The append-origin transcript (what the user watched happen) against the model-visible surface. |

Every line starts with the durable Session sequence of its event — `[12]` — so a
line in the panel can be cited to the agent exactly the way the prompt index
cites it, and `rwm_access` resolves it.

The panel reads the Session's own event window (`ctx.sessions.binding(id).eventSource`)
and re-derives the surface itself, because DSH publishes no RPC or projection for
the folded model-visible surface. That re-derivation is not taken on trust:
`tools/verify-client-fold.mjs` builds real Sessions through the plugin and
requires the client fold to reproduce `foldSurface()` node for node.

No build step is involved. The bundle is hand-written plain JavaScript in the
closure-factory form the client-modules loader serves, parses and executes — it
declares no `dsh.client.external` and requests nothing but `react`, which the
shell seeds in the frozen platform module table.

### Getting it into a running GUI

The browser half is served from whatever copy the profile installed, and the
Host reads that copy's `dsh.client` declaration at startup, so:

```sh
# 1. put this directory into the profile (or: push, then /rwm updateplugin)
dsh plugin --profile web add "/500gb/dsh plugins/autoremovecommandsandthoughtsonmaxtokens"

# 2. restart DSH — a negative client-scan verdict is cached until restart
```

Then reload the page and pick **Model context** from the right sidebar's guide.
Editing `lib/client.js` on disk is not enough on its own: the running Host served
the old bytes, and a package that declared no `dsh.client` at startup stays
negative until it restarts.

`/rwm updateplugin` reinstalls through the plugin manager, which removes the
dependency and then adds it back. A boot that composes the profile inside that
window sees no package, writes a `cordis.yml` with no row for it, and caches a
negative client scan — the plugin can come back with its tools once the Loader
re-adds the row, but it will not come back with its tab. Restart *after* an
update, never *during* one.

A restart also clears the session's `/rwm enable`: the command override lasts
only for the process, and `enabledByDefault` is false, so run `/rwm enable` again
after every restart.

---

## Verifying it

```sh
cd "/500gb/dsh plugins/autoremovecommandsandthoughtsonmaxtokens"

node --test test/                       # 92 unit tests
node tools/verify-against-harness.mjs   # tool schemas against the real DSH validator
node tools/mount-smoke.mjs              # real Cordis mount + real Session rewrite
node tools/verify-client-fold.mjs       # browser fold vs the harness's foldSurface()
```

`tools/mount-smoke.mjs` mounts the plugin into a real Cordis `Context`, builds
real `@deepseek-ai/dsh-session` Sessions, runs the actual `agent/pre-step` hook,
and checks that DSH's own surface validator accepts both replacements, that the
shadow price and replacement range agree, that `foldSurface(snapshotEvents())`
reproduces the live surface exactly, and that no tool result is orphaned.

`tools/verify-client-fold.mjs` then loads `lib/client.js` through a stub of
`window.__ModuleLoader__` — the same closure-factory contract the browser uses —
and compares its fold with the harness's `foldSurface()` over both a memory
rewrite and a tool-output stub, including a mid-log window.

It earns its keep: it caught `Session.deriveEventMessage` being called with a
sequence number instead of an event object — something the stubbed unit tests had
encoded wrongly.

Point `DSH_CHECKOUT` at a different checkout if yours is not
`/home/naruzkurai/deepseek-harness`.

---

## Known limitations and what is next

- **The judge is deterministic, not a model.** It refuses requests whose strong
  identifiers contradict the content and allows everything else. The design you
  described — a fresh, empty-context reviewer that reads the request's reasoning
  and the memory's lock and answers yes/no/maybe independently, with a re-ask
  interval after a failure — is not implemented. The lock, the denial record,
  and the "refusal is never re-sent as context" rule are all in place for it; the
  reviewer itself needs a one-shot `ctx.llm.stream()` call and is the next step.
- **Triage of a tool call is not automatic.** There is no flow yet for marking a
  call "no useful information", writing the note, or refusing repeats pending
  fulfilled reasoning. Nothing is blocked today; `rwm_access` is the only gate.
- **Reload of folded history.** `rwm_access` resolves shadowed originals from
  `sourceEventSeqs`, which every replacement carries, so citations keep working
  across a reload. Numbers are derived from the log, so they are stable too.
- **A rewrite is coarse.** It replaces a range with one node. The agent's visible
  text inside that range leaves the model's view and is readable only through
  `rwm_access`. Preserving what matters is the agent's job — it writes the memory.
- **Coexists with `dsh-compaction-basic`, uncoordinated.** A later compaction may
  shadow an `rwm-` node; the memory is still readable through `rwm_access`.
- **No exported `Config` schema.** The plugin imports nothing from DSH so it can
  run from any directory without a `node_modules` link; it validates its own
  configuration at activation instead.
- **Log growth.** Each rewrite appends two events, bounded by how often the agent
  chooses to rewrite.
- **The panel folds only what is loaded.** The client event window is paginated
  and message-aligned, so a replacement whose range starts above the oldest loaded
  event is skipped and the tab says the view is incomplete; scroll the
  conversation back to load more. A full-log fold would need to page to exhaustion
  through `ctx.remote.session.page`, whose `throughSeq` comes from a `follow`
  opening frame.
- **The panel ignores message projections.** It reads event content directly, so a
  rewrite path that publishes changed messages through a plugin-owned
  `SessionMessageProjection` (e.g. image offload) would show the un-projected
  text. The `rwm-` rewrite and the tool-output stub both carry their content in
  the replacement event, so neither is affected.
- **A client bundle must be restarted into place.** The Host reads
  `exports["./client"]` and each package's `dsh.client` at startup and caches a
  negative scan until restart, so a freshly installed browser half needs a DSH
  restart even though no DSH build is involved.
