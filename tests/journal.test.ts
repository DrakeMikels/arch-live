import { describe, expect, test } from 'claude-code/testing'

import type { ArchGraph, JournalCommit, JournalDay, JournalEntry, JournalNote, JournalTurn } from '../types'
import {
  buildStandup,
  carryOffer,
  commitsFromLog,
  componentFor,
  dateKey,
  dayMarkdown,
  insightsOf,
  labelsFrom,
  openItems,
  parseWebLines,
  projectKey,
  resolveDays,
  resolveTag,
  shipText,
  snapshotOf,
  standupDetail,
} from '../hooks/journal'

const graph: ArchGraph = {
  version: 1,
  title: 'Shop',
  nodes: [
    { id: 'web', label: 'Web App', kind: 'client', path: 'apps/web/page.tsx', order: 0 },
    { id: 'api', label: 'Orders API', kind: 'service', path: 'apps/api/server.ts', order: 1 },
    { id: 'shared', label: 'Shared', kind: 'service', path: 'apps', owns: ['apps/shared'], order: 2 },
  ],
  edges: [{ from: 'web', to: 'api' }],
  focus: [],
  updatedAt: 0,
}

// Local noon on a date, so tests do not depend on the machine's time zone.
const at = (date: string, hour = 12) => new Date(`${date}T${String(hour).padStart(2, '0')}:00:00`).getTime()
const note = (id: string, ts: number, type: JournalNote['type'], text: string, extra: Partial<JournalNote> = {}): JournalNote => ({ id, ts, type, text, by: 'you', ...extra })
const turn = (id: string, ts: number, extra: Partial<JournalTurn> = {}): JournalTurn => ({
  id, ts, type: 'turn', request: 'Do it', summary: ['Did it.'], files: [{ path: 'apps/api/x.ts', created: false, edits: 1 }], components: ['api'], commands: 0, ...extra,
})
const day = (date: string, entries: JournalEntry[], extra: Partial<JournalDay> = {}): JournalDay => ({ version: 1, date, project: '/p', entries, ...extra })

describe('names and keys', () => {
  test('dateKey is the local date', () => {
    expect(dateKey(at('2026-01-05', 0) + 60_000)).toBe('2026-01-05')
    expect(dateKey(at('2026-12-31', 23))).toBe('2026-12-31')
  })

  test('projectKey keeps letters and digits only', () => {
    expect(projectKey('/Users/mike/Dev Projects/arch-live')).toBe('-Users-mike-Dev-Projects-arch-live')
  })

  test('snapshotOf keeps ids, labels, kinds and connections only', () => {
    expect(snapshotOf({ ...graph, nodes: [{ ...graph.nodes[0]!, sublabel: 'x', owns: ['y'] }] }, 7)).toEqual({
      ts: 7,
      nodes: [{ id: 'web', label: 'Web App', kind: 'client' }],
      edges: [{ from: 'web', to: 'api' }],
    })
  })
})

describe('componentFor', () => {
  test('a file belongs to the node whose folder it is in', () => {
    expect(componentFor(graph, 'apps/api/routes/orders.ts')).toBe('api')
    expect(componentFor(graph, 'apps/web/page.tsx')).toBe('web')
  })

  test('the longest matching folder wins, and owning outranks starting there', () => {
    expect(componentFor(graph, 'apps/shared/util.ts')).toBe('shared')
    expect(componentFor(graph, 'apps/other.ts')).toBe('shared')
  })

  test('a file outside every component, or no map, is nobody’s', () => {
    expect(componentFor(graph, 'README.md')).toBeUndefined()
    expect(componentFor(null, 'apps/api/x.ts')).toBeUndefined()
  })
})

describe('resolveTag', () => {
  test('@id, @label slug or a prefix tags a component and leaves the tag out', () => {
    expect(resolveTag(graph, '@api retry is flaky')).toEqual({ text: 'retry is flaky', component: 'api' })
    expect(resolveTag(graph, 'retry @orders-api is flaky')).toEqual({ text: 'retry is flaky', component: 'api' })
    expect(resolveTag(graph, '@we slow load')).toEqual({ text: 'slow load', component: 'web' })
  })

  test('an unknown tag, or none, leaves the text as it was', () => {
    expect(resolveTag(graph, '@nothing here ')).toEqual({ text: '@nothing here' })
    expect(resolveTag(graph, ' plain ')).toEqual({ text: 'plain' })
    expect(resolveTag(null, '@api x')).toEqual({ text: '@api x' })
  })
})

