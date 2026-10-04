import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  ACTION_LABEL, changedFileCount, committedFlash, discardAllConfirm, discardFileConfirm, matchFiles, branchNameError, buildCheckoutEntries, errorPlan, existingBranchNote, localBranchFromArg, localNameOf, refNameFromArg, remoteBranchFromArg,
  resolveStashIndex, rootFromArg, shQuote, stashShaFromArg, tagNameError, terminalCommand, upstreamCandidates,
} from '../src/commands/messages';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { COMMAND_IDS } from '../src/commands/ids';
import { run } from '../src/git/run';
import { GitError } from '../src/git/types';
import type { FileChange, Refs } from '../src/git/types';
import { MAX_COPY, parseFromWebview, stateMessage } from '../src/graph/validate';

const pkg = JSON.parse(readFileSync(join(__dirname, '../package.json'), 'utf8'));
const SHA = 'a'.repeat(40);

describe('branch names', () => {
  it('rejects empty, invalid and existing names like the prototype', () => {
    expect(branchNameError('', [])).toBe('Please provide a branch name');
    for (const bad of ['a b', 'a..b', 'a~1', 'a^', 'a:b', 'a?', 'a*', 'a[b', 'a\\b', '/a', 'a/', 'a//b', 'x.lock', '-x', 'a@{b', 'a.', '@']) {
      expect(branchNameError(bad, []), bad).toMatch(/is not valid/);
    }
    expect(branchNameError('feature/x-1_2', [])).toBe('');
    expect(branchNameError('main', ['main'])).toBe("A branch named 'main' already exists");
    expect(branchNameError('main', ['main'], 'main')).toBe(''); // rename keeps its own name
  });
  it('local name of a remote branch', () => {
    expect([localNameOf('origin/main'), localNameOf('origin/feature/x')]).toEqual(['main', 'feature/x']);
  });
});

describe('tag names and row roots', () => {
  it('validates tag names', () => {
    expect(tagNameError('', [])).toBe('Please provide a tag name');
    for (const bad of ['a b', 'a..b', 'a~1', 'x.lock', '-x', 'a@{b', '@']) expect(tagNameError(bad, []), bad).toMatch(/is not valid/);
    expect(tagNameError('v1.0.0', ['v0.9'])).toBe('');
    expect(tagNameError('v1', ['v1'])).toBe("A tag named 'v1' already exists");
  });
  it('rootFromArg reads the root of a row context only', () => {
    expect(rootFromArg({ webviewSection: 'commit', sha: 'a'.repeat(40), root: '/r' })).toBe('/r');
    expect(rootFromArg({ root: '' })).toBeUndefined();
    expect(rootFromArg({ root: 5 })).toBeUndefined();
    expect(rootFromArg('/r')).toBeUndefined();
    expect(rootFromArg(undefined)).toBeUndefined();
  });
  it('errorPlan: a rejected commit shows git\'s line and Show Command Output; stage/discard stay generic', () => {
    expect(errorPlan({ kind: 'Other', message: 'lint failed' }, 'commit')).toEqual({ text: 'Commit failed: lint failed', level: 'error', actions: ['output'] });
    expect(errorPlan({ kind: 'Cancelled', message: 'Cancelled' }, 'commit')).toBeNull();
    // a hook whose stderr classify() reads as Auth still offers the output
    expect(errorPlan({ kind: 'Auth', message: 'authentication failed' }, 'commit')).toEqual({ text: 'Commit failed: authentication failed', level: 'error', actions: ['output'] });
    for (const op of ['stage', 'unstage', 'discard'] as const) {
      expect(errorPlan({ kind: 'Other', message: 'boom' }, op)).toEqual({ text: `${op[0].toUpperCase()}${op.slice(1)} failed: boom`, level: 'error', actions: [] });
    }
  });
  it('errorPlan: cherry-pick/revert conflicts point to Source Control', () => {
    expect(errorPlan({ kind: 'Conflict', message: 'x' }, 'cherryPick')).toMatchObject({ actions: ['scm'], text: expect.stringContaining('git cherry-pick --abort') });
    expect(errorPlan({ kind: 'Conflict', message: 'x' }, 'revert')).toMatchObject({ actions: ['scm'], text: expect.stringContaining('git revert --abort') });
    expect(errorPlan({ kind: 'Other', message: 'boom' }, 'tag')).toMatchObject({ text: 'Tag failed: boom' });
  });
});

