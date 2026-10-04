import { spawn } from 'node:child_process';
import { GitError, type ErrorKind } from './types';

export interface RunOptions {
  /** Path to the git binary (`git.path` setting); default `git`. */
  gitPath?: string;
  stdin?: string;
  /** Exit codes that are not errors (0 is always ok). */
  okCodes?: number[];
  /** Read-only call: sets GIT_OPTIONAL_LOCKS=0 so we never fight the user's git for index.lock. */
  read?: boolean;
  /** Aborting kills git and everything it spawned (process group); the promise rejects with `GitError('Cancelled')`. */
  signal?: AbortSignal;
  /** Kill git (and its children) after this many ms in total; rejects with an `Other` error that says so. 0/undefined = no limit. */
  timeout?: number;
}
export interface RunResult { stdout: string; stderr: string; code: number }

const MAX_BUFFER = 256 * 1024 * 1024;

/** Variables that relocate the repository (set e.g. when VS Code itself runs inside a git hook); they would override `-C`. */
const REPO_ENV = ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_COMMON_DIR', 'GIT_NAMESPACE', 'GIT_PREFIX'];

export function gitEnv(read: boolean): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, LC_ALL: 'C', GIT_TERMINAL_PROMPT: '0', ...(read ? { GIT_OPTIONAL_LOCKS: '0' } : {}) };
  for (const k of REPO_ENV) delete env[k];
  return env;
}

/** The most telling line of git's output: the last `fatal:`/`error:` line, else the last line that is not a `hint:`. */
export function lastLine(s: string): string {
  const lines = s.split('\n').map((l) => l.trim()).filter(Boolean);
  const err = lines.filter((l) => /^(fatal|error):/.test(l));
  if (err.length) return err[err.length - 1];
  const plain = lines.filter((l) => !l.startsWith('hint:'));
  return plain[plain.length - 1] ?? lines[lines.length - 1] ?? '';
}

/** Generic classification; per-method rules (PushRejected, Conflict, ...) are applied by `Repo`. */
export function classify(stderr: string): ErrorKind {
  const s = stderr.toLowerCase();
  if (s.includes('not a git repository')) return 'NotARepo';
  if (s.includes('permission denied (publickey') || s.includes('host key verification failed') || s.includes('authentication failed') || s.includes('could not read username')) return 'Auth';
  return 'Other';
}

export function run(root: string, args: string[], opts: RunOptions = {}): Promise<RunResult> {
  const full = ['-C', root, '-c', 'core.quotePath=false', ...args];
  const ok = new Set([0, ...(opts.okCodes ?? [])]);
  const bin = opts.gitPath || 'git';
  return new Promise((resolve, reject) => {
    if (opts.signal?.aborted) return reject(new GitError('Cancelled', 'Cancelled', '', full));
    // A killable call gets its own process group (POSIX): `fetch --all`, `pull` and ssh spawn children that would
    // outlive a kill of `git` alone, keep fetching and hold ref locks. (execFile does not pass `detached` to spawn.)
    const group = !!(opts.signal || opts.timeout) && process.platform !== 'win32';
    const child = spawn(bin, full, { env: gitEnv(!!opts.read), detached: group, windowsHide: true });
    let stdout = '';
    let stderr = '';
    let size = 0;
    let stopped: 'abort' | 'timeout' | 'maxBuffer' | undefined;
    let settled = false;

    const kill = (why: 'abort' | 'timeout' | 'maxBuffer'): void => {
      if (stopped || settled) return;
      stopped = why;
      try {
        if (group && child.pid) process.kill(-child.pid, 'SIGTERM');
        else child.kill('SIGTERM');
      } catch { child.kill('SIGTERM'); }
      // Settle even if something in the group ignores SIGTERM and keeps the pipes open.
      child.stdout.destroy();
      child.stderr.destroy();
    };
    const onAbort = (): void => kill('abort');
    opts.signal?.addEventListener('abort', onAbort, { once: true });
    const timer = opts.timeout ? setTimeout(() => kill('timeout'), opts.timeout) : undefined;
    const done = (f: () => void): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      opts.signal?.removeEventListener('abort', onAbort);
      f();
    };

    const collect = (which: 'out' | 'err') => (chunk: string): void => {
      size += Buffer.byteLength(chunk);
      if (size > MAX_BUFFER) { kill('maxBuffer'); return; }
      if (which === 'out') stdout += chunk; else stderr += chunk;
    };
    child.stdout.setEncoding('utf8').on('data', collect('out'));
    child.stderr.setEncoding('utf8').on('data', collect('err'));

    child.on('error', (err: NodeJS.ErrnoException) => done(() => {
      if (err.code === 'ENOENT' || err.code === 'EACCES') {
        reject(new GitError('GitMissing', `git not found or not executable (${bin})`, String(err.message), full, stdout));
      } else {
        reject(new GitError('Other', err.message, stderr, full, stdout));
      }
    }));
    child.on('close', (code: number | null, signal: NodeJS.Signals | null) => done(() => {
      if (stopped === 'abort') return reject(new GitError('Cancelled', 'Cancelled', stderr, full, stdout));
      if (stopped === 'timeout') {
        return reject(new GitError('Other', `git timed out after ${Math.round(opts.timeout! / 1000)} s`, stderr, full, stdout));
      }
      if (stopped === 'maxBuffer') return reject(new GitError('Other', 'git output is too large', stderr, full, stdout));
      if (code === null) return reject(new GitError('Other', `git was killed (${signal ?? 'signal'})`, stderr, full, stdout));
      if (ok.has(code)) return resolve({ stdout, stderr, code });
      const msg = lastLine(stderr) || lastLine(stdout) || `git exited with code ${code}`;
      reject(new GitError(classify(stderr), msg, stderr, full, stdout));
    }));

    // A closed pipe (git exited before reading stdin) must not crash the process.
    child.stdin.on('error', () => {});
    child.stdin.end(opts.stdin ?? '');
  });
}
