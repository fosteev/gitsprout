// Pure helpers behind the mutation commands (no `vscode` import, unit-tested): wording ported from the prototype
// (`doPull`, `doPush`, `branchNameError`, delete/stash dialogs), error -> notification mapping, quick pick contents.
import type { ErrorKind, LocalBranch, Refs, Stash, SummaryStatus } from '../git/types';

const plural = (n: number, one: string, many: string): string => (n === 1 ? one : many);
export const commits = (n: number): string => `${n} ${plural(n, 'commit', 'commits')}`;

// ---- branch names ----

/** Validation message for the branch-name input box ('' = ok). `except` = the name being renamed. Final word is `git check-ref-format`. */
export function branchNameError(name: string, existing: readonly string[], except?: string): string {
  if (!name) return 'Please provide a branch name';
  if (/\s|\.\.|[~^:?*[\\]|@\{|^\/|\/$|\/\/|\.lock$|\.$|^-|^@$/.test(name)) return `Branch name '${name}' is not valid`;
  if (name !== except && existing.includes(name)) return `A branch named '${name}' already exists`;
  return '';
}

/** Same for the tag-name input box; the final word is `git check-ref-format refs/tags/<name>`. */
export function tagNameError(name: string, existing: readonly string[]): string {
  if (!name) return 'Please provide a tag name';
  if (/\s|\.\.|[~^:?*[\\]|@\{|^\/|\/$|\/\/|\.lock$|\.$|^-|^@$/.test(name)) return `Tag name '${name}' is not valid`;
  if (existing.includes(name)) return `A tag named '${name}' already exists`;
  return '';
}

/** `origin/feature/x` -> `feature/x`. */
export const localNameOf = (remote: string): string => remote.slice(remote.indexOf('/') + 1);

export const shortSha = (sha: string): string => sha.slice(0, 7);

// ---- reset / cherry-pick / revert texts ----

export type ResetMode = 'soft' | 'mixed' | 'hard';
export const RESET_NEEDS_BRANCH = 'Gitsprout: Reset needs a branch checked out.';
export const resetConfirm = (branch: string, sha: string): string => `Reset '${branch}' to ${shortSha(sha)}? Uncommitted changes will be lost.`;
export const resetDone = (branch: string, sha: string, mode: ResetMode): string => `Reset '${branch}' to ${shortSha(sha)} (${mode}).`;
export const cherryPickDone = (branch: string, sha: string): string => `Cherry-picked ${shortSha(sha)} onto '${branch}'.`;
export const cherryPickHave = (branch: string, sha: string): string => `${shortSha(sha)} is already in '${branch}'.`;
export const cherryPickEmpty = (branch: string): string => `Nothing to cherry-pick: the changes are already in '${branch}'.`;
export const revertDone = (branch: string, sha: string): string => `Reverted ${shortSha(sha)} on '${branch}'.`;
export const revertEmpty = (branch: string, sha: string): string => `Nothing to revert: the changes of ${shortSha(sha)} are already undone on '${branch}'.`;

// ---- command arguments ----

/** What a tree node / graph context / bare string stands for as a ref name: branch, remote branch or tag. */
export function refNameFromArg(arg: unknown): string | undefined {
  if (typeof arg === 'string') return arg || undefined;
  const a = arg as { kind?: string; branch?: { name?: string }; ref?: { name?: string }; name?: string } | null;
  if (!a || typeof a !== 'object') return undefined;
  if (a.kind === 'branch') return a.branch?.name;
  if (a.kind === 'remoteBranch') return a.ref?.name;
  if (a.kind === undefined && typeof a.name === 'string') return a.name; // a Tag
  return undefined;
}

/** Repo root of a graph row context (`{ sha, root, … }`); undefined for anything else (tree nodes, strings). */
export function rootFromArg(arg: unknown): string | undefined {
  const root = (arg as { root?: unknown } | null)?.root;
  return typeof root === 'string' && root ? root : undefined;
}

/** Local branch name from a branches-tree leaf or a string. */
export function localBranchFromArg(arg: unknown): string | undefined {
  if (typeof arg === 'string') return arg || undefined;
  const a = arg as { kind?: string; branch?: { name?: string } } | null;
  return a?.kind === 'branch' ? a.branch?.name : undefined;
}

/** Remote branch name (`origin/x`) from a remotes-tree leaf or a string. */
export function remoteBranchFromArg(arg: unknown): string | undefined {
  if (typeof arg === 'string') return arg || undefined;
  const a = arg as { kind?: string; ref?: { name?: string } } | null;
  return a?.kind === 'remoteBranch' ? a.ref?.name : undefined;
}

/** The stash commit sha from a stash / stash-file node (indexes shift, shas do not). */
export function stashShaFromArg(arg: unknown): string | undefined {
  const a = arg as { kind?: string; stash?: { sha?: string } } | null;
  return (a?.kind === 'stash' || a?.kind === 'stashFile') ? a.stash?.sha : undefined;
}

/** Index of the stash with this sha right now, or undefined when it is gone. */
export function resolveStashIndex(stashes: readonly Pick<Stash, 'index' | 'sha'>[], sha: string): number | undefined {
  return stashes.find((s) => s.sha === sha)?.index;
}

// ---- set upstream quick pick ----

/** Remote branches for the Set Upstream pick: same-name ones first, then alphabetical; the current upstream is flagged. */
export function upstreamCandidates(branch: string, remotes: readonly string[], current: string | null): { name: string; sameName: boolean; current: boolean }[] {
  return remotes
    .filter((r) => !r.endsWith('/HEAD'))
    .map((name) => ({ name, sameName: name.slice(name.indexOf('/') + 1) === branch, current: name === current }))
    .sort((a, b) => Number(b.sameName) - Number(a.sameName) || a.name.localeCompare(b.name));
}

// ---- checkout quick pick ----

export type CheckoutEntry =
  | { kind: 'create'; label: string }
  | { kind: 'separator'; label: string }
  | { kind: 'local'; label: string; description: string; name: string }
  | { kind: 'remote'; label: string; description: string; name: string }
  | { kind: 'tag'; label: string; description: string; name: string };

/** Prototype `qp-checkout`: create new, branches (current marked), remote branches, tags. Empty groups are left out. */
export function buildCheckoutEntries(refs: Pick<Refs, 'head' | 'locals' | 'remotes' | 'tags'>): CheckoutEntry[] {
  const locals = [...refs.locals].sort((a, b) => a.name.localeCompare(b.name));
  const remotes = [...refs.remotes].sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
  const tags = [...refs.tags].sort((a, b) => b.name.localeCompare(a.name, undefined, { numeric: true }));
  const out: CheckoutEntry[] = [{ kind: 'create', label: 'Create new branch…' }];
  if (locals.length) {
    out.push({ kind: 'separator', label: 'branches' });
    for (const b of locals) {
      out.push({ kind: 'local', label: b.name, name: b.name, description: `${shortSha(b.sha)}${b.name === refs.head.branch ? ' · current' : ''}` });
    }
  }
  if (remotes.length) {
    out.push({ kind: 'separator', label: 'remote branches' });
    for (const r of remotes) out.push({ kind: 'remote', label: r.name, name: r.name, description: `Remote branch at ${shortSha(r.sha)}` });
  }
  if (tags.length) {
    out.push({ kind: 'separator', label: 'tags' });
    for (const t of tags) out.push({ kind: 'tag', label: t.name, name: t.name, description: `Tag at ${shortSha(t.sha)}` });
  }
  return out;
}

export const TAG_CHECKOUT_MESSAGE = "Checking out a tag leaves you in detached HEAD, which Gitsprout doesn't support yet. Create a branch from the tag instead (right-click the tag).";

/**
 * Checking out `origin/x` when a local `x` already exists switches to that branch as it is; say so when it is not
 * simply `origin/x`'s branch (tracks something else) or lags behind it. undefined = nothing worth a notification.
 */
export function existingBranchNote(b: Pick<LocalBranch, 'name' | 'upstream' | 'behind'>, remote: string): string | undefined {
  if (b.upstream !== remote) return `Switched to the existing branch '${b.name}', which ${b.upstream ? `tracks '${b.upstream}'` : 'tracks no remote branch'}, not '${remote}'.`;
  if (b.behind) return `Switched to the existing branch '${b.name}', ${commits(b.behind)} behind '${remote}'. Pull to update it.`;
  return undefined;
}

// ---- delete dialog ----

/** Detail line of the "delete branch" modal (prototype `delete`): what happens to unpushed commits. */
export function deleteDetail(b: Pick<LocalBranch, 'upstream' | 'upstreamGone' | 'ahead'>): string {
  if (!b.upstream) return 'This branch was never pushed. Its commits will only be reachable through the reflog.';
  if (b.upstreamGone) return `${b.upstream} no longer exists on the server. Unpushed commits will only be reachable through the reflog.`;
  if (b.ahead) return `${commits(b.ahead)} ${b.ahead === 1 ? 'is' : 'are'} not pushed to ${b.upstream}. They will only be reachable through the reflog.`;
  return `${b.upstream} stays on the server.`;
}

// ---- pull / push results ----

type Sum = Pick<SummaryStatus, 'branch' | 'upstream' | 'ahead' | 'behind'>;

/**
 * Notification after a successful pull. `before.behind` is only as fresh as the last fetch (pull fetches itself),
 * so the outcome is read from HEAD: unchanged = up to date; no local commits = fast-forward; otherwise a merge.
 */
export function pullMessage(before: Sum & Pick<SummaryStatus, 'sha'>, after: Pick<SummaryStatus, 'sha'>): string {
  const b = before.branch ?? 'HEAD';
  if (before.sha === after.sha) return 'Already up to date.';
  if (!before.ahead) return `Fast-forwarded '${b}'${after.sha ? ` to ${shortSha(after.sha)}` : ''}.`;
  return `Branches had diverged. Merged ${before.upstream ?? 'the remote branch'} into '${b}'.`;
}

/** Notification after a successful push; `after` is only needed for a first push (the new upstream). */
export function pushMessage(before: Sum, after: Pick<SummaryStatus, 'upstream'>): string {
  const b = before.branch ?? 'HEAD';
  if (!before.upstream) return `Published '${b}' to ${after.upstream ?? 'the remote'}.`;
  if (!before.ahead) return 'Everything up-to-date.';
  return `Pushed ${commits(before.ahead)} to ${before.upstream}.`;
}

// ---- error -> notification ----

export type Op = 'fetch' | 'pull' | 'push' | 'checkout' | 'create' | 'rename' | 'delete' | 'stash' | 'apply' | 'pop' | 'drop'
  | 'tag' | 'reset' | 'cherryPick' | 'revert' | 'upstream';
export type ActionId = 'pull' | 'publish' | 'terminal' | 'scm' | 'stash' | 'output';
export interface ErrorPlan { text: string; level: 'error' | 'warn' | 'info'; actions: ActionId[] }

export const ACTION_LABEL: Record<ActionId, string> = {
  pull: 'Pull', publish: 'Publish Branch', terminal: 'Run in Terminal', scm: 'Open Source Control', stash: 'Stash Changes', output: 'Show Command Output',
};

const OP_WORD: Record<Op, string> = {
  fetch: 'Fetch', pull: 'Pull', push: 'Push', checkout: 'Checkout', create: 'Create branch', rename: 'Rename branch',
  delete: 'Delete branch', stash: 'Stash', apply: 'Apply stash', pop: 'Pop stash', drop: 'Drop stash',
  tag: 'Tag', reset: 'Reset', cherryPick: 'Cherry pick', revert: 'Revert', upstream: 'Set upstream',
};
const NETWORK: readonly Op[] = ['fetch', 'pull', 'push'];

/**
 * How a failed git call is shown. null = nothing to show (cancelled by the user). PushRejected -> Pull,
 * NoUpstream -> Publish Branch, Auth -> Run in Terminal, Conflict -> Open Source Control (roadmap, "Decisions").
 */
export function errorPlan(e: { kind: ErrorKind; message: string }, op: Op, branch?: string | null): ErrorPlan | null {
  const plan = basePlan(e, op, branch);
  // Failed fetch/pull/push: the full git output (stderr) is in the `Gitsprout` channel. Not for the publish prompt (not a failure to read).
  if (plan && NETWORK.includes(op) && e.kind !== 'NoUpstream') plan.actions.push('output');
  return plan;
}

function basePlan(e: { kind: ErrorKind; message: string }, op: Op, branch?: string | null): ErrorPlan | null {
  switch (e.kind) {
    case 'Cancelled': return null;
    case 'PushRejected':
      return { text: "Can't push refs to remote. Try running 'Pull' first to integrate your changes.", level: 'error', actions: ['pull'] };
    case 'NoUpstream':
      return { text: `The branch '${branch ?? 'HEAD'}' has no remote branch. Would you like to publish it?`, level: 'warn', actions: ['publish'] };
    case 'Auth':
      return NETWORK.includes(op)
        ? { text: `${OP_WORD[op]} needs credentials that can't be asked for here: ${e.message}`, level: 'error', actions: ['terminal'] }
        : { text: `${OP_WORD[op]} failed: ${e.message}`, level: 'error', actions: [] };
    case 'Conflict':
      return {
        text: op === 'apply' || op === 'pop'
          ? 'The stash conflicts with your working tree. Resolve the conflicts in Source Control (a conflicting pop keeps the stash).'
          : op === 'cherryPick' || op === 'revert'
            ? `Resolve the conflicts and commit in Source Control, or run \`git ${op === 'cherryPick' ? 'cherry-pick' : 'revert'} --abort\`.`
            : 'Merge conflicts. Resolve them in Source Control, then commit the merge.',
        level: 'error', actions: ['scm'],
      };
    case 'LocalChanges':
      return { text: `Your local changes would be overwritten by ${op === 'apply' || op === 'pop' ? 'the stash' : OP_WORD[op].toLowerCase()}. Commit or stash them first.`, level: 'error', actions: op === 'apply' || op === 'pop' ? ['scm'] : ['stash', 'scm'] };
    case 'NothingToStash':
      return { text: 'There are no changes to stash.', level: 'info', actions: [] };
    default:
      return { text: `${OP_WORD[op]} failed: ${e.message}`, level: 'error', actions: [] };
  }
}

// ---- Run in Terminal ----

/** Single-quote for a POSIX shell; plain words stay bare (not a leading `=`: zsh expands `=cmd` to a path). */
export function shQuote(s: string): string {
  return /^[A-Za-z0-9_@%+:,./-][A-Za-z0-9_@%+=:,./-]*$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`;
}

/**
 * The failed command as a terminal line. `GitError.args` is `-C <root> -c core.quotePath=false <real args…>`; the
 * terminal starts in the repo, so the prefix is dropped. If the prefix is not there, the args are used as they are.
 */
export function terminalCommand(gitPath: string, args: readonly string[]): string {
  const rest = args[0] === '-C' && args[2] === '-c' ? args.slice(4) : [...args];
  return [gitPath, ...rest].map(shQuote).join(' ');
}
