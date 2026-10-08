import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { BoardView, Entry, Kind, Message, Mode, Nav, Pending, Status, Summary } from '../types'
import { buildView, loadBoard, setStatusArgv, summarize, totalsLine } from './board'
import type { Board } from './board'
import { HELP, LABEL, STATUS_KEYS, childLabel, criterionLabel, cursorDelta, fit, previewParts, rowLabel } from './layout'

// Octoshell: a Midnight-Commander-style board browser in a pane. Every row is a
// Button, so the pane's own focus ring is the cursor: it takes the keyboard the
// moment the pane opens, the arrows walk the rows, ⏎ opens, and letter hotkeys act.

const PANE = 'octoboard'
const SCRIPTS = '.claude/skills/mission-planner/scripts'
const ROW = 'row:'
const CHILD = 'child:'

const EMPTY: Record<Kind, string> = {
  campaign: 'No missions in this campaign yet',
  mission: 'No tasks or bugs in this mission yet',
  task: 'A task has nothing to open',
  bug: 'A bug has nothing to open',
}
const CRIT = 'crit:'

const nav = atom({ plugin: 'octoboard', key: 'nav' } as const, { path: [] } as Nav)
const summary = atom({ plugin: 'octoboard', key: 'summary' } as const, null as Summary | null)
const message = atom({ plugin: 'octoboard', key: 'message' } as const, null as Message | null)
const revision = atom({ plugin: 'octoboard', key: 'revision' } as const, 0)
const mode = atom({ plugin: 'octoboard', key: 'mode' } as const, 'browse' as Mode)
const side = atom({ plugin: 'octoboard', key: 'side' } as const, 'left' as 'left' | 'right')
const pending = atom({ plugin: 'octoboard', key: 'pending' } as const, null as Pending | null)

// The parsed board lives in the module: a reload re-reads it at session.start.
let board: Board | null = null
let loadedAt = ''
let loading: Promise<void> | null = null

async function readBoard($: EngineInterface): Promise<void> {
  try {
    if (!(await $.fs.exists('.octobots/campaigns'))) {
      board = null
      await update($, summary, () => null)
      return
    }
    board = await loadBoard({ list: path => $.fs.list(path), read: path => $.fs.read(path) as Promise<string> })
    loadedAt = new Date().toTimeString().slice(0, 8)
    await update($, summary, () => (board ? summarize(board) : null))
    await update($, revision, n => (n ?? 0) + 1)
  } finally {
    loading = null
  }
}

function reload($: EngineInterface): Promise<void> {
  if (!loading) loading = readBoard($)
  return loading
}

function say($: EngineInterface, text: string, isError = false) {
  return update($, message, () => ({ text, isError }))
}

function viewFor(where: Nav, said: Message | null): BoardView {
  return board
    ? buildView(board, where, said, loadedAt)
    : { crumbs: ['board'], entries: [], loadedAt: '—', totals: 'Reading .octobots/ … (r to retry)', message: said ?? undefined }
}

/** The row the cursor stands on: the remembered one, else the first real row. */
function cursorOf(view: BoardView): Entry | undefined {
  const remembered = view.entries.find(entry => entry.id === view.cursorId)
  return remembered ?? view.entries.find(entry => entry.kind !== 'up') ?? view.entries[0]
}

async function moveTo($: EngineInterface, next: Nav) {
  await update($, nav, () => next)
  await update($, mode, () => 'browse')
  const target = cursorOf(viewFor(next, null))
  if (target) await $.ui.focus({ requestId: PANE, key: `${ROW}${target.id}` }).catch(() => undefined)
}

async function openBoard($: EngineInterface) {
  if (!board) await reload($)
  await $.ui.open({ id: PANE, title: 'Octoshell', focus: true, closeOnEscape: true, rows: 60, columns: 400 })
}

async function openEntry($: EngineInterface, id: string) {
  const where = await read($, nav)
  if (id === '..') return goUp($)
  const entity = board?.byDir.get(id)
  if (!entity) return
  // Only a row marked › goes in; any other stays put and says why.
  if (entity.children.length === 0) {
    await update($, nav, () => ({ path: where.path, cursorId: id }))
    return say($, `${EMPTY[entity.kind]}; its details are on the right.`)
  }
  await say($, '')
  await moveTo($, { path: [...where.path, id] })
}

