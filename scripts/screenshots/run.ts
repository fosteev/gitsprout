// README screenshots: builds the demo workspace (demo.ts), reads it with the extension's own git layer and tree
// models, and renders the real webview bundle (dist/webview.js + .css) in an iframe inside a VS Code-like window
// (Dark Modern colours). Frames land in docs/screenshots/<name>.png. Started by scripts/screenshots.mjs.
import { chromium, type Frame, type Page } from 'playwright-core';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Repo } from '../../src/git/repo';
import type { Commit, FileChange, FileStat, RepoSummary } from '../../src/git/types';
import type { FromWebview, ToWebview } from '../../src/graph/protocol';
import { stateMessage } from '../../src/graph/validate';
import { branchDescription, buildBranchTree, buildRemoteTree, repoViewDescription, short, sortTags } from '../../src/views/refsModel';
import { buildRepoTree, repoDescription, viewDescription, type RepoTreeNode } from '../../src/views/repoModel';
import { buildDemo } from './demo';

const ROOT = resolve(process.argv[2] ?? '.');
const OUT = join(ROOT, 'docs/screenshots');
const TMP = join(tmpdir(), 'gitsprout-screenshots');
const CHROME = process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const SETTINGS = { ciPattern: '^AutoBuild$', hideCi: false, jira: { ATL: 'https://jira.example.com/browse/' }, logLimit: 1000 };

const esc = (s: string): string => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

// ---- data -------------------------------------------------------------------------------------------------

const demo = buildDemo(join(TMP, 'demo'));
const repo = new Repo(demo.active);
const [commits, refs, status, stashes] = await Promise.all([repo.log(1000), repo.refs(), repo.status(), repo.stashes()]);
const byShaMap = new Map<string, Commit>(commits.map((c) => [c.sha, c]));
const roots = ['apps/atlas-web', 'apps/atlas-mobile', 'services/auth-gateway', 'services/billing', 'services/notifications', 'libs/design-tokens', 'libs/ui-kit', 'infra']
  .map((rel) => join(demo.workspace, rel));
const summaries: RepoSummary[] = await Promise.all(roots.map(async (root) => {
  const relPath = relative(demo.workspace, root);
  const segs = relPath.split('/');
  return { ...(await new Repo(root).summary()), root, name: segs[segs.length - 1], relPath, group: segs.length > 1 ? segs[0] : '' };
}));
const state = stateMessage({ root: demo.active, name: 'atlas-web' }, roots.length, refs, commits, status, SETTINGS, stashes.length);
const bySubject = (s: string): Commit => commits.find((c) => c.subject === s)!;

/** The extension's side of the protocol, enough for the frames below. */
async function host(m: FromWebview): Promise<ToWebview[]> {
  switch (m.type) {
    case 'ready': return [state];
    case 'select': return m.sha === 'WIP' ? [] : [{ type: 'details', sha: m.sha, files: await repo.commitFiles(m.sha) }];
    case 'diffCommitFile': {
      const c = byShaMap.get(m.sha)!;
      const f: FileStat = m.file;
      return [{ type: 'diff', req: m.req, patch: await repo.patch({ kind: 'commit', sha: m.sha, parent: c.parents[0] ?? null, path: f.path, origPath: f.origPath }) }];
    }
    case 'diffWipFile': {
      const f: FileChange = m.file;
      const spec = m.area === 'staged' ? { kind: 'staged' as const, path: f.path, origPath: f.origPath }
        : f.untracked ? { kind: 'untracked' as const, path: f.path } : { kind: 'unstaged' as const, path: f.path };
      return [{ type: 'diff', req: m.req, patch: await repo.patch(spec) }];
    }
    case 'amendInfo': return [{ type: 'amendInfo', summary: commits[0].subject, description: '', pushed: false }];
    default: return [];
  }
}

// ---- window chrome ----------------------------------------------------------------------------------------

