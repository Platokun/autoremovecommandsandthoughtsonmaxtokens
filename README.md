# Rewritten Memory

A DeepSeek Harness (DSH) plugin that lets the agent **rewrite its own older
context into numbered memories it writes itself**, and keeps the context meter
honest while it does.

**The agent is never gated.** `rewrite_memory`, `rwm_access`, and `$rwm-<n>-full`
work in every session: the agent can rewrite its own history, cite it, and pull a
memory back without any command. `/rwm enable` *forces* the feature on for the
session — the automatic passes then run at every tool call and at every message
end — `/rwm disable` returns to agent-initiated only, and `/rwm status` reports
which mode a session is in. `/rwm version` reports the build that is loaded and
the profile source it was installed from; `/rwm updateplugin` reinstalls it from
that source.

Installing the plugin is not the same as forcing it: the agent-facing tool and
the citation tools are always live, and only the automatic passes wait for
`/rwm enable` (or `enabledByDefault: true`).

- `rewrite_memory` (never gated) folds everything older than the retained tail
  into one numbered node, `rwm-<n>-<context>` — a memory the agent wrote itself.
- `rwm_access` resolves citations. Each request states its reasoning, which is
  judged against the derived **reasoning lock** of the content.
- `$rwm-<n>-full` written in a reply pulls a memory's originals back in.
- Every user message, agent message, and tool call carries a **stable number**,
  and an agent message's thoughts and paragraphs are split into citable
  **chunks**. The agent cites them as `[12, 15-17, 12.3, rwm-3]`.
- **Forced mode only:** retired **tool output** is automatically replaced by a
  short recall marker, and **autoruns** fold every agent **thought** and every
  **console output** into a `rwm-c-<n>` memory, so every past thought and console
  output stays accessible via `rwm-c-<n>` — the same deterministic condensation
  as `rewrite_memory`, always available through citations like
  `[12, 15-17, rwm-c-3]`.
- **Forced mode only:** no file's content sits in the context twice. When a file
  is read or edited again, the older copy is retired behind a recall marker — the
  newest copy wins — and an `rwm-<n>-` **altered-memory note** says the context
  was changed without presenting it as a call the agent made.
- **On request:** `/rwm compact` rewrites the whole conversation from start to
  finish as one `rwm-<n>-` memory, and `/rwm wipe` leaves only the initial system
  prompt. A file is remembered as a **record** — path, action, timestamp, size —
  never as its bytes, so the memory cannot go stale and the file on disk is never
  touched. A model can write the summary if you name a cheap one; by default the
  wording is deterministic and nothing is spent.

Nothing is ever deleted. A replacement *shadows* a log entry; access is
controlled by the lock, not by destruction.

---

## Install and enable it

```sh
# one-off, no install
dsh --profile web --patch "/500gb/dsh plugins/autoremovecommandsandthoughtsonmaxtokens/overlay.yml"

# or install it into a profile
dsh plugin --profile web add "/500gb/dsh plugins/autoremovecommandsandthoughtsonmaxtokens"
dsh --profile web --dump-config      # confirm the row composed
```

Loading the plugin is enough for the agent to rewrite on its own. Then, in the
session, `/rwm enable` forces the automatic passes on: tool-output trimming at
every tool call, and the thought/console autoruns at every message end.

Set `enabledByDefault: true` in the row's `config` if you want that forced mode
on without the command. The command's override is per session and lasts for the
process.

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
| `rwm-c-3` | console-output memory 3, resolved to every original it shadowed |

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

## One copy per file

While the automatic passes are forced on, a file's content occupies the context
once. Every time a file is read or edited, any **older copy of that same file**
is replaced by a recall marker, so re-reading a file never doubles it:

```
14 [read] {"file_path":"/repo/src/a.js"} ...   <- marker: earlier copy retired
21 [read] {"file_path":"/repo/src/a.js"} ...   <- the copy that stays
rwm-4-1 older copy of a.js was replaced in this context to keep one copy ...
```

What the pass does and does not do:

- **Newest copy wins.** The last read or edit of a file is the one that stays;
  everything earlier for that file becomes a marker pointing at it.
- **A note, not a confession.** The retirement is reported as an `rwm-<n>-`
  altered-memory note — *"this was not a tool call you made"*. The agent reads
  that its context changed without being told it asked for the change. The note
  is an ordinary citable memory, so `rwm_access` resolves it and
  `$rwm-<n>-full` pulls the retired copies back.
