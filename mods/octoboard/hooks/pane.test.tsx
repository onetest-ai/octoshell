import { expect, test } from 'claude-code/testing'
import type { TestBody } from 'claude-code/testing'

const FILES: Record<string, string> = {
  '.octobots/campaigns/alpha/campaign.yaml': 'name: Alpha\nstatus: done\n',
  '.octobots/campaigns/beta/campaign.yaml': 'name: Beta\nstatus: executing\n',
  '.octobots/campaigns/beta/missions/m1-one/mission.yaml': 'name: M1 - One\nstatus: executing\n',
  '.octobots/campaigns/beta/missions/m1-one/tasks/t1-1-a/task.yaml': 'name: T1.1 - A\nstatus: done\n',
}

// The engine may hand hooks an absolute path; the fixture is keyed from .octobots/.
function rel(path: string): string {
  const at = path.indexOf('.octobots')
  return at >= 0 ? path.slice(at) : path
}

function dirsUnder(raw: string): string[] {
  const path = rel(raw)
  const names = new Set<string>()
  for (const file of Object.keys(FILES)) {
    if (!file.startsWith(`${path}/`)) continue
    const rest = file.slice(path.length + 1).split('/')
    if (rest.length > 1 && rest[0]) names.add(rest[0])
  }
  return [...names]
}

const PANE_PROPS = {
  title: 'Octoshell',
  isFocused: true,
  bodyColumns: 120,
  placement: 'dock',
  scroll: { offset: 0, bodyRows: 30 },
  view: {},
} as never

const PANE = { plugin: 'octoboard', surface: 'terminal', component: 'Pane', requestId: 'octoboard', props: PANE_PROPS } as const

type On = Parameters<TestBody>[1]

function fakeBoard(on: On) {
  on('fs.exists', ($, e) => ({ value: dirsUnder(e.path).length > 0 || rel(e.path) in FILES }) as never)
  on('fs.list', ($, e) => {
    const names = dirsUnder(e.path)
    if (names.length === 0) throw new Error(`ENOENT ${e.path}`)
    return { value: names.map(name => ({ name, kind: 'dir', size: 0, mtimeMs: 0, isLink: false })) } as never
  })
  on('fs.read', ($, e) => {
    const text = FILES[rel(e.path)]
    if (text === undefined) throw new Error(`ENOENT ${e.path}`)
    return { value: text } as never
  })
}

test('every row is a Button, ⏎ on a campaign drills in and u goes back up', async ($, on) => {
  fakeBoard(on)
  const ui = await $.ui.mount(PANE as never)
  await ui.press({ key: 'refresh' })

  expect(await ui.find({ text: /Octoshell +board/ })).toBeDefined()
  const beta = await ui.find({ type: 'Button', key: 'row:.octobots/campaigns/beta' })
  expect(beta?.text).toMatch(/▶ Beta/)

  await ui.press({ key: 'row:.octobots/campaigns/beta' })
  expect(await ui.find({ text: /board › Beta/ })).toBeDefined()
  expect(await ui.find({ type: 'Button', key: 'row:.octobots/campaigns/beta/missions/m1-one' })).toBeDefined()

  await ui.press({ key: 'up' })
  expect(await ui.find({ text: /board › Beta/ })).toBeUndefined()
  await ui.unmount()
})

test('c asks to cancel the row under the cursor, and n backs out', async ($, on) => {
  fakeBoard(on)
  const ui = await $.ui.mount(PANE as never)
  await ui.press({ key: 'refresh' })

  await ui.press({ key: 'cancel' })
  expect(await ui.find({ text: /Set "Beta" to cancelled\?/ })).toBeDefined()
  await ui.press({ key: 'no' })
  expect(await ui.find({ text: /Set "Beta"/ })).toBeUndefined()
  expect(await ui.find({ type: 'Button', key: 'cancel' })).toBeDefined()
  await ui.unmount()
})

test('h opens a help screen that lists the keys, and h returns to the board', async ($, on) => {
  fakeBoard(on)
  const ui = await $.ui.mount(PANE as never)
  await ui.press({ key: 'help' })
  expect(await ui.find({ text: /Octoshell — keys/ })).toBeDefined()
  expect(await ui.find({ text: /s {2}then 1-6/ })).toBeDefined()

  await ui.press({ key: 'help-close' })
  expect(await ui.find({ text: /Octoshell — keys/ })).toBeUndefined()
  await ui.unmount()
})

test('/octoshell opens the board pane asking for the keyboard, and writes nothing to the transcript', async ($, on) => {
  on('fs.exists', () => ({ value: false }) as never)
  const opened: { id: string; focus?: true }[] = []
  on('ui.open', ($, e) => {
    opened.push({ id: e.id, focus: e.focus })
    return { value: { isPlaced: true } } as never
  })
  const ran = await $.command.run({ command: 'octoshell' } as never)
  expect(opened).toEqual([{ id: 'octoboard', focus: true }])
  expect(ran.text).toBeUndefined()
})
