import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { categoriesFromManifest, parseFromSettings, shownValue, validateValue } from '../src/settings/model';
import type { SettingSchema } from '../src/settings/protocol';

const pkg = JSON.parse(readFileSync(join(__dirname, '../package.json'), 'utf8'));

describe('categoriesFromManifest', () => {
  const cats = categoriesFromManifest(pkg.contributes.configuration);

  it('keeps the manifest order of categories and settings', () => {
    expect(cats.map((c) => c.title)).toEqual(['Diff', 'Graph', 'Repositories', 'Worktrees', 'Jira']);
    expect(cats[0].settings.map((s) => s.key)).toEqual(['diff.syntaxHighlighting', 'diff.highlightTheme', 'diff.fontFamily', 'diff.fontSize']);
  });

  it('covers every gitsprout.* property of the manifest with a supported type', () => {
    const declared = pkg.contributes.configuration.flatMap((c: { properties: object }) => Object.keys(c.properties)).sort();
    expect(cats.flatMap((c) => c.settings.map((s) => `gitsprout.${s.key}`)).sort()).toEqual(declared);
  });

  it('reads types, enums and bounds', () => {
    const by = Object.fromEntries(cats.flatMap((c) => c.settings).map((s) => [s.key, s]));
    expect(by['diff.highlightTheme']).toMatchObject({ type: 'string', enum: ['auto', 'simple', 'github', 'one'], default: 'auto' });
    expect(by['diff.fontSize']).toMatchObject({ type: 'number', minimum: 0, maximum: 40 });
    expect(by['scanExclude'].type).toBe('stringArray');
    expect(by['jira'].type).toBe('stringMap');
    expect(by['hideCi'].type).toBe('boolean');
  });

  it('sorts by order and skips foreign or unsupported properties', () => {
    const out = categoriesFromManifest([
      { title: 'B', order: 1, properties: { 'gitsprout.b': { type: 'boolean', order: 1 }, 'gitsprout.a': { type: 'boolean', order: 0 }, 'other.x': { type: 'boolean' }, 'gitsprout.o': { type: 'array', items: { type: 'number' } } } },
      { title: 'A', order: 0, properties: { 'gitsprout.c': { type: 'string' } } },
    ]);
    expect(out.map((c) => c.title)).toEqual(['A', 'B']);
    expect(out[1].settings.map((s) => s.key)).toEqual(['a', 'b']);
  });
});

describe('validateValue', () => {
  const s = (o: Partial<SettingSchema> & Pick<SettingSchema, 'type'>): SettingSchema => ({ key: 'k', default: null, description: '', ...o });
  it('checks type, enum and range', () => {
    expect(validateValue(s({ type: 'boolean' }), true)).toEqual({ ok: true, value: true });
    expect(validateValue(s({ type: 'boolean' }), 'yes').ok).toBe(false);
    expect(validateValue(s({ type: 'number', minimum: 0, maximum: 40 }), 40).ok).toBe(true);
    expect(validateValue(s({ type: 'number', minimum: 0, maximum: 40 }), 41).ok).toBe(false);
    expect(validateValue(s({ type: 'number', minimum: 0 }), -1).ok).toBe(false);
    expect(validateValue(s({ type: 'number' }), NaN).ok).toBe(false);
    expect(validateValue(s({ type: 'string', enum: ['a', 'b'] }), 'c').ok).toBe(false);
    expect(validateValue(s({ type: 'string', enum: ['a', 'b'] }), 'b').ok).toBe(true);
    expect(validateValue(s({ type: 'stringArray' }), ['x', 1]).ok).toBe(false);
    expect(validateValue(s({ type: 'stringMap' }), { A: 'u' })).toEqual({ ok: true, value: { A: 'u' } });
    expect(validateValue(s({ type: 'stringMap' }), { A: 1 }).ok).toBe(false);
    expect(validateValue(s({ type: 'stringMap' }), ['x']).ok).toBe(false);
  });
});

describe('shownValue', () => {
  it('scope value, else (workspace) user value, else default', () => {
    const i = { defaultValue: 1, globalValue: 2, workspaceValue: 3 };
    expect(shownValue(0, i, 'user')).toEqual({ value: 2, modified: true });
    expect(shownValue(0, i, 'workspace')).toEqual({ value: 3, modified: true });
    expect(shownValue(0, { defaultValue: 1, globalValue: 2 }, 'workspace')).toEqual({ value: 2, modified: false });
    expect(shownValue(0, { defaultValue: 1, workspaceValue: 3 }, 'user')).toEqual({ value: 1, modified: false });
    expect(shownValue(7, undefined, 'user')).toEqual({ value: 7, modified: false });
  });
});

describe('parseFromSettings', () => {
  it('accepts well-formed messages', () => {
    expect(parseFromSettings({ type: 'ready' })).toEqual({ type: 'ready' });
    expect(parseFromSettings({ type: 'scope', scope: 'workspace' })).toEqual({ type: 'scope', scope: 'workspace' });
    expect(parseFromSettings({ type: 'set', key: 'diff.fontSize', value: 14, scope: 'user' })).toEqual({ type: 'set', key: 'diff.fontSize', value: 14, scope: 'user' });
    expect(parseFromSettings({ type: 'reset', key: 'jira', scope: 'user' })).toEqual({ type: 'reset', key: 'jira', scope: 'user' });
    expect(parseFromSettings({ type: 'openJson', scope: 'user' })).toEqual({ type: 'openJson', scope: 'user' });
    expect(parseFromSettings({ type: 'removeFont', family: 'JetBrains Mono' })).toEqual({ type: 'removeFont', family: 'JetBrains Mono' });
  });
  it('rejects the rest', () => {
    for (const m of [null, 'x', {}, { type: 'nope' }, { type: 'scope', scope: 'global' }, { type: 'set', key: '', scope: 'user' }, { type: 'set', key: 'a b', scope: 'user' },
      { type: 'set', key: 'jira' }, { type: 'reset', key: 'x', scope: 'both' }, { type: 'removeFont', family: '' }, { type: 'removeFont', family: 5 }, { type: 'openJson' }]) {
      expect(parseFromSettings(m), JSON.stringify(m)).toBeUndefined();
    }
  });
});