const THEME = `
  --vscode-font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; --vscode-font-size: 13px;
  --vscode-editor-font-family: Menlo, Monaco, "Courier New", monospace; --vscode-editor-font-size: 12px;
  --vscode-foreground: #cccccc; --vscode-descriptionForeground: #9d9d9d; --vscode-errorForeground: #f85149;
  --vscode-editor-background: #1f1f1f; --vscode-editorLineNumber-foreground: #6e7681; --vscode-editorWarning-foreground: #cca700;
  --vscode-badge-background: #616161; --vscode-badge-foreground: #f8f8f8;
  --vscode-button-background: #0078d4; --vscode-button-foreground: #ffffff; --vscode-button-hoverBackground: #026ec1;
  --vscode-charts-blue: #3794ff; --vscode-textLink-foreground: #4daafc; --vscode-focusBorder: #0078d4; --vscode-sash-hoverBorder: #0078d4;
  --vscode-diffEditor-insertedLineBackground: #9bb95533; --vscode-diffEditor-removedLineBackground: #ff000033;
  --vscode-gitDecoration-addedResourceForeground: #81b88b; --vscode-gitDecoration-deletedResourceForeground: #c74e39;
  --vscode-gitDecoration-modifiedResourceForeground: #e2c08d;
  --vscode-input-background: #313131; --vscode-input-border: #3c3c3c; --vscode-input-foreground: #cccccc;
  --vscode-list-activeSelectionBackground: #04395e; --vscode-list-activeSelectionForeground: #ffffff;
  --vscode-list-hoverBackground: #2a2d2e; --vscode-list-inactiveSelectionBackground: #37373d; --vscode-list-inactiveSelectionForeground: #cccccc;
  --vscode-menu-background: #1f1f1f; --vscode-menu-border: #454545; --vscode-menu-foreground: #cccccc;
  --vscode-menu-selectionBackground: #0078d4; --vscode-menu-selectionForeground: #ffffff;
  --vscode-panel-border: #2b2b2b; --vscode-widget-border: #313131; --vscode-widget-shadow: #0000005c; --vscode-toolbar-hoverBackground: #5a5d5e50;
  --vscode-scmGraph-foreground1: #ffb000; --vscode-scmGraph-foreground2: #dc267f; --vscode-scmGraph-foreground3: #994f00;
  --vscode-scmGraph-foreground4: #40b0a6; --vscode-scmGraph-foreground5: #b66dff;`;

/** 16px codicon-like glyphs, stroked in currentColor. */
const ICON: Record<string, string> = {
  chevR: '<path d="M6 4l4 4-4 4"/>',
  chevD: '<path d="M4 6l4 4 4-4"/>',
  folder: '<path d="M1.5 3.5h4.5l1.5 1.5h7v8h-13z"/>',
  repo: '<path d="M3.5 2.5h9v9h-9zM3.5 11.5v2h2v-2M7 13.5h5.5v-2"/><path d="M5.5 4.5v5"/>',
  branch: '<circle cx="4.5" cy="3.5" r="1.5"/><circle cx="4.5" cy="12.5" r="1.5"/><circle cx="11.5" cy="5" r="1.5"/><path d="M4.5 5v6M11.5 6.5c0 3-7 2-7 4.5"/>',
  check: '<path d="M3 8.5l3 3 7-7"/>',
  cloud: '<path d="M4.5 12.5a3 3 0 0 1-.3-6 4 4 0 0 1 7.6.8 2.6 2.6 0 0 1 .2 5.2z"/>',
  tag: '<path d="M2 2.5h6l6 6-5.5 5.5-6.5-6z"/><circle cx="5" cy="5.5" r="1"/>',
  stash: '<path d="M2 9v4.5h12V9M2 9h3l1 1.5h4L11 9h3M3 6.5h10M4 4h8"/>',
  files: '<path d="M4 1.5h5l3 3v10H4z"/><path d="M9 1.5v3h3"/>',
  search: '<circle cx="7" cy="7" r="4.5"/><path d="M10.5 10.5l4 4"/>',
  scm: '<circle cx="4.5" cy="3.5" r="1.5"/><circle cx="4.5" cy="12.5" r="1.5"/><circle cx="11.5" cy="8" r="1.5"/><path d="M4.5 5v6M10 8.5c-3 0-5.5-1-5.5-3.5"/>',
  ext: '<path d="M2 6.5h7.5V14H2zM6.5 2v4.5M9.5 9.5H14V2H6.5"/>',
  sync: '<path d="M13 8a5 5 0 0 1-9 3M3 8a5 5 0 0 1 9-3M12 2v3H9M4 14v-3h3"/>',
  close: '<path d="M4 4l8 8M12 4l-8 8"/>',
  graph: '<path d="M2 13.5h12M4 11V7M8 11V3M12 11V6"/>',
};
const svg = (name: string, cls = 'i'): string =>
  `<svg class="${cls}" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round">${ICON[name]}</svg>`;
const sprout = readFileSync(join(ROOT, 'media/sprout.svg'), 'utf8').replace('<svg ', '<svg class="sprout" ');

