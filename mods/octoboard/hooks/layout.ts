import type { Color } from 'claude-code'

import type { ChildLine, Entry, Preview, Status } from '../types'

// Pure text layout for the board: no `$`, no elements, so it is shared by the
// render hook and the tests.

export type Line = { text: string; color?: Color; bold?: boolean; dim?: boolean }

export const GLYPH: Record<Status, string> = {
  executing: '▶',
  awaitingApproval: '⏸',
  done: '✓',
  failed: '✗',
  cancelled: '⊘',
  draft: '○',
  unknown: '?',
}

export const COLOR: Record<Status, Color | undefined> = {
  executing: 'warning',
  awaitingApproval: 'permission',
  done: 'success',
  failed: 'error',
  cancelled: 'inactive',
  draft: undefined,
  unknown: 'inactive',
}

export const LABEL: Record<Status, string> = {
  executing: 'executing',
  awaitingApproval: 'awaiting approval',
  done: 'done',
  failed: 'failed',
  cancelled: 'cancelled',
  draft: 'draft',
  unknown: 'unknown',
}

export const STATUS_KEYS: [string, Exclude<Status, 'unknown'>][] = [
  ['1', 'draft'],
  ['2', 'executing'],
  ['3', 'awaitingApproval'],
  ['4', 'done'],
  ['5', 'failed'],
  ['6', 'cancelled'],
]

export const HELP: Line[] = [
  { text: 'Octoshell — keys', bold: true },
  { text: '' },
  { text: 'Moving around', bold: true },
  { text: '  ↑ ↓                 move the cursor (Tab / Shift+Tab do the same: Claude Code owns them)' },
  { text: '  PgUp PgDn          a page up / down' },
  { text: '  Home End           first / last row' },
  { text: '  p                  jump between the left and right panels (MC\'s Tab):' },
  { text: '                     children first, else the acceptance criteria' },
  { text: '  ⏎                  open a row marked › (it has missions, tasks or bugs);' },
  { text: '                     on a right-panel item, open it in its parent' },
  { text: '  u                  up one level (or ⏎ on the ".." row)' },
  { text: '' },
  { text: 'Changing the board (writes the YAML through set-status.js)', bold: true },
  { text: '  s  then 1-6        set status: draft, executing, awaiting approval,' },
  { text: '                     done, failed, cancelled; confirm with y, back with n' },
  { text: '  c                  cancel the entry under the cursor (y / n)' },
  { text: '  ⏎ on a criterion   tick / untick it (p reaches the right panel), via set-criterion.js' },
  { text: '  v                  run validate.js on the current campaign (or the board)' },
  { text: '  r                  re-read the board from disk' },
  { text: '' },
  { text: 'Elsewhere', bold: true },
  { text: '  h                  this help' },
  { text: '  q  or  Esc         close the board' },
  { text: '' },
  { text: 'Mouse (fullscreen terminal)', bold: true },
  { text: '  click a row or a right-panel item to open it; click any label on the bottom bar' },
  { text: '' },
  { text: 'Legend', bold: true },
  { text: '  ▶ executing   ⏸ awaiting approval   ✗ failed   ○ draft   ✓ done   ⊘ cancelled' },
  { text: '  3/5 › on a row: children done out of all; › means ⏎ opens it' },
  { text: '  on the .. row the right panel shows the folder you are in' },
]

/**
 * How far a pane scroll request moves the cursor: a page key asks for exactly bodyRows,
 * Home/End for contentRows, the wheel (it has a pointer) for a tick or two. Anything else
 * (an arrow's single row) is the focus ring's business, so 0.
 */
export function cursorDelta(by: number, bodyRows: number, contentRows: number, isWheel: boolean, page: number): number {
  const size = Math.abs(by)
  const direction = Math.sign(by)
  if (direction === 0) return 0
  if (isWheel) return by
  if (size === bodyRows) return direction * page
  if (size >= contentRows) return direction * 100_000
  return 0
}

export function fit(text: string, width: number): string {
  if (width <= 0) return ''
  const chars = Array.from(text.replace(/\s+/g, ' '))
  if (chars.length > width) return `${chars.slice(0, Math.max(0, width - 1)).join('')}…`
  return chars.join('') + ' '.repeat(width - chars.length)
}

export function wrap(text: string, width: number): string[] {
  const out: string[] = []
  const room = Math.max(8, width)
  for (const paragraph of text.split('\n')) {
    let line = ''
    for (const word of paragraph.split(/\s+/)) {
      if (!word) continue
      if (line.length === 0) line = word
      else if (line.length + 1 + word.length <= room) line += ` ${word}`
      else {
        out.push(line)
        line = word
      }
      while (line.length > room) {
        out.push(line.slice(0, room))
        line = line.slice(room)
      }
    }
    out.push(line)
  }
  return out
}