describe('command arguments', () => {
  it('ref names from tree nodes, tags and strings', () => {
    expect(refNameFromArg({ kind: 'branch', branch: { name: 'feature/x' } })).toBe('feature/x');
    expect(refNameFromArg({ kind: 'remoteBranch', ref: { name: 'origin/dev' } })).toBe('origin/dev');
    expect(refNameFromArg({ name: 'v1.0', sha: SHA })).toBe('v1.0');
    expect(refNameFromArg('main')).toBe('main');
    expect(refNameFromArg({ webviewSection: 'commit', sha: SHA })).toBeUndefined(); // graph context -> falls back to the sha
    expect(refNameFromArg(undefined)).toBeUndefined();
  });
  it('typed accessors', () => {
    expect(localBranchFromArg({ kind: 'branch', branch: { name: 'a' } })).toBe('a');
    expect(localBranchFromArg({ kind: 'remoteBranch', ref: { name: 'origin/a' } })).toBeUndefined();
    expect(remoteBranchFromArg({ kind: 'remoteBranch', ref: { name: 'origin/a' } })).toBe('origin/a');
    expect(stashShaFromArg({ kind: 'stash', stash: { sha: SHA } })).toBe(SHA);
    expect(stashShaFromArg({ kind: 'stashFile', stash: { sha: SHA } })).toBe(SHA);
    expect(stashShaFromArg({ kind: 'branch' })).toBeUndefined();
  });
  it('stash index is re-resolved by sha', () => {
    const list = [{ index: 0, sha: 'b' }, { index: 1, sha: 'a' }];
    expect(resolveStashIndex(list, 'a')).toBe(1);
    expect(resolveStashIndex(list, 'zz')).toBeUndefined();
  });
});

describe('checkout quick pick', () => {
  const refs: Refs = {
    head: { branch: 'main', sha: SHA },
    locals: [{ name: 'main', sha: SHA, upstream: null, ahead: 0, behind: 0, upstreamGone: false }, { name: 'dev', sha: 'b'.repeat(40), upstream: null, ahead: 0, behind: 0, upstreamGone: false }],
    remotes: [{ name: 'origin/main', sha: SHA }],
    tags: [{ name: 'v1.9', sha: SHA }, { name: 'v1.10', sha: SHA }],
  };
  it('create, branches (current marked), remote branches, tags newest first', () => {
    const e = buildCheckoutEntries(refs);
    expect(e.map((x) => `${x.kind}:${x.label}`)).toEqual([
      'create:Create new branch…', 'separator:branches', 'local:dev', 'local:main', 'separator:remote branches', 'remote:origin/main', 'separator:tags', 'tag:v1.10', 'tag:v1.9',
    ]);
    expect(e.find((x) => x.label === 'main' && x.kind === 'local')).toMatchObject({ description: 'aaaaaaa · current' });
  });
  it('leaves empty groups out', () => {
    expect(buildCheckoutEntries({ ...refs, remotes: [], tags: [] }).map((x) => x.label)).toEqual(['Create new branch…', 'branches', 'dev', 'main']);
  });
});