interface Row { depth: number; twisty?: 'open' | 'closed'; icon?: string; iconColor?: string; label: string; desc?: string; selected?: boolean; descColor?: string }
const row = (r: Row): string => `<div class="row${r.selected ? ' sel' : ''}" style="padding-left:${8 + r.depth * 8}px">
  <span class="tw">${r.twisty ? svg(r.twisty === 'open' ? 'chevD' : 'chevR') : ''}</span>${r.icon ? `<span class="ic" ${r.iconColor ? `style="color:${r.iconColor}"` : ''}>${svg(r.icon)}</span>` : ''}<span class="lb">${esc(r.label)}</span>${r.desc ? `<span class="ds" ${r.descColor ? `style="color:${r.descColor}"` : ''}>${esc(r.desc)}</span>` : ''}</div>`;
const section = (title: string, open: boolean, desc: string | undefined, rows: string[]): string =>
  `<div class="sec${open ? ' open' : ''}"><div class="sh">${svg(open ? 'chevD' : 'chevR')}<b>${title}</b>${desc ? `<span>${esc(desc)}</span>` : ''}</div>${open ? `<div class="sb">${rows.join('')}</div>` : ''}</div>`;

function repoRows(nodes: RepoTreeNode[], depth = 0): string[] {
  return nodes.flatMap((n): string[] => n.kind === 'repo'
    ? [row({ depth, icon: 'repo', iconColor: n.repo.root === demo.active ? '#89d185' : undefined, label: n.repo.name, desc: repoDescription(n.repo), selected: n.repo.root === demo.active })]
    : [row({ depth, twisty: 'open', icon: 'folder', label: n.label, desc: n.description }), ...repoRows(n.children, depth + 1)]);
}

function sidebar(): string {
  const reposDesc = viewDescription(summaries, false);
  const branchRows = buildBranchTree(refs.locals, refs.head.branch).flatMap((n): string[] => n.kind === 'folder'
    ? [row({ depth: 0, twisty: 'open', icon: 'folder', label: n.label }), ...n.children.map((b) => row({ depth: 1, icon: b.isHead ? 'check' : 'branch', label: b.label, desc: branchDescription(b.branch) }))]
    : [row({ depth: 0, icon: n.isHead ? 'check' : 'branch', label: n.label, desc: branchDescription(n.branch) })]);
  const remoteRows = buildRemoteTree(refs.remotes).flatMap((g) => [row({ depth: 0, twisty: 'open', icon: 'cloud', label: g.name }), ...g.children.map((b) => row({ depth: 1, icon: 'branch', label: b.label }))]);
  const stashRows = stashes.map((s) => row({ depth: 0, twisty: 'closed', icon: 'stash', label: `stash@{${s.index}}`, desc: s.message.replace(/^On [^:]+: /, '') }));
  const tagRows = sortTags(refs.tags).map((t) => row({ depth: 0, icon: 'tag', label: t.name, desc: short(t.sha) }));
  const d = repoViewDescription('atlas-web', true);
  return `<div class="side"><div class="side-h">GITSPROUT</div>
    ${section('REPOSITORIES', true, reposDesc, repoRows(buildRepoTree(summaries, { onlyAttention: false, activeRoot: demo.active })))}
    ${section('BRANCHES', true, d, branchRows)}
    ${section('REMOTES', false, d, remoteRows)}
    ${section('STASHES', true, d, stashRows)}
    ${section('TAGS', false, d, tagRows)}
  </div>`;
}

