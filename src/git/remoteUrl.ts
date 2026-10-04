// Remote URL -> web links. Pure: no `vscode`, no git.

export type WebHost = 'github' | 'gitlab' | 'bitbucket';
export interface WebBase { base: string; host: WebHost }

/** GitHub (`github.com` or a host containing `github`), Bitbucket (`bitbucket.org`), anything else is treated as GitLab. */
function hostKind(host: string): WebHost {
  const h = host.toLowerCase();
  if (h.includes('github')) return 'github';
  if (h === 'bitbucket.org') return 'bitbucket';
  return 'gitlab';
}

/**
 * Web base of a remote URL (`https://host/group/repo`), or undefined for forms that are not a hosted repo
 * (local paths, `file://`). ssh ports and credentials are dropped; http(s) keeps its scheme and port.
 */
export function webBase(remoteUrl: string): WebBase | undefined {
  const url = remoteUrl.trim();
  let scheme = 'https';
  let host: string;
  let path: string;
  const m = /^([a-z][a-z0-9+.-]*):\/\/(?:[^/@]*@)?(\[[^\]]+\]|[^/:]+)(?::(\d+))?\/(.+)$/i.exec(url);
  if (m) {
    const proto = m[1].toLowerCase();
    if (proto === 'file') return undefined;
    const web = proto === 'http' || proto === 'https';
    if (proto === 'http') scheme = 'http';
    host = web && m[3] ? `${m[2]}:${m[3]}` : m[2];
    path = m[4];
  } else {
    const s = /^(?:[^@/\s]+@)?([^:/\s]+):(?!\/)(.+)$/.exec(url); // scp-like: git@host:group/repo.git
    if (!s) return undefined;
    host = s[1];
    path = s[2];
  }
  path = path.replace(/[?#].*$/, '').replace(/\/+$/, '').replace(/\.git$/, '').replace(/^\/+/, '');
  if (!host || !path) return undefined;
  return { base: `${scheme}://${host}/${path}`, host: hostKind(host.replace(/:\d+$/, '')) };
}

const seg = (s: string): string => s.split('/').map(encodeURIComponent).join('/');

export function commitLink(b: WebBase, sha: string): string {
  const mid = b.host === 'github' ? 'commit' : b.host === 'bitbucket' ? 'commits' : '-/commit';
  return `${b.base}/${mid}/${seg(sha)}`;
}

export function branchLink(b: WebBase, branch: string): string {
  const mid = b.host === 'github' ? 'tree' : b.host === 'bitbucket' ? 'branch' : '-/tree';
  return `${b.base}/${mid}/${seg(branch)}`;
}

/** `origin/feature/x` -> `{ remote: 'origin', branch: 'feature/x' }` against the repo's remotes (longest remote name wins). */
export function splitRemoteRef(ref: string, remotes: readonly string[]): { remote: string; branch: string } | undefined {
  const r = [...remotes].sort((a, b) => b.length - a.length).find((x) => ref.startsWith(`${x}/`) && ref.length > x.length + 1);
  return r ? { remote: r, branch: ref.slice(r.length + 1) } : undefined;
}
