# Changelog

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
