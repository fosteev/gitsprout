import { describe, expect, it } from 'vitest';
import { branchLink, commitLink, splitRemoteRef, webBase } from '../src/git/remoteUrl';

describe('webBase', () => {
  it.each([
    ['https://github.com/g/r.git', 'https://github.com/g/r', 'github'],
    ['https://github.com/g/r', 'https://github.com/g/r', 'github'],
    ['http://git.example.com/g/r.git', 'http://git.example.com/g/r', 'gitlab'],
    ['git@github.com:g/r.git', 'https://github.com/g/r', 'github'],
    ['git@gitlab.pilot-gps.com:g/sub/r.git', 'https://gitlab.pilot-gps.com/g/sub/r', 'gitlab'],
    ['ssh://git@gitlab.pilot-gps.com:2222/g/sub/r.git', 'https://gitlab.pilot-gps.com/g/sub/r', 'gitlab'],
    ['ssh://git@bitbucket.org/g/r.git', 'https://bitbucket.org/g/r', 'bitbucket'],
    ['https://user:secret@bitbucket.org/g/r.git', 'https://bitbucket.org/g/r', 'bitbucket'],
    ['https://oauth2:tok@gitlab.example.com/g/sub/r.git/', 'https://gitlab.example.com/g/sub/r', 'gitlab'],
    ['https://github.mycorp.com/g/r.git', 'https://github.mycorp.com/g/r', 'github'],
    ['https://git.example.com:8443/g/r.git', 'https://git.example.com:8443/g/r', 'gitlab'],
    ['ssh://github.com/g/r', 'https://github.com/g/r', 'github'],
  ])('%s', (url, base, host) => {
    expect(webBase(url)).toEqual({ base, host });
  });

  it('rejects what is not a hosted repo', () => {
    expect(webBase('/srv/git/r.git')).toBeUndefined();
    expect(webBase('file:///srv/git/r.git')).toBeUndefined();
    expect(webBase('../r')).toBeUndefined();
    expect(webBase('')).toBeUndefined();
  });
});

describe('links', () => {
  const gh = { base: 'https://github.com/g/r', host: 'github' as const };
  const gl = { base: 'https://gl.example.com/g/sub/r', host: 'gitlab' as const };
  const bb = { base: 'https://bitbucket.org/g/r', host: 'bitbucket' as const };
  it('commit', () => {
    expect(commitLink(gh, 'abc123')).toBe('https://github.com/g/r/commit/abc123');
    expect(commitLink(gl, 'abc123')).toBe('https://gl.example.com/g/sub/r/-/commit/abc123');
    expect(commitLink(bb, 'abc123')).toBe('https://bitbucket.org/g/r/commits/abc123');
  });
  it('branch: segments are encoded, slashes kept', () => {
    expect(branchLink(gh, 'feature/a b#1')).toBe('https://github.com/g/r/tree/feature/a%20b%231');
    expect(branchLink(gl, 'main')).toBe('https://gl.example.com/g/sub/r/-/tree/main');
    expect(branchLink(bb, 'fix/x')).toBe('https://bitbucket.org/g/r/branch/fix/x');
  });
});

describe('splitRemoteRef', () => {
  it('splits on the longest matching remote', () => {
    expect(splitRemoteRef('origin/feature/x', ['origin'])).toEqual({ remote: 'origin', branch: 'feature/x' });
    expect(splitRemoteRef('team/fork/x', ['team', 'team/fork'])).toEqual({ remote: 'team/fork', branch: 'x' });
    expect(splitRemoteRef('nope/x', ['origin'])).toBeUndefined();
    expect(splitRemoteRef('origin/', ['origin'])).toBeUndefined();
  });
});