/** ⏎ on a right-panel item: step into its parent with the cursor on it. */
async function openChild($: EngineInterface, parentId: string, childId: string) {
  const where = await read($, nav)
  await say($, '')
  await update($, side, () => 'left')
  await moveTo($, { path: [...where.path, parentId], cursorId: childId })
}

/** p: the focus ring jumps between the left rows and the right panel's items. */
async function switchPanel($: EngineInterface) {
  const view = viewFor(await read($, nav), null)
  const cursor = cursorOf(view)
  if (!cursor) return
  // The .. row's preview is read-only: nothing on the right to walk.
  const shown = cursor.kind === 'up' ? undefined : cursor.preview
  const children = shown?.children ?? []
  const criteria = shown?.criteria ?? []
  const isRight = (await read($, side)) === 'right'
  if (isRight || (children.length === 0 && criteria.length === 0)) {
    if (!isRight) await say($, 'Nothing to select on the right for this row.')
    await update($, side, () => 'left')
    await $.ui.focus({ requestId: PANE, key: `${ROW}${cursor.id}` }).catch(() => undefined)
    return
  }
  const first = children[0]
  await update($, side, () => 'right')
  await $.ui.focus({ requestId: PANE, key: first ? `${CHILD}${first.id}` : `${CRIT}1` }).catch(() => undefined)
}

/** ⏎ on a criterion: tick or untick it through the planner's own script, then re-read. */
async function toggleCriterion($: EngineInterface, dir: string, n: number, isDone: boolean) {
  const op = isDone ? 'uncheck' : 'check'
  const ran = await $.process.run(['node', `${SCRIPTS}/set-criterion.js`, dir, op, String(n)], { timeoutMs: 20_000 })
  const output = (ran.exitCode === 0 ? ran.stdout : ran.stderr || ran.stdout).trim().split('\n').pop() ?? ''
  await say(
    $,
    ran.exitCode === 0 ? `Criterion ${n} ${isDone ? 'unticked' : 'ticked'}.` : `set-criterion failed: ${output}`,
    ran.exitCode !== 0,
  )
  await reload($)
  await update($, side, () => 'right')
  await $.ui.focus({ requestId: PANE, key: `${CRIT}${n}` }).catch(() => undefined)
}

/** PgUp/PgDn, Home/End and the wheel move the cursor, MC-style, instead of scrolling the pane. */
async function moveCursor($: EngineInterface, by: number) {
  const view = viewFor(await read($, nav), null)
  const rows = view.entries
  if (rows.length === 0) return
  const at = Math.max(0, rows.findIndex(entry => entry.id === cursorOf(view)?.id))
  const target = rows[Math.max(0, Math.min(rows.length - 1, at + by))]
  if (!target) return
  await update($, side, () => 'left')
  await update($, nav, current => ({ path: current.path, cursorId: target.id }))
  await $.ui.focus({ requestId: PANE, key: `${ROW}${target.id}` }).catch(() => undefined)
}

async function goUp($: EngineInterface) {
  const where = await read($, nav)
  if (where.path.length === 0) return
  await moveTo($, { path: where.path.slice(0, -1), cursorId: where.path.at(-1) })
}

async function setMode($: EngineInterface, next: Mode) {
  await update($, mode, () => next)
}

async function askStatus($: EngineInterface, status: Exclude<Status, 'unknown'>) {
  const target = cursorOf(viewFor(await read($, nav), null))
  if (!target || target.kind === 'up') return setMode($, 'browse')
  await update($, pending, () => ({ id: target.id, name: target.name, status }))
  await setMode($, 'confirm')
}

