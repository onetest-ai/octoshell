import { load } from './js-yaml.mjs'

import type {
  BoardView,
  Criterion,
  Entity,
  Entry,
  Kind,
  Message,
  Nav,
  Preview,
  Status,
  Summary,
} from '../types'

export const ROOT = '.octobots/campaigns'

/** The slice of `$.fs` the loader needs, so it can be driven without a session. */
export type BoardFs = {
  list: (path: string) => Promise<{ name: string; kind: string }[]>
  read: (path: string) => Promise<string>
}

export type Board = { campaigns: string[]; byDir: Map<string, Entity> }

const CHILD_FOLDERS: Record<Kind, [string, Kind][]> = {
  campaign: [['missions', 'mission']],
  mission: [
    ['tasks', 'task'],
    ['bugs', 'bug'],
  ],
  task: [],
  bug: [],
}

const STATUS_ORDER: Status[] = [
  'executing',
  'awaitingApproval',
  'failed',
  'draft',
  'unknown',
  'done',
  'cancelled',
]

export function mapStatus(raw: unknown): Status {
  const key = String(raw ?? '')
    .trim()
    .toLowerCase()
    .replace(/[\s_-]+/g, ' ')
  switch (key) {
    case 'draft':
      return 'draft'
    case 'active':
    case 'executing':
    case 'in progress':
    case 'running':
      return 'executing'
    case 'awaiting approval':
    case 'awaitingapproval':
    case 'awaiting':
      return 'awaitingApproval'
    case 'done':
    case 'complete':
    case 'completed':
      return 'done'
    case 'failed':
    case 'fail':
      return 'failed'
    case 'cancelled':
    case 'canceled':
      return 'cancelled'
    default:
      return 'unknown'
  }
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : value == null ? '' : String(value)
}

function criteriaOf(value: unknown): Criterion[] {
  if (!Array.isArray(value)) return []
  return value.map(item =>
    typeof item === 'object' && item !== null
      ? { text: text((item as { text?: unknown }).text), done: (item as { done?: unknown }).done === true }
      : { text: text(item), done: false },
  )
}

export function parseEntity(source: string, dir: string, kind: Kind): Entity {
  let doc: Record<string, unknown> = {}
  try {
    const loaded = load(source)
    if (loaded && typeof loaded === 'object') doc = loaded as Record<string, unknown>
  } catch {
    return {
      dir,
      kind,
      name: `${dir.split('/').pop()} (unparseable ${kind}.yaml)`,
      status: 'unknown',
      description: '',
      criteria: [],
      notes: '',
      children: [],
    }
  }
  return {
    dir,
    kind,
    name: text(doc.name) || (dir.split('/').pop() ?? dir),
    status: mapStatus(doc.status),
    description: text(doc.description),
    criteria: criteriaOf(doc.acceptance_criteria),
    notes: text(doc.notes),
    role: text(doc.role) || undefined,
    severity: text(doc.severity) || undefined,
    target: text(doc.target) || undefined,
    children: [],
  }
}

async function subfolders(fs: BoardFs, path: string): Promise<string[]> {
  try {
    const entries = await fs.list(path)
    return entries.filter(entry => entry.kind === 'dir').map(entry => entry.name)
  } catch {
    return []
  }
}

async function loadEntity(fs: BoardFs, board: Board, dir: string, kind: Kind): Promise<boolean> {
  let source: string
  try {
    source = await fs.read(`${dir}/${kind}.yaml`)
  } catch {
    return false
  }
  const entity = parseEntity(source, dir, kind)
  board.byDir.set(dir, entity)
  for (const [folder, childKind] of CHILD_FOLDERS[kind]) {
    const names = await subfolders(fs, `${dir}/${folder}`)
    const loaded = await Promise.all(
      names.map(async name => {
        const childDir = `${dir}/${folder}/${name}`
        return (await loadEntity(fs, board, childDir, childKind)) ? childDir : undefined
      }),
    )
    entity.children.push(...loaded.filter((one): one is string => one !== undefined))
  }
  return true
}

/** Reads every `<kind>.yaml` under the board root; children come from folders, never the parent. */
export async function loadBoard(fs: BoardFs, root = ROOT): Promise<Board> {
  const board: Board = { campaigns: [], byDir: new Map() }
  const names = await subfolders(fs, root)
  const loaded = await Promise.all(
    names.map(async name => {
      const dir = `${root}/${name}`
      return (await loadEntity(fs, board, dir, 'campaign')) ? dir : undefined
    }),
  )
  board.campaigns = loaded.filter((one): one is string => one !== undefined)
  return board
}

const byNatural = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' })

function sortDirs(board: Board, dirs: string[], isActiveFirst: boolean): string[] {
  return [...dirs].sort((a, b) => {
    const left = board.byDir.get(a)
    const right = board.byDir.get(b)
    if (!left || !right) return 0
    if (isActiveFirst) {
      const rank = STATUS_ORDER.indexOf(left.status) - STATUS_ORDER.indexOf(right.status)
      if (rank !== 0) return rank
    }
    if (left.kind !== right.kind) return left.kind === 'task' ? -1 : 1
    return byNatural.compare(a.split('/').pop() ?? a, b.split('/').pop() ?? b)
  })
}

