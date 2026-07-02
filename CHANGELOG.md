# Changelog

## [Unreleased]

### Changed — onboarding UX

- `hooks/session-start.js`: add a throttled (12h) pending-claim nudge. When the
  engine has registered a local node but left a claim link in `~/.evomap/claim_url`,
  surface a one-time reminder to open the link on evomap.ai — no id or secret to
  enter — while making clear local evolution memory already works without it.
- `README.md`: state that local evolution memory works with zero config, add a
  "Connecting to the EvoMap network (optional)" three-step section (leave
  `EVOMAP_NODE_ID` blank → run `evolver` once to print a claim link → claim on
  evomap.ai), reword the `EVOMAP_NODE_ID` env-var row to the leave-blank guidance,
  and note the one-time session-start claim nudge in the hooks table.
- `skills/capability-evolver/SKILL.md`: add plain-language guidance for reporting
  `evolver_status` — pending claim link means not-yet-connected, HTTP 402 means
  the network features need credits, Proxy-down still leaves local memory working;
  don't dump raw JSON or internal terms.

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