async function confirm($: EngineInterface, isYes: boolean) {
  const asked = await read($, pending)
  await update($, pending, () => null)
  await setMode($, 'browse')
  if (!isYes || !asked || !board) return
  const argv = setStatusArgv(board, asked.id, asked.status, `${SCRIPTS}/set-status.js`)
  if (!argv) return say($, 'That entry is no longer on the board.', true)
  const ran = await $.process.run(argv, { timeoutMs: 20_000 })
  const output = (ran.exitCode === 0 ? ran.stdout : ran.stderr || ran.stdout).trim().split('\n').pop() ?? ''
  await update($, nav, current => ({ path: current.path, cursorId: asked.id }))
  await say($, ran.exitCode === 0 ? output || 'Status set.' : `set-status failed: ${output}`, ran.exitCode !== 0)
  await reload($)
}

async function validate($: EngineInterface) {
  const target = (await read($, nav)).path[0]
  await say($, `Validating ${target ? target.split('/').pop() : 'the board'} …`)
  const ran = await $.process.run(['node', `${SCRIPTS}/validate.js`, ...(target ? [target] : [])], { timeoutMs: 60_000 })
  const lines = `${ran.stdout}\n${ran.stderr}`.trim().split('\n').filter(Boolean)
  await say($, `validate: ${lines.slice(-2).join(' | ') || `exit ${ran.exitCode}`}`, ran.exitCode !== 0)
}

async function refresh($: EngineInterface) {
  try {
    await reload($)
    await say($, board ? `Re-read the board at ${loadedAt}.` : 'No .octobots/campaigns folder here.', !board)
  } catch (error) {
    await say($, `Could not read the board: ${String(error)}`, true)
  }
}

