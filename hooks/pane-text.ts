import type { ArchGraph, ArchNode, MapChange, TimelineStep } from '../types'
import type { RecentEdits } from './graph'
import { dayLabel, timeLabel } from './journal'
import { stepCounts } from './timeline'

// The Markdown the pane shows: the component card, what changed lately, and
// the timeline. No engine calls.

// The pane refuses a Markdown block over 10,000 characters (and then draws
// nothing), so a long one is cut at a line, with the rest in the notepad.
export const MARKDOWN_MAX = 9000
export const fitText = (text: string, keep: 'start' | 'end' = 'start') => {
  if (text.length <= MARKDOWN_MAX) return text
  const note = '_…cut here to fit the pane: the rest is in the notepad (Open notepad ↗)._'
  if (keep === 'end') {
    const tail = text.slice(-MARKDOWN_MAX)
    return `${note}\n\n${tail.slice(Math.min(Math.max(tail.indexOf('\n\n'), 0), MARKDOWN_MAX / 2)).trimStart()}`
  }
  const cut = text.slice(0, MARKDOWN_MAX)
  return `${cut.slice(0, Math.max(cut.lastIndexOf('\n'), MARKDOWN_MAX / 2))}\n\n${note}`
}

export const changeText = (change: MapChange, graph: ArchGraph | null) => {
  const name = (id: string) => graph?.nodes.find(n => n.id === id)?.label ?? id
  return [
    change.added.length ? `${change.added.length} new (${change.added.map(name).join(', ')})` : '',
    change.changed.length ? `${change.changed.length} updated` : '',
    change.removed.length ? `${change.removed.length} removed (${change.removed.join(', ')})` : '',
    change.links ? `${change.links} link${change.links === 1 ? '' : 's'} changed` : '',
  ]
    .filter(Boolean)
    .join(', ')
}

// The selected component, as the notepad's drawer has it: what it is, what
// is happening in it, its connections and its parts.
export const componentCard = (
  n: ArchNode,
  graph: ArchGraph,
  facts: { isActive: boolean; edits?: RecentEdits[string]; tag: string; mark?: string; now: number },
) => {
  const name = (id: string) => graph.nodes.find(x => x.id === id)?.label ?? id
  const calls = [...new Set(graph.edges.filter(e => e.from === n.id).map(e => name(e.to)))]
  const callers = [...new Set(graph.edges.filter(e => e.to === n.id).map(e => name(e.from)))]
  const parts = n.breakdown?.parts ?? []
  const status = [
    facts.isActive ? 'Claude is working here now' : '',
    facts.edits ? `edited ${facts.edits.edits} time${facts.edits.edits === 1 ? '' : 's'}, last at ${timeLabel(facts.edits.at)}` : '',
    facts.tag === 'NEW' ? 'new in the latest map update' : facts.tag ? 'changed in the latest map update' : '',
  ].filter(Boolean)
  const described = Object.keys(n.files ?? {}).length
  return [
    `**${n.label}** · ${n.kind}${n.sublabel ? ` · ${n.sublabel}` : ''}`,
    n.path ? `\`${n.path}${n.line ? `:${n.line}` : ''}\`` : '',
    status.length ? `_${status.join(' · ')}_` : '',
    facts.mark ? `◯ Mark: ${facts.mark}` : '',
    calls.length ? `Calls ${calls.join(', ')}` : '',
    callers.length ? `Called by ${callers.join(', ')}` : '',
    facts.edits
      ? `**Changed lately**\n${Object.entries(facts.edits.files)
          .sort((a, b) => b[1] - a[1])
          .slice(0, 6)
          .map(([path, count]) => `- \`${path}\` · ${count} edit${count === 1 ? '' : 's'}`)
          .join('\n')}`
      : '',
    parts.length
      ? `**Parts**\n${parts.map((p, i) => `${i + 1}. **${p.label}**${p.summary ? ` · ${p.summary}` : ''}`).join('\n')}`
      : '_Not broken down yet: Break down asks Claude for its parts._',
    described ? `${described} file${described === 1 ? '' : 's'} described (the notepad's drawer lists them)` : '',
  ]
    .filter(Boolean)
    .join('\n\n')
}

const noon = (date: string) => Date.parse(`${date}T12:00:00`)

/** A step's name: its day, and whether it happened in sessions or between them. */
export const stepTitle = (step: Pick<TimelineStep, 'date' | 'kind'>) =>
  `${dayLabel(noon(step.date))}${step.kind === 'between' ? ' · before the first session' : ''}`

/** One step of the timeline, in full: what changed and the turns that did it. */
export const stepMarkdown = (step: TimelineStep, sessions: Record<string, string> = {}) => {
  const names = new Map([...step.after.nodes, ...step.removed].map(n => [n.id, n.label]))
  const name = (id: string) => names.get(id) ?? id
  const link = (l: { from: string; to: string; label?: string }) => `${name(l.from)} → ${name(l.to)}${l.label ? ` _(${l.label})_` : ''}`
  const changes = [
    `**${stepTitle(step)}** · ${stepCounts(step)}`,
    step.kind === 'between' ? '_Changed outside any session since the day before: a pull, a merge or an edit by hand._' : '',
    step.added.length ? `- **Added** ${step.added.map(n => `${n.label} (${n.kind})`).join(', ')}` : '',
    step.removed.length ? `- **Removed** ${step.removed.map(n => n.label).join(', ')}` : '',
    step.renamed.length ? `- **Renamed** ${step.renamed.map(r => `${r.from} → ${r.to}`).join(', ')}` : '',
    step.linked.length ? `- **New connections** ${step.linked.map(link).join(', ')}` : '',
    step.unlinked.length ? `- **Connections gone** ${step.unlinked.map(link).join(', ')}` : '',
  ].filter(Boolean)
  const turns = step.turns.map(t => {
    const did = [t.added.length ? `added ${t.added.join(', ')}` : '', t.removed.length ? `removed ${t.removed.join(', ')}` : ''].filter(Boolean).join('; ')
    const where = t.session && sessions[t.session] ? ` _[${sessions[t.session]}]_` : ''
    return `- ${timeLabel(t.ts)} ${t.request}${where} · ${did}`
  })
  return [...changes, ...(turns.length ? ['', '**What did it**', ...turns] : [])].join('\n')
}

/** The whole timeline, newest first, a line a step. */
export const timelineMarkdown = (steps: TimelineStep[]) =>
  steps.length
    ? [...steps].reverse().map(s => `- **${stepTitle(s)}** · ${stepCounts(s)}`).join('\n')
    : '_No map changes recorded yet. Each day the map changes, the journal keeps how it stood, and its history shows here._'
