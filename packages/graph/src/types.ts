/** One commit reduced to what co-change analysis needs. */
export interface Commit {
  sha: string;
  files: string[];
  /** Author timestamp, epoch milliseconds. */
  timestamp: number;
}
