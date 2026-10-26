# Changelog

## 0.2.0 - 2026-10-26

Keep Evolver out of the model context: recall behind the prompt, report at turn end, distill at session end.

### Changed
- Rewritten as a native OpenCode plugin package: `./server` (recall, reports, distillation) and `./tui`
  (the `/evolver-*` commands). The Claude-style command hooks, the `evolver-proxy` MCP bridge and the
  always-on `capability-evolver` skill are gone, so no `evolver_*` tool and no Evolver instruction reaches the
  model. The skill is offered only with `skillEnabled: true`.
- The recalled strategy joins each prompt as synthetic text behind it and ends with `Apply them where they
  fit.`; a recall slower than the wait joins the turn's next step. Nothing else is injected: no
  `[Evolution Signal]` after edits, no session-start text, and the claim reminder is off by default.
- Every injected strategy is reported at turn end, with the turn's real end (completed, interrupted, failed,
  length-capped, blocked) read from OpenCode's `session.error` and the last assistant message, and the check
  verdict from the bash tool's exit code. The next prompt revises it as a correction or praise.
- Turn numbers survive a resumed session (`opencode-turns.json`), so reports never repeat a task id.
- An injected strategy counts as used (dsh #55): every reuse report sends `applied: used`, tier `L1` whenever
  a check ran, and a reason without an applied verdict. A verified turn that reused a strategy is a
  distillation candidate like any other; the engine's intake drops a Gene that repeats one it already has.

### Added
- Aborted reports for strategies whose turn never ended: at session deletion, at OpenCode shutdown (queued
  only), and, for a killed process, at the next session start.
- Session-end distillation of the session's latest verified turn through the session's own model in a
  tool-less, archived helper session, sent to the Proxy's `POST /conversation/distill`; a candidate is kept
  until distilled or given up after three tries, and a closed or orphaned one is claimed by the next session.
- `/evolver-status`, `/evolver-search`, `/evolver-distill`, `/evolver-sync`, `/evolver-review`, `/evolver-run`
  and `/evolver-solidify` run in the TUI plugin and answer in a dialog; `/evolver-evolve` is the one prompt
  command.
- The local installer lists the TUI plugin in `.opencode/tui.json` and removes the old `AGENTS.md` section.

### Removed
- `hooks/`, `mcp/evolver-proxy.mjs`, `server.js`/`server.mjs`, `.opencode-plugin/plugin.json` and the
  session-end diff outcome recording they did.
- The applied verdict (`src/applied.js`) and the per-turn buffer of edited code it read; a turn record keeps
  the paths of the files it edited.

## 0.1.1 - 2026-06-25

- Record session outcomes on OpenCode `session.deleted` instead of
  `session.idle`, avoiding repeated near-duplicate memory writes while a
  session remains idle between turns.
- Limit session-end diffs to current working-tree and staged changes, add
  session/diff de-duplication, and include `session_id`, `workspace_id`, and
  `diff_hash` metadata in records.
- Send optional Hub records with Node `fetch` so API keys are not exposed in
  `curl` process arguments.
- Add OpenCode compaction context injection for Evolver memory.
- Fix local-file uninstall so it removes the full managed `AGENTS.md` section
  and writes files atomically.
- Tighten npm packaging to exclude Claude Code hook config leftovers.

## 0.1.0 - 2026-06-25

- Initial OpenCode server plugin for Evolver.
- Wire OpenCode `session.created`, `tool.execute.after`, and `session.idle`
  events to the clean-room Evolver hook scripts.
- Support npm package loading through `exports["./server"]`.
- Add local-file install, verify, and uninstall CLI for `.opencode/plugins`.
- Ship the shared Evolver hooks, capability skill, and proxy MCP bridge.
