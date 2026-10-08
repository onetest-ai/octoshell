import { expect, test } from 'claude-code/testing'

import { buildView, loadBoard, setStatusArgv, summarize } from './board'
import type { BoardFs } from './board'
import { cursorDelta } from './layout'

const FILES: Record<string, string> = {
  '.octobots/campaigns/alpha/campaign.yaml': 'name: Alpha\nstatus: done\n',
  '.octobots/campaigns/beta/campaign.yaml': 'name: Beta\nstatus: executing\n',
  '.octobots/campaigns/beta/missions/m1-one/mission.yaml':
    'name: M1 - One\nstatus: executing\nacceptance_criteria:\n  - text: it works\n    done: true\n  - text: it ships\n    done: false\n',
  '.octobots/campaigns/beta/missions/m1-one/tasks/t1-1-a/task.yaml': 'name: T1.1 - A\nstatus: done\nrole: android-dev\n',
  '.octobots/campaigns/beta/missions/m1-one/tasks/t1-2-b/task.yaml': 'name: T1.2 - B\nstatus: draft\n',
  '.octobots/campaigns/beta/missions/m1-one/bugs/flaky/bug.yaml': 'name: Flaky thing\nstatus: failed\nseverity: major\n',
  '.octobots/campaigns/beta/missions/m2-empty/mission.yaml':
    'name: M2 - Empty\nstatus: draft\nacceptance_criteria:\n  - text: it exists\n    done: true\n',
}

const fakeFs: BoardFs = {
  list: async path => {
    const prefix = `${path}/`
    const names = new Set<string>()
    for (const file of Object.keys(FILES)) {
      if (!file.startsWith(prefix)) continue
      const rest = file.slice(prefix.length).split('/')
      if (rest.length > 1 && rest[0]) names.add(rest[0])
    }
    if (names.size === 0) throw new Error(`ENOENT ${path}`)
    return [...names].map(name => ({ name, kind: 'dir' }))
  },
  read: async path => {
    const text = FILES[path]
    if (text === undefined) throw new Error(`ENOENT ${path}`)
    return text
  },
}

test('the board is folder-derived and the active campaign lists first', async () => {
  const board = await loadBoard(fakeFs)
  const root = buildView(board, { path: [] }, null, '12:00:00')
  expect(root.entries.map(entry => entry.name)).toEqual(['Beta', 'Alpha'])
  expect(root.entries[0]?.progress).toBe('0/2')

  const mission = buildView(
    board,
    { path: ['.octobots/campaigns/beta', '.octobots/campaigns/beta/missions/m1-one'] },
    null,
    '12:00:00',
  )
  expect(mission.crumbs).toEqual(['board', 'Beta', 'M1 - One'])
  expect(mission.entries.map(entry => entry.name)).toEqual(['..', 'T1.1 - A', 'T1.2 - B', 'Flaky thing'])
  expect(mission.entries[3]?.preview?.meta[0]).toBe('severity major')
})

test('a vanished folder in the nav path falls back to its nearest parent', async () => {
  const board = await loadBoard(fakeFs)
  const view = buildView(board, { path: ['.octobots/campaigns/beta', '.octobots/campaigns/beta/missions/gone'] }, null, '')
  expect(view.crumbs).toEqual(['board', 'Beta'])
})

test('summary counts non-campaign statuses and open campaigns', async () => {
  const board = await loadBoard(fakeFs)
  expect(summarize(board)).toEqual({ executing: 1, awaiting: 0, failed: 1, draft: 2, campaignsOpen: 1 })
})

test('set-status gets the parent folder and the entity title', async () => {
  const board = await loadBoard(fakeFs)
  expect(setStatusArgv(board, '.octobots/campaigns/beta/missions/m1-one', 'cancelled', 's.js')).toEqual([
    'node',
    's.js',
    '.octobots/campaigns/beta',
    'M1 - One',
    'cancelled',
  ])
  expect(setStatusArgv(board, '.octobots/campaigns/beta', 'awaitingApproval', 's.js')).toEqual([
    'node',
    's.js',
    '.octobots/campaigns/beta',
    'Beta',
    'awaiting approval',
  ])
})

test('page keys, Home/End and the wheel become cursor moves; an arrow row does not', () => {
  // bodyRows 30, a tree of 30 rows, a page of 25 list rows
  expect(cursorDelta(30, 30, 30, false, 25)).toBe(25)
  expect(cursorDelta(-30, 30, 30, false, 25)).toBe(-25)
  expect(cursorDelta(60, 30, 60, false, 25)).toBe(100_000)
  expect(cursorDelta(-60, 30, 60, false, 25)).toBe(-100_000)
  expect(cursorDelta(2, 30, 30, true, 25)).toBe(2)
  expect(cursorDelta(1, 30, 30, false, 25)).toBe(0)
  expect(cursorDelta(0, 30, 30, false, 25)).toBe(0)
})

test('only a row with children opens, and its count is children, never criteria', async () => {
  const board = await loadBoard(fakeFs)
  const campaign = buildView(board, { path: ['.octobots/campaigns/beta'] }, null, '')
  const [up, one, empty] = campaign.entries
  expect([one?.name, one?.progress, one?.opens]).toEqual(['M1 - One', '1/3', true])
  expect([empty?.name, empty?.progress, empty?.opens]).toEqual(['M2 - Empty', '', false])
  expect([up?.opens, up?.preview?.name]).toEqual([false, 'Beta'])

  const mission = buildView(board, { path: ['.octobots/campaigns/beta', '.octobots/campaigns/beta/missions/m1-one'] }, null, '')
  expect(mission.entries[0]?.preview?.name).toBe('M1 - One')
  expect(mission.entries.slice(1).every(entry => !entry.opens && entry.progress === '')).toBe(true)
})