function clip(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`
}

/** Children done (or cancelled) out of all; a row with no children shows no count. */
function progressOf(board: Board, entity: Entity): string {
  if (entity.children.length === 0) return ''
  const done = entity.children.filter(dir => {
    const status = board.byDir.get(dir)?.status
    return status === 'done' || status === 'cancelled'
  }).length
  return `${done}/${entity.children.length}`
}

function previewOf(board: Board, entity: Entity, budget: number): Preview {
  const meta: string[] = []
  if (entity.target) meta.push(`target   ${entity.target}`)
  if (entity.role) meta.push(`role     ${entity.role}`)
  if (entity.severity) meta.push(`severity ${entity.severity}`)
  meta.push(`folder   ${entity.dir.replace(`${ROOT}/`, '')}`)
  return {
    kind: entity.kind,
    name: entity.name,
    status: entity.status,
    meta,
    description: clip(entity.description, Math.min(900, budget)),
    criteria: entity.criteria
      .slice(0, 40)
      .map(one => ({ text: clip(one.text, Math.min(260, budget)), done: one.done })),
    children: sortDirs(board, entity.children, false)
      .slice(0, 40)
      .flatMap(dir => {
        const child = board.byDir.get(dir)
        return child ? [{ id: dir, name: clip(child.name, 90), kind: child.kind, status: child.status }] : []
      }),
    notes: clip(entity.notes, Math.min(1400, budget)),
  }
}

/** Resolves the nav path against the board, dropping any folder that no longer exists. */
export function resolvePath(board: Board, path: string[]): string[] {
  const kept: string[] = []
  for (const dir of path) {
    const parent = kept.length === 0 ? undefined : board.byDir.get(kept.at(-1) ?? "")
    const siblings = parent ? parent.children : board.campaigns
    if (!siblings.includes(dir)) break
    kept.push(dir)
  }
  return kept
}

const PROPS_BUDGET = 90_000

/** The Client's props for where the person stands: the listing, each row's preview, the breadcrumb. */
export function buildView(board: Board, nav: Nav, message: Message | null, loadedAt: string): BoardView {
  const path = resolvePath(board, nav.path)
  const here = path.length === 0 ? undefined : board.byDir.get(path.at(-1) ?? "")
  const dirs = here ? sortDirs(board, here.children, here.kind === 'campaign') : sortDirs(board, board.campaigns, true)
  const crumbs = ['board', ...path.map(dir => board.byDir.get(dir)?.name ?? dir)]

  const build = (budget: number): Entry[] => {
    const rows: Entry[] = dirs.flatMap(dir => {
      const entity = board.byDir.get(dir)
      return entity
        ? [
            {
              id: dir,
              kind: entity.kind,
              name: entity.name,
              status: entity.status,
              progress: progressOf(board, entity),
              opens: entity.children.length > 0,
              preview: previewOf(board, entity, budget),
            },
          ]
        : []
    })
    if (here) {
      rows.unshift({
        id: '..',
        kind: 'up',
        name: '..',
        status: 'unknown',
        progress: '',
        opens: false,
        preview: previewOf(board, here, budget),
      })
    }
    return rows
  }

  let budget = 1400
  let entries = build(budget)
  while (JSON.stringify(entries).length > PROPS_BUDGET && budget > 60) {
    budget = Math.floor(budget / 2)
    entries = build(budget)
  }

  return {
    crumbs,
    entries,
    cursorId: nav.cursorId,
    message: message ?? undefined,
    loadedAt,
    totals: totalsLine(summarize(board)),
  }
}

export function summarize(board: Board): Summary {
  const summary: Summary = { executing: 0, awaiting: 0, failed: 0, draft: 0, campaignsOpen: 0 }
  for (const entity of board.byDir.values()) {
    if (entity.kind === 'campaign') {
      if (entity.status !== 'done' && entity.status !== 'cancelled') summary.campaignsOpen += 1
      continue
    }
    if (entity.status === 'executing') summary.executing += 1
    if (entity.status === 'awaitingApproval') summary.awaiting += 1
    if (entity.status === 'failed') summary.failed += 1
    if (entity.status === 'draft') summary.draft += 1
  }
  return summary
}

export function totalsLine(summary: Summary): string {
  const parts = [
    `${summary.campaignsOpen} open campaign${summary.campaignsOpen === 1 ? '' : 's'}`,
    `${summary.executing} executing`,
  ]
  if (summary.awaiting > 0) parts.push(`${summary.awaiting} awaiting approval`)
  if (summary.failed > 0) parts.push(`${summary.failed} failed`)
  parts.push(`${summary.draft} draft`)
  return parts.join(' · ')
}

/** The words `set-status.js` takes for each status. */
export const STATUS_WORD: Record<Exclude<Status, 'unknown'>, string> = {
  draft: 'draft',
  executing: 'executing',
  awaitingApproval: 'awaiting approval',
  done: 'done',
  failed: 'failed',
  cancelled: 'cancelled',
}

/**
 * The argv for `set-status.js`: a campaign sets its own status (parent = itself),
 * every other entity is resolved by name inside its parent's folder.
 */
export function setStatusArgv(board: Board, dir: string, status: Exclude<Status, 'unknown'>, script: string): string[] | undefined {
  const entity = board.byDir.get(dir)
  if (!entity) return undefined
  const parent = entity.kind === 'campaign' ? dir : dir.split('/').slice(0, -2).join('/')
  return ['node', script, parent, entity.name, STATUS_WORD[status]]
}
