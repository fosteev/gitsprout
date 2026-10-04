// Pure checks for messages coming from the webview: the panel never trusts their shape.
import type { FileChange, FileStat, FileStatus } from '../git/types';
import type { Commit, Refs, Status } from '../git/types';
import type { FromWebview, GraphSettings, ToWebview } from './protocol';

const STATUSES: readonly string[] = ['M', 'A', 'D', 'R', 'U'];

/** A repo-relative path from the webview: non-empty, not absolute, no `..` or `.git` segment (git itself never tracks one), no NUL. */
export function isSafeRelPath(p: unknown): p is string {
  return typeof p === 'string' && p.length > 0 && !p.startsWith('/') && !p.startsWith('\\') && !p.includes('\0') && !/(^|[\\/])\.\.([\\/]|$)/.test(p)
    && !/(^|[\\/])\.git([\\/]|$)/i.test(p) && !/^[a-zA-Z]:/.test(p);
}

const isPathOrNull = (p: unknown): p is string | null => p === null || isSafeRelPath(p);
const isStatus = (s: unknown): s is FileStatus => typeof s === 'string' && STATUSES.includes(s);
const isCount = (n: unknown): n is number | null => n === null || (typeof n === 'number' && Number.isFinite(n));

export function asFileStat(f: unknown): FileStat | undefined {
  const o = f as Partial<FileStat> | null;
  if (!o || typeof o !== 'object' || !isSafeRelPath(o.path) || !isPathOrNull(o.origPath) || !isStatus(o.status) || !isCount(o.add) || !isCount(o.del)) return undefined;
  return { path: o.path, origPath: o.origPath, status: o.status, add: o.add, del: o.del };
}

export function asFileChange(f: unknown): FileChange | undefined {
  const o = f as Partial<FileChange> | null;
  if (!o || typeof o !== 'object' || !isSafeRelPath(o.path) || !isPathOrNull(o.origPath) || !isStatus(o.status) || typeof o.untracked !== 'boolean') return undefined;
  return { path: o.path, origPath: o.origPath, status: o.status, untracked: o.untracked };
}

/** A path inside some `.git` folder (also a nested repo's or a submodule's): the working-tree watcher skips it, the registry watches the git dir itself. */
export const inGitDir = (p: string): boolean => /(^|[\\/])\.git([\\/]|$)/.test(p);

/** Longest text the webview may put on the clipboard. */
export const MAX_COPY = 1000;
/** Longest commit summary / description accepted from the webview (UTF-16 code units). */
export const MAX_COMMIT_TEXT = 64 * 1024;
/** Most files one `stage`/`unstage` message may carry. */
export const MAX_FILES = 10000;

const asFileChanges = (a: unknown): FileChange[] | undefined => {
  if (!Array.isArray(a) || a.length > MAX_FILES) return undefined;
  const out: FileChange[] = [];
  for (const x of a) {
    const f = asFileChange(x);
    if (!f) return undefined;
    out.push(f);
  }
  return out;
};
const isText = (s: unknown): s is string => typeof s === 'string' && s.length <= MAX_COMMIT_TEXT;

const isSha = (s: unknown): s is string => typeof s === 'string' && /^[0-9a-f]{7,64}$/.test(s);

/** Narrows an untrusted message to a well-formed `FromWebview`, or undefined. */
export function parseFromWebview(m: unknown): FromWebview | undefined {
  const o = m as { type?: unknown; sha?: unknown; file?: unknown; area?: unknown; files?: unknown; summary?: unknown; description?: unknown; amend?: unknown; push?: unknown; hideCi?: unknown; url?: unknown; text?: unknown } | null;
  if (!o || typeof o !== 'object') return undefined;
  switch (o.type) {
    case 'ready': case 'openScm': case 'switchRepo': case 'refresh':
    case 'stageAll': case 'unstageAll': case 'discardAll': case 'amendInfo': return { type: o.type };
    case 'stage': case 'unstage': {
      const files = asFileChanges(o.files);
      return files && files.length > 0 ? { type: o.type, files } : undefined;
    }
    case 'discard': {
      const file = asFileChange(o.file);
      return file ? { type: 'discard', file } : undefined;
    }
    case 'commit':
      return isText(o.summary) && isText(o.description) && typeof o.amend === 'boolean' && typeof o.push === 'boolean'
        ? { type: 'commit', summary: o.summary, description: o.description, amend: o.amend, push: o.push }
        : undefined;
    case 'select': return isSha(o.sha) ? { type: 'select', sha: o.sha } : undefined;
    case 'openCommitFile': {
      const file = asFileStat(o.file);
      return isSha(o.sha) && file ? { type: 'openCommitFile', sha: o.sha, file } : undefined;
    }
    case 'openWipFile': {
      const file = asFileChange(o.file);
      return file && (o.area === 'staged' || o.area === 'unstaged') ? { type: 'openWipFile', file, area: o.area } : undefined;
    }
    case 'toggleCi': return typeof o.hideCi === 'boolean' ? { type: 'toggleCi', hideCi: o.hideCi } : undefined;
    case 'openUrl': return typeof o.url === 'string' ? { type: 'openUrl', url: o.url } : undefined;
    case 'copy': return typeof o.text === 'string' && o.text.length > 0 && o.text.length <= MAX_COPY ? { type: 'copy', text: o.text } : undefined;
    default: return undefined;
  }
}

/** Only http(s) links under one of the configured Jira bases may leave the webview. */
export function isAllowedUrl(url: string, jira: Record<string, string>): boolean {
  let u: URL;
  try { u = new URL(url); } catch { return false; }
  if ((u.protocol !== 'https:' && u.protocol !== 'http:') || u.username || u.password) return false;
  // Compare parsed URLs, not raw prefixes: a base without a trailing slash must not admit
  // `https://base@evil/` (userinfo) or `https://base.evil/` (host suffix).
  return Object.values(jira).some((base) => {
    if (typeof base !== 'string' || !/^https?:\/\//.test(base)) return false;
    let b: URL;
    try { b = new URL(base); } catch { return false; }
    return u.origin === b.origin && u.href.startsWith(b.href);
  });
}

/** The commit sha a `webview/context` command was invoked for: `{sha}` (the row context) or a bare string. */
export function shaFromArg(arg: unknown): string | undefined {
  if (typeof arg === 'string') return isSha(arg) ? arg : undefined;
  const sha = (arg as { sha?: unknown } | null)?.sha;
  return isSha(sha) ? sha : undefined;
}

export interface HtmlParts { cspSource: string; nonce: string; scriptUri: string; styleUri: string }

/** The webview document: strict CSP (no inline script/style), one script, one stylesheet. */
export function graphHtml(p: HtmlParts): string {
  const csp = `default-src 'none'; style-src ${p.cspSource}; script-src 'nonce-${p.nonce}'; img-src ${p.cspSource} data:; font-src ${p.cspSource};`;
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${p.styleUri}">
<title>Graph</title>
</head>
<body>
<div id="app"></div>
<script nonce="${p.nonce}" src="${p.scriptUri}"></script>
</body>
</html>`;
}

/** The `state` message; `multiRepo` (more than one repo in the window) decides whether the toolbar shows the repo chip. */
export function stateMessage(
  repo: { root: string; name: string }, repoCount: number, refs: Refs, commits: Commit[], wip: Status | null, settings: GraphSettings,
): Extract<ToWebview, { type: 'state' }> {
  return { type: 'state', repo, multiRepo: repoCount > 1, head: refs.head, commits, refs, wip, settings };
}