- **Detection is by path, not by bytes.** Two reads of one path are one file even
  if the bytes differ between them, which is the intended rule: the newest copy
  is the current one. Paths are compared normalised (`./a/../b.js` and `a\b.js`
  are one file) and case-insensitively.
- **Only reads and edits count.** A call that names a file under a read-ish tool
  name is tracked; a `bash` call is not, however much output it prints.
- **The originals survive.** The retired copy is shadowed, not deleted: its bytes
  stay in the log, reachable through the citation tools, exactly like every other
  rewrite here.

It converges rather than landing all at once. Retiring means replacing a whole
tool-call group, and a group that overlaps the retained tail or the running step
cannot be split, so a duplicate created inside the current step survives that
step and the next pass retires it. The generic tool-output trimming is aware of
this pass: it never stubs the surviving copy of a file (which would leave zero
copies) and never overwrites a duplicate marker with its own generic stub.

`dedupeFileReads: false` turns the pass off. `/rwm disable` does too, because the
whole pass is part of the forced set — with the feature off, a session behaves
exactly as it did before, and `rewrite_memory` keeps working as always.

---

## Start to finish: `/rwm compact`

Everything above is incremental. `/rwm compact` is not: it takes the whole
conversation — the first foldable node through the retained tail — and replaces
it with **one** numbered memory. `/rwm wipe` goes further and leaves only the
initial system prompt.

```
/rwm compact     # the whole conversation becomes one rwm-<n>- memory
/rwm wipe        # everything except the initial system prompt goes
```

Both are manual: they are not part of the automatic passes and do not require
`/rwm enable`.

### The memory is a record with a pointer, not a copy

Every file a session touched becomes a record that **cites the session event it
came from**, so the agent can walk back to the real thing:

```
rwm-7-compacted:earlier work compacted (8 entries)
files: 2
file /repo/src/alpha.js read 2026-10-16T03:21:10Z 690b ->214
file /repo/src/beta.js written 2026-10-16T03:21:10Z 660b ->218
tools: 1
tool bash: 4 tests passed 1 test skipped
asked:
please tidy up the alpha module,now update beta.js
```

Path, action, timestamp, size, and `-><seq>` — a real, resolvable citation back
to the event that read or wrote the file, not a filesystem symlink and not a
copy. The agent knows *what* exists, *when* it last changed, and *where to look*.

How much of the document rides along behind the pointer is the **shrink mode**
(`compactFileShrink`):

| Mode | The record carries |
|---|---|
| `reference` | the pointer alone — no file text at all |
| `partial` (default) | the pointer plus up to 3 opening lines, clipped, elided with `...` |
| `full` | the pointer plus the whole document |

`partial` is the default because the opening lines are a strong recognition hint
at a few tokens each, while `reference` is what you want when the memory must be
as small as possible. Either way the bytes remain recoverable: the citation is
dereferenceable, and the original tool result is still in the log.

A read followed by a write of one file collapses to a single `written` record,
because the current state is the thing worth remembering.

Every other tool result becomes one clipped line, errors included — "this
failed" is exactly what a compacted context must not lose. Repetition is folded:
the same command run twelve times becomes one line marked `x12`, so a long
session's hundred test runs cost a line, not a hundred. Lines are clipped at a
word boundary, and the list is capped (`toolLineLimit`, default 40) with an
honest count of what was dropped. Agent prose keeps its first line. The memory's
size is bounded by the number of distinct tools and files, not by how long the
conversation was.

### What a rewrite costs at the provider

DSH has no prefix-cache API to call — the cache belongs to the provider, and the
harness only reports what it did after the fact (`cacheReadTokens` /
`cacheWriteTokens` on each assistant message). Prefix stability is therefore an
*emergent* property of the request pipeline rather than something a plugin can
set. The harness states the invariant plainly: a log projected by a per-node pure
function yields requests that are append-extensions of their predecessors
whenever the header is unchanged, so only the rewritten tail is re-billed.

That leaves one thing this plugin can get wrong, and it guards it explicitly. A
replacement may only retire **one contiguous, ascending run of the surface**.
Everything before the run stays byte-identical to what the provider already
cached; a run with a hole in it, or a reversed one, would rewrite bytes the
provider had already paid to cache and silently re-bill the request from that
point on. Both planners assert this before emitting a plan, and
`isContiguousTail` in [lib/memory.js](lib/memory.js) is the single predicate. It
is checked where the run is *derived* rather than at the append site, because
there the seqs come from the same slice they would be checked against — a guard
at that point could never fire.

