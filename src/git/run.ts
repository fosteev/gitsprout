import { execFile } from 'node:child_process';
import { GitError, type ErrorKind } from './types';

export interface RunOptions {
  /** Path to the git binary (`git.path` setting); default `git`. */
  gitPath?: string;
  stdin?: string;
  /** Exit codes that are not errors (0 is always ok). */
  okCodes?: number[];
  /** Read-only call: sets GIT_OPTIONAL_LOCKS=0 so we never fight the user's git for index.lock. */
  read?: boolean;
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
  return new Promise((resolve, reject) => {
    const child = execFile(
      opts.gitPath || 'git', full,
      { env: gitEnv(!!opts.read), maxBuffer: MAX_BUFFER, encoding: 'utf8' },
      (err, stdout, stderr) => {
        if (!err) return resolve({ stdout, stderr, code: 0 });
        const e = err as NodeJS.ErrnoException & { code?: number | string };
        if (e.code === 'ENOENT' || e.code === 'EACCES') {
          return reject(new GitError('GitMissing', `git not found or not executable (${opts.gitPath || 'git'})`, String(e.message), full, stdout));
        }
        if (typeof e.code === 'number') {
          if (ok.has(e.code)) return resolve({ stdout, stderr, code: e.code });
          const msg = lastLine(stderr) || lastLine(stdout) || `git exited with code ${e.code}`;
          return reject(new GitError(classify(stderr), msg, stderr, full, stdout));
        }
        reject(new GitError('Other', e.message, stderr ?? '', full, stdout ?? ''));
      },
    );
    // A closed pipe (git exited before reading stdin) must not crash the process.
    child.stdin?.on('error', () => {});
    child.stdin?.end(opts.stdin ?? '');
  });
}
