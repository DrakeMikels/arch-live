import type { ArchEdgeStyle, ArchKind, JournalNoteType, PaneTab } from '../types'

// Names, files and limits the mod's parts share.

export const PANE = 'arch-live'
export const GRAPH_FILE = '.claude/architecture.json'
export const EXPORT_FILE = 'docs/architecture.svg'
export const POPOUT_FILE = '.claude/architecture.html'
// Desktop panes report their width in character cells of about this many CSS
// pixels (measured: a 79-cell pane is about 550px wide).
export const CELL_PX = 7

export const UPDATE_TOOL = 'mcp__arch-live__arch_update'
export const THEME_TOOL = 'mcp__arch-live__arch_theme'
export const DECISION_TOOL = 'mcp__arch-live__log_decision'
export const BLOCKER_TOOL = 'mcp__arch-live__log_blocker'
export const TODO_TOOL = 'mcp__arch-live__log_todo'
export const DESCRIBE_TOOL = 'mcp__arch-live__describe_files'
export const STANDUP_TOOL = 'mcp__arch-live__save_standup'
export const BREAKDOWN_TOOL = 'mcp__arch-live__arch_breakdown'
export const EXPLAIN_TOOL = 'mcp__arch-live__explain_part'

export const PART_ROLES = ['entry', 'handler', 'ui', 'logic', 'data', 'integration', 'config', 'util']
export const NOTE_COMMANDS: Record<string, JournalNoteType> = { n: 'note', todo: 'todo', blocker: 'blocker', decision: 'decision' }
export const COMMANDS = ['arch', 'arch-map', 'arch-theme', 'arch-export', 'standup', 'done', 'notepad', ...Object.keys(NOTE_COMMANDS)]
export const DAY_MS = 24 * 60 * 60 * 1000

export const TABS: [PaneTab, string][] = [
  ['diagram', 'Diagram'],
  ['journal', 'Journal'],
  ['timeline', 'Timeline'],
  ['standup', 'Standup'],
]
export const NOTE_TYPES: [JournalNoteType, string][] = [
  ['note', 'Note'],
  ['todo', 'Todo'],
  ['blocker', 'Blocker'],
  ['decision', 'Decision'],
]
export const NOTE_PLACEHOLDER: Partial<Record<JournalNoteType, string>> = {
  note: 'Note… (@component to tag it)',
  todo: 'What is left to do…',
  blocker: 'What is blocking you…',
  decision: 'Decision… because why',
}

export const KINDS: ArchKind[] = ['client', 'edge', 'service', 'worker', 'queue', 'store', 'external']
export const STYLES: ArchEdgeStyle[] = ['call', 'http', 'async']
export const PROJECT_MARKERS = ['.git', 'package.json', 'pyproject.toml', 'go.mod', 'Cargo.toml', 'Gemfile', 'pom.xml']

// How long the drawing tags what the latest map change added or changed.
export const FRESH_MS = 15 * 60_000
// Which components are open in place, beside the journal: the pane and the
// notepad both read and write it, so they open and close together.
export const VIEW_FILE = 'map-view.json'
