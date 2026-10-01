export interface ApprovalIndexEntry {
  slug: string
  revision: number
  mode: 'approve' | 'approve_with_changes' | 'not_yet' | 'approve_to_try'
  comment: string
  at_et: string
}

export function appendApprovalIndex(root: string, approval: ApprovalIndexEntry): void

export function moveTabToInflight(options: {
  pane?: string | null
  revision: number
  herdr?: string
  herdrLane?: string
}): Promise<void>

export function createLivedocApprovals(options?: {
  root?: string
  stateFile?: string
  livedoc?: string
  herdr?: string
  herdrLane?: string
}): {
  tick(): Promise<void>
  start(ms: number): void
  stop(): void
}
