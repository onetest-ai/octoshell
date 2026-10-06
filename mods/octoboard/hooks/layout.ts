import type { Color } from 'claude-code'

import type { Entry, Status } from '../types'

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
  { text: '  ↑ ↓  Tab           move the cursor (the right panel follows it)' },
  { text: '  ⏎                  open the campaign or mission under the cursor' },
  { text: '  u                  up one level (or ⏎ on the ".." row)' },
  { text: '' },
  { text: 'Changing the board (writes the YAML through set-status.js)', bold: true },
  { text: '  s  then 1-6        set status: draft, executing, awaiting approval,' },
  { text: '                     done, failed, cancelled; confirm with y, back with n' },
  { text: '  c                  cancel the entry under the cursor (y / n)' },
  { text: '  v                  run validate.js on the current campaign (or the board)' },
  { text: '  r                  re-read the board from disk' },
  { text: '' },
  { text: 'Elsewhere', bold: true },
  { text: '  h                  this help' },
  { text: '  q  or  Esc         close the board' },
  { text: '' },
  { text: 'Mouse (fullscreen terminal)', bold: true },
  { text: '  click a row to open it; click any label on the bottom bar' },
  { text: '' },
  { text: 'Legend', bold: true },
  { text: '  ▶ executing   ⏸ awaiting approval   ✗ failed   ○ draft   ✓ done   ⊘ cancelled' },
  { text: '  3/5 on a row: children done (or ✓ criteria met) out of all' },
]

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
  const progress = entry.progress ? ` ${entry.progress}` : ''
  const tag = entry.kind === 'bug' ? 'bug ' : ''
  return fit(`${GLYPH[entry.status]} ${tag}${entry.name}`, width - progress.length) + progress
}

export function previewLines(entry: Entry | undefined, width: number): Line[] {
  if (!entry) return [{ text: 'Nothing here.', dim: true }]
  if (entry.kind === 'up') return [{ text: 'Up one level  (u)', dim: true }]
  const preview = entry.preview
  if (!preview) return []
  const lines: Line[] = []
  for (const text of wrap(preview.name, width)) lines.push({ text, bold: true })
  lines.push({ text: `${GLYPH[preview.status]} ${LABEL[preview.status]}  ·  ${preview.kind}`, color: COLOR[preview.status] })
  for (const meta of preview.meta) lines.push({ text: meta, dim: true })
  if (preview.description) {
    lines.push({ text: '' })
    for (const text of wrap(preview.description, width)) lines.push({ text })
  }
  if (preview.criteria.length > 0) {
    const done = preview.criteria.filter(one => one.done).length
    lines.push({ text: '' })
    lines.push({ text: `── acceptance criteria ${done}/${preview.criteria.length}`, bold: true })
    for (const one of preview.criteria) {
      wrap(one.text, width - 4).forEach((text, i) =>
        lines.push({ text: `${i === 0 ? (one.done ? '[x] ' : '[ ] ') : '    '}${text}`, dim: one.done }),
      )
    }
  }
  if (preview.children.length > 0) {
    lines.push({ text: '' })
    lines.push({ text: `── ${preview.kind === 'campaign' ? 'missions' : 'tasks & bugs'}`, bold: true })
    for (const child of preview.children) {
      lines.push({
        text: `${GLYPH[child.status]} ${child.kind === 'bug' ? 'bug ' : ''}${child.name}`,
        color: COLOR[child.status],
      })
    }
  }
  if (preview.notes) {
    lines.push({ text: '' })
    lines.push({ text: '── notes', bold: true })
    for (const text of wrap(preview.notes, width)) lines.push({ text, dim: true })
  }
  return lines
}
