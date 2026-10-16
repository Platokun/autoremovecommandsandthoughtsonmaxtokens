# Handoff — rwm shorthand references (file "symlinks")

**Status: items 1–5 DONE and green.** 171 unit tests + all six verifiers pass.
Version `0.1.0010`. Nothing committed; the working tree is dirty by design.

Workspace: `/500gb/dsh plugins/autoremovecommandsandthoughtsonmaxtokens`
Checkout: `DSH_CHECKOUT=/2tb/@/nzk/Applications/deepseek-harness` (required; the default
`/home/naruzkurai/deepseek-harness` does not exist).

## What the user asked for

1. File records in memories must carry **an explicit reference ("symlink") to the real
   file content** — a citation, NOT a filesystem symlink. Confirmed by the user.
2. **Never invent file contents**; model summaries must be **verified, not just
   instructed**. User chose: *"Rewrite wrong file records to the truth, report it."*
3. rwm is **allowed to collapse, keep, or partially keep** file content.
4. The sent prompt may carry the **real full doc** when it matters.
5. Tool emits live updated files in the **most prefix-cache-friendly form**.

## What is DONE

### The record and its pointer
`file <path> <read|written> <ts> <N>b -><seq>` — a resolvable session citation
(`REFERENCE_ARROW = '->'`). Not a disk symlink; the no-write guarantee is intact.

### Shrink modes (`compactFileShrink`)
`reference` (pointer only) / `partial` (default: ≤3 clipped opening lines + `...`) /
`full` (whole document). Validated against `SHRINK_MODES` in `resolveConfig`.
`buildFileRecord` / `fileRecordReference` / `isFileRecordLine` in `lib/memory.js`.

### Verified, not trusted
`verifyFileRecords(text, truths)` → `{text, corrections, invented}`. Rewrites every
wrong `file ...` line to the truth, marks unknown files
`file <path> UNVERIFIED (no such tool call in this session)`, and **never touches model
prose**. Wired into the model path only (`condenseWithModel`).

### Replies derived from data, not prose
`SHRINK_SUMMARY` + rewritten `describeCompact`/`describeWipe`: the reply names the
shrink mode that actually ran and reports corrections/invented files.
`compactSession`/`wipeSession` report `fileShrink`.

### Item 5 — prefix-cache-friendly emission (DONE, structural)
There is **no prefix-cache API in DSH**; cache is provider-side, observable only after
the fact via `cacheReadTokens`/`cacheWriteTokens`. The harness's own Agent Note
(`.agents/notes/implemented/architecture/2026-07-05-reconstructable-requests.md`) states
the invariant: prefix stability is *emergent* — a log projected by a per-node pure
function yields requests that are append-extensions of their predecessors whenever the
header is unchanged.

So the one thing this plugin can get wrong is *how much prefix a rewrite invalidates*.
A replacement may only retire **one contiguous ascending run of the surface**;
everything before it stays byte-identical. `isContiguousTail(entries, seqs)` is the
predicate, asserted by `planMemoryFold`, `planCompact` (via `runSeqs`), and `planWipe`
**at the point the run is derived**.

Two things worth knowing about this:
- It is asserted in the *planners*, not at `appendReplacement`. A guard at the append
  site is vacuous: `shadowedSeqs` there comes from the same contiguous slice it would be
  checked against, so it can never fire. That version was written, tested, and found to
  be dead code — it was removed rather than kept as the appearance of protection.
- Both costs that remain are inherent: compaction itself, and a change to system-prompt
  node 0. Node 0 is never compacted or wiped, so compaction is a one-time full-price
  event rather than a recurring one.

### Fixed along the way
- **Stale node-0 policy line**: the system prompt still said a record is *"never its
  bytes"* with shape `file <path> <read|written> <timestamp>` — false under
  `partial`/`full`, and missing the byte count and `->` pointer. It sits in surface
  node 0, which is never replaced, so it was permanent for a session's whole life.
  Fixed to describe the real format.
- **TDZ crash**: `DEFAULTS` referenced `DEFAULT_FILE_SHRINK` before its declaration.
- **Stale assertions** in `tools/verify-compact.mjs` and `test/compact.test.js` written
  for the old never-carries-content contract.

## Verification state (all green)

| Check | Result |
|---|---|
| `node --test test/` | **171 pass, 0 fail** |
| `tools/verify-compact.mjs` | OK — 20 scenarios |
| `tools/verify-no-write.mjs` | OK — 0 fs mutations |
| `tools/verify-file-dedupe.mjs` | OK |
| `tools/mount-smoke.mjs` | OK |
| `tools/verify-client-fold.mjs` | OK |
| `tools/verify-against-harness.mjs` | OK |

**The prefix invariant is load-bearing, and that was checked by sabotage**: neutering
`isContiguousTail` makes 2 tests fail. An earlier version of this guard did *not* have
that property, which is how the dead-code problem above was found.

## Known smaller loose ends

- `runCompactCall` still hand-rolls `{role:'user', content:[{type:'text'}]}` instead of the
  harness's `createUserMessage` — works, but not the house pattern.
- `isContiguousTail` matches on **surface positions**, not raw seq numbers: `[1,2,4]` is
  contiguous when seq 3 is absent from the surface. This is correct and was the source of
  one wrong test assertion during this work.
- `verifyFileRecords` matches on normalised identity (lowercased, `\`→`/`, `.`/`..`
  resolved). A model spelling a real path differently is reported `UNVERIFIED`.
- Honest limits to keep documented: a compacted conversation is *recalled* via `rwm_access`
  rather than re-read (`compactKeepRecent`, default 1, stays verbatim); `/rwm wipe` has no
  confirmation; tool classification trusts the tool name + known path arg key.
- No full-Context smoke test exercises `verifyFileRecords` end-to-end through
  `condenseWithModel` with a live `ctx.llm`; scenario 18 tests the function directly.

## Installing changes in the running GUI

Installed in profile `web` as
`"@local/dsh-autotrim-context": "github:Platokun/autoremovecommandsandthoughtsonmaxtokens"`
— this checkout is canonical. `/rwm updateplugin` + DSH restart to load changes; `/rwm
enable` must be re-run after a restart (the override is process-local).