describe('parseWebLines', () => {
  test('reads one entry a line and skips what is not one', () => {
    const text = [
      JSON.stringify(note('a', 1, 'note', 'hi')),
      'not json',
      JSON.stringify({ id: 'b' }),
      '',
      JSON.stringify(note('c', 2, 'todo', 'do')),
    ].join('\n')
    expect(parseWebLines(text).map(e => e.id)).toEqual(['a', 'c'])
  })
})

describe('resolveDays', () => {
  const mon = '2026-09-28'
  const wed = '2026-09-30'

  test('a todo closed on a later day is done on its own day too, and the done stays where it happened', () => {
    const days = resolveDays([
      day(mon, [note('t1', at(mon), 'todo', 'Ship it')]),
      day(wed, [{ id: 'd1', ts: at(wed), type: 'done', ref: 't1', by: 'you' }]),
    ])
    expect(days[0]!.entries[0]).toMatchObject({ id: 't1', done: true, doneAt: at(wed) })
    expect(days[1]!.entries[0]).toMatchObject({ type: 'done', refText: 'Ship it', refType: 'todo', refDate: mon })
  })

  test('the latest edit sets the text; edits leave the page', () => {
    const days = resolveDays([
      day(mon, [
        note('n1', at(mon, 9), 'decision', 'Use Postgres', { why: 'joins' }),
        { id: 'e1', ts: at(mon, 10), type: 'edit', ref: 'n1', text: 'Use SQLite', by: 'you' },
        { id: 'e2', ts: at(mon, 11), type: 'edit', ref: 'n1', text: 'Use Postgres 16', why: '', by: 'you' },
      ]),
    ])
    expect(days[0]!.entries).toHaveLength(1)
    expect(days[0]!.entries[0]).toMatchObject({ text: 'Use Postgres 16', editedAt: at(mon, 11) })
    expect((days[0]!.entries[0] as JournalNote).why).toBeUndefined()
  })

  test('undone reopens, and a removed note goes with its done', () => {
    const days = resolveDays([
      day(mon, [
        note('t1', at(mon, 9), 'todo', 'A'),
        note('t2', at(mon, 9), 'todo', 'B'),
        { id: 'd1', ts: at(mon, 10), type: 'done', ref: 't1', by: 'you' },
        { id: 'u1', ts: at(mon, 11), type: 'undone', ref: 't1', by: 'you' },
        { id: 'd2', ts: at(mon, 10), type: 'done', ref: 't2', by: 'you' },
        { id: 'r2', ts: at(mon, 12), type: 'remove', ref: 't2', by: 'you' },
      ]),
    ])
    expect(days[0]!.entries.map(e => e.id)).toEqual(['t1'])
    expect((days[0]!.entries[0] as JournalNote).done).toBeUndefined()
    expect(openItems(days).map(n => n.id)).toEqual(['t1'])
  })
})

describe('labels, carry-forward and the day page', () => {
  const mon = '2026-09-28'
  const tue = '2026-09-29'
  const days = resolveDays([
    day(mon, [
      turn('a', at(mon, 9)),
      note('b', at(mon, 10), 'blocker', 'No staging access', { component: 'api' }),
      note('c', at(mon, 11), 'decision', 'Keep REST', { why: 'clients use it' }),
      note('d', at(mon, 12), 'todo', 'Write the migration'),
    ], { snapshot: { nodes: [{ id: 'old', label: 'Old Thing', kind: 'worker' }], edges: [] } }),
  ])

  test('labels come from snapshots, then the live map', () => {
    const labels = labelsFrom(days, graph)
    expect(labels.get('old')).toBe('Old Thing')
    expect(labels.get('api')).toBe('Orders API')
  })

  test('carry-forward offers the last working day before today', () => {
    const offer = carryOffer(days, tue, graph)
    expect(offer).toMatchObject({ date: mon, open: 1, blockers: 1, decisions: 1 })
    expect(offer!.context).toContain('Open blockers:\n- No staging access (Orders API)')
    expect(offer!.context).toContain('- Keep REST (because clients use it)')
    expect(offer!.context).toContain('Worked in: Orders API.')
    expect(carryOffer(days, mon, graph)).toBeNull()
  })

  test('the day page lists turns and notes in order, with their components', () => {
    const page = dayMarkdown(days[0]!, labelsFrom(days, graph))
    expect(page).toContain('Do it · _Orders API_')
    expect(page).toContain('- Did it.')
    expect(page).toContain('⛔ ')
    expect(page).toContain('Keep REST — because clients use it')
    expect(page.indexOf('Do it')).toBeLessThan(page.indexOf('Write the migration'))
  })

  test('an empty day says how to fill it', () => {
    expect(dayMarkdown(day(tue, []), new Map())).toContain('Nothing logged this day yet')
  })
})

