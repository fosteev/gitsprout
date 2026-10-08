import { describe, expect, it } from 'vitest';
import { loadThemeRules } from '../src/theme/chain';
import { customizationRules, matchRules, parseJsonc, resolveTokens, type TokenRule } from '../src/theme/tokens';

describe('parseJsonc', () => {
  it('handles comments, trailing commas, comment markers inside strings and BOM', () => {
    const text = '﻿// head\n{\n  /* block */ "a": "http://x // not a comment",\n  "b": [1, 2,], // tail\n  "c": {"d": "/* no */",},\n}\n';
    expect(parseJsonc(text)).toEqual({ a: 'http://x // not a comment', b: [1, 2], c: { d: '/* no */' } });
  });
  it('handles escaped quotes in strings', () => {
    expect(parseJsonc('{"a": "q\\"//x", "b": 1,}')).toEqual({ a: 'q"//x', b: 1 });
  });
  it('throws on garbage', () => {
    expect(() => parseJsonc('{ nope')).toThrow();
  });
});

describe('matchRules', () => {
  const r = (scope: string | string[], foreground?: string, fontStyle?: string): TokenRule => ({ scope, settings: { foreground, fontStyle } });

  it('matches by prefix on dot boundaries only', () => {
    const rules = [r('string', '#111111')];
    expect(matchRules(rules, 'string').color).toBe('#111111');
    expect(matchRules(rules, 'string.regexp').color).toBe('#111111');
    expect(matchRules(rules, 'stringy').color).toBeUndefined();
  });
  it('more specific selector wins regardless of order; later wins a tie', () => {
    const rules = [r('string.regexp', '#222222'), r('string', '#111111'), r('string', '#333333')];
    expect(matchRules(rules, 'string.regexp').color).toBe('#222222');
    expect(matchRules(rules, 'string.quoted').color).toBe('#333333');
  });
  it('resolves colour and fontStyle independently; empty fontStyle clears', () => {
    const rules = [r('comment', '#6a9955', 'italic'), r('comment', undefined, '')];
    expect(matchRules(rules, 'comment')).toEqual({ color: '#6a9955', fontStyle: '' });
  });
  it('splits comma and array selectors', () => {
    expect(matchRules([r('keyword, storage', '#aa0000')], 'storage.type').color).toBe('#aa0000');
    expect(matchRules([r(['x.y', 'keyword'], '#bb0000')], 'keyword.control').color).toBe('#bb0000');
  });
  it('skips descendant and exclusion selectors', () => {
    expect(matchRules([r('source.ts string', '#111111')], 'string').color).toBeUndefined();
    expect(matchRules([r('string - comment', '#111111')], 'string').color).toBeUndefined();
    expect(matchRules([r('string, source.ts string', '#222222')], 'string').color).toBe('#222222');
  });
  it('ignores rules without scope and invalid colours', () => {
    expect(matchRules([{ settings: { foreground: '#ffffff' } }, r('string', 'red')], 'string')).toEqual({});
  });
  it('keeps hyphenated scope names', () => {
    expect(matchRules([r('support.type.property-name', '#9cdcfe')], 'support.type.property-name.json').color).toBe('#9cdcfe');
  });
});

describe('resolveTokens', () => {
  it('first scope with a colour wins; italic and bold from fontStyle', () => {
    const t = resolveTokens([
      { scope: 'storage.type', settings: { foreground: '#569cd6', fontStyle: 'italic bold' } },
      { scope: 'comment', settings: { foreground: '#6a9955', fontStyle: 'italic' } },
      { scope: 'keyword.control', settings: { foreground: '#c586c0' } },
    ]);
    expect(t.comment).toEqual({ color: '#6a9955', italic: true });
    expect(t.keyword).toEqual({ color: '#569cd6', italic: true, bold: true });
    expect(t.string).toBeUndefined();
  });
  it('falls through the scope list', () => {
    const t = resolveTokens([{ scope: 'support.type', settings: { foreground: '#4ec9b0' } }]);
    expect(t.type).toEqual({ color: '#4ec9b0' });
    expect(t.builtIn).toEqual({ color: '#4ec9b0' });
  });
  it('empty fontStyle clears italic', () => {
    const t = resolveTokens([
      { scope: 'comment', settings: { foreground: '#6a9955', fontStyle: 'italic' } },
      { scope: 'comment', settings: { fontStyle: '' } },
    ]);
    expect(t.comment).toEqual({ color: '#6a9955' });
  });
});