describe('errorPlan', () => {
  const E = (kind: Parameters<typeof errorPlan>[0]['kind']) => ({ kind, message: 'msg' });
  it('maps the decided error kinds to actions', () => {
    expect(errorPlan(E('PushRejected'), 'push')?.actions).toEqual(['pull', 'output']);
    expect(errorPlan(E('NoUpstream'), 'pull', 'x')).toMatchObject({ actions: ['publish'], level: 'warn' });
    expect(errorPlan(E('Auth'), 'fetch')?.actions).toEqual(['terminal', 'output']);
    expect(errorPlan(E('Conflict'), 'pull')?.actions).toEqual(['scm', 'output']);
    expect(errorPlan(E('Conflict'), 'pop')?.text).toMatch(/keeps the stash/);
    expect(errorPlan(E('NothingToStash'), 'stash')).toMatchObject({ level: 'info', text: 'There are no changes to stash.' });
    expect(errorPlan(E('Other'), 'rename')?.text).toBe('Rename branch failed: msg');
  });
  it('failed fetch/pull/push offer Show Command Output, other ops and the publish prompt do not', () => {
    for (const op of ['fetch', 'pull', 'push'] as const) {
      expect(errorPlan(E('Other'), op)).toMatchObject({ text: expect.stringMatching(/failed: msg$/), actions: ['output'] });
      expect(errorPlan(E('Conflict'), op)?.actions).toEqual(['scm', 'output']);
    }
    expect(errorPlan(E('Other'), 'checkout')?.actions).toEqual([]);
    expect(errorPlan(E('NoUpstream'), 'push', 'x')?.actions).toEqual(['publish']);
    expect(ACTION_LABEL.output).toBe('Show Command Output');
  });
  it('a cancelled call shows nothing; Auth outside network ops is a plain error', () => {
    expect(errorPlan(E('Cancelled'), 'fetch')).toBeNull();
    expect(errorPlan(E('Auth'), 'checkout')?.actions).toEqual([]);
  });
});