function windowHtml(frameUrl: string): string {
  const behind = 0, ahead = refs.locals.find((b) => b.name === refs.head.branch)?.ahead ?? 0;
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
  :root{${THEME}}
  *{box-sizing:border-box} html,body{margin:0;height:100%;background:#0e0e0e}
  body{font:13px var(--vscode-font-family);color:#cccccc;display:flex;align-items:center;justify-content:center}
  #win{width:1360px;height:820px;display:grid;grid-template-rows:35px 1fr 22px;background:#181818;overflow:hidden}
  .title{display:flex;align-items:center;border-bottom:1px solid #2b2b2b;color:#9d9d9d;font-size:12px;position:relative}
  .lights{display:flex;gap:8px;padding-left:13px}.lights i{width:12px;height:12px;border-radius:50%;display:block}
  .title .t{position:absolute;left:0;right:0;text-align:center;pointer-events:none}
  .title .cmd{margin:0 auto;width:420px;height:24px;border:1px solid #3c3c3c;border-radius:6px;background:#222;display:flex;align-items:center;justify-content:center;gap:6px}
  .title .cmd .i{width:14px;height:14px}
  .mid{display:grid;grid-template-columns:48px 280px 1fr;min-height:0}
  .act{display:flex;flex-direction:column;align-items:center;padding-top:6px;gap:4px;border-right:1px solid #2b2b2b}
  .act span{width:48px;height:44px;display:flex;align-items:center;justify-content:center;color:#868686;position:relative}
  .act span.on{color:#d7d7d7}.act span.on::before{content:"";position:absolute;left:0;top:8px;bottom:8px;width:2px;background:#0078d4}
  .act .i{width:24px;height:24px;stroke-width:1.1}.act .sprout{width:24px;height:24px}
  .side{border-right:1px solid #2b2b2b;overflow:hidden;display:flex;flex-direction:column}
  .side-h{height:35px;line-height:35px;padding-left:20px;font-size:11px;letter-spacing:.2px}
  .sec{border-top:1px solid #2b2b2b}.sh{height:22px;display:flex;align-items:center;gap:2px;font-size:11px;padding-left:2px}
  .sh b{font-weight:700}.sh span{color:#9d9d9d;margin-left:8px;font-size:11px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .sh .i{width:16px;height:16px}
  .row{height:22px;display:flex;align-items:center;white-space:nowrap;padding-right:8px}
  .row.sel{background:#37373d}
  .tw{width:16px;flex:none;display:flex}.tw .i{width:16px;height:16px}
  .ic{width:16px;height:16px;flex:none;margin-right:6px;display:flex}.ic .i{width:16px;height:16px}
  .lb{flex:none}.ds{color:#9d9d9d;margin-left:6px;font-size:12px;overflow:hidden;text-overflow:ellipsis}
  .ed{display:grid;grid-template-rows:35px 1fr;min-width:0;background:#1f1f1f}
  .tabs{display:flex;background:#181818;border-bottom:1px solid #2b2b2b}
  .tab{display:flex;align-items:center;gap:6px;padding:0 10px 0 12px;border-right:1px solid #2b2b2b;color:#9d9d9d}
  .tab.on{background:#1f1f1f;color:#fff;border-top:1px solid #0078d4;margin-bottom:-1px}
  .tab .i{width:14px;height:14px}.tab .x{opacity:.8}
  iframe{border:0;width:100%;height:100%;display:block}
  .status{display:flex;align-items:center;background:#181818;border-top:1px solid #2b2b2b;font-size:12px;color:#cccccc}
  .status span{display:flex;align-items:center;gap:4px;padding:0 8px;height:100%}
  .status .i{width:14px;height:14px}.status .rem{background:#0078d4;color:#fff;padding:0 10px}
  .status .r{margin-left:auto}
  #menu{position:absolute;display:none;min-width:250px;background:#1f1f1f;border:1px solid #454545;border-radius:6px;padding:4px 0;box-shadow:0 2px 8px #0000005c;font-size:13px;z-index:9}
  #menu div{height:26px;line-height:26px;padding:0 26px;margin:0 4px;border-radius:4px;display:flex;justify-content:space-between}
  #menu div.on{background:#0078d4;color:#fff}#menu hr{border:0;border-top:1px solid #454545;margin:4px 0}
  </style></head><body>
  <div id="win" style="position:relative">
    <div class="title"><div class="lights"><i style="background:#ff5f57"></i><i style="background:#febc2e"></i><i style="background:#28c840"></i></div>
      <div class="cmd">${svg('search')}<span>work</span></div></div>
    <div class="mid">
      <div class="act"><span>${svg('files')}</span><span>${svg('search')}</span><span>${svg('scm')}</span><span class="on">${sprout}</span><span>${svg('ext')}</span></div>
      ${sidebar()}
      <div class="ed"><div class="tabs"><div class="tab on">${svg('graph')}<span>Graph · atlas-web</span><span class="x">${svg('close')}</span></div></div>
        <iframe id="wv" src="${frameUrl}"></iframe></div>
    </div>
    <div class="status"><span>${svg('branch')}${esc(refs.head.branch ?? '')}*</span><span>${svg('sync')}${behind}↓ ${ahead}↑</span><span class="r">${svg('repo')}atlas-web</span></div>
    <div id="menu"></div>
  </div></body></html>`;
}

/** The webview document: as `graphHtml` makes it, minus the CSP, plus the theme variables and a fake VS Code API. */
function frameHtml(): string {
  const dist = pathToFileURL(join(ROOT, 'dist')).href;
  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><style>:root{${THEME}}</style>
  <link rel="stylesheet" href="${dist}/webview.css"></head><body class="vscode-dark"><div id="app"></div>
  <script>
    let saved = window.__initialState;
    window.acquireVsCodeApi = () => ({
      postMessage: (m) => window.__host(m).then((out) => out.forEach((d) => window.dispatchEvent(new MessageEvent('message', { data: d })))),
      setState: (s) => { saved = s; }, getState: () => saved,
    });
  </script><script src="${dist}/webview.js"></script></body></html>`;
}

// ---- frames -----------------------------------------------------------------------------------------------

const wv = async (p: Page): Promise<Frame> => {
  const f = p.frames().find((x) => x.url().endsWith('frame.html'))!;
  await f.waitForSelector('.gr[data-sha]');
  return f;
};
const pick = async (f: Frame, subject: string): Promise<void> => {
  await f.click(`.gr[data-sha="${bySubject(subject).sha}"]`);
  await f.waitForSelector('#details [data-file]');
};

const frames: Record<string, (p: Page) => Promise<void>> = {
  graph: async (p) => { await pick(await wv(p), 'ATL-231 Filter chips in the search bar'); },
  wip: async (p) => {
    const f = await wv(p);
    await f.click('.gr[data-sha="WIP"]');
    await f.fill('#wsum', 'ATL-231 Debounce the search query');
    await f.fill('#wdesc', 'Typing no longer fires a request per keystroke; filters gain a sort order.');
  },
  diff: async (p) => {
    const f = await wv(p);
    await pick(f, 'ATL-231 Filter chips in the search bar');
    await f.click('#details [data-file] >> text=SearchBar.tsx');
    await f.waitForSelector('#dview .dbody .dn, #dview .dc');
  },
  actions: async (p) => {
    const f = await wv(p);
    const c = bySubject('ATL-219 Retry failed requests once');
    await pick(f, c.subject);
    const box = (await (await f.$(`.gr[data-sha="${c.sha}"]`))!.boundingBox())!;
    const items = ['Create Branch From…', 'Create Tag Here…', 'Create Annotated Tag Here…', '-', 'Copy Commit SHA', 'Copy Commit Message', 'Copy Link to Commit', '-',
      'Reset Current Branch to Here ›', 'Cherry Pick Commit', 'Revert Commit', '-', 'Compare with Working Tree', 'Save as Patch…'];
    await p.evaluate(({ items, x, y }) => {
      const m = document.getElementById('menu')!;
      m.innerHTML = items.map((t) => t === '-' ? '<hr>' : `<div${t.startsWith('Cherry') ? ' class="on"' : ''}><span>${t.replace(' ›', '')}</span>${t.endsWith('›') ? '<span>›</span>' : ''}</div>`).join('');
      Object.assign(m.style, { display: 'block', left: `${x}px`, top: `${y}px` });
    }, { items, x: box.x + 420, y: box.y + box.height / 2 });
  },
};

const only = process.argv.slice(3);
mkdirSync(OUT, { recursive: true });
writeFileSync(join(TMP, 'frame.html'), frameHtml());
writeFileSync(join(TMP, 'index.html'), windowHtml(pathToFileURL(join(TMP, 'frame.html')).href));

const browser = await chromium.launch({ executablePath: CHROME, args: ['--allow-file-access-from-files'] });
let failed = false;
try {
  const context = await browser.newContext({ viewport: { width: 1400, height: 860 }, deviceScaleFactor: 2, colorScheme: 'dark', locale: 'en-US' });
  for (const [name, act] of Object.entries(frames)) {
    if (only.length && !only.includes(name)) continue;
    const page = await context.newPage();
    const errors: Error[] = [];
    page.on('pageerror', (e) => errors.push(e));
    await page.exposeFunction('__host', (m: FromWebview) => host(m));
    await page.addInitScript(() => { (window as unknown as { __initialState: unknown }).__initialState = { paneWidth: 360 }; });
    await page.goto(pathToFileURL(join(TMP, 'index.html')).href);
    await act(page);
    await page.waitForTimeout(200);
    if (errors.length) throw new Error(`${name}: ${errors[0].message}`);
    await page.locator('#win').screenshot({ path: join(OUT, `${name}.png`), animations: 'disabled' });
    console.log(`docs/screenshots/${name}.png`);
    await page.close();
  }
} catch (e) {
  failed = true;
  console.error(e);
} finally {
  await browser.close();
}
if (failed) process.exit(1);