/** One left-panel row as a Button label: glyph, name, and progress pinned right. */
export function rowLabel(entry: Entry, width: number): string {
  if (entry.kind === 'up') return fit('↰ ..', width)
  const progress = `${entry.progress ? ` ${entry.progress}` : ''}${entry.opens ? ' ›' : ''}`
  const tag = entry.kind === 'bug' ? 'bug ' : ''
  return fit(`${GLYPH[entry.status]} ${tag}${entry.name}`, width - progress.length) + progress
}

/** One acceptance criterion as the right panel draws it: `n` is its 1-based place in the YAML list. */
export type CriterionLine = { n: number; text: string; done: boolean }

/**
 * The right panel in parts: a header, the children (drawn as Buttons), the acceptance
 * criteria (Buttons too: ⏎ ticks or unticks one), and the text after.
 */
export type PreviewParts = {
  head: Line[]
  childTitle?: string
  children: ChildLine[]
  criteriaTitle?: string
  criteria: CriterionLine[]
  tail: Line[]
}

export function previewParts(entry: Entry | undefined, width: number): PreviewParts {
  const none = { children: [], criteria: [], tail: [] }
  if (!entry) return { head: [{ text: 'Nothing here.', dim: true }], ...none }
  const preview = entry.preview
  if (entry.kind === 'up') return upParts(preview, width)
  if (!preview) return { head: [], ...none }
  const head: Line[] = []
  for (const text of wrap(preview.name, width)) head.push({ text, bold: true })
  head.push({ text: `${GLYPH[preview.status]} ${LABEL[preview.status]}  ·  ${preview.kind}`, color: COLOR[preview.status] })
  for (const meta of preview.meta) head.push({ text: meta, dim: true })

  const criteria = preview.criteria.map((one, i) => ({ n: i + 1, text: one.text, done: one.done }))
  const done = criteria.filter(one => one.done).length
  const criteriaTitle =
    criteria.length > 0 ? `── acceptance criteria ${done}/${criteria.length}  (⏎ ticks / unticks)` : undefined

  const tail: Line[] = []
  if (preview.description) {
    tail.push({ text: '' })
    for (const text of wrap(preview.description, width)) tail.push({ text })
  }
  if (preview.notes) {
    tail.push({ text: '' })
    tail.push({ text: '── notes', bold: true })
    for (const text of wrap(preview.notes, width)) tail.push({ text, dim: true })
  }
  const childTitle =
    preview.children.length > 0 ? `── ${preview.kind === 'campaign' ? 'missions' : 'tasks & bugs'}  (p to go here)` : undefined
  return { head, childTitle, children: preview.children, criteriaTitle, criteria, tail }
}

/** One criterion as a Button label: its box, then as much of its text as fits. */
export function criterionLabel(one: CriterionLine, width: number): string {
  return fit(`${one.done ? '[x]' : '[ ]'} ${one.text}`, width)
}

/**
 * The `..` row previews the folder the person stands in, read-only: its children are
 * the left panel's rows, and its criteria are ticked from the row one level up.
 */
function upParts(preview: Preview | undefined, width: number): PreviewParts {
  const head: Line[] = [{ text: `Up one level (u) · you are in this ${preview?.kind ?? 'folder'}:`, dim: true }]
  if (!preview) return { head, children: [], criteria: [], tail: [] }
  head.push({ text: '' })
  for (const text of wrap(preview.name, width)) head.push({ text, bold: true })
  head.push({ text: `${GLYPH[preview.status]} ${LABEL[preview.status]}  ·  ${preview.kind}`, color: COLOR[preview.status] })
  for (const meta of preview.meta) head.push({ text: meta, dim: true })
  const tail: Line[] = []
  if (preview.criteria.length > 0) {
    tail.push({ text: '' })
    tail.push({ text: `── acceptance criteria ${preview.criteria.filter(one => one.done).length}/${preview.criteria.length}`, bold: true })
    for (const one of preview.criteria) {
      wrap(one.text, width - 4).forEach((text, i) =>
        tail.push({ text: `${i === 0 ? (one.done ? '[x] ' : '[ ] ') : '    '}${text}`, dim: one.done }),
      )
    }
  }
  if (preview.description) {
    tail.push({ text: '' })
    for (const text of wrap(preview.description, width)) tail.push({ text })
  }
  if (preview.notes) {
    tail.push({ text: '' })
    tail.push({ text: '── notes', bold: true })
    for (const text of wrap(preview.notes, width)) tail.push({ text, dim: true })
  }
  return { head, children: [], criteria: [], tail }
}

/** One right-panel child as a Button label. */
export function childLabel(child: ChildLine, width: number): string {
  return fit(`${GLYPH[child.status]} ${child.kind === 'bug' ? 'bug ' : ''}${child.name}`, width)
}
