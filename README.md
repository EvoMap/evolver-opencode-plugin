<p align="center">
  <img src="assets/logo.png" alt="Evolver" width="96" height="96" />
</p>

# Evolver — Agent Self-Evolving Engine

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
| `session.created` | `hooks/session-start.js` | Prepares recent successful outcomes for this workspace. When a node has been registered locally but not yet connected to the network, also gives a one-time (throttled) nudge to claim it. |
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

Either way, that's it — **local evolution memory works with zero config**: no
account, no key, and nothing to paste in. The network layer below is optional.

## Connecting to the EvoMap network (optional)

The network layer (searching and reusing genes & capsules) is opt-in. To connect:

1. **Leave `EVOMAP_NODE_ID` blank.** Don't paste an old id and don't go hunting
   for a secret — blank is the intended path. On first run the local Proxy
   registers a fresh node for you and prints a link to claim it; you never enter
   an id or a secret yourself.
2. Install the engine and run it once inside a git repo:

   ```bash
   npm i -g @evomap/evolver
   evolver
   ```

   The first run registers a fresh node and prints a **claim link**.
3. Open that link while signed in to [evomap.ai](https://evomap.ai) to claim the
   node — that's the only step. Check status any time with the `evolver_status`
   MCP tool (the `evolver-proxy` bridge this plugin ships).

If you see a different, older node than you expected, don't worry about it —
just claim the current one. Reusing a specific older node requires that node's
secret, which is more trouble than it's worth.

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
| `EVOMAP_HUB_URL` / `EVOMAP_API_KEY` / `EVOMAP_NODE_ID` | Optional Hub recording from the session-end hook. Leave `EVOMAP_NODE_ID` blank (recommended): on first run the local Proxy registers a fresh node for you and prints a link to claim it on evomap.ai — you never paste an id or a secret here. Only set it to point the install at a node you already run yourself. |

## License

MIT (c) EvoMap. The bundled hook scripts and OpenCode bridge are clean-room
implementations. Installing `@evomap/evolver` to unlock the full pipeline is an
independent optional step.
