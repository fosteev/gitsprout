// Which branch a commit was made on. Git does not record it, so it is inferred (pure, unit-tested):
// every ref claims the commits on its first-parent chain, long-lived branches first; a merge's second-parent chain that no
// ref claims takes the branch name from the merge subject ("Merge branch 'x'", "Merge pull request #1 from o/x").
import type { Commit, Head, Refs } from '../src/git/types';

/** `via: 'merge'` = the branch is gone, its name comes from the merge subject (`name` null = the subject does not say). */
export type Owner = { name: string; via: 'ref' } | { name: string | null; via: 'merge'; into: string };

const TRUNKS = ['main', 'master', 'develop', 'development', 'dev', 'trunk'];

/** The merged branch named by a merge commit's subject (git, GitHub, GitLab, Bitbucket formats); null = not a known form. */
export function mergedBranch(subject: string): string | null {
  let m = /^Merge (?:remote-tracking )?branch '([^']+)'/.exec(subject);
  if (m) return m[1];
  m = /^Merge pull request #\d+ from [^/\s]+\/(\S+)/.exec(subject);
  if (m) return m[1];
  m = /^Merged in (\S+) \(pull request #\d+\)/.exec(subject);
  return m ? m[1] : null;
}

/** Owner of every commit in `commits` (topo order: children before parents). */
export function branchOwners(commits: readonly Commit[], refs: Refs, head: Head): Map<string, Owner> {
  const bySha = new Map(commits.map((c) => [c.sha, c]));
  const pos = new Map(commits.map((c, i) => [c.sha, i]));
  const owners = new Map<string, Owner>();
  const claim = (sha: string | undefined, o: Owner): void => {
    while (sha && !owners.has(sha) && bySha.has(sha)) {
      owners.set(sha, o);
      sha = bySha.get(sha)?.parents[0];
    }
  };
  // Trunks first (local before remote: commits only on origin/main read "origin/main"), then the other branches with
  // the oldest tip first (a branch forked from another one leaves the shared commits to it), then tags and a detached HEAD.
  const trunk = (remote: string): number => TRUNKS.indexOf(remote.slice(remote.indexOf('/') + 1));
  const seeds = [
    ...refs.locals.map((b) => ({ name: b.name, sha: b.sha, rank: TRUNKS.indexOf(b.name), remote: 0 })),
    ...refs.remotes.map((b) => ({ name: b.name, sha: b.sha, rank: trunk(b.name), remote: 1 })),
  ];
  const tipAge = (sha: string): number => -(pos.get(sha) ?? -1);
  seeds.sort((a, b) => (a.rank < 0 ? 99 : a.rank) - (b.rank < 0 ? 99 : b.rank)
    || (a.rank >= 0 ? a.remote - b.remote : tipAge(a.sha) - tipAge(b.sha) || a.remote - b.remote));
  for (const s of seeds) claim(s.sha, { name: s.name, via: 'ref' });
  for (const t of refs.tags) claim(t.sha, { name: t.name, via: 'ref' });
  if (head.sha) claim(head.sha, { name: 'HEAD', via: 'ref' });
  for (const c of commits) {
    const o = owners.get(c.sha);
    if (!o || c.parents.length < 2) continue;
    const name = mergedBranch(c.subject);
    const into = o.via === 'ref' ? o.name : o.name ?? o.into;
    for (const p of c.parents.slice(1)) claim(p, { name, via: 'merge', into });
  }
  return owners;
}

/** Child shas of every commit, for `containedIn`. */
export function childrenOf(commits: readonly Commit[]): Map<string, string[]> {
  const m = new Map<string, string[]>();
  for (const c of commits) for (const p of c.parents) { const l = m.get(p); if (l) l.push(c.sha); else m.set(p, [c.sha]); }
  return m;
}

/** Branches (local, then remote) whose tip has `sha` in its history, within the loaded commits. */
export function containedIn(sha: string, children: ReadonlyMap<string, string[]>, refs: Refs): string[] {
  const seen = new Set([sha]);
  const stack = [sha];
  while (stack.length) for (const ch of children.get(stack.pop() as string) ?? []) if (!seen.has(ch)) { seen.add(ch); stack.push(ch); }
  return [...refs.locals, ...refs.remotes].filter((b) => seen.has(b.sha)).map((b) => b.name);
}
