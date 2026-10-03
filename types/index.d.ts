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
  order: number
}

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

export type JournalFile = { path: string; created: boolean; edits: number }

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

export type JournalEntry = JournalTurn | JournalNote | JournalDone

export type ArchSnapshot = {
  ts?: number
  nodes: { id: string; label: string; kind: ArchKind }[]
  edges: { from: string; to: string; label?: string }[]
}

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

export type ArchAsk = 'theme' | 'brand' | 'map' | 'carry' | 'mark' | null

export type PaneTab = 'diagram' | 'journal' | 'standup'

/** What the carry-forward offer shows and, once taken, hands Claude. */
export type CarryOffer = { date: string; open: number; blockers: number; decisions: number; context: string }

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
    }
  }
}
