import { describe, expect, it } from 'vitest';
import { highlightLines, languageFor, MAX_HIGHLIGHT_CHARS } from '../webview/highlight';

describe('languageFor', () => {
  it('maps extensions', () => {
    const cases: Record<string, string> = {
      'src/a.ts': 'typescript', 'a.TSX': 'typescript', 'a.mts': 'typescript', 'a.cjs': 'javascript', 'a.jsx': 'javascript',
      'package.json': 'json', 'tsconfig.jsonc': 'json', 'x/index.html': 'xml', 'a.svg': 'xml', 'App.vue': 'xml',
      'a.css': 'css', 'a.scss': 'scss', 'a.less': 'less', 'README.md': 'markdown', 'ci.yml': 'yaml', 'ci.yaml': 'yaml',
      'run.sh': 'bash', 'run.zsh': 'bash', 'a.py': 'python', 'a.go': 'go', 'a.rs': 'rust', 'A.java': 'java', 'a.kts': 'kotlin',
      'a.swift': 'swift', 'a.c': 'c', 'a.h': 'c', 'a.hpp': 'cpp', 'a.cc': 'cpp', 'a.cs': 'csharp', 'a.php': 'php', 'a.rb': 'ruby',
      'a.sql': 'sql', 'a.dart': 'dart', 'a.toml': 'ini', 'a.cfg': 'ini', 'a.properties': 'ini', 'rules.mk': 'makefile',
    };
    for (const [path, lang] of Object.entries(cases)) expect([path, languageFor(path)]).toEqual([path, lang]);
  });
  it('maps well-known basenames', () => {
    expect(languageFor('Dockerfile')).toBe('dockerfile');
    expect(languageFor('docker/Dockerfile')).toBe('dockerfile');
    expect(languageFor('build/Makefile')).toBe('makefile');
  });
  it('unknown → null', () => {
    expect(languageFor('a.xyz')).toBeNull();
    expect(languageFor('LICENSE')).toBeNull();
    expect(languageFor('dir.ts/noext')).toBeNull();
  });
});

describe('highlightLines', () => {
  it('wraps tokens in hljs spans', () => {
    expect(highlightLines(['const x = 1;'], 'typescript')[0]).toContain('<span class="hljs-keyword">const</span>');
    expect(highlightLines(['const x = 1;'], 'typescript')[0]).toContain('<span class="hljs-number">1</span>');
  });

  it('splits a multi-line block comment, closing and reopening the span on every line', () => {
    const out = highlightLines(['/* a', ' b', ' c */ x'], 'javascript');
    expect(out).toHaveLength(3);
    expect(out[0]).toBe('<span class="hljs-comment">/* a</span>');
    expect(out[1]).toBe('<span class="hljs-comment"> b</span>');
    expect(out[2]).toBe('<span class="hljs-comment"> c */</span> x');
  });

  it('splits a multi-line template string; every line is balanced', () => {
    const out = highlightLines(['const s = `one', 'two ${a}', 'three`;'], 'javascript');
    expect(out).toHaveLength(3);
    for (const l of out) expect((l.match(/<span/g) ?? []).length).toBe((l.match(/<\/span>/g) ?? []).length);
    expect(out[1]).toMatch(/^<span class="hljs-string">two /);
    expect(out[2]).toMatch(/^<span class="hljs-string">three`<\/span>;$/);
  });

  it('keeps nested spans open across lines in the right order', () => {
    const out = highlightLines(['/**', ' * @param {number} x', ' */'], 'javascript');
    expect(out).toHaveLength(3);
    expect(out[1]).toContain('<span class="hljs-comment"> * <span class="hljs-doctag">@param</span> ');
  });

  it('escapes HTML in code', () => {
    const out = highlightLines(['<div class="a">&</div>'], 'xml').join('');
    expect(out).not.toContain('<div');
    expect(out).toContain('&lt;');
    expect(out).toContain('&amp;');
    const plain = highlightLines(['a < b && "c"'], null);
    expect(plain).toEqual(['a &lt; b &amp;&amp; &quot;c&quot;']);
  });

  it('unknown or missing language → escaped plain text', () => {
    expect(highlightLines(['<b>'], 'nope')).toEqual(['&lt;b&gt;']);
    expect(highlightLines(['<b>'], null)).toEqual(['&lt;b&gt;']);
  });

  it('empty input → empty output', () => expect(highlightLines([], 'typescript')).toEqual([]));

  it('an oversized block is not highlighted', () => {
    const big = ['x'.repeat(MAX_HIGHLIGHT_CHARS + 1)];
    expect(highlightLines(big, 'typescript')).toEqual(big);
  });

  it('always returns one entry per input line', () => {
    const lines = ['', 'function f() {', '', '  return "a\\', 'b";', '}', ''];
    expect(highlightLines(lines, 'typescript')).toHaveLength(lines.length);
  });
});
