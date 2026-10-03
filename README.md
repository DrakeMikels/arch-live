# arch-live

A Claude Code mod that keeps a live picture of the system you are building and a work journal for your daily standup.

- **Live architecture.** Claude keeps `.claude/architecture.json` up to date as it works; the side pane draws it in your own design tokens.
- **Work journal.** Each turn is logged with the files and components it touched. `/n`, `/todo`, `/blocker` and `/decision` jot notes mid-turn; Claude logs its own decisions and blockers.
- **Standup.** `/standup` builds a brief since the last one and copies it for Slack.
- **Notepad.** `/notepad` opens a browser app for a second monitor: journal, component drawer (files, functions, summaries), whiteboard with Send to Claude, and the standup.

## Layout

| Part | Files |
| --- | --- |
| Mod hooks | `hooks/register.tsx`, `types/index.d.ts` |
| Diagram renderer | `hooks/render.ts`, `hooks/theme.ts` |
| Journal and STE distiller | `hooks/journal.ts`, `hooks/ste.ts` |
| Notepad server | `notepad/server.mjs`, `notepad/workspace.mjs` |
| Browser notepad | `notepad/app.html` |

Your theme lives in `~/.claude/arch-live/theme.json` and your journal in `~/.claude/arch-live/logs/<project>/`, outside every repo.

## Install

Claude Code loads it from this folder through `CLAUDE_CODE_PLUGIN_DIRS` in `~/.claude/settings.json`; `CLAUDE_CODE_PLUGIN_DIR_WATCH=1` reloads it in running sessions when files change.

```bash
claude plugin validate .
```
