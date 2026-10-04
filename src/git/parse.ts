// Pure parsers over git output. No I/O.
import type { Commit, FileChange, FilePatch, FileStat, FileStatus, Head, Hunk, LocalBranch, RemoteBranch, Refs, Stash, Status, SummaryStatus, Tag } from './types';

const nonEmpty = (s: string) => s.length > 0;

/** Text after the n-th space (path fields may contain spaces). */
function afterSpaces(rec: string, n: number): string {
  let idx = -1;
  for (let i = 0; i < n; i++) {
    idx = rec.indexOf(' ', idx + 1);
    if (idx < 0) return '';
  }
  return rec.slice(idx + 1);
}

function letter(c: string): FileStatus {
  switch (c) {
    case 'A': return 'A';
    case 'D': return 'D';
    case 'R': case 'C': return 'R';
    case 'U': return 'U';
    default: return 'M'; // M, T and anything unknown
  }
}

/** `status --porcelain=v2 --branch -z --untracked-files=all` -> branch info + number of entry records. */
export function parseStatusSummary(out: string): SummaryStatus {
  const s: SummaryStatus = { branch: null, sha: null, upstream: null, ahead: 0, behind: 0, changes: 0 };
  const recs = out.split('\0').filter(nonEmpty);
  for (let i = 0; i < recs.length; i++) {
    const r = recs[i];
    if (r.startsWith('# branch.oid ')) {
      const v = r.slice('# branch.oid '.length);
      s.sha = v === '(initial)' ? null : v;
    } else if (r.startsWith('# branch.head ')) {
      const v = r.slice('# branch.head '.length);
      s.branch = v === '(detached)' ? null : v;
    } else if (r.startsWith('# branch.upstream ')) {
      s.upstream = r.slice('# branch.upstream '.length);
    } else if (r.startsWith('# branch.ab ')) {
      const m = /^# branch\.ab \+(\d+) -(\d+)$/.exec(r);
      if (m) { s.ahead = Number(m[1]); s.behind = Number(m[2]); }
    } else if (r.startsWith('# ')) {
      // other headers (branch.* we don't know, stash)
    } else if (r[0] === '2') {
      s.changes++;
      i++; // next record is origPath
    } else if (r[0] === '1' || r[0] === 'u' || r[0] === '?') {
      s.changes++;
    }
  }
  return s;
}

/** `status --porcelain=v2 -z --untracked-files=all` -> staged/unstaged lists. */
export function parseStatus(out: string): Status {
  const staged: FileChange[] = [];
  const unstaged: FileChange[] = [];
  const recs = out.split('\0').filter(nonEmpty);
  for (let i = 0; i < recs.length; i++) {
    const r = recs[i];
    const t = r[0];
    if (t === '1' || t === '2') {
      const x = r[2], y = r[3];
      const path = afterSpaces(r, t === '1' ? 8 : 9);
      const orig = t === '2' ? (recs[++i] ?? null) : null;
      if (x !== '.') {
        const st = letter(x);
        staged.push({ path, origPath: st === 'R' ? orig : null, status: st, untracked: false });
      }
      if (y !== '.') {
        const st = letter(y);
        unstaged.push({ path, origPath: st === 'R' ? orig : null, status: st, untracked: false });
      }
    } else if (t === 'u') {
      unstaged.push({ path: afterSpaces(r, 10), origPath: null, status: 'U', untracked: false });
    } else if (t === '?') {
      unstaged.push({ path: r.slice(2), origPath: null, status: 'A', untracked: true });
    }
    // '!' (ignored) and '#' headers are skipped
  }
  return { staged, unstaged };
}

/** `ahead N, behind M` / `ahead N` / `behind M` / `gone` / ''. */
export function parseTrack(text: string): { ahead: number; behind: number; gone: boolean } {
  const t = text.trim();
  if (t === 'gone') return { ahead: 0, behind: 0, gone: true };
  const a = /ahead (\d+)/.exec(t);
  const b = /behind (\d+)/.exec(t);
  return { ahead: a ? Number(a[1]) : 0, behind: b ? Number(b[1]) : 0, gone: false };
}

/**
 * `for-each-ref --format=%(refname)%00%(objectname)%00%(upstream:short)%00%(upstream:track,nobracket)%00%(*objectname)`
 * over refs/heads, refs/remotes, refs/tags (one record per line). `head` comes from separate calls.
 */
export function parseRefs(out: string, head: Head): Refs {
  const locals: LocalBranch[] = [];
  const remotes: RemoteBranch[] = [];
  const tags: Tag[] = [];
  for (const line of out.split('\n')) {
    if (!line) continue;
    const [ref, sha, upstream = '', track = '', peeled = ''] = line.split('\0');
    if (ref.startsWith('refs/heads/')) {
      const tr = parseTrack(track);
      locals.push({ name: ref.slice('refs/heads/'.length), sha, upstream: upstream || null, ahead: tr.ahead, behind: tr.behind, upstreamGone: tr.gone });
    } else if (ref.startsWith('refs/remotes/')) {
      const name = ref.slice('refs/remotes/'.length);
      if (name.endsWith('/HEAD')) continue;
      remotes.push({ name, sha });
    } else if (ref.startsWith('refs/tags/')) {
      tags.push({ name: ref.slice('refs/tags/'.length), sha: peeled || sha });
    }
  }
  return { head, locals, remotes, tags };
}

