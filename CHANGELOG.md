# Changelog

## 0.1.0 - 2026-06-25

- Initial OpenCode server plugin for Evolver.
- Wire OpenCode `session.created`, `tool.execute.after`, and `session.idle`
  events to the clean-room Evolver hook scripts.
- Support npm package loading through `exports["./server"]`.
- Add local-file install, verify, and uninstall CLI for `.opencode/plugins`.
- Ship the shared Evolver hooks, capability skill, and proxy MCP bridge.
