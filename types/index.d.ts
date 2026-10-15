// The data arch-live keeps. Hooks import from '../types'. The engine reads this
// file as the mod's contract, so it stays one self-contained file (no imports
// or re-exports); each area has its own section below.

/* ---------- The project map: .claude/architecture.json ---------- */

export type ArchKind = 'client' | 'edge' | 'service' | 'worker' | 'queue' | 'store' | 'external'

export type ArchNode = {
  id: string
  label: string
  kind: ArchKind
  sublabel?: string
  path?: string
  line?: number
  /** Folders the component owns, project-relative, for matching edits to it. */
  owns?: string[]
  /** One-line summaries of the component's files, by project-relative path. */
  files?: Record<string, { summary: string; at: number }>
  /** What the component is made of, drawn when you open it in the notepad. */
  breakdown?: ArchBreakdown
  order: number
}

/** One part inside a component: a folder, a file or a section of a large file. */
export type ArchPart = {
  id: string
  label: string
  /** entry, handler, ui, logic, data, integration, config or util. */
  role?: string
  path?: string
  line?: number
  /** One plain sentence on its purpose. */
  summary?: string
  /** Claude's in-depth explanation, in Markdown, when asked for. */
  detail?: string
  detailAt?: number
}

/** A component's parts and how they connect; an edge may end at another component's id. */
export type ArchBreakdown = { parts: ArchPart[]; edges: { from: string; to: string; label?: string }[]; at: number }

export type ArchEdgeStyle = 'call' | 'http' | 'async'

export type ArchEdge = { from: string; to: string; label?: string; style?: ArchEdgeStyle }

export type ArchGraph = {
  version: 1
  title?: string
  nodes: ArchNode[]
  edges: ArchEdge[]
  focus: string[]
  updatedAt: number
}

export type ArchSnapshot = {
  ts?: number
  nodes: { id: string; label: string; kind: ArchKind }[]
  edges: { from: string; to: string; label?: string }[]
}

/** What a change to the map added, changed (by id) or removed (by name), and when. */
export type MapChange = { at: number; added: string[]; changed: string[]; removed: string[]; links: number }

/* ---------- The map's history, day by day ---------- */

export type TimelineNode = { id: string; label: string; kind: ArchKind }
export type TimelineLink = { from: string; to: string; label?: string }

/** One step in the map's history: what a day's work changed, or what changed outside any session between two days. */
export type TimelineStep = {
  date: string
  /** day: changed during that day's sessions; between: changed outside them (a pull, an editor) since the day before. */
  kind: 'day' | 'between'
  /** When the map stood as it was before, and as it was after. */
  from: number
  to: number
  added: TimelineNode[]
  removed: TimelineNode[]
  renamed: { id: string; from: string; to: string }[]
  linked: TimelineLink[]
  unlinked: TimelineLink[]
  /** The turns that changed the map that day, oldest first. */
  turns: { ts: number; request: string; session?: string; added: string[]; removed: string[] }[]
  /** The map as it stood after this step. */
  after: ArchSnapshot
}

/* ---------- The diagram's look: ~/.claude/arch-live/theme.json ---------- */

export type ArchPalette = {
  paper: string
  paper2: string
  ink: string
  muted: string
  soft: string
  rule: string
  accent: string
  accentTint: string
  link: string
  nodeFill: string
}

export type ArchTheme = {
  name: string
  source?: string
  mode: 'auto' | 'light' | 'dark'
  light: ArchPalette
  dark: ArchPalette
  fonts: { serif: string; sans: string; mono: string }
}

/* ---------- The work journal: logs/<project>/<date>.json and .web.jsonl ---------- */
// Events are appended, never edited in place, so two writers never clash.

export type JournalFile = { path: string; created: boolean; edits: number }

/** A test run's counts, read from the output of a test command (the turn's last run). */
export type JournalTests = { passed: number; failed: number; command: string }

/** A commit to the project, recorded by the notepad from git: your own, merges left out. */
export type JournalCommit = {
  id: string
  ts: number
  type: 'commit'
  sha: string
  subject: string
  /** Paths relative to the project folder. */
  files: string[]
}

export type JournalTurn = {
  id: string
  ts: number
  type: 'turn'
  request: string
  summary: string[]
  files: JournalFile[]
  components: string[]
  commands: number
  arch?: { added: string[]; removed: string[] }
  /** The Claude Code session it happened in. */
  session?: string
  tests?: JournalTests
  /** Set when days are resolved: the commits that later took this turn's files, oldest first. */
  shipped?: { sha: string; subject: string }[]
  /** Set when days are resolved in a git project: its files no later commit has taken. */
  uncommitted?: string[]
}

export type JournalNoteType = 'note' | 'todo' | 'blocker' | 'decision' | 'mark'

export type JournalNote = {
  id: string
  ts: number
  type: JournalNoteType
  text: string
  by: 'you' | 'claude'
  component?: string
  why?: string
  alternatives?: string
  done?: boolean
  doneAt?: number
  session?: string
  /** Set on reading when the person edited it later. */
  editedAt?: number
}