describe('customizationRules', () => {
  const base: TokenRule[] = [{ scope: 'comment', settings: { foreground: '#111111' } }];
  const apply = (custom: unknown, label = 'Dark Modern') => resolveTokens([...base, ...customizationRules(custom, label)]);

  it('maps shorthand keys', () => {
    const t = apply({ comments: '#222222', strings: { foreground: '#333333', fontStyle: 'bold' }, keywords: '#444444', numbers: '#555555', types: '#666666', functions: '#777777', variables: '#888888' });
    expect(t.comment?.color).toBe('#222222');
    expect(t.string).toEqual({ color: '#333333', bold: true });
    expect(t.keyword?.color).toBe('#444444');
    expect(t.number?.color).toBe('#555555');
    expect(t.type?.color).toBe('#666666');
    expect(t.function?.color).toBe('#777777');
    expect(t.variable?.color).toBe('#888888');
  });
  it('textMateRules go after shorthand; theme block goes last', () => {
    const t = apply({
      comments: '#222222',
      textMateRules: [{ scope: 'comment', settings: { foreground: '#999999' } }],
      '[Dark Modern]': { comments: '#aaaaaa' },
      '[Other]': { comments: '#bbbbbb' },
    });
    expect(t.comment?.color).toBe('#aaaaaa');
    expect(apply({ comments: '#222222', textMateRules: [{ scope: 'comment', settings: { foreground: '#999999' } }] }).comment?.color).toBe('#999999');
  });
  it('tolerates junk', () => {
    expect(customizationRules(undefined, 'x')).toEqual([]);
    expect(customizationRules({ textMateRules: 5, comments: 7 }, 'x')).toEqual([]);
  });
});

describe('loadThemeRules', () => {
  const files: Record<string, string> = {
    '/t/dark_modern.json': '{ // modern\n "include": "./dark_plus.json", "tokenColors": [ {"scope": "comment", "settings": {"foreground": "#6a9955"}}, ] }',
    '/t/dark_plus.json': '{ "include": "./dark_vs.json", "tokenColors": [ {"scope": ["keyword", "storage"], "settings": {"foreground": "#569cd6"}}, ], }',
    '/t/dark_vs.json': '{ "tokenColors": [ {"scope": "comment", "settings": {"foreground": "#000000", "fontStyle": "italic"}}, {"scope": "string", "settings": {"foreground": "#ce9178"}} ] }',
    '/t/ext.json': '{ "include": "./ext-tokens.json" }',
    '/t/ext-tokens.json': '{ "settings": [ {"settings": {"foreground": "#fff"}}, {"scope": "string", "settings": {"foreground": "#00ff00"}} ] }',
    '/t/tm.json': '{ "tokenColors": "./theme.tmTheme" }',
    '/t/loop.json': '{ "include": "./loop.json" }',
    '/t/bad.json': '{ nope',
  };
  const read = async (p: string): Promise<string> => {
    const f = files[p];
    if (f === undefined) throw new Error(`ENOENT ${p}`);
    return f;
  };

  it('follows the include chain with base rules first', async () => {
    const rules = await loadThemeRules('/t/dark_modern.json', read);
    expect(rules).toHaveLength(4);
    const t = resolveTokens(rules!);
    expect(t.comment).toEqual({ color: '#6a9955', italic: true }); // later colour, earlier fontStyle
    expect(t.keyword?.color).toBe('#569cd6');
    expect(t.string?.color).toBe('#ce9178');
  });
  it('reads rules from a JSON file named by tokenColors / include with a settings array', async () => {
    const rules = await loadThemeRules('/t/ext.json', read);
    expect(resolveTokens(rules!).string?.color).toBe('#00ff00');
  });
  it('returns null for .tmTheme, missing files, loops and invalid JSON', async () => {
    expect(await loadThemeRules('/t/tm.json', read)).toBeNull();
    expect(await loadThemeRules('/t/theme.tmTheme', read)).toBeNull();
    expect(await loadThemeRules('/t/missing.json', read)).toBeNull();
    expect(await loadThemeRules('/t/loop.json', read)).toBeNull();
    expect(await loadThemeRules('/t/bad.json', read)).toBeNull();
  });
});
