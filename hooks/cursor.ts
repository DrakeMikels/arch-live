import type { ArchGraph, JournalFile, JournalTests, JournalTurn } from '../types'
import { componentFor } from './journal'
import { boardPrompt, breakdownPrompt, brandPrompt, describePrompt, explainPrompt, mapPrompt, standupInstructions } from './prompts'
import { distill } from './ste'

// arch-live in Cursor, the parts that are plain logic: the journal turn built
// from what Cursor's hooks report, and the prompts the notepad hands to
// Cursor's chat. Cursor names MCP tools without Claude Code's mcp__server__
// prefix, and a prompt link holds at most 8,000 characters, so long material
// (the journal for a standup, the text on a whiteboard) is fetched by a tool
// or read from a file instead of pasted in.

// A Cursor turn while it runs, kept in a small file between hook calls.
export type CursorDraft = {
  ts: number
  request: string
  files: Record<string, JournalFile>
  commands: number
  tests?: JournalTests
  answer: string
  /** The map's components when the turn began, to tell what it added or removed. */
  mapBefore: { id: string; label: string }[]
}

export const newDraft = (ts: number, request: string, graph: ArchGraph | null): CursorDraft => ({
  ts,
  request,
  files: {},
  commands: 0,
  answer: '',
  mapBefore: (graph?.nodes ?? []).map(n => ({ id: n.id, label: n.label })),
})

/** The journal entry for a finished turn, or null when it did nothing worth a line. */
export const cursorTurn = (draft: CursorDraft, graph: ArchGraph | null, id: string, session: string): JournalTurn | null => {
  const files = Object.values(draft.files)
  const components = [...new Set(files.map(f => componentFor(graph, f.path)).filter((c): c is string => !!c))]
  const had = new Set(draft.mapBefore.map(n => n.id))
  const has = new Set((graph?.nodes ?? []).map(n => n.id))
  const added = (graph?.nodes ?? []).filter(n => !had.has(n.id)).map(n => n.label)
  const removed = draft.mapBefore.filter(n => !has.has(n.id)).map(n => n.label)
  const request = distill(draft.request, { mode: 'request', max: 2 }).statements.map(s => s.text).join(' ')
  const summary = distill(draft.answer, { mode: 'log', max: 3 }).statements.map(s => s.text)
  const isWorth = files.length > 0 || added.length > 0 || removed.length > 0 || summary.length > 0 || !!draft.tests
  if (!isWorth) return null
  return {
    id,
    ts: draft.ts,
    type: 'turn',
    request: request || draft.request.slice(0, 160),
    summary,
    files,
    components,
    commands: draft.commands,
    ...(added.length || removed.length ? { arch: { added, removed } } : {}),
    ...(draft.tests ? { tests: draft.tests } : {}),
    session,
  }
}

// The Claude Code prompts, with tools named the way Cursor shows them.
export const plainTools = (text: string) => text.replace(/mcp__arch-live__/g, '')

export type Handoff =
  | { kind: 'map' }
  | { kind: 'brand'; url: string }
  | { kind: 'breakdown'; component: string }
  | { kind: 'explain'; component: string; part: string }
  | { kind: 'describe'; component: string; label: string; files: string[] }
  | { kind: 'standup'; scope: 'all' | 'session'; session?: string; names?: Record<string, string> }
  | { kind: 'board'; title: string; png: string; mdFile?: string; note: string }

/** What the notepad hands to Cursor's chat for a request; undefined when there is nothing to ask. */
export const handoffPrompt = (request: Handoff, graph: ArchGraph | null, root: string, since: number): string | undefined => {
  if (request.kind === 'map') return plainTools(mapPrompt(root))
  if (request.kind === 'brand') return plainTools(brandPrompt(request.url))
  if (request.kind === 'describe') return request.files.length ? plainTools(describePrompt(request.component, request.label, request.files)) : undefined
  const node = 'component' in request ? graph?.nodes.find(n => n.id === request.component) : undefined
  if (request.kind === 'breakdown') return graph && node ? plainTools(breakdownPrompt(node, graph)) : undefined
  if (request.kind === 'explain') {
    const part = node?.breakdown?.parts.find(p => p.id === request.part)
    return node && part ? plainTools(explainPrompt(node, part)) : undefined
  }
  if (request.kind === 'standup') {
    const name = request.session ? (request.names?.[request.session] ?? 'one session') : 'all sessions'
    const fetch = request.session ? `call standup_brief with session "${request.session}"` : 'call standup_brief'
    return [
      ...standupInstructions(name, since, 'save_standup'),
      '',
      `For the journal, ${fetch}: it returns the brief and every turn and note in the window.`,
    ].join('\n')
  }
  // The board's text can be long: it stays in its file, beside the picture.
  const base = boardPrompt(request.title, request.png, '', request.note)
  return request.mdFile ? `${base}\n\nThe text and code on the board, exactly as written, are in ${request.mdFile}.` : base
}
