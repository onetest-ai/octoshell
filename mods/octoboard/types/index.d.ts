export type Kind = 'campaign' | 'mission' | 'task' | 'bug'

export type Status =
  | 'draft'
  | 'executing'
  | 'awaitingApproval'
  | 'done'
  | 'failed'
  | 'cancelled'
  | 'unknown'

export type Criterion = { text: string; done: boolean }

/** One board entity as read from its own `<kind>.yaml`. */
export type Entity = {
  dir: string
  kind: Kind
  name: string
  status: Status
  description: string
  criteria: Criterion[]
  notes: string
  role?: string
  severity?: string
  target?: string
  children: string[]
}

export type ChildLine = { name: string; kind: Kind; status: Status }

/** The right panel's content for the entry under the cursor. */
export type Preview = {
  kind: Kind
  name: string
  status: Status
  meta: string[]
  description: string
  criteria: Criterion[]
  children: ChildLine[]
  notes: string
}

/** One row of the left panel. `id` is the entity's folder; `..` goes up. */
export type Entry = {
  id: string
  kind: Kind | 'up'
  name: string
  status: Status
  progress: string
  preview?: Preview
}

export type Message = { text: string; isError: boolean }

/** Everything the board's Client draws: plain data, sent as its props. */
export type BoardView = {
  crumbs: string[]
  entries: Entry[]
  cursorId?: string
  message?: Message
  loadedAt: string
  totals: string
}

export type Nav = { path: string[]; cursorId?: string }

export type Summary = {
  executing: number
  awaiting: number
  failed: number
  draft: number
  campaignsOpen: number
}

/** What the bottom bar is asking for: browsing, a status pick, a y/n, or the help screen. */
export type Mode = 'browse' | 'status' | 'confirm' | 'help'

export type Pending = { id: string; name: string; status: Exclude<Status, 'unknown'> }

declare module 'claude-code' {
  interface PluginState {
    octoboard: {
      nav: Nav
      summary: Summary | null
      message: Message | null
      revision: number
      mode: Mode
      pending: Pending | null
    }
  }
}
