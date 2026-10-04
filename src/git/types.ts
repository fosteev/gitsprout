export type ErrorKind = 'NotARepo' | 'GitMissing' | 'PushRejected' | 'NoUpstream' | 'Conflict'
  | 'LocalChanges' | 'NotFullyMerged' | 'Auth' | 'NothingToStash' | 'Cancelled' | 'Other';

export class GitError extends Error {
  constructor(
    public kind: ErrorKind,
    message: string,
    public stderr: string,
    public args: string[],
    /** Extra (not in the original contract): git prints some failures (CONFLICT, "No local changes to save") to stdout. */
    public stdout: string = '',
  ) {
    super(message);
    this.name = 'GitError';
  }
}

/** What one `status --porcelain=v2 --branch` yields; `RepoSummary` adds the workspace-derived identity. */
export interface SummaryStatus {
  branch: string | null; sha: string | null; upstream: string | null;
  ahead: number; behind: number; changes: number;
}
export interface RepoSummary extends SummaryStatus {
  root: string; name: string; relPath: string;
  group: string; // first segment of relPath ('' for a top-level repo)
}
export interface Head { branch: string | null; sha: string | null } // branch null = detached, sha null = unborn
export interface LocalBranch { name: string; sha: string; upstream: string | null; ahead: number; behind: number; upstreamGone: boolean }
export interface RemoteBranch { name: string; sha: string } // "origin/develop"
export interface Tag { name: string; sha: string } // peeled commit sha
export interface Refs { head: Head; locals: LocalBranch[]; remotes: RemoteBranch[]; tags: Tag[] }
export interface Commit { sha: string; parents: string[]; author: string; email: string; time: number; subject: string; body: string }
export type FileStatus = 'M' | 'A' | 'D' | 'R' | 'U';
export interface FileChange { path: string; origPath: string | null; status: FileStatus; untracked: boolean }
export interface Status { staged: FileChange[]; unstaged: FileChange[] }
export interface FileStat { path: string; origPath: string | null; status: FileStatus; add: number | null; del: number | null }
/** A file of a stash; `untracked` = exists only in `stash@{i}^3`. */
export interface StashFile extends FileStat { untracked: boolean }
export interface Stash { index: number; sha: string; message: string }
