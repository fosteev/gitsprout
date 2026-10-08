import * as path from 'node:path';
import { parseJsonc, type TokenRule } from './tokens';

const MAX_DEPTH = 10;

function isObj(v: unknown): v is Record<string, unknown> { return typeof v === 'object' && v !== null && !Array.isArray(v); }

async function load(file: string, read: (path: string) => Promise<string>, depth: number): Promise<TokenRule[] | null> {
  if (depth > MAX_DEPTH || !/\.jsonc?$/i.test(file)) return null; // `.tmTheme` (plist) and friends are unsupported
  const doc = parseJsonc(await read(file));
  if (Array.isArray(doc)) return doc.filter(isObj) as TokenRule[];
  if (!isObj(doc)) return null;
  const rules: TokenRule[] = [];
  if (typeof doc.include === 'string') {
    const base = await load(path.resolve(path.dirname(file), doc.include), read, depth + 1);
    if (!base) return null;
    rules.push(...base);
  }
  // a TextMate-style theme in JSON keeps its rules under `settings`
  if (Array.isArray(doc.settings)) rules.push(...(doc.settings.filter(isObj) as TokenRule[]));
  const tc = doc.tokenColors;
  if (Array.isArray(tc)) {
    for (const r of tc) if (isObj(r)) rules.push(r as TokenRule);
  } else if (typeof tc === 'string') {
    const ext = await load(path.resolve(path.dirname(file), tc), read, depth + 1);
    if (!ext) return null;
    rules.push(...ext);
  }
  return rules;
}

/**
 * Token rules of a theme file: `include` chain first (base rules first), then its own `tokenColors`
 * (inline array or a path to another `.json`). Null when anything is unreadable, unparsable or a `.tmTheme`.
 */
export async function loadThemeRules(file: string, read: (path: string) => Promise<string>): Promise<TokenRule[] | null> {
  try {
    return await load(file, read, 0);
  } catch {
    return null;
  }
}
