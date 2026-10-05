// A fictional multi-repo workspace for the README screenshots: real git history, branches, tags, a stash and
// uncommitted changes, so every frame is rendered from what the extension's own git layer reads.
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';

const PEOPLE = {
  maya: ['Maya Chen', 'maya@atlas.dev'],
  leo: ['Leo Novak', 'leo@atlas.dev'],
  priya: ['Priya Raman', 'priya@atlas.dev'],
  tom: ['Tom Becker', 'tom@atlas.dev'],
} as const;
type Who = keyof typeof PEOPLE;

const NOW = Math.floor(Date.now() / 1000);

class Demo {
  /** Minutes before now of the next commit; every commit moves the clock forward. */
  private clock: number;
  constructor(readonly root: string, startMinutesAgo: number) { this.clock = startMinutesAgo; }

  git(...args: string[]): string {
    return execFileSync('git', ['-C', this.root, ...args], { encoding: 'utf8', env: this.env() });
  }

  private env(who: Who = 'maya'): NodeJS.ProcessEnv {
    const [name, email] = PEOPLE[who];
    const date = `${NOW - this.clock * 60} +0000`;
    return { ...process.env, GIT_AUTHOR_NAME: name, GIT_AUTHOR_EMAIL: email, GIT_COMMITTER_NAME: name, GIT_COMMITTER_EMAIL: email, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date, LC_ALL: 'C' };
  }

  write(files: Record<string, string>): void {
    for (const [p, text] of Object.entries(files)) {
      mkdirSync(dirname(join(this.root, p)), { recursive: true });
      writeFileSync(join(this.root, p), text);
    }
  }

  commit(who: Who, minutesLater: number, message: string, files: Record<string, string> = {}): void {
    this.clock -= minutesLater;
    this.write(files);
    execFileSync('git', ['-C', this.root, 'add', '-A'], { env: this.env(who) });
    execFileSync('git', ['-C', this.root, 'commit', '-q', '--allow-empty', '-m', message], { env: this.env(who) });
  }

  merge(who: Who, minutesLater: number, branch: string, message: string): void {
    this.clock -= minutesLater;
    execFileSync('git', ['-C', this.root, 'merge', '-q', '--no-ff', branch, '-m', message], { env: this.env(who) });
  }
}

function init(root: string, startMinutesAgo: number): Demo {
  mkdirSync(root, { recursive: true });
  execFileSync('git', ['init', '-q', '-b', 'main', root]);
  return new Demo(root, startMinutesAgo);
}

/** Bare remote + push of the given refs, so the views show upstreams and ahead/behind. */
function remote(d: Demo, bare: string, refs: string[]): void {
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', bare]);
  d.git('remote', 'add', 'origin', bare);
  d.git('push', '-q', '-u', 'origin', ...refs);
}

const searchBarV1 = `import { useState } from 'react';
import { searchProjects } from '../api/projects';

export function SearchBar({ onResults }: Props) {
  const [query, setQuery] = useState('');

  async function submit() {
    onResults(await searchProjects(query));
  }

  return (
    <form onSubmit={(e) => { e.preventDefault(); submit(); }}>
      <input value={query} onChange={(e) => setQuery(e.target.value)} />
    </form>
  );
}
`;

const searchBarV2 = `import { useEffect, useState } from 'react';
import { searchProjects } from '../api/projects';
import { DEFAULT_FILTERS } from '../search/filters';
import { FilterChips } from './FilterChips';

export function SearchBar({ onResults }: Props) {
  const [query, setQuery] = useState('');
  const [filters, setFilters] = useState(DEFAULT_FILTERS);

  useEffect(() => {
    const ctrl = new AbortController();
    searchProjects(query, filters, ctrl.signal)
      .then(onResults)
      .catch(() => {});
    return () => ctrl.abort();
  }, [query, filters]);

  return (
    <div className="search">
      <input value={query} onChange={(e) => setQuery(e.target.value)} />
      <FilterChips value={filters} onChange={setFilters} />
    </div>
  );
}
`;

const searchBarWip = searchBarV2
  .replace("import { useEffect, useState } from 'react';", "import { useEffect, useState } from 'react';\nimport { useDebounce } from '../search/useDebounce';")
  .replace("  const [filters, setFilters]", "  const debounced = useDebounce(query, 250);\n  const [filters, setFilters]")
  .replace('searchProjects(query, filters', 'searchProjects(debounced, filters')
  .replace('}, [query, filters]);', '}, [debounced, filters]);');

