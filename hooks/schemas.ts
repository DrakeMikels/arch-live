import type { CommandSpec } from 'claude-code'

import { EXPORT_FILE, GRAPH_FILE, KINDS, PART_ROLES, STYLES } from './constants'
import { DEFAULT_THEME } from './theme'

// The tools and commands the mod registers: names, descriptions and input
// schemas, as Claude and the person see them.

const UPDATE_SCHEMA = {
  type: 'object',
  properties: {
    root: {
      type: 'string',
      description: 'The project folder: a full path, or relative to the session folder. Omitted, the current one.',
    },
    title: { type: 'string', description: 'Diagram title, e.g. the product name.' },
    replace: { type: 'boolean', description: 'Start from an empty diagram instead of merging (use for a full re-map).' },
    nodes: {
      type: 'array',
      description: 'Components to add, or to update by id.',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'Stable kebab-case id, e.g. "orders-api".' },
          label: { type: 'string', description: 'Human name, e.g. "Orders API".' },
          kind: { type: 'string', enum: KINDS },
          sublabel: { type: 'string', description: 'Technical detail in mono: stack, port or protocol, e.g. "Next.js · :3000".' },
          path: { type: 'string', description: 'Project-relative file where the code starts: an entry point, route or handler. A folder opens on its entry file.' },
          line: { type: 'number', description: 'Entry-point line within path, when path is a file.' },
          owns: { type: 'array', items: { type: 'string' }, description: 'Project-relative folders that belong to this component, for matching edits to it.' },
        },
        required: ['id'],
      },
    },
    edges: {
      type: 'array',
      description: 'Connections to add, or to update by from+to.',
      items: {
        type: 'object',
        properties: {
          from: { type: 'string' },
          to: { type: 'string' },
          label: { type: 'string', description: 'Short arrow label, e.g. "REST", "publishes", "SQL".' },
          style: { type: 'string', enum: STYLES, description: 'http: HTTP/API call; async: event or queue; call: anything else.' },
        },
        required: ['from', 'to'],
      },
    },
    remove_nodes: { type: 'array', items: { type: 'string' }, description: 'Ids to remove, with their edges.' },
    remove_edges: {
      type: 'array',
      items: { type: 'object', properties: { from: { type: 'string' }, to: { type: 'string' } }, required: ['from', 'to'] },
    },
    focus: {
      type: 'array',
      items: { type: 'string' },
      description: 'At most 2 ids drawn in the accent color. Omitted, the nodes this call added or changed are accented when there are 2 or fewer.',
    },
  },
}

const PALETTE_SCHEMA = {
  type: 'object',
  properties: Object.fromEntries(Object.keys(DEFAULT_THEME.light).map(k => [k, { type: 'string', description: 'Hex or rgba() color.' }])),
}

const THEME_SCHEMA = {
  type: 'object',
  properties: {
    name: { type: 'string', description: 'Name of the style, e.g. "Acme brand".' },
    source: { type: 'string', description: 'Where it came from: the URL, file or "pasted".' },
    mode: { type: 'string', enum: ['auto', 'light', 'dark'], description: "auto follows the viewer's light/dark setting." },
    light: PALETTE_SCHEMA,
    dark: PALETTE_SCHEMA,
    fonts: {
      type: 'object',
      properties: { serif: { type: 'string' }, sans: { type: 'string' }, mono: { type: 'string' } },
    },
  },
  required: ['light'],
}

const LOG_SCHEMA_COMPONENT = { type: 'string', description: 'The architecture node id this is about, when there is one.' }