async function closeBoard($: EngineInterface) {
  await setMode($, 'browse')
  await $.ui.close({ id: PANE })
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'octoshell', description: 'Open the Octoshell board browser (Midnight-Commander style)' })
    void reload($)
    // Keep the board current while it is open; a closed board re-reads on open.
    $.clock.every(15_000, async () => {
      const panes = await $.ui.panes()
      if (panes.some(pane => pane.id === PANE)) await reload($)
    })
    return next(e)
  })

  // An agent editing the board (the planner scripts run through Bash, or a direct edit)
  // re-reads it once the call has finished.
  on('tool.call', async ($, e, next) => {
    const result = await next(e)
    const call = JSON.stringify(e)
    if (call.includes('.octobots') || call.includes('mission-planner')) {
      void reload($)
    }
    return result
  }).catch(($, e, next) => next(e))

  // Typed at the prompt: opens the board and leaves nothing in the conversation.
  on('command.run', { command: 'octoshell' }, async $ => {
    await openBoard($)
    return {}
  })

  // The ring moving onto a row is the cursor moving: the right panel follows it.
  on('ui.focus', { requestId: PANE }, async ($, e, next) => {
    const key = e.element
    if (key?.startsWith(ROW)) {
      const id = key.slice(ROW.length)
      await update($, nav, current => (current.cursorId === id ? current : { path: current.path, cursorId: id }))
      await update($, side, current => (current === 'left' ? current : 'left'))
    } else if (key?.startsWith(CHILD) || key?.startsWith(CRIT)) {
      // The preview stays on the left row while the person walks its children.
      await update($, side, current => (current === 'right' ? current : 'right'))
    }
    return next(e)
  }).catch(($, e, next) => next(e))

  // The board never scrolls as a page: a page key asks for bodyRows, Home/End for
  // contentRows, the wheel for a tick or two; each moves the cursor instead.
  on('ui.scroll', { requestId: PANE }, async ($, e) => {
    if (e.origin.kind !== 'person') return {}
    const by = cursorDelta(e.by, e.bodyRows, e.contentRows, e.pointer !== undefined, Math.max(1, e.bodyRows - 5))
    if (by !== 0) await moveCursor($, by)
    return {}
  }).catch(() => ({}))

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const counts = await read($, summary)
    if (e.props.hasSurvey || counts === null) return next(e)

    const { Box, Button, Text } = $.ui.resolve(e)
    return (
      <Box gap={1}>
        <Button key="open-board" label="Board" hotkey="b" variant="primary" onPress={() => openBoard($)} />
        <Text dimColor>{totalsLine(counts)}</Text>
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Button, Text } = $.ui.resolve(e)
    await read($, revision)
    const where = await read($, nav)
    const said = await read($, message)
    const asking = await read($, mode)
    const asked = await read($, pending)
    const panelSide = await read($, side)

    const view = viewFor(where, said)
    const entries = view.entries
    const cursor = cursorOf(view)
    const index = Math.max(0, entries.findIndex(entry => entry.id === cursor?.id))

    const width = Math.max(60, e.props.bodyColumns)
    const rows = Math.max(12, e.props.scroll.bodyRows)
    const panelRows = rows - 3
    const listRows = Math.max(3, panelRows - 2)
    const leftWidth = Math.max(30, Math.floor(width * 0.42))
    const rightWidth = width - leftWidth
    const innerRight = rightWidth - 4

    // A window over the rows, centred on the cursor, so the next row is always drawn
    // for the arrows to walk onto.
    const top = Math.max(0, Math.min(index - Math.floor(listRows / 2), entries.length - listRows))
    const shown = entries.slice(top, top + listRows)
    const parts = previewParts(cursor, innerRight)
    const childRoom = parts.childTitle ? Math.max(3, listRows - parts.head.length - 2) : 0
    const childrenShown = parts.children.slice(0, childRoom)
    const childrenHidden = parts.children.length - childrenShown.length
    const childLines = parts.childTitle ? 1 + childrenShown.length + (childrenHidden > 0 ? 1 : 0) : 0
    // Criteria come before the description: they are what the person acts on.
    const critRoom = parts.criteriaTitle ? Math.max(0, listRows - parts.head.length - childLines - 2) : 0
    const criteriaShown = parts.criteria.slice(0, critRoom)
    const criteriaHidden = parts.criteria.length - criteriaShown.length
    const critLines = parts.criteriaTitle ? 2 + criteriaShown.length + (criteriaHidden > 0 ? 1 : 0) : 0
    const tailRoom = Math.max(0, listRows - parts.head.length - childLines - critLines)
    const tail = parts.tail.slice(0, tailRoom)

    const stamp = `read ${view.loadedAt} `
    const header = fit(` Octoshell  ${view.crumbs.join(' › ')}`, width - stamp.length) + stamp

    const line =
      asking === 'help'
        ? { text: 'Help: h or n to return to the board.', isError: false, isAsk: true }
        : asking === 'confirm' && asked
          ? { text: `Set "${asked.name}" to ${LABEL[asked.status]}?  y / n`, isError: false, isAsk: true }
          : asking === 'status'
            ? { text: 'Pick the new status (1-6), n to go back.', isError: false, isAsk: true }
            : { text: view.message?.text || view.totals, isError: view.message?.isError ?? false, isAsk: false }

    type Action = { key: string; hotkey: string; label: string; run: () => unknown }
    const actions: Action[] =
      asking === 'help'
        ? [
            { key: 'help-close', hotkey: 'h', label: 'Back to the board', run: () => setMode($, 'browse') },
            { key: 'help-n', hotkey: 'n', label: 'Back', run: () => setMode($, 'browse') },
          ]
        : asking === 'confirm'
          ? [
              { key: 'yes', hotkey: 'y', label: 'Yes', run: () => confirm($, true) },
              { key: 'no', hotkey: 'n', label: 'No', run: () => confirm($, false) },
            ]
          : asking === 'status'
            ? [
                ...STATUS_KEYS.map(([hotkey, status]) => ({
                  key: `status-${status}`,
                  hotkey,
                  label: LABEL[status],
                  run: () => askStatus($, status),
                })),
                { key: 'status-back', hotkey: 'n', label: 'Back', run: () => setMode($, 'browse') },
              ]
            : [
                { key: 'help', hotkey: 'h', label: 'Help', run: () => setMode($, 'help') },
                { key: 'up', hotkey: 'u', label: 'Up', run: () => goUp($) },
                { key: 'panel', hotkey: 'p', label: 'Panel', run: () => switchPanel($) },
                { key: 'status', hotkey: 's', label: 'Status', run: () => setMode($, 'status') },
                { key: 'cancel', hotkey: 'c', label: 'Cancel', run: () => askStatus($, 'cancelled') },
                { key: 'validate', hotkey: 'v', label: 'Validate', run: () => validate($) },
                { key: 'refresh', hotkey: 'r', label: 'Refresh', run: () => refresh($) },
                { key: 'close', hotkey: 'q', label: 'Close', run: () => closeBoard($) },
              ]

    const body =
      asking === 'help' ? (
        <Box flexDirection="column" width={width} height={panelRows} paddingX={2} borderStyle="round" borderColor="suggestion">
          {HELP.slice(0, listRows).map((help, i) => (
            <Text key={`h-${i}`} wrap="truncate-end" bold={help.bold} dimColor={help.dim}>
              {help.text || ' '}
            </Text>
          ))}
        </Box>
      ) : (
        <Box flexDirection="row" height={panelRows}>
          <Box
            flexDirection="column"
            width={leftWidth}
            height={panelRows}
            borderStyle="single"
            borderColor={panelSide === 'left' ? 'suggestion' : 'subtle'}
          >
            {shown.length === 0 && <Text dimColor>{fit(' (empty)', leftWidth - 2)}</Text>}
            {shown.map(entry => (
              <Button
                key={`${ROW}${entry.id}`}
                plain
                label={rowLabel(entry, leftWidth - 2)}
                dimColor={entry.kind !== 'up' && (entry.status === 'done' || entry.status === 'cancelled')}
                autoFocus={entry.id === cursor?.id ? true : undefined}
                onPress={() => openEntry($, entry.id)}
              />
            ))}
          </Box>
          <Box
            flexDirection="column"
            width={rightWidth}
            height={panelRows}
            paddingX={1}
            borderStyle="single"
            borderColor={panelSide === 'right' ? 'suggestion' : 'subtle'}
          >
            {parts.head.map((one, i) => (
              <Text key={`ph-${i}`} wrap="truncate-end" color={one.color} bold={one.bold} dimColor={one.dim}>
                {one.text || ' '}
              </Text>
            ))}
            {parts.childTitle && (
              <Text key="pc-title" bold wrap="truncate-end">
                {parts.childTitle}
              </Text>
            )}
            {cursor &&
              childrenShown.map(child => (
                <Button
                  key={`${CHILD}${child.id}`}
                  plain
                  label={childLabel(child, innerRight)}
                  dimColor={child.status === 'done' || child.status === 'cancelled' ? true : undefined}
                  onPress={() => openChild($, cursor.id, child.id)}
                />
              ))}
            {childrenHidden > 0 && (
              <Text key="pc-more" dimColor wrap="truncate-end">
                {`… ${childrenHidden} more: open the row to see all`}
              </Text>
            )}
            {parts.criteriaTitle && <Text key="pk-gap"> </Text>}
            {parts.criteriaTitle && (
              <Text key="pk-title" bold wrap="truncate-end">
                {parts.criteriaTitle}
              </Text>
            )}
            {cursor &&
              criteriaShown.map(one => (
                <Button
                  key={`${CRIT}${one.n}`}
                  plain
                  label={criterionLabel(one, innerRight)}
                  dimColor={one.done ? true : undefined}
                  onPress={() => toggleCriterion($, cursor.id, one.n, one.done)}
                />
              ))}
            {criteriaHidden > 0 && (
              <Text key="pk-more" dimColor wrap="truncate-end">
                {`… ${criteriaHidden} more criteria`}
              </Text>
            )}
            {tail.map((one, i) => (
              <Text key={`pt-${i}`} wrap="truncate-end" color={one.color} bold={one.bold} dimColor={one.dim}>
                {one.text || ' '}
              </Text>
            ))}
          </Box>
        </Box>
      )

    return (
      <Box flexDirection="column" width={width}>
        <Text inverse bold wrap="truncate-end">
          {header}
        </Text>
        {body}
        <Text
          wrap="truncate-end"
          color={line.isError ? 'error' : line.isAsk ? 'warning' : undefined}
          dimColor={!line.isError && !line.isAsk}
        >
          {` ${line.text}`}
        </Text>
        <Box flexDirection="row" gap={2}>
          {actions.map(action => (
            <Button key={action.key} plain hotkey={action.hotkey} label={action.label} onPress={() => action.run()} />
          ))}
        </Box>
      </Box>
    )
  })
}