/** `log -z --format=%H%x1f%P%x1f%an%x1f%ae%x1f%at%x1f%s%x1f%b` */
export function parseLog(out: string): Commit[] {
  const commits: Commit[] = [];
  for (const rec of out.split('\0')) {
    const r = rec.replace(/^\n+/, '');
    if (!r) continue;
    const f = r.split('\x1f');
    if (f.length < 6) continue;
    commits.push({
      sha: f[0],
      parents: f[1].split(' ').filter(nonEmpty),
      author: f[2],
      email: f[3],
      time: Number(f[4]),
      subject: f[5],
      body: f.slice(6).join('\x1f').replace(/^\n+/, '').trimEnd(),
    });
  }
  return commits;
}

export interface NameStatus { path: string; origPath: string | null; status: FileStatus }

/** `--name-status -z`: `M\0path\0`, `R100\0old\0new\0`. A leading sha record (diff-tree without --no-commit-id) is skipped. */
export function parseNameStatusZ(out: string): NameStatus[] {
  const recs = out.split('\0');
  const res: NameStatus[] = [];
  for (let i = 0; i < recs.length; i++) {
    const code = recs[i];
    if (!/^[A-Z]\d*$/.test(code)) continue;
    const st = letter(code[0]);
    if (code[0] === 'R' || code[0] === 'C') {
      const orig = recs[i + 1], path = recs[i + 2];
      if (path === undefined) break;
      res.push({ path, origPath: orig, status: 'R' });
      i += 2;
    } else {
      const path = recs[i + 1];
      if (path === undefined) break;
      res.push({ path, origPath: null, status: st });
      i += 1;
    }
  }
  return res;
}

export interface Numstat { path: string; origPath: string | null; add: number | null; del: number | null }

/** `--numstat -z`: `add\tdel\tpath\0`, rename `add\tdel\t\0old\0new\0`, binary `-\t-`. */
export function parseNumstatZ(out: string): Numstat[] {
  const recs = out.split('\0');
  const res: Numstat[] = [];
  for (let i = 0; i < recs.length; i++) {
    const m = /^(-|\d+)\t(-|\d+)\t(.*)$/s.exec(recs[i]);
    if (!m) continue;
    const add = m[1] === '-' ? null : Number(m[1]);
    const del = m[2] === '-' ? null : Number(m[2]);
    if (m[3] === '') {
      const orig = recs[i + 1], path = recs[i + 2];
      if (path === undefined) break;
      res.push({ path, origPath: orig, add, del });
      i += 2;
    } else {
      res.push({ path: m[3], origPath: null, add, del });
    }
  }
  return res;
}

/** Joins name-status and numstat by path; files missing from numstat get null counts. */
export function mergeFileStats(names: NameStatus[], nums: Numstat[]): FileStat[] {
  const byPath = new Map(nums.map((n) => [n.path, n]));
  return names.map((n) => {
    const s = byPath.get(n.path);
    return { path: n.path, origPath: n.origPath, status: n.status, add: s?.add ?? null, del: s?.del ?? null };
  });
}

/** `stash list -z --format=%gd%x1f%H%x1f%gs` */
export function parseStashList(out: string): Stash[] {
  const res: Stash[] = [];
  for (const rec of out.split('\0')) {
    const r = rec.replace(/^\n+/, '');
    if (!r) continue;
    const [gd, sha, ...rest] = r.split('\x1f');
    const m = /^stash@\{(\d+)\}$/.exec(gd);
    if (!m || !sha) continue;
    res.push({ index: Number(m[1]), sha, message: rest.join('\x1f') });
  }
  return res;
}

const HUNK_HEADER = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

/**
 * One file's unified diff (`git diff` / `diff-tree -p` output) -> hunks. Lines before the first `@@` are file headers
 * (only checked for the binary markers). Stops after `maxLines` hunk lines and sets `truncated`.
 */
export function parsePatch(text: string, maxLines = 10000): FilePatch {
  const res: FilePatch = { binary: false, hunks: [], truncated: false };
  const lines = text.split('\n');
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  let hunk: Hunk | null = null;
  let oldNo = 0;
  let newNo = 0;
  let count = 0;
  for (const raw of lines) {
    const m = HUNK_HEADER.exec(raw);
    if (m) {
      hunk = { header: raw.replace(/\r$/, ''), oldStart: Number(m[1]), newStart: Number(m[2]), lines: [] };
      res.hunks.push(hunk);
      oldNo = hunk.oldStart;
      newNo = hunk.newStart;
      continue;
    }
    if (!hunk) {
      if (/^Binary files .* differ$/.test(raw) || raw === 'GIT binary patch') res.binary = true;
      continue;
    }
    if (raw.startsWith('\\')) continue; // "\ No newline at end of file"
    const c = raw[0];
    if (c !== ' ' && c !== '+' && c !== '-' && raw !== '') continue; // not part of the hunk
    if (count >= maxLines) { res.truncated = true; break; }
    count++;
    const t = raw.slice(1).replace(/\r$/, '');
    if (c === '+') hunk.lines.push({ kind: '+', text: t, old: null, new: newNo++ });
    else if (c === '-') hunk.lines.push({ kind: '-', text: t, old: oldNo++, new: null });
    else hunk.lines.push({ kind: ' ', text: t, old: oldNo++, new: newNo++ });
  }
  return res;
}
