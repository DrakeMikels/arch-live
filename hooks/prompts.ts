import type { ArchGraph, ArchNode, ArchPart } from '../types'
import {
  BLOCKER_TOOL,
  BREAKDOWN_TOOL,
  DECISION_TOOL,
  DESCRIBE_TOOL,
  EXPLAIN_TOOL,
  EXPORT_FILE,
  GRAPH_FILE,
  PART_ROLES,
  STANDUP_TOOL,
  THEME_TOOL,
  TODO_TOOL,
  UPDATE_TOOL,
} from './constants'
import { dayLabel, timeLabel } from './journal'

// What the mod tells Claude: the standing guide in every prompt, and the
// requests the pane, the commands and the notepad send.

export const SECTION = {
  id: 'arch-live:guide',
  scope: 'session' as const,
  text: [
    '# Live architecture (arch-live)',
    `This session shows a live system-architecture diagram, stored in ${GRAPH_FILE} of the mapped project.`,
    `When your work adds, removes, renames or rewires a system component (an app, service, worker, queue, data store, external API or client), call ${UPDATE_TOOL} in the same turn so the diagram stays true.`,
    'Keep it architectural: deployable components and the connections between them, not files, classes or functions. Changes inside a component need no update.',
    '',
    "The person keeps a work journal for their daily standup. Record what they would need to explain later:",
    `- ${DECISION_TOOL} when you make or recommend a design choice (what, why, and what else you considered).`,
    `- ${BLOCKER_TOOL} when something stops progress (a failing dependency, missing access, an open question for someone), and again with resolved: true once it is cleared.`,
    `- ${TODO_TOOL} for work left over at the end of a task, and with done: true when you finish an item already on the list.`,
    'Keep each entry to one plain sentence. Do not log routine edits; the journal records files and components by itself.',
    '',
    `When you create a file or change what one does (not small fixes), call ${DESCRIBE_TOOL} with a one-line summary for it, so the notepad's file view stays true.`,
  ].join('\n'),
}

export const mapPrompt = (root: string) =>
  [
    `Map the system architecture of the project in ${root} for the arch-live diagram.`,
    'Explore the codebase: package manifests, workspace and docker-compose files, infra config, entry points and top-level directories. Identify the clients, edge (gateways, CDNs, routers), services and workers, queues, data stores and external APIs.',
    `Then call ${UPDATE_TOOL} once with replace: true, root: "${root}", the components and the connections between them. Stay at architecture level: 4 to 12 nodes, each a distinct deployable or system boundary. Give every node a path, relative to the project, to the file where its code starts (an entry point, route or handler, not a folder) and a line when that code sits inside a larger file, plus owns: the folders that belong to it. Mark the 1 or 2 components a newcomer should look at first as focus.`,
    `Then call ${DESCRIBE_TOOL} once per component with one plain sentence (under 15 words) for each of its key files: entry points, routes, handlers, models; up to 15 per component.`,
    `Finally, ask me whether to add an "Architecture" section to the README that embeds the diagram (/arch-export writes ${EXPORT_FILE}).`,
  ].join('\n\n')

export const brandPrompt = (url: string) =>
  [
    `Extract design tokens from ${url} for my arch-live diagram style (saved for my account; every repo uses it).`,
    'Fetch the page and its linked stylesheets. Read the CSS custom properties, the most used colors, and the font families.',
    'Map them to these roles: paper (page and container background), paper2, ink (primary text and strokes), muted (secondary text, default arrows), soft (sublabels), rule (hairlines), accent (focal nodes only), accentTint (fill behind an accent stroke), link (HTTP/API arrows), nodeFill (service node fill). Leave fonts out: the person keeps JetBrains Mono.',
    "Constraints: ink and muted must reach WCAG AA on paper; exactly one accent hue, the brand's most distinctive; paper warm-neutral, never pure white; from an 8-color brand keep 3 (paper, ink, accent) and make the rest muted variants. Give a dark palette too, or leave it out and it is derived by swapping paper and ink.",
    `Call ${THEME_TOOL} with source: "${url}", fix anything its warnings flag, then show me the tokens in a short table.`,
  ].join('\n\n')

