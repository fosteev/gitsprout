// Command ids contributed in package.json (without the `gitsprout.` prefix).
// Kept free of `vscode` imports so tests can compare it with the manifest.
export const COMMAND_IDS = [
  'showGraph', 'switchRepository', 'refresh', 'fetch', 'fetchAll', 'pull', 'push',
  'checkout', 'checkoutBranch', 'checkoutRemote', 'createBranch', 'createBranchFrom',
  'renameBranch', 'deleteBranch', 'stash', 'stashApply', 'stashPop', 'stashDrop',
  'copySha', 'copyMessage', 'copyBranchName', 'copyRepoPath',
  'toggleAutoBuild', 'toggleOnlyAttention', 'openSourceControl', 'repoShowGraph', 'repoFetch',
  'openStashFile',
] as const;

export const VIEW_IDS = ['repositories', 'branches', 'remotes', 'stashes', 'tags'] as const;
