import * as path from 'node:path';
import * as vscode from 'vscode';
import type { DiffStyle } from '../graph/protocol';
import { loadThemeRules } from './chain';
import { customizationRules, resolveTokens } from './tokens';

type Tokens = NonNullable<DiffStyle['tokens']>;

interface ThemeContribution { id?: string; label?: string; path?: string }

/** Theme name per decision 6: `workbench.colorTheme`, or the preferred theme of the current kind with auto-detect on. */
export function activeThemeName(): string {
  const w = vscode.workspace.getConfiguration('workbench');
  if (vscode.workspace.getConfiguration('window').get<boolean>('autoDetectColorScheme', false)) {
    const K = vscode.ColorThemeKind;
    const key = {
      [K.Dark]: 'preferredDarkColorTheme',
      [K.Light]: 'preferredLightColorTheme',
      [K.HighContrast]: 'preferredHighContrastColorTheme',
      [K.HighContrastLight]: 'preferredHighContrastLightColorTheme',
    }[vscode.window.activeColorTheme.kind];
    const name = w.get<string>(key, '');
    if (name) return name;
  }
  return w.get<string>('colorTheme', 'Default Dark Modern') || 'Default Dark Modern';
}

/** Built-in themes are listed by id ("Dark Modern"), while older settings may hold "Default Dark Modern". */
function findTheme(name: string): { file: string; label: string } | null {
  const names = name.startsWith('Default ') ? [name, name.slice('Default '.length)] : [name];
  for (const n of names) {
    for (const ext of vscode.extensions.all) {
      const themes = (ext.packageJSON as { contributes?: { themes?: ThemeContribution[] } } | undefined)?.contributes?.themes;
      if (!Array.isArray(themes)) continue;
      for (const t of themes) {
        if (typeof t.path === 'string' && ((t.id ?? t.label) === n || t.label === n)) {
          return { file: path.join(ext.extensionPath, t.path), label: t.label ?? n };
        }
      }
    }
  }
  return null;
}

const read = async (file: string): Promise<string> =>
  new TextDecoder().decode(await vscode.workspace.fs.readFile(vscode.Uri.file(file)));

let current: Tokens | null = null;
let currentKey = '';
let seq = 0;
const changed = new vscode.EventEmitter<void>();

/** Fires when the resolved token styles change. */
export const onDidChangeThemeTokens: vscode.Event<void> = changed.event;

/** Last resolved token styles of the active theme; null while unresolved or when the theme can't be read. */
export function themeTokens(): Tokens | null { return current; }

async function refresh(log: (m: string) => void): Promise<void> {
  const mine = ++seq;
  const name = activeThemeName();
  const custom = vscode.workspace.getConfiguration('editor').get<unknown>('tokenColorCustomizations');
  const key = `${name}\n${JSON.stringify(custom ?? null)}`;
  if (key === currentKey && current) return;
  let tokens: Tokens | null = null;
  try {
    const theme = findTheme(name);
    if (!theme) {
      log(`theme tokens: theme “${name}” not found among extensions`);
    } else {
      const base = await loadThemeRules(theme.file, read);
      if (!base) log(`theme tokens: cannot read “${name}” (${theme.file}); falling back to the simple palette`);
      else {
        const resolved = resolveTokens([...base, ...customizationRules(custom, theme.label)]);
        tokens = Object.keys(resolved).length > 0 ? resolved : null;
      }
    }
  } catch (e) {
    log(`theme tokens “${name}”: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (mine !== seq) return; // a newer refresh is in flight
  currentKey = key;
  if (JSON.stringify(tokens) !== JSON.stringify(current)) {
    current = tokens;
    changed.fire();
  }
}

const WATCHED = [
  'workbench.colorTheme', 'workbench.preferredDarkColorTheme', 'workbench.preferredLightColorTheme',
  'workbench.preferredHighContrastColorTheme', 'workbench.preferredHighContrastLightColorTheme',
  'window.autoDetectColorScheme', 'editor.tokenColorCustomizations',
];

/** Resolves the active theme now and again whenever it or its customizations change. */
export function registerThemeTokens(context: vscode.ExtensionContext, log: (m: string) => void): void {
  const run = (): void => { void refresh(log); };
  context.subscriptions.push(
    changed,
    vscode.window.onDidChangeActiveColorTheme(run),
    vscode.workspace.onDidChangeConfiguration((e) => { if (WATCHED.some((k) => e.affectsConfiguration(k))) run(); }),
  );
  run();
}