Two costs are inherent, because the model genuinely must see something different:
compaction itself, and a change to the system prompt at surface node 0. Node 0 is
never compacted or wiped, which is why `/rwm wipe` keeps it and why a compaction
is a one-time full-price event rather than a recurring one.

### A model's summary is verified, not trusted

Instructing a model to "copy the records verbatim and invent nothing" is a
request, not a guarantee. So when a model writes the memory, every `file ...`
line it produces is **checked against the records actually collected from the
session**, and repaired:

- a line naming a file the session never touched becomes
  `file <path> UNVERIFIED (no such tool call in this session)` — the model's
  intent is kept, but the falsehood is not;
- a line misstating a real file's action, size, timestamp, or `->` pointer is
  **rewritten to the true record**.

Model *prose* is never rewritten: a good summary wrapped around one bad path
keeps the summary and loses only the bad path. The reply tells you what was
corrected and what could not be verified. With `compactUseModel: false` (the
default) there is no model output to verify, and this pass does nothing.

### Choosing the model

By default `/rwm compact` is **deterministic**: no model is called, no tokens are
spent, and the same conversation always produces the same memory. Set
`compactUseModel: true` to hand the rewriting to a model instead.

That model is **never chosen silently from a costly route**. A coding session's
own route is usually the expensive one, so:

- `compactProvider` + `compactModel` name the route explicitly; an explicit pair
  always wins, including a `deepseek` route — that is how you say "yes, this one".
- Without a pair, an implicit pick must clear `compactDenyProviders` (default
  `deepseek,dsk`, so your local `spark` model is chosen instead), and the model id
  is resolved from what the chosen provider actually advertises rather than
  guessed.
- If nothing permitted is available, the pass **refuses the model and says so**
  rather than quietly falling back to the route you were avoiding — and still
  compacts, deterministically. The same applies if a permitted provider advertises
  no model at all: an uncallable empty route is reported, not attempted.

A model that is unreachable, slow, or returns nothing usable is likewise never
fatal: the pass falls back to the deterministic memory and reports why. The model
only ever replaces the *wording*, never the decision to compact — and what it
writes is verified as described above.

### What survives

`/rwm wipe` keeps node 0 — the system prompt — because that is the frame the
agent reasons inside and the one thing that was asked to be kept. Everything
after it collapses into a single memory that still lists the file records, so a
wipe does not lose track of which files were touched.

Nothing is deleted in either case. Both passes shadow through the same
`replace` op as every other rewrite here: the replaced nodes stay in the log,
carry their `compaction/prune` shadow price, and remain readable through
`rwm_access` and `$rwm-<n>-full`. Neither pass writes to disk — there is a
verifier for that, below.

### Terse prompt

The instruction text this plugin contributes to the system prompt is kept short
deliberately: it is re-sent on every single request, so a verbose policy is a
permanent tax on the context it exists to save. The block describing memories,
citations, the file rule, and both commands is ~700 characters — about a fifth
smaller than the version that described *less*, since each line now carries its
weight and the tool schemas supply the detail.

`exposePolicySection: false` drops the block entirely for a session that does not
need the reminder, leaving only the citable index.

---

## Tools

### `rewrite_memory`

| Argument | Meaning |
|---|---|
| `memory` (required) | The replacement text, as terse as possible. |
| `keep_recent_messages` | Newest messages kept verbatim (default `retainRecentMessages`, minimum 1). |

