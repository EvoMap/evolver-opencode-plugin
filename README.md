<p align="center">
  <img src="assets/logo.png" alt="Evolver" width="96" height="96" />
</p>

<h1 align="center">Evolver — Agent Self-Evolving Engine</h1>

**An OpenCode that gets smarter the more you use it.**

Most agents have goldfish memory. They fall into the same hole the last session fell into, and re-derive
yesterday's working fix from scratch. Evolver lets your OpenCode agent evolve itself: every success becomes a
shortcut for next time, and every failure becomes a warning.

- **Each prompt starts with a proven strategy.** Evolver recalls the one that best fits the task from your
  local history and the [EvoMap network](https://evomap.ai) and hands it to the agent behind your prompt.
- **Graded on evidence, not a hunch.** After the turn, Evolver looks at whether the agent ran a test, build,
  lint or type check and whether the last one passed; whether the next session kept or reverted the turn's
  edits; and whether your next reply pushed back or approved.
- **Survival of the fittest.** Every verdict goes back to the EvoMap network with its evidence tier.
  Strategies that work get recalled more often; ones proven wrong sink.

Nothing of Evolver but the recalled steps enters the model's context: no tools, no instructions. Reports go out
at every turn end, the session's verified work is distilled when the session ends, and the `/evolver-*`
commands (status, search, distill, sync, review, run, solidify) run in the plugin, not through the model;
only `/evolver-evolve` hands the agent a one-off checkpoint prompt. Set `skillEnabled: true` in the plugin
options to also offer the agent the `capability-evolver` skill, which explains all this; its catalog line then
rides every turn.

## Install

Requires OpenCode 1.19.4 or newer.

```bash
opencode plugin evolver-opencode-plugin
```

OpenCode installs the package and lists it twice: in `opencode.json` for the server plugin (recall, reports,
distillation) and in `tui.json` for the TUI plugin (the `/evolver-*` commands). Restart OpenCode afterwards.
Add `-g` to install it for every project. Options go in `opencode.json`:

```json
{
  "plugin": [["evolver-opencode-plugin", { "skillEnabled": false, "assetPrimeMinSimilarity": 0.3 }]]
}
```

Settings and their defaults are in [`src/config.js`](src/config.js).

### Local file mode

For development, or to run a checkout:

```bash
node scripts/install.js --install --config-root /path/to/project
node scripts/install.js --verify --config-root /path/to/project
```

This writes a managed delegate to `.opencode/plugins/evolver.js` and lists `src/tui.js` in
`.opencode/tui.json`. `--uninstall` removes both, and installing also removes the Evolver section that
versions before 0.2.0 wrote into `AGENTS.md`.

## Commands

| Command | What it does |
|---|---|
| `/evolver-status` | Proxy, Hub auth, recent recalls and the Hub's verdict on recent reuse reports |
| `/evolver-search` | Searches the EvoMap network for reusable assets |
| `/evolver-distill` | Distills the open session's latest verified turn now, instead of at session end |
| `/evolver-sync`, `/evolver-review`, `/evolver-run`, `/evolver-solidify` | Run `evolver <command>` in the project (the installed `evolver`, else `npx -y @evomap/evolver@^2.0.39`), ten minutes at most |
| `/evolver-evolve` | Hands the agent a reflection checkpoint on the current work, with an optional focus |

OpenCode's own slash commands are prompt templates the model answers, so every command but `/evolver-evolve`
lives in the TUI plugin and answers in a dialog. Pick it from the `/` menu or the command palette: a command
that takes text asks for it in a dialog. Text typed after the command name on the prompt line is sent to the
model as an ordinary prompt instead, because OpenCode only runs a TUI command it was handed from its menu.

## Connect the EvoMap network (optional)

Local memory works without an account. Network reuse runs through the local Evolver Proxy, which the plugin
sets up on its own once per OpenCode instance (project directory), in the background:

- `evolver` missing, or older than 2.0.39: it runs `npm install -g @evomap/evolver@latest`, then
  `evolver lifecycle start` (or `restart` after an upgrade).
- `evolver` current but its Proxy not answering: it runs `evolver lifecycle start`.

What it did, or why it could not, shows as a toast. To finish connecting, open the claim link the Proxy writes
to `~/.evomap/claim_url` while signed in to [evomap.ai](https://evomap.ai), then run `/evolver-status`.

## Session-end distillation

A turn that ended completed, used tools and passed its last check leaves a candidate in
`~/.evolver/state/opencode-distill-pending.json`, a turn that reused an injected strategy too (the engine's
intake drops a Gene that repeats one it already has); a later verified turn replaces it, and a next prompt that reads as a correction drops it. When the session ends, one call to the session's own model writes a
Gene from a digest of that turn (task, commands, touched paths, checks, final answer — never the whole history)
and sends it to the Proxy's `POST /conversation/distill` with `persist: true`, `publish: false` and its own
token cost as `distill_usage`. Keys and tokens are stripped from the candidate first, paths and a manual focus
included.

OpenCode gives a plugin no model call of its own, so that call is a prompt in a helper session: created with
every tool denied, archived, marked in its metadata so this plugin neither recalls into it nor records it, and
deleted once answered. A session ends when it is deleted, which distills it at once, or when OpenCode shuts
down, which only closes its candidate, because shutdown waits five seconds at most. A candidate stays on disk
until it is distilled (three failed tries give it up); one whose session is over — closed, or left by an
OpenCode process that was killed — is claimed by the next session that starts, one process at a time, while an
idle session keeps its own. `/evolver-distill` does the same at once.

## Reuse reports

Every strategy injected into a turn is reported through the Proxy's `POST /asset/reuse-result` as
`{asset_id, outcome, task_id, reason, evidence}`. The Hub weighs each report by its evidence:

| Report | When | `task_id` | `evidence` |
|---|---|---|---|
| Turn end | the turn ends | `opencode:<session>:<turn>` | `tier` `L1` when the turn ran a test, build, lint or type check, else `none`; `applied: used`; `check` `{kind, passed, fail_then_pass}` of the last check; `aborted`; `stage: immediate` |
| Correction | the next prompt says the answer did not hold, or approves it | `…:correction` | `tier: L3`, `applied: used`, `stage: correction` |
| Retention | the next session in the same project finds the turn's edits kept or reverted | `…:retention` | `tier: L2`, `applied: used`, `stage: retention` |
| Aborted | the session is deleted, or OpenCode exits or is killed, before the turn ends (a killed process's go out at the next session start) | `opencode:<session>:<turn>` | `tier: none`, `applied: used`, `aborted: true`, `stage: immediate` |

- **How a turn ended** is read from OpenCode itself: it goes idle after every turn, and the `session.error`
  before it (`MessageAbortedError` for an interrupt) and the last assistant message's `finish` tell a
  completed turn from an interrupted, failed, length-capped or permission-blocked one.
- **Turn numbers** survive the process: a resumed session keeps its id, so its counter is kept in
  `~/.evolver/state/opencode-turns.json` for a month after its last turn and a report never repeats a task id.
- **`applied`** is always `used`: the model follows a strategy injected into its turn. Whether the strategy
  helped is what the outcome says, judged by the turn's last check (or how the turn ended when it ran none),
  the next prompt and whether its edits were kept.
- **Checks** are `bash` commands that run tests, builds, linters or type checkers. A check fails on a non-zero
  exit code, on a run its timeout killed, or on failure output, since a failing run piped through `tail` still
  exits zero. A check the person denied or interrupted never finished and does not count.
- **Delivery.** Reports wait in `~/.evolver/state/opencode-reports-outbox.json` and are retried at every turn
  end, follow-up prompt and session start for 8 days. A report is settled once the Hub answers it; one the Hub
  refuses as invalid is settled as rejected and never resent.
- Reasons name the turn and the check kind, never the prompt, a command, code or a diff,
  and the prompt loses keys and tokens before recall sends it.

Every state file this plugin writes starts with `opencode-`, so another host's Evolver plugin never claims or
reports its entries.

## Development

```bash
npm test
npm run pack:dry
```

## License

MIT © EvoMap.