describe('buildStandup', () => {
  const mon = '2026-09-28'
  const tue = '2026-09-29'
  const since = at(mon, 8)
  const now = at(tue, 9)

  test('done by component, decisions, blockers, next and notes since the last standup', () => {
    const days = resolveDays([
      day(mon, [
        turn('a', at(mon, 9), { summary: ['Added order retries.'] }),
        turn('q', at(mon, 9, ), { files: [], summary: ['Only talked.'] }),
        note('b', at(mon, 10), 'blocker', 'No staging access'),
        note('c', at(mon, 11), 'decision', 'Keep REST', { why: 'clients use it', alternatives: 'gRPC' }),
        note('d', at(mon, 12), 'todo', 'Write the migration', { component: 'api' }),
        note('e', at(mon, 13), 'note', 'Pairing with Sam'),
      ]),
    ])
    const brief = buildStandup({ title: 'Shop', since, now, days, graph })
    expect(brief).toStartWith('# Standup · Shop · ')
    expect(brief).toContain('## Done\n**Orders API**\n- Added order retries. _(1 file)_')
    expect(brief).not.toContain('Only talked.')
    expect(brief).toContain('## Decisions\n- Keep REST — because clients use it _(considered: gRPC)_')
    expect(brief).toContain('## Blockers\n- No staging access')
    expect(brief).toContain('## Next\n- Write the migration _(Orders API)_')
    expect(brief).toContain('Pairing with Sam')
  })

  test('with two sessions, done is grouped by session name', () => {
    const days = resolveDays([day(mon, [turn('a', at(mon, 9), { session: 's1' }), turn('b', at(mon, 10), { session: 's2', summary: ['Other work.'] })])])
    const brief = buildStandup({ title: 'Shop', since, now, days, graph, sessions: { s1: 'Retries', s2: 'Docs' } })
    expect(brief).toContain('### Retries')
    expect(brief).toContain('### Docs')
  })

  test('architecture: what was added, removed and newly connected since the window opened', () => {
    const before = { ts: since - 1000, nodes: [{ id: 'web', label: 'Web App', kind: 'client' as const }, { id: 'api', label: 'Orders API', kind: 'service' as const }, { id: 'cron', label: 'Cron', kind: 'worker' as const }], edges: [] }
    const days = [day(mon, [], { opening: before })]
    const brief = buildStandup({ title: 'Shop', since, now, days, graph })
    expect(brief).toContain('- Added: Shared (service)')
    expect(brief).toContain('- Removed: Cron')
    expect(brief).toContain('- New connections: Web App → Orders API')
  })

  test('an empty window says so', () => {
    expect(buildStandup({ title: 'Shop', since, now, days: [], graph: null })).toContain('No logged work since')
  })

  test('the detail lists every turn and note in the window, oldest first, with session names', () => {
    const days = resolveDays([day(mon, [note('x', at(mon, 7), 'note', 'Before the window'), turn('a', at(mon, 9), { session: 's1' }), note('b', at(mon, 10), 'todo', 'Later', { session: 's1' })])])
    const detail = standupDetail({ since, days, sessions: { s1: 'Retries' } })
    expect(detail).not.toContain('Before the window')
    expect(detail.split('\n')).toHaveLength(2)
    expect(detail).toContain('[Retries] Asked: Do it → Did it. (components: api) (1 file)')
    expect(standupDetail({ since, days: [] })).toBe('(nothing logged)')
  })
})

// --- commits and test runs -------------------------------------------------

