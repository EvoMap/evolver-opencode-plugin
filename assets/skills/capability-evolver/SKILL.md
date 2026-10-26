---
name: capability-evolver
description: How Evolver's evolution memory works in this session and how to reach it. Use when the user asks about Evolver or EvoMap, an [Evolution Memory] block, or asks the agent to "evolve", "learn from this", or "remember how this went". An injected [Evolution Memory] block needs none of this: apply it.
---

# Capability Evolver

This plugin gives the agent a **persistent, auditable evolution memory** built on the
Genome Evolution Protocol (GEP): past outcomes — what worked, what failed — are carried
forward into future sessions. All of it runs on its own; nothing here asks you to call a tool.

## What runs on its own

- **Behind every prompt** (`chat.message`, once per turn) — recalls the strategy that best
  fits the turn's prompt from the local history and the EvoMap network and injects its steps
  as an `[Evolution Memory]` block. Apply them where they fit.
- **Turn end** — reports every injected strategy with the turn's evidence: whether its steps
  show up in the commands, edits and answer, and the result of the last test, build, lint or
  type check. A turn that never ends (the session goes away or is killed) is reported as aborted.
- **Follow-ups** — the next prompt that says the answer did not hold (or approves it), and the
  next session in the same project, which checks whether the edits were kept, revise that report.
- **Session end** — the latest turn that finished verified, used tools and reused no injected
  strategy is distilled into a reusable Gene, outside this conversation.

## Commands the user can run

`/evolver-status`, `/evolver-search <task>`, `/evolver-distill [focus]` (distill now instead of
at session end), `/evolver-sync`, `/evolver-review`, `/evolver-run`, `/evolver-solidify`, and
`/evolver-evolve` for a deliberate checkpoint. All but `/evolver-evolve` run in the plugin, in
OpenCode's TUI; point the user to them rather than reproducing them by hand.
