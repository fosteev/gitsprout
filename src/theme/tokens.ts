import { TOKEN_KINDS, type TokenKind, type TokenStyle } from '../graph/protocol';

/** One `tokenColors` entry of a VS Code colour theme (or a customization). Rules without a scope are ignored. */
export interface TokenRule {
  scope?: string | string[];
  settings?: { foreground?: string; fontStyle?: string };
}

/** Strips `//` and block comments (outside strings) and trailing commas, then parses. Throws on invalid JSON. */
export function parseJsonc(text: string): unknown {
  let out = '';
  let i = 0;
  const n = text.length;
  while (i < n) {
    const ch = text[i];
    if (ch === '"') {
      let j = i + 1;
      while (j < n && text[j] !== '"') j += text[j] === '\\' ? 2 : 1;
      out += text.slice(i, j + 1);
      i = j + 1;
    } else if (ch === '/' && text[i + 1] === '/') {
      while (i < n && text[i] !== '\n') i++;
    } else if (ch === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      i = end < 0 ? n : end + 2;
    } else if (ch === ',') {
      let j = i + 1;
      while (j < n && /\s/.test(text[j]!)) j++;
      // a comment between the comma and the closer is rare; handle by looking past comments
      for (;;) {
        if (text[j] === '/' && text[j + 1] === '/') { while (j < n && text[j] !== '\n') j++; }
        else if (text[j] === '/' && text[j + 1] === '*') { const e = text.indexOf('*/', j + 2); j = e < 0 ? n : e + 2; }
        else if (j < n && /\s/.test(text[j]!)) j++;
        else break;
      }
      if (text[j] === '}' || text[j] === ']') i++; else { out += ch; i++; }
    } else {
      out += ch;
      i++;
    }
  }
  // BOM
  return JSON.parse(out.replace(/^﻿/, ''));
}

/** Decision 3: TextMate scopes per token kind, tried in order. */
export const KIND_SCOPES: Record<TokenKind, readonly string[]> = {
  comment: ['comment'],
  keyword: ['keyword', 'storage.type', 'keyword.control'],
  string: ['string'],
  number: ['constant.numeric'],
  literal: ['constant.language'],
  builtIn: ['support.function', 'support.class', 'support.type'],
  type: ['entity.name.type', 'entity.name.class', 'support.type'],
  function: ['entity.name.function', 'support.function'],
  variable: ['variable.parameter', 'variable', 'variable.other'],
  property: ['variable.other.property', 'support.type.property-name', 'variable'],
  tag: ['entity.name.tag'],
  attribute: ['entity.other.attribute-name'],
  regexp: ['string.regexp'],
  meta: ['meta.preprocessor', 'keyword.control.directive', 'meta.decorator'],
  operator: ['keyword.operator'],
  heading: ['markup.heading', 'entity.name.section'],
};

export interface Match { color?: string; fontStyle?: string }

const COLOR = /^#[0-9a-f]{3,8}$/i;

function selectors(scope: string | string[] | undefined): string[] {
  const list = Array.isArray(scope) ? scope : typeof scope === 'string' ? [scope] : [];
  const out: string[] = [];
  for (const entry of list) {
    if (typeof entry !== 'string') continue;
    for (const part of entry.split(',')) {
      const s = part.trim();
      // descendant selectors ("a b") and exclusions ("a - b") are not supported
      if (s && !/\s/.test(s) && !s.startsWith('-')) out.push(s);
    }
  }
  return out;
}

/** A selector `S` matches scope `X` when `X === S` or `X` starts with `S + '.'`. */
function selectorMatches(selector: string, scope: string): boolean {
  return scope === selector || scope.startsWith(selector + '.');
}

/**
 * Resolves colour and fontStyle of `scope` independently: the matching selector with the most dot segments wins,
 * a later rule wins a tie. `fontStyle: ""` is a match that clears the style.
 */
export function matchRules(rules: readonly TokenRule[], scope: string): Match {
  let colorSpec = -1;
  let styleSpec = -1;
  const res: Match = {};
  for (const rule of rules) {
    const st = rule.settings;
    if (!st) continue;
    const fg = typeof st.foreground === 'string' && COLOR.test(st.foreground.trim()) ? st.foreground.trim() : undefined;
    const fs = typeof st.fontStyle === 'string' ? st.fontStyle : undefined;
    if (fg === undefined && fs === undefined) continue;
    for (const sel of selectors(rule.scope)) {
      if (!selectorMatches(sel, scope)) continue;
      const spec = sel.split('.').length;
      if (fg !== undefined && spec >= colorSpec) { colorSpec = spec; res.color = fg; }
      if (fs !== undefined && spec >= styleSpec) { styleSpec = spec; res.fontStyle = fs; }
    }
  }
  return res;
}

/** Per kind the first scope of `KIND_SCOPES` that resolves a colour wins; its fontStyle gives italic / bold. */
export function resolveTokens(rules: readonly TokenRule[]): Partial<Record<TokenKind, TokenStyle>> {
  const out: Partial<Record<TokenKind, TokenStyle>> = {};
  for (const kind of TOKEN_KINDS) {
    for (const scope of KIND_SCOPES[kind]) {
      const m = matchRules(rules, scope);
      if (m.color === undefined) continue;
      const words = (m.fontStyle ?? '').split(/\s+/);
      const style: TokenStyle = { color: m.color };
      if (words.includes('italic')) style.italic = true;
      if (words.includes('bold')) style.bold = true;
      out[kind] = style;
      break;
    }
  }
  return out;
}

const SHORTHANDS: Record<string, string[]> = {
  comments: ['comment'],
  strings: ['string'],
  keywords: ['keyword', 'storage.type'],
  numbers: ['constant.numeric'],
  types: ['entity.name.type', 'entity.name.class', 'support.type', 'support.class'],
  functions: ['entity.name.function', 'support.function'],
  variables: ['variable', 'entity.name.variable'],
};

function isObj(v: unknown): v is Record<string, unknown> { return typeof v === 'object' && v !== null && !Array.isArray(v); }

function blockRules(block: Record<string, unknown>): TokenRule[] {
  const rules: TokenRule[] = [];
  for (const [key, scopes] of Object.entries(SHORTHANDS)) {
    const v = block[key];
    if (typeof v === 'string') rules.push({ scope: scopes, settings: { foreground: v } });
    else if (isObj(v)) {
      rules.push({
        scope: scopes,
        settings: {
          ...(typeof v.foreground === 'string' ? { foreground: v.foreground } : {}),
          ...(typeof v.fontStyle === 'string' ? { fontStyle: v.fontStyle } : {}),
        },
      });
    }
  }
  const tm = block.textMateRules;
  if (Array.isArray(tm)) {
    for (const r of tm) if (isObj(r) && isObj(r.settings)) rules.push(r as TokenRule);
  }
  return rules;
}

/**
 * `editor.tokenColorCustomizations` as rules, in application order: shorthand keys, `textMateRules`,
 * then the same for the `"[<themeLabel>]"` block.
 */
export function customizationRules(custom: unknown, themeLabel: string): TokenRule[] {
  if (!isObj(custom)) return [];
  const rules = blockRules(custom);
  const themed = custom[`[${themeLabel}]`];
  if (isObj(themed)) rules.push(...blockRules(themed));
  return rules;
}