Never gated: the agent may call this in a session that was never enabled, and the
call lands at the next pre-step. `/rwm enable` only adds the automatic passes on
top.

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
| `enabledByDefault` | `false` | Force the automatic passes on without `/rwm enable`. |
| `retainRecentMessages` | `8` | Tail messages never rewritten. |
| `autoStubToolResults` | `true` | Replace retired tool output with a recall marker. |
| `dedupeFileReads` | `true` | Keep one copy of each file: retire older reads and edits. |
| `keepErrorResults` | `true` | Never shorten a failed tool result. |
| `toolResultPreviewChars` | `0` | Leading characters of a stubbed output worth keeping. |
| `exposePolicySection` | `true` | Publish the policy section and the citable index. |
| `sectionOrder` | `2550` | Prompt-section order; the index sits ten after it. |
| `indexLimit` | `40` | Most recent citable entries listed. |
| `accessMaxChars` | `8000` | Budget for one `rwm_access` answer. |
| `dereferenceMaxChars` | `20000` | Budget for one `$rwm-<n>-full` expansion. |
| `autorunAfterThoughts` | `true` | Fold agent thoughts into `rwm-c-` memories after each. |
| `autorunAfterConsole` | `true` | Fold console output into `rwm-c-` memories after each. |
| `condenseSummaryTokens` | `8` | Max salient tokens a condensation summary may list. |
| `compactKeepRecent` | `1` | Newest surface nodes `/rwm compact` always leaves alone. |
| `compactFileShrink` | `'partial'` | How much file text a record carries: `reference`, `partial`, or `full`. |
| `compactUseModel` | `false` | Let a model write the compact memory instead of the deterministic wording. |
| `compactProvider` | `''` | Provider route for that model; pair it with `compactModel`. |
| `compactModel` | `''` | Model id for that route; pair it with `compactProvider`. |
| `compactMaxTokens` | `700` | Output-token cap for the compaction call. |
| `compactTimeoutMs` | `30000` | Deadline for the compaction call before it falls back. |
| `compactDenyProviders` | `'deepseek,dsk'` | Provider fragments never chosen implicitly. |
| `compactAllowProviders` | `''` | Exact provider ids allowed despite a deny fragment. |

Choosing a model for `/rwm compact` without spending on the frontier:

```yaml
config:
  compactUseModel: true
  compactProvider: local-spark     # your own model
  compactModel: spark-x-t-4b
  compactDenyProviders: deepseek,dsk
```

An explicit `compactProvider`/`compactModel` pair is always honoured — writing
`deepseek` there is how you deliberately choose it. The deny list governs only
the *implicit* pick, so leaving the pair unset can never silently land on a route
you were avoiding.

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

The transcript is never truncated. Every line the loaded window folds to is
rendered, however many that is, so the preview cannot end in a "more lines not
shown" dead end. Rows carry per-row paint containment
(`content-visibility: auto` with an intrinsic line size), which keeps a
tens-of-thousands-of-lines transcript scrolling without giving up a line.

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
after every restart to get the automatic passes back. The agent's own
`rewrite_memory` calls do not depend on it and keep working either way.

---

## Verifying it