describe('terminal command', () => {
  it('quotes only what needs it and drops the -C/-c prefix', () => {
    expect(shQuote('origin')).toBe('origin');
    expect(shQuote('a b')).toBe("'a b'");
    expect(shQuote("it's")).toBe("'it'\\''s'");
    expect(terminalCommand('git', ['-C', '/r', '-c', 'core.quotePath=false', 'fetch', '--all', '--prune'])).toBe('git fetch --all --prune');
    expect(terminalCommand('git', ['status'])).toBe('git status');
  });
  it('quotes shell metacharacters and a leading = (zsh expands =cmd)', () => {
    for (const w of ['$HOME', 'a;b', '`id`', 'a"b', 'a\nb', '~x', '=ls', '*', 'a|b', '$(id)']) {
      expect(shQuote(w)).toBe(`'${w}'`);
    }
    expect(shQuote('a=b')).toBe('a=b');
    // The quoted word survives a real POSIX shell unchanged.
    for (const w of ["it's", '$(id) `id` ;x', 'a\nb', '=ls', ' lead']) {
      expect(execFileSync('/bin/sh', ['-c', `printf %s ${shQuote(w)}`], { encoding: 'utf8' })).toBe(w);
    }
  });
  it('replays the args of a real failed run() without the -C/-c prefix', async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'gitsprout-term-')));
    try {
      const e = await run(dir, ['push', 'my remote', 'HEAD:$x']).catch((x: unknown) => x);
      expect(e).toBeInstanceOf(GitError);
      expect(terminalCommand('git', (e as GitError).args)).toBe("git push 'my remote' 'HEAD:$x'");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

describe('checkout of a remote branch with an existing local branch', () => {
  it('notes a different upstream or a lagging branch, else stays quiet', () => {
    expect(existingBranchNote({ name: 'x', upstream: 'origin/x', behind: 0 }, 'origin/x')).toBeUndefined();
    expect(existingBranchNote({ name: 'x', upstream: 'origin/x', behind: 2 }, 'origin/x')).toBe("Switched to the existing branch 'x', 2 commits behind 'origin/x'. Pull to update it.");
    expect(existingBranchNote({ name: 'x', upstream: 'fork/x', behind: 0 }, 'origin/x')).toBe("Switched to the existing branch 'x', which tracks 'fork/x', not 'origin/x'.");
    expect(existingBranchNote({ name: 'x', upstream: null, behind: 0 }, 'origin/x')).toBe("Switched to the existing branch 'x', which tracks no remote branch, not 'origin/x'.");
  });
});

describe('graph: copy message and multiRepo flag', () => {
  it('validates the copy message', () => {
    expect(parseFromWebview({ type: 'copy', text: SHA })).toEqual({ type: 'copy', text: SHA });
    expect(parseFromWebview({ type: 'copy', text: '' })).toBeUndefined();
    expect(parseFromWebview({ type: 'copy', text: 'x'.repeat(MAX_COPY + 1) })).toBeUndefined();
    expect(parseFromWebview({ type: 'copy', text: 5 })).toBeUndefined();
    expect(parseFromWebview({ type: 'copy' })).toBeUndefined();
  });
  it('state.multiRepo is true only with more than one repo', () => {
    const refs: Refs = { head: { branch: 'main', sha: SHA }, locals: [], remotes: [], tags: [] };
    const settings = { ciPattern: '', hideCi: false, jira: {}, logLimit: 10 };
    const st = (n: number) => stateMessage({ root: '/r', name: 'r' }, n, refs, [], null, settings);
    expect([st(0).multiRepo, st(1).multiRepo, st(2).multiRepo]).toEqual([false, false, true]);
  });
});

describe('manifest: palette', () => {
  it('hides every command that needs a tree/graph argument', () => {
    const hidden = new Set(pkg.contributes.menus.commandPalette.filter((m: { when: string }) => m.when === 'false').map((m: { command: string }) => m.command));
    for (const id of ['checkoutBranch', 'checkoutRemote', 'createBranchFrom', 'renameBranch', 'deleteBranch', 'stashApply', 'stashPop', 'stashDrop', 'copySha', 'copyMessage', 'copyBranchName', 'copyRepoPath', 'repoShowGraph', 'repoFetch']) {
      expect(hidden.has(`gitsprout.${id}`), id).toBe(true);
      expect(COMMAND_IDS).toContain(id);
    }
  });
  it('the details card has the Copy SHA button', async () => {
    const { commitDetailsHtml } = await import('../webview/render');
    const c = { sha: SHA, parents: [], author: 'a', email: 'a@b', time: 0, subject: 'S', body: '' };
    expect(commitDetailsHtml(c, [], { jira: {}, pills: new Map(), nowMs: 0, known: new Set() })).toContain(`data-copy="${SHA}"`);
  });
});

describe('upstreamCandidates', () => {
  it('same-name first, HEAD skipped, current flagged', () => {
    expect(upstreamCandidates('feat', ['origin/a', 'origin/HEAD', 'fork/feat', 'origin/feat'], 'origin/a')).toEqual([
      { name: 'fork/feat', sameName: true, current: false },
      { name: 'origin/feat', sameName: true, current: false },
      { name: 'origin/a', sameName: false, current: true },
    ]);
  });
});

describe('WIP panel helpers', () => {
  const f = (path: string, o: Partial<FileChange> = {}): FileChange => ({ path, origPath: null, status: 'M', untracked: false, ...o });

  it('matchFiles returns our own entries for the requested ones only', () => {
    const list = [f('a'), f('b'), f('c', { origPath: 'old', status: 'R' })];
    expect(matchFiles([f('b'), f('gone')], list)).toEqual([list[1]]);
    expect(matchFiles([f('c')], list)).toEqual([]); // origPath differs
    expect(matchFiles([f('c', { origPath: 'old', status: 'R' })], list)).toEqual([list[2]]);
    expect(matchFiles([], list)).toEqual([]);
  });

  it('changedFileCount counts a partly staged file once', () => {
    expect(changedFileCount({ staged: [f('a'), f('b')], unstaged: [f('a'), f('c')] })).toBe(3);
    expect(changedFileCount({ staged: [], unstaged: [] })).toBe(0);
  });

  it('discard modal: untracked and intent-to-add rows say the file is deleted', () => {
    expect(discardFileConfirm(f('x.ts'))).toEqual({ text: "Discard changes in 'x.ts'?", detail: "This can't be undone." });
    expect(discardFileConfirm(f('n.ts', { status: 'A', untracked: true })).detail).toBe("The file will be deleted. This can't be undone.");
    expect(discardFileConfirm(f('n.ts', { status: 'A' })).detail).toContain('deleted'); // intent-to-add
    expect(discardFileConfirm(f('n.ts', { status: 'R', origPath: 'o' })).detail).toContain('deleted');
  });

  it('discard all modal and flash', () => {
    expect(discardAllConfirm(1).text).toBe('Discard all changes in 1 file?');
    expect(discardAllConfirm(3).text).toBe('Discard all changes in 3 files?');
    expect(discardAllConfirm(3).detail).toContain('untracked files are deleted');
    expect(committedFlash('abcdef0123456789')).toBe('Committed abcdef0');
  });
});
