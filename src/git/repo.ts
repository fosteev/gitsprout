import { classify, run, type RunOptions, type RunResult } from './run';
import {
  mergeFileStats, parseLog, parseNameStatusZ, parseNumstatZ, parseRefs, parseStashList, parseStatus, parseStatusSummary,
} from './parse';
import {
  GitError, type Commit, type ErrorKind, type FileStat, type Refs, type Stash, type StashFile, type Status, type SummaryStatus,
} from './types';

type Rule = [RegExp, ErrorKind];

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
}