```sh
cd "/500gb/dsh plugins/autoremovecommandsandthoughtsonmaxtokens"

node --test test/                       # 171 unit tests
node tools/verify-against-harness.mjs   # tool schemas against the real DSH validator
node tools/mount-smoke.mjs              # real Cordis mount + real Session rewrite
node tools/verify-client-fold.mjs       # browser fold vs the harness's foldSurface()
node tools/verify-file-dedupe.mjs       # one copy per file, on real DSH sessions
node tools/verify-compact.mjs           # /rwm compact and /rwm wipe, on real sessions
node tools/verify-no-write.mjs          # neither pass writes to disk
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

`tools/verify-file-dedupe.mjs` is the file rule's own proof. On real Sessions it
requires that two reads of one file leave **one** full copy and one marker, five
reads leave one copy and four markers, no read ever leaves history, the retired
bytes stay recoverable from the log, the shadow price is non-zero, an unforced
session is left byte-identical, and two distinct files are never mistaken for
duplicates.

It earns its keep: it caught `Session.deriveEventMessage` being called with a
sequence number instead of an event object — something the stubbed unit tests had
encoded wrongly — and, for the file rule, it is what proved that the generic
tool-output trimming could otherwise stub a file's single surviving copy.

`tools/verify-compact.mjs` proves the whole-conversation passes. Its twenty
scenarios run on real Sessions and require that compact collapses the
conversation to one numbered memory while the system prompt stays first and
unaltered; that a file appears as a
`file <path> <read|written> <timestamp> <bytes>b -><seq>` record carrying a
resolvable pointer back to its source event; that the three shrink modes are
genuinely distinct — `reference` carries no file text, `partial` (the default)
carries a bounded hint and never the whole document, `full` carries all of it —
and that **the reply names the mode that actually ran**; that tool output
survives as one clipped line and a 2MB message becomes a 261-character memory;
that a **developer message** and a tool result that arrived **without a call**
are compacted like any other context; that a wipe leaves exactly the system
prompt plus one memory and still lists which files were touched; that a session
holding only the system prompt, and a completely empty session, are graceful
no-ops rather than errors; that repeated compact/wipe passes interleave safely;
that the `compaction/prune` price covers **exactly** the nodes that left the
surface and all of them are cited by the replacement; that `verifyFileRecords`
rewrites a record that contradicts the session log and marks a file the session
never touched as `UNVERIFIED`; that every replacement in a real compact+wipe
retires one **contiguous surface run**, so the provider's cached prefix still
applies; and that the model path behaves: no call when
`compactUseModel` is false, the configured route when it is true, a **refused**
denied route, and a deterministic fallback when the model throws.

`tools/verify-no-write.mjs` is the adversarial one. It wraps every `node:fs`
mutator and runs compact — both deterministic and model-backed — followed by a
wipe, then fails if any of them was called. "Files unaltered" is the load-bearing
promise of the whole feature, and reading the memory text cannot prove it.

Point `DSH_CHECKOUT` at a different checkout if yours is not
`/home/naruzkurai/deepseek-harness`.

---

## Known limitations and what is next

- **The judge is deterministic, not a model.** It refuses requests whose strong
  identifiers contradict the content and allows everything else. The design you
  described — a fresh, empty-context reviewer that reads the request's reasoning
  and the memory's lock and answers yes/no/maybe independently, with a re-ask
  interval after a failure — is not implemented. The lock, the denial record,
  the "refusal is never re-sent as context" rule are in place for it, and
  `/rwm compact` now provides the working `ctx.llm.stream()` call to build it
  from; the reviewer itself is the next step.
- **Compaction trusts the tool name to classify a call.** A call is a *file* when
  its name looks file-ish and its arguments carry a known path key: it becomes a
  `file ...` record. Everything else — including a `bash` call that printed a
  file — becomes one clipped tool line. Nothing here reads the disk, so no
  record can be more accurate than the call it came from.
- **A compaction's summary is lossy by construction.** The deterministic memory
  keeps paths, actions, counts, errors, and one clipped line per tool; it does
  not keep the wording of what was said. That is the point, but it means a
  compacted conversation is recalled through `rwm_access`, not re-read. The
  retained tail (`compactKeepRecent`, default 1) is the only part left verbatim.
- **Only the file records of a model summary are verified.** `/rwm compact` tells
  the model to copy `file ...` records verbatim and invent nothing, and
  `verifyFileRecords` enforces that part: a record contradicting the log is
  rewritten to the truth, and a file the session never touched is marked
  `UNVERIFIED`. The model's *prose* is deliberately untouched, so a summary can
  still misdescribe what happened in words. That is why the deterministic path is
  the default and the model path is opt-in.
- **Prefix-cache friendliness is structural, not tunable.** There is no
  prefix-cache API in DSH, so this plugin cannot request a cache block, pin a
  cache key, or measure a hit. What it can do — and does — is refuse to emit a
  replacement that would invalidate more of the prefix than necessary, which is
  checked on every plan. Whether the provider then reports a hit is observable
  only after the fact, in `cacheReadTokens` per assistant message.
- **`/rwm wipe` is not undoable from the model's view.** It shadows everything
  after the system prompt; the retired nodes stay in the log and remain readable
  through `rwm_access`, but the model will not see them again unless it cites
  them. There is no confirmation prompt.
- **Compaction is manual and unguarded.** It does not require `/rwm enable`, has
  no dry run, and no size threshold — `/rwm compact` always compacts whatever is
  foldable. `/rwm` on its own reports status without changing anything.
- **Triage of a tool call is not automatic.** There is no flow yet for marking a
  call "no useful information", writing the note, or refusing repeats pending
  fulfilled reasoning. Nothing is blocked today; `rwm_access` is the only gate.
- **The file rule converges, it does not land at once.** One pass retires what is
  foldable; a copy created inside the current step becomes foldable on the next
  pass, so a duplicate can survive the step that made it. Four passes are enough
  for every shape the verifier builds, and nothing is left behind indefinitely.
- **The file rule trusts the tool name and the argument shape.** A call is treated
  as naming a file when its name looks read-ish and its arguments carry a known
  path key. A tool that hides its path under another key, or that prints a file's
  contents under a name like `bash`, is not deduped. Paths are compared as
  normalised strings — no symlink resolution, no volume case rules, and no read
  from disk, because this module never touches the filesystem.
- **Only the surface is visible to it.** A copy that was already folded away is
  out of reach and stays reachable only through `rwm_access`.
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