const projectsApiV1 = `import { http } from './client';

export function searchProjects(q: string): Promise<Project[]> {
  return http.get('/projects', { params: { q } });
}
`;

const projectsApiV2 = `import { http } from './client';

export interface SearchFilters { status: 'active' | 'archived' | 'all'; owner: string | null }

export function searchProjects(q: string, f: SearchFilters, signal?: AbortSignal): Promise<Project[]> {
  return http.get('/projects', { params: { q, status: f.status, owner: f.owner ?? undefined }, signal });
}
`;

const filtersV1 = `import type { SearchFilters } from '../api/projects';

export const DEFAULT_FILTERS: SearchFilters = { status: 'active', owner: null };

export function toQuery(f: SearchFilters): string {
  return [f.status !== 'all' && \`status:\${f.status}\`, f.owner && \`owner:\${f.owner}\`].filter(Boolean).join(' ');
}
`;

/** Builds the workspace under `base` and returns the root of the repo shown in the graph. */
export function buildDemo(base: string): { workspace: string; active: string } {
  rmSync(base, { recursive: true, force: true });
  const ws = join(base, 'work');
  const remotes = join(base, 'remotes');
  mkdirSync(remotes, { recursive: true });

  // apps/atlas-web: the repo in the graph.
  const w = init(join(ws, 'apps/atlas-web'), 60 * 62);
  w.commit('maya', 0, 'Initial project layout', {
    'package.json': '{ "name": "atlas-web", "private": true }\n',
    'README.md': '# Atlas Web\n\nThe Atlas project dashboard.\n',
    'src/api/client.ts': "export const http = createClient({ baseUrl: '/api' });\n",
  });
  w.commit('leo', 180, 'ATL-201 Add projects API client', { 'src/api/projects.ts': projectsApiV1 });
  w.commit('maya', 240, 'ATL-203 Search bar on the dashboard', { 'src/components/SearchBar.tsx': searchBarV1 });
  w.git('tag', 'v2.3.0');
  w.commit('priya', 600, 'Bump dependencies', { 'package.json': '{ "name": "atlas-web", "private": true, "version": "2.3.1" }\n' });

  w.git('checkout', '-q', '-b', 'fix/login-redirect');
  w.commit('tom', 90, 'ATL-214 Keep the return URL after login', { 'src/auth/redirect.ts': "export const returnTo = (u: URL) => u.searchParams.get('next') ?? '/';\n" });
  w.commit('tom', 45, 'ATL-214 Cover redirect edge cases', { 'src/auth/redirect.test.ts': "test('defaults to /', () => {});\n" });

  w.git('checkout', '-q', 'main');
  w.git('checkout', '-q', '-b', 'feature/billing-page');
  w.commit('leo', 200, 'ATL-198 Billing page skeleton', { 'src/pages/Billing.tsx': 'export default function Billing() { return null; }\n' });
  w.commit('leo', 130, 'ATL-198 Invoices table with pagination', { 'src/pages/Invoices.tsx': 'export function Invoices() { return null; }\n' });

  w.git('checkout', '-q', 'main');
  w.merge('maya', 300, 'fix/login-redirect', "Merge branch 'fix/login-redirect'");
  w.commit('priya', 420, 'Speed up the CI cache', { '.ci/cache.yml': 'paths: [node_modules]\n' });
  w.merge('maya', 140, 'feature/billing-page', "Merge branch 'feature/billing-page'");
  w.commit('maya', 60, 'Release 2.4.0', { 'CHANGELOG.md': '## 2.4.0\n\n- Billing page\n- Login keeps the return URL\n' });
  w.git('tag', 'v2.4.0');

  w.git('checkout', '-q', '-b', 'feature/dark-mode');
  w.commit('priya', 500, 'ATL-226 Theme tokens for dark mode', { 'src/theme/tokens.ts': "export const dark = { bg: '#14161a' };\n" });

  w.git('checkout', '-q', 'main');
  w.commit('tom', 260, 'ATL-219 Retry failed requests once', { 'src/api/client.ts': "export const http = createClient({ baseUrl: '/api', retry: 1 });\n" });

  w.git('checkout', '-q', '-b', 'feature/search-filters');
  w.commit('maya', 180, 'ATL-231 Filters in the projects API', { 'src/api/projects.ts': projectsApiV2 });
  w.commit('maya', 75, 'ATL-231 Filter chips in the search bar', {
    'src/components/SearchBar.tsx': searchBarV2,
    'src/components/FilterChips.tsx': 'export function FilterChips(p: { value: SearchFilters; onChange(f: SearchFilters): void }) { return null; }\n',
  });

  w.git('checkout', '-q', 'main');
  w.commit('priya', 50, 'ATL-224 Empty state for the dashboard', { 'src/pages/Empty.tsx': 'export const Empty = () => null;\n' });

  remote(w, join(remotes, 'atlas-web.git'), ['main', 'feature/dark-mode', 'feature/search-filters', 'v2.3.0', 'v2.4.0']);
  w.git('branch', '-q', '-D', 'feature/dark-mode');
  w.git('checkout', '-q', 'feature/search-filters');
  w.commit('maya', 40, 'ATL-231 Search filter query string', { 'src/search/filters.ts': filtersV1 });
  w.commit('maya', 25, 'ATL-231 Remember the last filters', { 'src/search/filters.ts': filtersV1 + "\nexport const STORAGE_KEY = 'atlas.search.filters';\n" });

  // A stash and uncommitted work: staged, unstaged and untracked files.
  w.write({ 'src/search/fuzzy.ts': 'export const fuzzy = (a: string, b: string) => a.includes(b);\n' });
  w.git('stash', 'push', '-q', '-u', '-m', 'fuzzy matching experiment');
  w.write({
    'src/search/filters.ts': filtersV1.replace("owner: null };", "owner: null, sort: 'updated' };") + "\nexport const STORAGE_KEY = 'atlas.search.filters';\n",
    'src/api/projects.ts': projectsApiV2.replace("owner: string | null }", "owner: string | null; sort: 'updated' | 'name' }"),
  });
  w.git('add', 'src/search/filters.ts', 'src/api/projects.ts');
  w.write({
    'src/components/SearchBar.tsx': searchBarWip,
    'src/search/useDebounce.ts': `import { useEffect, useState } from 'react';

export function useDebounce<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}
`,
    'README.md': '# Atlas Web\n\nThe Atlas project dashboard.\n\n## Search\n\nType to search; filters narrow the list.\n',
  });

  // The other repos of the workspace: just enough history for the Repositories view.
  const small = (rel: string, opts: { ahead?: number; behind?: number; dirty?: boolean; branch?: string } = {}): void => {
    const name = rel.split('/').pop()!;
    const r = init(join(ws, rel), 60 * 24 * 4);
    r.commit('leo', 0, 'Initial commit', { 'README.md': `# ${name}\n` });
    r.commit('priya', 300, 'Set up CI', { '.ci/pipeline.yml': 'stages: [test]\n' });
    const bare = join(remotes, `${name}.git`);
    remote(r, bare, ['main']);
    if (opts.behind) {
      const tmp = join(base, 'tmp', name);
      execFileSync('git', ['clone', '-q', bare, tmp]);
      const other = new Demo(tmp, 60 * 24 * 2);
      for (let i = 0; i < opts.behind; i++) other.commit('tom', 60, `Update ${i}`, { [`notes/${i}.md`]: `${i}\n` });
      other.git('push', '-q', 'origin', 'main');
      r.git('fetch', '-q', 'origin');
    }
    if (opts.branch) r.git('checkout', '-q', '-b', opts.branch);
    for (let i = 0; i < (opts.ahead ?? 0); i++) r.commit('maya', 30, `Local change ${i}`, { [`src/${i}.ts`]: `export const v${i} = ${i};\n` });
    if (opts.dirty) r.write({ 'README.md': `# ${name}\n\nWork in progress.\n`, 'src/draft.ts': 'export {};\n' });
  };
  small('apps/atlas-mobile', { behind: 3 });
  small('services/auth-gateway', { dirty: true });
  small('services/billing', { ahead: 2 });
  small('services/notifications');
  small('libs/design-tokens');
  small('libs/ui-kit', { branch: 'feature/buttons', dirty: true });
  small('infra');
  rmSync(join(base, 'tmp'), { recursive: true, force: true });

  return { workspace: ws, active: join(ws, 'apps/atlas-web') };
}
