import { describe, expect, it } from 'vitest';
import { MAX_COMMIT_TEXT, MAX_FILES, parseFromWebview } from '../src/graph/validate';

const F = { path: 'app/widgets/a.php', origPath: null, status: 'M', untracked: false };
const R = { path: 'new.txt', origPath: 'old.txt', status: 'R', untracked: false };
const commit = { type: 'commit', summary: 'Fix it', description: '', amend: false, push: false };

describe('parseFromWebview: WIP messages', () => {
  it('passes the argument-free ones through', () => {
    for (const type of ['stageAll', 'unstageAll', 'discardAll', 'amendInfo'] as const) {
      expect(parseFromWebview({ type })).toEqual({ type });
    }
  });

  it('stage / unstage: a non-empty list of well-formed files', () => {
    expect(parseFromWebview({ type: 'stage', files: [F, R] })).toEqual({ type: 'stage', files: [F, R] });
    expect(parseFromWebview({ type: 'unstage', files: [F] })).toEqual({ type: 'unstage', files: [F] });
    expect(parseFromWebview({ type: 'stage', files: [] })).toBeUndefined();
    expect(parseFromWebview({ type: 'stage' })).toBeUndefined();
    expect(parseFromWebview({ type: 'stage', files: F })).toBeUndefined();
    expect(parseFromWebview({ type: 'unstage', files: [F, { ...F, path: '../x' }] })).toBeUndefined();
    expect(parseFromWebview({ type: 'stage', files: [F, { ...F, status: 'X' }] })).toBeUndefined();
    expect(parseFromWebview({ type: 'stage', files: [{ ...F, untracked: 'no' }] })).toBeUndefined();
    expect(parseFromWebview({ type: 'stage', files: [{ ...R, origPath: '/abs' }] })).toBeUndefined();
    expect(parseFromWebview({ type: 'stage', files: Array.from({ length: MAX_FILES + 1 }, () => F) })).toBeUndefined();
  });

  it('strips unknown fields off files', () => {
    expect(parseFromWebview({ type: 'discard', file: { ...F, evil: 1 } })).toEqual({ type: 'discard', file: F });
  });

  it('discard: one well-formed file', () => {
    expect(parseFromWebview({ type: 'discard', file: R })).toEqual({ type: 'discard', file: R });
    expect(parseFromWebview({ type: 'discard' })).toBeUndefined();
    expect(parseFromWebview({ type: 'discard', file: [F] })).toBeUndefined();
    expect(parseFromWebview({ type: 'discard', file: { ...F, path: '' } })).toBeUndefined();
    expect(parseFromWebview({ type: 'discard', file: { ...F, path: 'a\0b' } })).toBeUndefined();
    for (const path of ['.git/config', 'sub/.git/HEAD', '.GIT/index', 'a\\.git\\x', '.git', '..\\x', '\\x', 'C:x', '/etc/passwd']) {
      expect(parseFromWebview({ type: 'discard', file: { ...F, path } }), path).toBeUndefined();
    }
    for (const path of ['.gitignore', '.github/w.yml', 'a.git/x', 'sub/']) {
      expect(parseFromWebview({ type: 'discard', file: { ...F, path } }), path).toBeDefined();
    }
  });

  it('commit: strings within the cap and both booleans', () => {
    expect(parseFromWebview(commit)).toEqual(commit);
    expect(parseFromWebview({ ...commit, amend: true, push: true, description: 'body' })).toEqual({ ...commit, amend: true, push: true, description: 'body' });
    expect(parseFromWebview({ ...commit, summary: '' })).toEqual({ ...commit, summary: '' }); // emptiness is the action's call
    expect(parseFromWebview({ ...commit, summary: 'x'.repeat(MAX_COMMIT_TEXT) })).toBeDefined();
    expect(parseFromWebview({ ...commit, summary: 'x'.repeat(MAX_COMMIT_TEXT + 1) })).toBeUndefined();
    expect(parseFromWebview({ ...commit, description: 'x'.repeat(MAX_COMMIT_TEXT + 1) })).toBeUndefined();
    expect(parseFromWebview({ ...commit, summary: 5 })).toBeUndefined();
    expect(parseFromWebview({ ...commit, description: null })).toBeUndefined();
    expect(parseFromWebview({ ...commit, amend: 'yes' })).toBeUndefined();
    expect(parseFromWebview({ ...commit, push: undefined })).toBeUndefined();
    expect(parseFromWebview({ type: 'commit' })).toBeUndefined();
  });

  it('ToWebview-only types are not accepted from the webview', () => {
    for (const type of ['wipBusy', 'committed']) expect(parseFromWebview({ type, on: true, sha: 'abcdef1' })).toBeUndefined();
  });
});

describe('inGitDir', () => {
  it('matches paths inside a .git folder only', async () => {
    const { inGitDir } = await import('../src/graph/validate');
    expect(inGitDir('/r/.git/index')).toBe(true);
    expect(inGitDir('/r/.git')).toBe(true);
    expect(inGitDir('/r/sub/.git/HEAD')).toBe(true);
    expect(inGitDir('C:\\r\\.git\\index')).toBe(true);
    expect(inGitDir('/r/.github/x.yml')).toBe(false);
    expect(inGitDir('/r/src/a.git.txt')).toBe(false);
    expect(inGitDir('/r/.gitignore')).toBe(false);
  });
});

describe('parseFromWebview: inline diff requests', () => {
  const sha = 'a'.repeat(40);
  const S = { path: 'a.ts', origPath: null, status: 'M', add: 1, del: 2 };

  it('diffCommitFile: req, sha and a well-formed file', () => {
    expect(parseFromWebview({ type: 'diffCommitFile', req: 3, sha, file: S })).toEqual({ type: 'diffCommitFile', req: 3, sha, file: S });
    for (const req of [0, -1, 1.5, '2', null, undefined, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
      expect(parseFromWebview({ type: 'diffCommitFile', req, sha, file: S }), String(req)).toBeUndefined();
    }
    expect(parseFromWebview({ type: 'diffCommitFile', req: 1, sha: 'zz', file: S })).toBeUndefined();
    expect(parseFromWebview({ type: 'diffCommitFile', req: 1, sha, file: { ...S, path: '../x' } })).toBeUndefined();
    expect(parseFromWebview({ type: 'diffCommitFile', req: 1, sha })).toBeUndefined();
  });

  it('diffWipFile: req, area and a well-formed file', () => {
    expect(parseFromWebview({ type: 'diffWipFile', req: 1, file: F, area: 'staged' })).toEqual({ type: 'diffWipFile', req: 1, file: F, area: 'staged' });
    expect(parseFromWebview({ type: 'diffWipFile', req: 9, file: R, area: 'unstaged' })).toEqual({ type: 'diffWipFile', req: 9, file: R, area: 'unstaged' });
    expect(parseFromWebview({ type: 'diffWipFile', req: 0, file: F, area: 'staged' })).toBeUndefined();
    expect(parseFromWebview({ type: 'diffWipFile', req: 1, file: F, area: 'other' })).toBeUndefined();
    expect(parseFromWebview({ type: 'diffWipFile', req: 1, file: { ...F, path: '.git/config' }, area: 'staged' })).toBeUndefined();
  });
});
