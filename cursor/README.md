# arch-live for Cursor

The same live architecture map, work journal and browser notepad as the Claude Code mod, for Cursor's agent. Cursor has no side pane for plugins, so everything you look at is in the notepad; the agent keeps the map and the journal up to date through an MCP server, and Cursor's hooks log each turn.

The map (`<project>/.claude/architecture.json`) and the journal (`~/.claude/arch-live/logs/<project>/`) are the files the Claude Code mod uses, so a project worked on in both apps has one map, one journal and one notepad.

## Install

Needs Node 22.6 or newer (`node -v`).

```bash
git clone https://github.com/DrakeMikels/arch-live.git
node arch-live/cursor/install.mjs
```

Then in Cursor run **Developer: Reload Window** and open **Customize**: the arch-live rule, MCP server and commands should be listed. On an Enterprise plan, **Allow Local Plugin Imports** must be on.

The installer writes a small local plugin to `~/.cursor/plugins/local/arch-live/` whose scripts run from your clone. After a `git pull`, run the installer again and reload Cursor. `node cursor/install.mjs --uninstall` removes it.

## Use

| Command | What it does |
| --- | --- |
| `/arch-map` | The agent maps the project's architecture (do this once per project) |
| `/notepad` | Starts the notepad and gives you its address: journal, diagram, board, standup, timeline, insights |
| `/standup` | The agent writes your standup from the journal and saves it to the notepad's Standup tab |
| `/n`, `/todo`, `/blocker`, `/decision` | Add to the journal, e.g. `/todo add retries @api` |
| `/done` | Close the open todo or blocker that matches |
| `/arch-export` | Writes the diagram to `docs/architecture.svg` |

The notepad starts by itself when a chat starts. Buttons that need the agent (Write in Cursor, Break down, Describe, Send to Cursor, Re-map) open the request in Cursor's chat through a prompt link; press Enter there to run it. The request is also copied, in case your browser asks before opening Cursor or the request is too long for a link.

## How it fits together

| Part | File | Instead of (Claude Code mod) |
| --- | --- | --- |
| Tools the agent calls | `scripts/mcp.mjs` (MCP over stdio) | the mod's registered tools |
| Turn logging | `scripts/hook.mjs` (`beforeSubmitPrompt`, `afterFileEdit`, `afterShellExecution`, `afterAgentResponse`, `stop`, …) | `prompt.submit`, `tool.call`, `turn.complete` |
| When to call the tools | `rules/arch-live.mdc`, generated from `hooks/prompts.ts` | the guide in every prompt |
| Files, journal, notepad start | `scripts/core.mjs` | the engine's `$.fs`, `$.state`, `$.process` |
| Requests from the notepad | the notepad server with `--host cursor` returns a prompt; the page opens it in Cursor | the session inbox the mod reads |

Everything else (map logic, journal, standup, prompts, rendering, the notepad) is shared with the mod, unchanged. Node loads the TypeScript modules directly (`notepad/ts-register.mjs` resolves their extensionless imports).

## Not in Cursor

- The side pane and the row above the prompt (carry yesterday forward, mark a component): use the notepad.
- Sending a board to another open chat: it goes to the current one.