/** Closes a todo or blocker by id; appended, never edited in place, so two writers never clash. */
export type JournalDone = {
  id: string
  ts: number
  type: 'done'
  ref: string
  by: 'you' | 'claude'
  session?: string
  /** Filled in on reading: what was closed, its kind and the day it was added. */
  refText?: string
  refType?: JournalNoteType
  refDate?: string
}

/** One Claude Code session on the project, kept in logs/<project>/sessions/<id>.json. */
export type JournalSession = {
  id: string
  /** From its first request, until the person renames it. */
  name?: string
  /** True once the person named it, so the first request no longer does. */
  isNamed?: boolean
  startedAt: number
  lastAt: number
  endedAt?: number
}

/** Changes to a note you wrote, appended like done events, never edited in place. */
export type JournalEdit = { id: string; ts: number; type: 'edit'; ref: string; text: string; why?: string; by: 'you' | 'claude'; session?: string }

/** Reopens a todo or blocker closed earlier. */
export type JournalUndone = { id: string; ts: number; type: 'undone'; ref: string; by: 'you' | 'claude'; session?: string }

/** Takes a note you wrote out of the journal. */
export type JournalRemove = { id: string; ts: number; type: 'remove'; ref: string; by: 'you' | 'claude'; session?: string }

/** The last few weeks at a glance: the notepad's Insights tab and diagram overlays. */
export type Insights = {
  span: number
  /** One per day, oldest first, days without work included. */
  days: { date: string; turns: number; commits: number; files: number; tests?: { passed: number; failed: number } }[]
  /** Per component: work in the window, files not committed yet, and the last test run after work on it. */
  components: Record<string, { turns: number; lastAt: number; uncommitted: string[]; tests?: { passed: number; failed: number; at: number } }>
  /** The files changed most in the window. */
  files: { path: string; edits: number; turns: number }[]
  /** Todos and blockers: how many are open, how fast they close, the oldest still open. */
  items: { open: number; closed: number; avgCloseMs?: number; oldest: { text: string; type: string; ts: number }[] }
}

export type JournalEntry = JournalTurn | JournalNote | JournalDone | JournalEdit | JournalUndone | JournalRemove | JournalCommit

export type JournalDay = {
  version: 1
  date: string
  project: string
  entries: JournalEntry[]
  /** The map as the day began (before its first change). */
  opening?: ArchSnapshot
  /** The map after the day's latest change. */
  snapshot?: ArchSnapshot
}

/** What the carry-forward offer shows and, once taken, hands Claude. */
export type CarryOffer = { date: string; open: number; blockers: number; decisions: number; context: string }

/* ---------- Files the mod and the notepad server share, beside the journal ---------- */

/** map-view.json: which components are open in place, in the pane and the notepad. */
export type MapView = { open: string[]; updatedAt: number }

/** map-layout.json: your own arrangement of the map in the notepad. */
export type MapArrangement = {
  positions: Record<string, { x: number; y: number }>
  /** A bent line's handle, relative to the midpoint of its two boxes, by "from->to". */
  bends: Record<string, { dx: number; dy: number }>
  updatedAt: number
}

/** notepad.json: the project's notepad address, kept so it stays the same. */
export type NotepadInfo = { token: string; port: number }

/** meta.json: what the mod tells the notepad about the project. */
export type LiveMeta = {
  project: string
  title: string
  nodes: { id: string; label: string; kind: string; path: string | null; line: number | null }[]
  theme: { light: unknown; dark: unknown; fonts: unknown; mode: string; name: string | null; source: string | null }
  marks: Record<string, string>
  active: string[]
  updatedAt: number
}

/** inbox/<session>.jsonl: one request per line from the notepad for a session's Claude. */
export type NotepadAsk = { kind: string } & Record<string, unknown>

/* ---------- Claude Code's plugin state: what the pane draws from ---------- */

export type ArchAsk = 'theme' | 'brand' | 'map' | 'carry' | 'mark' | null

export type PaneTab = 'diagram' | 'journal' | 'timeline' | 'standup'

declare module 'claude-code' {
  interface PluginState {
    'arch-live': {
      graph: ArchGraph | null
      theme: ArchTheme | null
      ask: ArchAsk
      root: string
      /** True while the root is only a guess (the newest map in a folder of repos). */
      rootGuess: boolean
      tab: PaneTab
      /** The day the Journal tab shows, and the days there are. */
      jdate: string
      jday: JournalDay | null
      jdates: string[]
      /** The step the Timeline tab shows: its date and kind, '' for the latest. */
      tlStep: string
      /** Open todos and blockers across recent days, for the pane. */
      open: JournalNote[]
      /** Components Claude is working in this turn. */
      active: string[]
      noteType: JournalNoteType
      carry: CarryOffer | null
      /** Text the next prompt carries to Claude, once. */
      pending: string | null
      /** The component a Mark is being written for. */
      markTarget: string | null
      /** The local notepad's address once it runs. */
      notepad: string | null
      /** When Re-map last asked Claude, until the map is next updated. */
      mapAskedAt: number | null
      /** Components drawn open in place; the notepad shares this through map-view.json. */
      mapOpen: string[]
      /** The component the pane's card shows. */
      mapSel: string | null
      /** The latest change to the map, whoever made it. */
      mapChange: MapChange | null
      /** Bumped each minute, so the pane redraws what fades with time. */
      paneClock: number
    }
  }
}