const commit = (sha: string, ts: number, files: string[], subject = 'Ship it'): JournalCommit => ({ id: `commit-${sha}`, ts, type: 'commit', sha, subject, files })
const sha = (c: string) => c.repeat(40)

describe('commitsFromLog', () => {
  const log = [
    '',
    `${sha('a')}\u001f1760000000\u001fme@x.dev\u001fAdd router\n\napps/api/x.ts\napps/api/y.ts\n`,
    `${sha('b')}\u001f1760000100\u001fsomeone@else.dev\u001fTheir change\n\napps/api/x.ts\n`,
    `${sha('c')}\u001f1760000200\u001fMe@X.dev\u001fOnly outside the folder\n`,
  ].join('\u001e')

  test('keeps your commits that touch the project', () => {
    expect(commitsFromLog(log, 'me@x.dev')).toEqual([
      { id: `commit-${sha('a')}`, ts: 1760000000000, type: 'commit', sha: sha('a'), subject: 'Add router', files: ['apps/api/x.ts', 'apps/api/y.ts'] },
    ])
  })

  test('keeps every author without an email to match', () => {
    expect(commitsFromLog(log).map(c => c.subject)).toEqual(['Add router', 'Their change'])
  })
})

describe('shipping', () => {
  const t1 = turn('t1', at('2026-10-14', 10), { files: [{ path: 'a.ts', created: true, edits: 1 }, { path: 'b.ts', created: false, edits: 2 }] })
  const t2 = turn('t2', at('2026-10-14', 15), { files: [{ path: 'a.ts', created: false, edits: 1 }] })
  const days = [
    day('2026-10-14', [t1, commit(sha('1'), at('2026-10-14', 11), ['a.ts']), t2]),
    day('2026-10-15', [commit(sha('2'), at('2026-10-15', 9), ['b.ts', 'c.ts'], 'Finish b')]),
  ]
  const turns = (ds: JournalDay[]) => ds.flatMap(d => d.entries).filter((e): e is JournalTurn => e.type === 'turn')

  test('a turn learns which later commits took its files, across days', () => {
    const [one, two] = turns(resolveDays(days, { tracksCommits: true }))
    expect(one?.shipped?.map(c => c.sha)).toEqual([sha('1'), sha('2')])
    expect(one?.uncommitted).toEqual([])
    expect(shipText(one as JournalTurn)).toBe('shipped in 1111111, 2222222')
    // a.ts was committed at 11:00, before this turn changed it again.
    expect(two?.uncommitted).toEqual(['a.ts'])
    expect(shipText(two as JournalTurn)).toBe('not committed')
  })

  test('says how much is committed when only some files are', () => {
    const [one] = turns(resolveDays([day('2026-10-14', [t1, commit(sha('1'), at('2026-10-14', 11), ['a.ts'])])], { tracksCommits: true }))
    expect(shipText(one as JournalTurn)).toBe('1 of 2 files committed')
  })

  test('says nothing outside a git project', () => {
    const [one] = turns(resolveDays(days))
    expect(one?.shipped).toBeUndefined()
    expect(shipText(one as JournalTurn)).toBe('')
  })

  test('the standup lists what shipped, what is not committed, and the tests', () => {
    const resolved = resolveDays(
      [
        day('2026-10-14', [
          turn('r1', at('2026-10-14', 9), { tests: { passed: 101, failed: 0, command: 'claude plugin test .' } }),
          { ...t1, tests: { passed: 108, failed: 2, command: 'claude plugin test .' } },
          commit(sha('1'), at('2026-10-14', 11), ['a.ts']),
          { ...t2, tests: { passed: 110, failed: 0, command: 'claude plugin test .' } },
        ]),
      ],
      { tracksCommits: true },
    )
    const brief = buildStandup({ title: 'Shop', since: at('2026-10-14', 0), now: at('2026-10-14', 18), days: resolved, graph })
    expect(brief).toContain('## Shipped\n- `1111111` Ship it _(1 file)_')
    expect(brief).toContain('## Not committed yet\n- 3 files: `apps/api/x.ts`, `b.ts`, `a.ts`')
    expect(brief).toContain('## Tests\n- 110 passed · `claude plugin test .` _(was 101 passed)_')
    expect(brief).toContain('_(2 files, 1 of 2 files committed)_')
    const detail = standupDetail({ since: at('2026-10-14', 0), days: resolved })
    expect(detail).toContain('(tests: 108 passed, 2 failed) (1 of 2 files committed)')
    expect(detail).toContain('Committed 1111111: Ship it (1 file)')
    expect(dayMarkdown(resolved[0] as JournalDay, new Map())).toContain('⎇ **11:00 AM** Committed `1111111` Ship it _(1 file)_')
  })

  test('a failing last run is flagged', () => {
    const brief = buildStandup({
      title: 'Shop', since: at('2026-10-14', 0), now: at('2026-10-14', 18), graph,
      days: [day('2026-10-14', [turn('r', at('2026-10-14', 9), { tests: { passed: 3, failed: 1, command: 'npm test' } })])],
    })
    expect(brief).toContain('## Tests\n- ⚠ 3 passed, 1 failed · `npm test`')
  })
})