export const TOOL_DEFS = [
  {
    name: 'arch_update',
    description: `Add, update or remove components and connections in the live architecture diagram (saved to ${GRAPH_FILE} in the project). Nodes merge by id, edges by from+to. Read that file for the current state.`,
    inputSchema: UPDATE_SCHEMA,
  },
  {
    name: 'arch_theme',
    description: "Save the person's diagram style: a palette of semantic color roles and three font families. Returns contrast warnings to fix.",
    inputSchema: THEME_SCHEMA,
  },
  {
    name: 'describe_files',
    description: "Save one-line summaries of a component's files for the person's notepad (shown in its file view).",
    inputSchema: {
      type: 'object',
      properties: {
        component: { type: 'string', description: 'The architecture node id.' },
        files: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              path: { type: 'string', description: 'Project-relative file path.' },
              summary: { type: 'string', description: 'One plain sentence, under 15 words.' },
            },
            required: ['path', 'summary'],
          },
        },
      },
      required: ['component', 'files'],
    },
  },
  {
    name: 'arch_breakdown',
    description: "Save a component's internal parts and how they connect, for the notepad's zoomed-in diagram. Replaces that component's breakdown.",
    inputSchema: {
      type: 'object',
      properties: {
        component: { type: 'string', description: 'The architecture node id.' },
        parts: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string' },
              label: { type: 'string' },
              role: { type: 'string', enum: PART_ROLES },
              path: { type: 'string', description: 'Project-relative file or folder.' },
              line: { type: 'number' },
              summary: { type: 'string', description: 'One plain sentence on its purpose.' },
            },
            required: ['id', 'label'],
          },
        },
        edges: {
          type: 'array',
          items: {
            type: 'object',
            properties: { from: { type: 'string' }, to: { type: 'string', description: 'A part id, or another component id.' }, label: { type: 'string' } },
            required: ['from', 'to'],
          },
        },
      },
      required: ['component', 'parts'],
    },
  },
  {
    name: 'explain_part',
    description: "Save an in-depth explanation (Markdown) of one part of a component, shown in the notepad when the person opens that part.",
    inputSchema: {
      type: 'object',
      properties: { component: { type: 'string' }, part: { type: 'string' }, detail: { type: 'string', description: 'Markdown, under 200 words.' } },
      required: ['component', 'part', 'detail'],
    },
  },
  {
    name: 'save_standup',
    description: "Save the standup notes you wrote for the person; they show on the notepad's Standup tab, ready to copy.",
    inputSchema: {
      type: 'object',
      properties: {
        markdown: { type: 'string', description: 'The standup notes, in Markdown.' },
        scope: { type: 'string', description: 'What it covers, e.g. "all sessions".' },
      },
      required: ['markdown'],
    },
  },
  {
    name: 'log_decision',
    description: 'Record a design decision in the person’s work journal: what was decided, why, and what else was considered.',
    inputSchema: {
      type: 'object',
      properties: {
        decision: { type: 'string' },
        why: { type: 'string' },
        alternatives: { type: 'string', description: 'What else was considered, briefly.' },
        component: LOG_SCHEMA_COMPONENT,
      },
      required: ['decision', 'why'],
    },
  },
  {
    name: 'log_blocker',
    description: 'Record something that blocks progress in the person’s work journal, or mark one resolved.',
    inputSchema: {
      type: 'object',
      properties: { text: { type: 'string' }, resolved: { type: 'boolean' }, component: LOG_SCHEMA_COMPONENT },
      required: ['text'],
    },
  },
  {
    name: 'log_todo',
    description: 'Add a remaining work item to the person’s work journal, or mark one done.',
    inputSchema: {
      type: 'object',
      properties: { text: { type: 'string' }, done: { type: 'boolean' }, component: LOG_SCHEMA_COMPONENT },
      required: ['text'],
    },
  },
]

export const COMMAND_DEFS: CommandSpec[] = [
  { name: 'arch', description: 'Show the live architecture diagram' },
  { name: 'arch-map', description: "Ask Claude to map a project's architecture", argumentHint: '[folder]' },
  { name: 'arch-theme', description: 'Set your diagram style from a website', argumentHint: '[url | default]' },
  { name: 'arch-export', description: `Write the diagram to ${EXPORT_FILE}` },
  { name: 'notepad', description: 'Open the live notepad in your browser', immediate: true },
  { name: 'standup', description: 'Your standup brief since the last one, copied to the clipboard', immediate: true },
  { name: 'n', description: 'Jot a note in today’s journal', argumentHint: '[@component] text', immediate: true },
  { name: 'todo', description: 'Add a todo to the journal', argumentHint: '[@component] text', immediate: true },
  { name: 'blocker', description: 'Log a blocker', argumentHint: '[@component] text', immediate: true },
  { name: 'decision', description: 'Log a decision ("… because …")', argumentHint: '[@component] text', immediate: true },
  { name: 'done', description: 'Close a todo or blocker', argumentHint: 'words from it', immediate: true },
]
