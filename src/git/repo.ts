import { classify, run, type RunOptions, type RunResult } from './run';
import {
  mergeFileStats, parseLog, parseNameStatusZ, parseNumstatZ, parsePatch, parseRefs, parseStashList, parseStatus, parseStatusSummary,
} from './parse';
import type { NameStatus } from './parse';
import { splitMessage } from './message';
import {
  GitError, type Commit, type ErrorKind, type FileChange, type FilePatch, type FileStat, type Refs, type Stash, type StashFile, type Status, type SummaryStatus,
} from './types';

type Rule = [RegExp, ErrorKind];

/** What `Repo.patch` diffs: one file of a commit (against its first parent, null = root), of the index, or of the working tree. */
export type PatchSpec =
  | { kind: 'commit'; sha: string; parent: string | null; path: string; origPath: string | null }
  | { kind: 'staged'; path: string; origPath: string | null }
  | { kind: 'unstaged'; path: string }
  | { kind: 'untracked'; path: string };

const LOCAL_CHANGES: Rule[] = [[/would be overwritten|local changes to the following files|commit your changes or stash/i, 'LocalChanges']];
// Case-sensitive and anchored: branch names like `conflict-fix` or `unmerged-ui` show up in unrelated failures.
const CONFLICT: Rule[] = [[/^CONFLICT \(|Automatic merge failed|you have unmerged files|: needs merge$/m, 'Conflict']];
const PUSH_REJECTED: Rule[] = [[/\[rejected\]/, 'PushRejected']];

/** A fetch running longer than this in total is killed with its children (a dead VPN/remote would otherwise hang the progress forever). */
export const FETCH_TIMEOUT_MS = 300_000;

/** Methods that read: `GIT_OPTIONAL_LOCKS=0`. */
const READ = { read: true } as const;

export class Repo {
  constructor(public readonly root: string, public readonly gitPath: string = 'git') {}

  /**
   * Runs git; a generic `Other` failure is re-classified by the method's rules, matched over stderr + stdout
   * (git prints CONFLICT and friends to stdout).
   */
  private async git(args: string[], opts: RunOptions = {}, rules: Rule[] = []): Promise<RunResult> {
    try {
      return await run(this.root, args, { gitPath: this.gitPath, ...opts });
    } catch (e) {
      if (e instanceof GitError && e.kind === 'Other') {
        const text = `${e.stderr}\n${e.stdout}`;
        for (const [re, kind] of rules) {
          if (re.test(text)) throw new GitError(kind, e.message, e.stderr, e.args, e.stdout);
        }
      }
      throw e;
    }
  }

  // ---- reads ----

  async summary(): Promise<SummaryStatus> {
    const { stdout } = await this.git(['status', '--porcelain=v2', '--branch', '-z', '--untracked-files=all'], READ);
    return parseStatusSummary(stdout);
  }

  async refs(): Promise<Refs> {
    const fmt = '%(refname)%00%(objectname)%00%(upstream:short)%00%(upstream:track,nobracket)%00%(*objectname)';
    const [list, sym, head] = await Promise.all([
      this.git(['for-each-ref', `--format=${fmt}`, 'refs/heads', 'refs/remotes', 'refs/tags'], READ),
      this.git(['symbolic-ref', '-q', '--short', 'HEAD'], { ...READ, okCodes: [1] }),
      this.git(['rev-parse', '-q', '--verify', 'HEAD'], { ...READ, okCodes: [1] }),
    ]);
    return parseRefs(list.stdout, {
      branch: sym.code === 0 ? sym.stdout.trim() || null : null,
      sha: head.code === 0 ? head.stdout.trim() || null : null,
    });
  }

  async log(limit: number): Promise<Commit[]> {
    const head = await this.git(['rev-parse', '-q', '--verify', 'HEAD'], { ...READ, okCodes: [1] });
    const unborn = head.code !== 0;
    const args = ['log', '--branches', '--remotes', '--tags', ...(unborn ? [] : ['HEAD']), '--topo-order', '-n', String(limit), '-z',
      '--format=%H%x1f%P%x1f%an%x1f%ae%x1f%at%x1f%s%x1f%b'];
    const { stdout } = await this.git(args, READ);
    return parseLog(stdout);
  }

  async status(): Promise<Status> {
    const { stdout } = await this.git(['status', '--porcelain=v2', '-z', '--untracked-files=all'], READ);
    return parseStatus(stdout);
  }

  async commitFiles(sha: string): Promise<FileStat[]> {
    const base = ['diff-tree', '-r', '--root', '--no-commit-id', '-M', '-z'];
    const [names, nums] = await Promise.all([
      this.git([...base, '--name-status', sha], READ),
      this.git([...base, '--numstat', sha], READ),
    ]);
    return mergeFileStats(parseNameStatusZ(names.stdout), parseNumstatZ(nums.stdout));
  }

  async stashes(): Promise<Stash[]> {
    const { stdout } = await this.git(['stash', 'list', '-z', '--format=%gd%x1f%H%x1f%gs'], READ);
    return parseStashList(stdout);
  }

  /**
   * Files of a stash. `stash` is an index (`stash@{i}`) or, preferably, the stash commit sha: indexes shift on every
   * push/drop, the sha does not. Untracked files come from `<stash>^3`. git < 2.32 lacks
   * `stash show --include-untracked`; then the tracked list is read without it and the `^3` files are appended as added.
   */
  async stashFiles(stash: number | string): Promise<StashFile[]> {
    const ref = typeof stash === 'number' ? `stash@{${stash}}` : stash;
    const [names, untrackedList] = await Promise.all([
      this.git(['stash', 'show', '--name-status', '-z', '--include-untracked', ref], READ).then(
        (r) => ({ stdout: r.stdout, withUntracked: true }),
        async (e: unknown) => {
          if (!(e instanceof GitError) || !/unknown option|unrecognized argument|usage: git (stash|diff)/i.test(e.stderr)) throw e;
          const r = await this.git(['stash', 'show', '--name-status', '-z', ref], READ);
          return { stdout: r.stdout, withUntracked: false };
        },
      ),
      this.git(['rev-parse', '-q', '--verify', `${ref}^3`], { ...READ, okCodes: [1] }).then(async (third) => {
        if (third.code !== 0) return [] as string[];
        const { stdout } = await this.git(['ls-tree', '-r', '--name-only', '-z', `${ref}^3`], READ);
        return stdout.split('\0').filter(Boolean);
      }),
    ]);
    const untracked = new Set(untrackedList);
    const files: StashFile[] = parseNameStatusZ(names.stdout).map((n) => ({
      path: n.path, origPath: n.origPath, status: n.status, add: null, del: null,
      untracked: untracked.has(n.path),
    }));
    if (!names.withUntracked) {
      for (const path of untrackedList) files.push({ path, origPath: null, status: 'A', add: null, del: null, untracked: true });
    }
    return files;
  }

  /**
   * File content at `ref:path` ('' ref = empty side, ':' = index stage 0; a conflicted file falls back to stage 2, "ours");
   * a missing file/revision yields ''.
   */
  async show(ref: string, path: string): Promise<string> {
    if (ref === '') return '';
    const spec = ref === ':' ? `:0:${path}` : `${ref}:${path}`;
    try {
      return await this.showSpec(spec);
    } catch (e) {
      if (ref === ':' && e instanceof GitError && /but not at stage 0/.test(e.stderr)) {
        return this.showSpec(`:2:${path}`).catch(() => '');
      }
      throw e;
    }
  }

  /** Unified diff of one file as hunks (no color, no external diff tool, rename detection on). */
  async patch(spec: PatchSpec): Promise<FilePatch> {
    const base = ['--no-color', '--no-ext-diff'];
    const paths = (path: string, origPath?: string | null): string[] => ['--', ...(origPath && origPath !== path ? [origPath] : []), path];
    let args: string[];
    let opts: RunOptions = READ;
    switch (spec.kind) {
      case 'commit':
        args = spec.parent === null
          ? ['diff-tree', '-p', '-r', '-M', '--root', '--no-commit-id', ...base, spec.sha, ...paths(spec.path)]
          : ['diff', ...base, '-M', spec.parent, spec.sha, ...paths(spec.path, spec.origPath)];
        break;
      case 'staged': args = ['diff', '--cached', ...base, '-M', ...paths(spec.path, spec.origPath)]; break;
      case 'unstaged': args = ['diff', ...base, ...paths(spec.path)]; break;
      case 'untracked':
        args = ['diff', '--no-index', ...base, '--', '/dev/null', spec.path];
        opts = { ...READ, okCodes: [1] };
        break;
    }
    const { stdout } = await this.git(args, opts);
    return parsePatch(stdout);
  }

  /** Blob id and size at `ref:path` (same spec rules as `show`, stage 0 for the index); `undefined` if there is none. */
  async blobInfo(ref: string, path: string): Promise<{ oid: string; size: number } | undefined> {
    if (ref === '') return undefined;
    const spec = ref === ':' ? `:0:${path}` : `${ref}:${path}`;
    const { stdout } = await this.git(['cat-file', '--batch-check=%(objectname) %(objecttype) %(objectsize)'], { ...READ, stdin: `${spec}\n` });
    const m = /^([0-9a-f]+) blob (\d+)$/.exec(stdout.trim());
    return m ? { oid: m[1], size: Number(m[2]) } : undefined;
  }

  private async showSpec(spec: string): Promise<string> {
    try {
      const { stdout } = await this.git(['show', spec], READ);
      return stdout;
    } catch (e) {
      if (e instanceof GitError && e.kind === 'Other'
        && /does not exist|exists on disk, but not in|bad revision|invalid object name|unknown revision|not in the index|bad object/i.test(e.stderr)) {
        return '';
      }
      throw e;
    }
  }

  // ---- branches ----

  async checkout(name: string): Promise<void> {
    await this.git(['switch', '--end-of-options', name], {}, LOCAL_CHANGES);
  }

  async checkoutRemote(remote: string): Promise<void> {
    const local = remote.slice(remote.indexOf('/') + 1);
    const exists = await this.git(['rev-parse', '-q', '--verify', `refs/heads/${local}`], { ...READ, okCodes: [1] });
    if (exists.code === 0) await this.checkout(local);
    else await this.git(['switch', '--track', '--end-of-options', remote], {}, LOCAL_CHANGES);
  }

  async createBranch(name: string, start: string, checkout: boolean): Promise<void> {
    await this.git(['check-ref-format', '--branch', name], READ).catch((e) => {
      if (e instanceof GitError && e.kind === 'Other') {
        throw new GitError('Other', `'${name}' is not a valid branch name`, e.stderr, e.args, e.stdout);
      }
      throw e;
    });
    // --no-track: a branch started from `origin/main` must not track it, or Push would target `main`
    // (push.default=simple refuses; a forced refspec would push feature work to main). Push publishes it instead.
    // `--end-of-options`: a start ref from the trees may legally start with `-` (a cloned tag `--x`).
    if (checkout) await this.git(['switch', '--no-track', '-c', name, '--end-of-options', start], {}, LOCAL_CHANGES);
    else await this.git(['branch', '--no-track', '--end-of-options', name, start]);
  }

  async renameBranch(oldName: string, newName: string): Promise<void> {
    await this.git(['branch', '-m', '--end-of-options', oldName, newName]);
  }

  async deleteBranch(name: string, force: boolean): Promise<void> {
    await this.git(['branch', force ? '-D' : '-d', '--end-of-options', name], {}, [[/not fully merged/i, 'NotFullyMerged']]);
  }

  // ---- tags ----

  /** Lightweight tag, or annotated with `message`. `--end-of-options`: the name was validated, the sha comes from the graph. */
  async createTag(name: string, sha: string, message?: string): Promise<void> {
    await this.git(['check-ref-format', `refs/tags/${name}`], READ).catch((e) => {
      if (e instanceof GitError && e.kind === 'Other') {
        throw new GitError('Other', `'${name}' is not a valid tag name`, e.stderr, e.args, e.stdout);
      }
      throw e;
    });
    await this.git(['tag', ...(message === undefined ? [] : ['-a', '-m', message]), '--end-of-options', name, sha]);
  }

  async deleteTag(name: string): Promise<void> {
    await this.git(['tag', '-d', '--end-of-options', name]);
  }

  /** Remote for a tag: remote.pushDefault, origin, first remote. */
  private async tagRemote(): Promise<string | null> {
    const { stdout } = await this.git(['remote'], READ);
    const remotes = stdout.split('\n').map((s) => s.trim()).filter(Boolean);
    const dflt = await this.config('remote.pushDefault');
    if (dflt && remotes.includes(dflt)) return dflt;
    return remotes.includes('origin') ? 'origin' : remotes[0] ?? null;
  }

  /** Pushes `refs/tags/<name>`; resolves with the remote used. A rejected tag push is a plain failure (Pull would not help). */
  async pushTag(name: string, opts: { signal?: AbortSignal } = {}): Promise<string> {
    const remote = await this.tagRemote();
    if (!remote) throw new GitError('Other', 'No remote configured', '', ['remote']);
    await this.git(['push', remote, `refs/tags/${name}`], { signal: opts.signal });
    return remote;
  }

  // ---- reset, cherry-pick, revert ----

  /** Current branch name, or null when HEAD is detached. */
  async currentBranch(): Promise<string | null> {
    const r = await this.git(['symbolic-ref', '-q', '--short', 'HEAD'], { ...READ, okCodes: [1] });
    return r.code === 0 ? r.stdout.trim() || null : null;
  }

  /** Moves the current branch to `sha` (hex-validated by the caller). The trailing `--` stops path parsing. */
  async reset(mode: 'soft' | 'mixed' | 'hard', sha: string): Promise<void> {
    await this.git(['reset', `--${mode}`, sha, '--'], {}, LOCAL_CHANGES);
  }

  /** Number of parents of a commit (a merge has more than one). */
  async parentCount(sha: string): Promise<number> {
    const { stdout } = await this.git(['rev-list', '--parents', '-n', '1', sha, '--'], READ);
    return Math.max(0, stdout.trim().split(/\s+/).filter(Boolean).length - 1);
  }

  /** Tracked files that differ between `sha` and the working tree (untracked files are not listed). */
  async diffWithWorktree(sha: string): Promise<NameStatus[]> {
    const { stdout } = await this.git(['diff', '--name-status', '-z', '-M', sha, '--'], READ);
    return parseNameStatusZ(stdout);
  }

  /**
   * `git format-patch -1 --stdout`; empty for a merge commit. Checked up front: format-patch skips merges and would
   * silently emit the next non-merge commit down the history instead.
   */
  async formatPatch(sha: string): Promise<string> {
    if ((await this.parentCount(sha)) > 1) return '';
    const { stdout } = await this.git(['format-patch', '-1', '--stdout', sha, '--'], READ);
    return stdout;
  }

  async commitSubject(sha: string): Promise<string> {
    const { stdout } = await this.git(['log', '-1', '--format=%s', sha, '--'], READ);
    return stdout.trim();
  }

  /** Is the commit reachable from HEAD? */
  async isInHead(sha: string): Promise<boolean> {
    const r = await this.git(['merge-base', '--is-ancestor', sha, 'HEAD'], { ...READ, okCodes: [1] });
    return r.code === 0;
  }

  /**
   * Cherry-picks `sha` (`-m 1` for a merge commit). Resolves `false` when the pick turned out empty (the changes are
   * already there): git stops in a "cherry-pick in progress" state, which is aborted here. Conflicts leave the
   * operation in progress for Source Control and throw kind `Conflict`.
   */
  async cherryPick(sha: string): Promise<boolean> {
    const mainline = (await this.parentCount(sha)) > 1 ? ['-m', '1'] : [];
    try {
      await this.git(['cherry-pick', ...mainline, sha], {}, [...LOCAL_CHANGES, ...CONFLICT]);
      return true;
    } catch (e) {
      if (e instanceof GitError && /previous cherry-pick is now empty/.test(`${e.stderr}\n${e.stdout}`)) {
        await this.git(['cherry-pick', '--abort']);
        return false;
      }
      throw e;
    }
  }

  /**
   * Reverts `sha` with a new commit (`-m 1` for a merge commit). Resolves `false` when there is nothing to revert
   * (the changes are already undone): git exits 1 with "nothing to commit" and leaves no revert in progress.
   */
  async revert(sha: string): Promise<boolean> {
    const mainline = (await this.parentCount(sha)) > 1 ? ['-m', '1'] : [];
    try {
      await this.git(['revert', '--no-edit', ...mainline, sha], {}, [...LOCAL_CHANGES, ...CONFLICT]);
      return true;
    } catch (e) {
      if (e instanceof GitError && e.kind !== 'Conflict' && /nothing to commit/.test(`${e.stderr}\n${e.stdout}`)) return false;
      throw e;
    }
  }

  // ---- remotes and upstream ----

  async remotes(): Promise<string[]> {
    const { stdout } = await this.git(['remote'], READ);
    return stdout.split('\n').map((s) => s.trim()).filter(Boolean);
  }

  async remoteUrl(remote: string): Promise<string | null> {
    const r = await this.git(['remote', 'get-url', '--end-of-options', remote], { ...READ, okCodes: [1, 2, 128] });
    return r.code === 0 ? r.stdout.trim() || null : null;
  }

  /** Remote for web links: the current branch's own remote, `origin`, first remote. */
  async linkRemote(): Promise<string | null> {
    const remotes = await this.remotes();
    const sym = await this.git(['symbolic-ref', '-q', '--short', 'HEAD'], { ...READ, okCodes: [1] });
    const branch = sym.code === 0 ? sym.stdout.trim() : '';
    const own = branch ? await this.config(`branch.${branch}.remote`) : null;
    if (own && remotes.includes(own)) return own;
    return remotes.includes('origin') ? 'origin' : remotes[0] ?? null;
  }

  /** Is the commit reachable from any remote-tracking branch? */
  async isOnRemote(sha: string): Promise<boolean> {
    const { stdout } = await this.git(['branch', '-r', '--contains', sha], READ);
    return stdout.trim() !== '';
  }

  /** `remoteBranch` = `origin/x`; null unsets the upstream. */
  async setUpstream(branch: string, remoteBranch: string | null): Promise<void> {
    if (remoteBranch === null) await this.git(['branch', '--unset-upstream', '--end-of-options', branch]);
    else await this.git(['branch', `--set-upstream-to=${remoteBranch}`, '--end-of-options', branch]);
  }

  // ---- network ----

  /** `signal` kills the running git (rejects with kind `Cancelled`); a stuck fetch is killed after `timeoutMs`. */
  async fetch(opts: { signal?: AbortSignal; timeoutMs?: number } = {}): Promise<void> {
    await this.git(['fetch', '--all', '--prune'], { signal: opts.signal, timeout: opts.timeoutMs ?? FETCH_TIMEOUT_MS });
  }

  /** Short name of the upstream of the current branch, or null (no upstream, detached, unborn). */
  private async upstream(): Promise<string | null> {
    const args = ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'];
    const r = await this.git(args, { ...READ, okCodes: [1, 128] });
    if (r.code === 0) return r.stdout.trim() || null;
    // 128 also covers fatal errors unrelated to the upstream; don't turn those into NoUpstream.
    const kind = classify(r.stderr);
    if (kind !== 'Other') throw new GitError(kind, r.stderr.trim(), r.stderr, args, r.stdout);
    return null;
  }

  private async config(key: string): Promise<string | null> {
    const r = await this.git(['config', '--get', key], { ...READ, okCodes: [1] });
    return r.code === 0 ? r.stdout.trim() || null : null;
  }

  /** Remote to publish `branch` to: branch.<b>.pushRemote, remote.pushDefault, branch.<b>.remote, origin, first remote. */
  private async publishRemote(branch: string): Promise<string | null> {
    const { stdout } = await this.git(['remote'], READ);
    const remotes = stdout.split('\n').map((s) => s.trim()).filter(Boolean);
    const configured = [
      await this.config(`branch.${branch}.pushRemote`),
      await this.config('remote.pushDefault'),
      await this.config(`branch.${branch}.remote`),
    ].find((r) => r && remotes.includes(r));
    return configured ?? (remotes.includes('origin') ? 'origin' : remotes[0] ?? null);
  }

  /** `signal` kills git and its children (fetch + merge); rejects with kind `Cancelled`. */
  async pull(opts: { signal?: AbortSignal } = {}): Promise<void> {
    if (!(await this.upstream())) {
      throw new GitError('NoUpstream', 'The current branch has no upstream branch', '', ['pull']);
    }
    await this.git(['pull', '--no-rebase', '--no-edit'], { signal: opts.signal }, [...CONFLICT, ...LOCAL_CHANGES]);
  }

  /** `signal` kills git and its children (ssh/https helper); rejects with kind `Cancelled`. */
  async push(opts: { signal?: AbortSignal } = {}): Promise<void> {
    if (await this.upstream()) {
      await this.git(['push'], { signal: opts.signal }, PUSH_REJECTED);
      return;
    }
    const sym = await this.git(['symbolic-ref', '-q', '--short', 'HEAD'], { ...READ, okCodes: [1] });
    const branch = sym.code === 0 ? sym.stdout.trim() : '';
    if (!branch) throw new GitError('Other', 'HEAD is detached; check out a branch to push', '', ['symbolic-ref', 'HEAD']);
    const remote = await this.publishRemote(branch);
    if (!remote) throw new GitError('Other', 'No remote configured', '', ['remote']);
    await this.git(['push', '-u', remote, 'HEAD'], { signal: opts.signal }, PUSH_REJECTED);
  }

  // ---- stash ----

  async stashPush(message?: string): Promise<void> {
    const args = ['stash', 'push', '-u', ...(message ? ['-m', message] : [])];
    const r = await this.git(args);
    if (/No local changes to save/i.test(r.stdout) || /No local changes to save/i.test(r.stderr)) {
      throw new GitError('NothingToStash', 'No local changes to save', r.stderr, args, r.stdout);
    }
  }

  async stashApply(i: number): Promise<void> {
    await this.git(['stash', 'apply', `stash@{${i}}`], {}, [...CONFLICT, ...LOCAL_CHANGES]);
  }

  async stashPop(i: number): Promise<void> {
    await this.git(['stash', 'pop', `stash@{${i}}`], {}, [...CONFLICT, ...LOCAL_CHANGES]);
  }

  async stashDrop(i: number): Promise<void> {
    await this.git(['stash', 'drop', `stash@{${i}}`]);
  }

  // ---- WIP: stage, unstage, discard, commit ----

  /**
   * HEAD's message split into summary and description; null on an unborn branch. Used to prefill the amend box.
   */
  async headMessage(): Promise<{ summary: string; description: string } | null> {
    if ((await this.headSha()) === null) return null;
    const { stdout } = await this.git(['log', '-1', '--format=%B', 'HEAD', '--'], READ);
    return splitMessage(stdout);
  }

  /** `add -A` for the files (untracked, deleted and conflicted ones too; for a conflicted file this marks it resolved). */
  async stage(files: FileChange[]): Promise<void> {
    const paths = pathsOf(files);
    if (paths.length) await this.git(['--literal-pathspecs', 'add', '-A', '--', ...paths]);
  }

  async stageAll(): Promise<void> {
    await this.git(['add', '-A']);
  }

  /** `reset -q` for the files; a rename contributes both sides, so both end up unstaged. Works on an unborn branch. */
  async unstage(files: FileChange[]): Promise<void> {
    const paths = pathsOf(files);
    if (paths.length) await this.git(['--literal-pathspecs', 'reset', '-q', '--', ...paths]);
  }

  async unstageAll(): Promise<void> {
    await this.git(['reset', '-q']);
  }

  /**
   * Throws away an unstaged change. Tracked: restores the worktree from the index (a staged part survives).
   * Untracked: deletes the file. Intent-to-add (`git add -N`, unstaged `A`/`R`): drops the index entry and deletes the
   * file (restoring the rename's original). A conflicted (`U`) file and a nested repository (`dir/`) are refused.
   */
  async discard(file: FileChange): Promise<void> {
    if (file.status === 'U') throw new GitError('Other', `Cannot discard a conflicted file: ${file.path}`, '', ['restore', file.path]);
    // `clean -f` without `-ff` silently skips a nested repository; refuse instead of reporting a no-op as success.
    if (file.path.endsWith('/')) throw new GitError('Other', `Cannot discard a nested repository: ${file.path}`, '', ['clean', file.path]);
    if (file.untracked) {
      await this.git(['--literal-pathspecs', 'clean', '-f', '-q', '--', file.path]);
    } else if (file.status === 'A' || file.status === 'R') {
      // The index holds an empty intent-to-add entry: `restore --worktree` would truncate the file to it.
      await this.git(['--literal-pathspecs', 'reset', '-q', '--', file.path]);
      await this.git(['--literal-pathspecs', 'clean', '-f', '-q', '--', file.path]);
      if (file.origPath) await this.git(['--literal-pathspecs', 'restore', '--worktree', '--', file.origPath]);
    } else {
      await this.git(['--literal-pathspecs', 'restore', '--worktree', '--', file.path]);
    }
  }

  /** `reset --hard` + `clean -fd`: staged and unstaged changes go back to HEAD, untracked files are deleted (ignored ones stay). Needs a commit to reset to. */
  async discardAll(): Promise<void> {
    if ((await this.headSha()) === null) {
      throw new GitError('Other', 'Nothing to discard to: the branch has no commits yet.', '', ['reset', '--hard']);
    }
    await this.git(['reset', '--hard', '-q']);
    await this.git(['clean', '-fd', '-q']);
  }

  /**
   * Commits the index with `message` (stdin, so no editor and no argv limits) and returns the new HEAD sha. Hooks run and
   * signing follows the user's config; a failure (hook, nothing to commit, GPG) is an `Other` GitError with git's output
   * kept. `amend` rewrites HEAD. A cancel that lands after the commit was made (e.g. during a slow post-commit hook)
   * counts as success: HEAD has moved, so a retry must not commit or amend again.
   */
  async commit(message: string, opts: { amend: boolean; signal?: AbortSignal }): Promise<string> {
    const before = await this.headSha();
    const args = ['commit', '--cleanup=whitespace', '-F', '-', ...(opts.amend ? ['--amend'] : [])];
    try {
      await this.git(args, { stdin: message, signal: opts.signal });
    } catch (e) {
      const after = e instanceof GitError && e.kind === 'Cancelled' ? await this.headSha() : before;
      if (after === null || after === before) throw e;
      return after;
    }
    const after = await this.headSha();
    if (after === null) throw new GitError('Other', 'HEAD is missing after the commit', '', args);
    return after;
  }

  private async headSha(): Promise<string | null> {
    const r = await this.git(['rev-parse', '-q', '--verify', 'HEAD'], { ...READ, okCodes: [1] });
    return r.code === 0 ? r.stdout.trim() || null : null;
  }
}

/** Paths to act on: each file's path plus, for a rename, its original path; deduplicated. */
function pathsOf(files: FileChange[]): string[] {
  const out = new Set<string>();
  for (const f of files) {
    out.add(f.path);
    if (f.origPath) out.add(f.origPath);
  }
  return [...out];
}