describe('insightsOf', () => {
  const now = at('2026-10-15', 18)
  const days = resolveDays(
    [
      day('2026-10-13', [
        turn('a', at('2026-10-13', 10), { components: ['api'], files: [{ path: 'apps/api/x.ts', created: false, edits: 3 }], tests: { passed: 9, failed: 1, command: 'npm test' } }),
        note('todo1', at('2026-10-13', 11), 'todo', 'Retry the webhook'),
        note('todo2', at('2026-10-13', 12), 'todo', 'Write docs', { done: true, doneAt: at('2026-10-14', 12) }),
      ]),
      day('2026-10-14', [commit(sha('d'), at('2026-10-14', 9), ['apps/api/x.ts'])]),
      day('2026-10-15', [
        turn('b', at('2026-10-15', 9), { components: ['api', 'web'], files: [{ path: 'apps/web/page.tsx', created: true, edits: 1 }], tests: { passed: 10, failed: 0, command: 'npm test' } }),
        turn('c', at('2026-10-15', 10), { components: ['web'], files: [{ path: 'apps/web/page.tsx', created: false, edits: 2 }] }),
      ]),
    ],
    { tracksCommits: true },
  )
  const out = insightsOf(days, graph, now, 7)

  test('has one row per day, oldest first, empty days included', () => {
    expect(out.days.map(d => d.date)).toEqual(['2026-10-09', '2026-10-10', '2026-10-11', '2026-10-12', '2026-10-13', '2026-10-14', '2026-10-15'])
    expect(out.days[4]).toEqual({ date: '2026-10-13', turns: 1, commits: 0, files: 1, tests: { passed: 9, failed: 1 } })
    expect(out.days[5]).toEqual({ date: '2026-10-14', turns: 0, commits: 1, files: 0 })
    expect(out.days[6]?.turns).toBe(2)
    expect(out.days[6]?.tests).toEqual({ passed: 10, failed: 0 })
  })

  test('counts work per component, with what is not committed and its last test run', () => {
    expect(out.components.api?.turns).toBe(2)
    expect(out.components.api?.tests).toEqual({ passed: 10, failed: 0, command: 'npm test', at: at('2026-10-15', 9) })
    expect(out.components.web?.turns).toBe(2)
    expect(out.components.web?.uncommitted).toEqual(['apps/web/page.tsx'])
    expect(out.components.api?.uncommitted).toEqual([])
  })

  test('ranks the files changed most', () => {
    // Equal edits: the file more turns touched comes first.
    expect(out.files).toEqual([
      { path: 'apps/web/page.tsx', edits: 3, turns: 2 },
      { path: 'apps/api/x.ts', edits: 3, turns: 1 },
    ])
  })

  test('says how todos and blockers are going', () => {
    expect(out.items.open).toBe(1)
    expect(out.items.closed).toBe(1)
    expect(out.items.avgCloseMs).toBe(24 * 3_600_000)
    expect(out.items.oldest.map(o => o.text)).toEqual(['Retry the webhook'])
  })
})

describe('misread test runs', () => {
  test('a logged run of no tests is dropped when days are resolved', () => {
    const [t] = resolveDays([day('2026-10-15', [turn('z', at('2026-10-15'), { tests: { passed: 0, failed: 0, command: 'x | tail -2' } })])])[0]?.entries ?? []
    expect((t as JournalTurn).tests).toBeUndefined()
  })
})
