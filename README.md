<p align="center">
  <img src="assets/logo.png" alt="Evolver" width="96" height="96" />
</p>

# Evolver — Self-Evolving Agent Memory for OpenCode

Give OpenCode a persistent, auditable evolution memory powered by
[EvoMap](https://evomap.ai) and the Genome Evolution Protocol (GEP).

The plugin recalls what worked in recent sessions during OpenCode compaction,
detects improvement signals while OpenCode edits files, and records outcomes
when a session is deleted. It uses the same memory format as the Evolver Claude
Code and Cursor plugins, so successful patterns can be reused across agent
hosts without sharing unrelated project state.

## What it does

| OpenCode event | Evolver hook | Effect |
|---|---|---|
| `session.created` | `hooks/session-start.js` | Prepares recent successful outcomes for this workspace. |
| `experimental.session.compacting` | `hooks/session-start.js` | Adds Evolver memory to OpenCode's compaction context. |
| `tool.execute.after` (`write`/`edit`) | `hooks/signal-detect.js` | Detects evolution signals in edited content. |
| `session.deleted` | `hooks/session-end.js` | Records one current-diff outcome to local memory. |

Memory is workspace-scoped via `<repo>/.evolver/workspace-id`, so one project's
outcomes do not leak into another project.

## Install

### npm package mode

Add the package to your OpenCode config:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["evolver-opencode-plugin"]
}
```

Restart OpenCode. OpenCode installs npm plugins automatically with Bun at
startup and loads the server plugin from this package's `./server` entrypoint.

### Local file mode

For local development or manual installation:

```bash
npx evolver-opencode-plugin --install --config-root /path/to/project --force
npx evolver-opencode-plugin --verify --config-root /path/to/project
```

This writes a small managed delegate file to
`/path/to/project/.opencode/plugins/evolver.js`.

## Requirements

- Node.js 18 or newer.
- Git, because outcomes are derived from git diffs.
- OpenCode 1.x.

The plugin works offline by default and writes local memory to
`~/.evolver/memory/evolution/memory_graph.jsonl` unless the project already has
`memory/evolution/memory_graph.jsonl` or `MEMORY_GRAPH_PATH` is set.

## Optional Evolver engine

The plugin hooks are self-contained and do not require the Evolver engine. To
unlock the full CLI, proxy mailbox, asset search, review, and solidify flows:

```bash
npm install -g @evomap/evolver
evolver
```

Running `evolver` starts the local EvoMap Proxy mailbox. This repository also
ships the same thin `mcp/evolver-proxy.mjs` bridge used by the sibling plugins
for MCP clients that can consume it.

## Verify

For this repository:

```bash
npm test
npm run pack:dry
```

For a local-file install:

```bash
npx evolver-opencode-plugin --verify --config-root /path/to/project
```

OpenCode's TUI plugin list is for TUI plugins. Evolver is a server/event plugin,
so it runs in the background and may not appear in UI-only plugin screens.

## Environment variables

| Variable | Purpose |
|---|---|
| `EVOLVER_OPENCODE_HOOKS_DIR` | Override the package hooks directory. |
| `OPENCODE_PROJECT_DIR` | Set by this plugin before invoking hooks. |
| `MEMORY_GRAPH_PATH` | Override the local memory graph JSONL path. |
| `EVOLVER_WORKSPACE_ID` | Override workspace scoping id. |
| `EVOMAP_HUB_URL` / `EVOMAP_API_KEY` / `EVOMAP_NODE_ID` | Optional Hub recording from the session-end hook. |

## License

MIT (c) EvoMap. The bundled hook scripts and OpenCode bridge are clean-room
implementations. Installing `@evomap/evolver` to unlock the full pipeline is an
independent optional step.
