---
name: project-memory
description: Recall and record durable project knowledge in .agents/memory. Use at the start of any non-trivial task and whenever you learn something that cost time to discover.
---

# Project memory

The store is a flat folder of one-fact markdown files plus an index. It is the accumulated cost of
rounds that went wrong: a fact here is one you would otherwise re-derive from a failed experiment.

Claude Code writes this format natively (its auto-memory directory is pointed at the same folder by
`scripts/install-agent-config.sh`). This skill exists so Codex reads and writes the *same* store,
rather than starting a second one that neither tool can see.

## Where

- `.agents/memory/MEMORY.md` — the index: one `- [Title](file.md) — one-line hook` line per memory.
- `.agents/memory/<slug>.md` — one memory, one fact.
- The store belongs to the **main checkout**. In a worktree `.agents/memory` is a symlink to it, so
  every branch reads and writes the same files. If the symlink is missing, run
  `scripts/install-agent-config.sh`; never create a second real directory there.
- In a worktree, Codex's `apply_patch` refuses to write through that symlink ("writing outside of
  the project"), so create and edit memory files there with a shell command instead.
- Git-ignored, like the rest of `.agents/`.

## Recall

1. Read `MEMORY.md` first. The hooks are written to be skimmed — that is the whole point of them.
2. Open the **1–3** files whose hooks match what you are about to do, and follow their `[[links]]`.
3. Never bulk-read the folder. It has hundreds of files; reading them all buries the task.

Do this before any non-trivial task, and again when something surprises you — a "this is impossible"
or "this was measured and refuted" note is usually already there.

## Save

Write a memory when you learn something that cost time and will still be true next month: a root
cause, a refuted hypothesis, a trap in a tool, a preference the user stated. Not a task summary, not
something already in `AGENTS.md` or `docs/`.

```markdown
---
name: r23-atlas-residency
description: One line that says the finding, not the topic
metadata:
  node_type: memory
  type: project
---

The fact, stated first, in one or two sentences.

**Why:** what was observed, and what made the obvious explanation wrong.

**How to apply:** what a future agent should do differently. Related: [[other-memory-name]].
```

- `metadata.type` is one of `user` (a stable preference), `feedback` (a correction to act on),
  `project` (how this codebase actually behaves), `reference` (a durable pointer or table).
- `**Why:**` and `**How to apply:**` are required for `feedback` and `project` — a bare claim with no
  evidence gets re-litigated.
- Add exactly one line to `MEMORY.md` for the new file.
- Negative results are worth as much as positive ones. Say so explicitly: "measured, NOT reproducible".

## Update, don't duplicate

Before writing, check whether a memory on the subject exists. Amend it — correct the claim, add the
new evidence, keep the same filename and index line. A second file on the same subject means the
next agent reads the stale one. When a subject grows past ~8 files, make a topic index memory that
links them and point the index line at that.

## Never store game code, assets or wire payloads

Everything in the Artifact Policy in `AGENTS.md` applies here too — `.agents/memory` is a working
store, not a place for transcribed game source, a walkthrough of the game's internals, captured
payloads or extracted assets. That material goes to `.sts2/research/` at the **main checkout** path.
A memory may point at a research note; it may not inline one.