export const breakdownPrompt = (node: ArchNode, graph: ArchGraph) => {
  const others = graph.nodes.filter(n => n.id !== node.id).map(n => `${n.id} (${n.label})`).join(', ')
  const files = Object.entries(node.files ?? {}).slice(0, 30).map(([p, f]) => `- ${p}: ${f.summary}`)
  return [
    `Break down the ${node.label} component of my architecture into its internal parts, for the arch-live diagram.`,
    `Read its code: entry ${node.path ?? '(none)'}${node.line ? `:${node.line}` : ''}; it owns ${(node.owns ?? []).join(', ') || 'no folders listed'}.`,
    ...(files.length ? ['What its files do, as summarised before:', ...files] : []),
    'Pick 3 to 10 parts, each with one clear responsibility: a module, handler, store, UI area or job. A part can be a folder, a file, or a section of a large file (give the line where it starts).',
    `For each part: id (kebab-case), label (2 to 4 words), role (${PART_ROLES.join(', ')}), path, line, and one plain sentence under 20 words on its purpose.`,
    `Then the connections: part to part, and part to another component where the call happens. Other components: ${others || 'none'}.`,
    `Call ${BREAKDOWN_TOOL} once with component "${node.id}". Reply with one short line when done.`,
  ].join('\n')
}

export const explainPrompt = (node: ArchNode, part: ArchPart) =>
  [
    `Explain the "${part.label}" part of the ${node.label} component in depth, for my arch-live notepad.`,
    `Read its code at ${part.path ?? node.path ?? 'the component'}${part.line ? `:${part.line}` : ''}. Its purpose, as summarised: ${part.summary ?? 'not yet described'}.`,
    'Write Markdown under 200 words: what it does; how it works (the main flow in 3 to 6 bullets); what it depends on and what calls it; anything risky or surprising. Plain, short sentences.',
    `Then call ${EXPLAIN_TOOL} with component "${node.id}", part "${part.id}" and the Markdown as detail. Reply with one short line when done.`,
  ].join('\n')

export const describePrompt = (id: string, label: string, files: string[]) =>
  [
    `Describe the files of the ${label} component for my arch-live notepad.`,
    'For each file below, read enough of it to write one plain sentence (under 15 words) on what it does. Skip generated or trivial files.',
    `Then call ${DESCRIBE_TOOL} with component "${id}" and all of the summaries in one call. Reply with one short line when done.`,
    '',
    ...files.map(f => `- ${f}`),
  ].join('\n')

export const boardPrompt = (title: string, png: string, md: string, note: string) =>
  [
    `I sketched this on my arch-live whiteboard ("${title}").${note ? ` ${note}` : ''}`,
    '',
    `The drawing is saved at ${png}. Read that image to see the layout: shapes, arrows, what is circled or connected to what.`,
    ...(md.trim() ? ['', 'Text and code on the board, exactly as written:', '', md.trim()] : []),
    ...(note ? [] : ['', 'Tell me briefly what you make of it, then ask what I want to do with it.']),
  ].join('\n')

export const standupPrompt = (scope: string, since: number, brief: string, detail: string) =>
  [
    `Write my standup notes for this morning's engineering meeting from my arch-live work journal (${scope}, since ${dayLabel(since)} ${timeLabel(since)}).`,
    'Markdown, in this order. Short plain bullets about outcomes, not activity. Group related work into one bullet and start it with the area in bold when that helps. No file paths unless they matter to the team.',
    '## Accomplished\n## In progress\n## Blockers (write "None" when there are none)\n## Next\n## Decisions (only when there are any)\n## Heads-up (only when useful: risks, asks, things others should know)',
    'Leave out noise: repeated or test notes, and checks of the tooling itself, unless that was the work. When the journal is unclear, you may read `git log` in the project for the same window.',
    `Then call ${STANDUP_TOOL} once with the Markdown and scope "${scope}". Reply with one short line when done.`,
    '',
    'Journal brief:',
    '',
    brief,
    '',
    'Every turn and note, oldest first:',
    '',
    detail,
  ].join('\n')
