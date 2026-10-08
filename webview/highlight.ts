// Syntax highlighting of diff lines (highlight.js core + an explicit language list, so the bundle stays small).
import hljs from 'highlight.js/lib/core';
import bash from 'highlight.js/lib/languages/bash';
import c from 'highlight.js/lib/languages/c';
import cpp from 'highlight.js/lib/languages/cpp';
import csharp from 'highlight.js/lib/languages/csharp';
import css from 'highlight.js/lib/languages/css';
import dart from 'highlight.js/lib/languages/dart';
import dockerfile from 'highlight.js/lib/languages/dockerfile';
import go from 'highlight.js/lib/languages/go';
import ini from 'highlight.js/lib/languages/ini';
import java from 'highlight.js/lib/languages/java';
import javascript from 'highlight.js/lib/languages/javascript';
import json from 'highlight.js/lib/languages/json';
import kotlin from 'highlight.js/lib/languages/kotlin';
import less from 'highlight.js/lib/languages/less';
import makefile from 'highlight.js/lib/languages/makefile';
import markdown from 'highlight.js/lib/languages/markdown';
import php from 'highlight.js/lib/languages/php';
import python from 'highlight.js/lib/languages/python';
import ruby from 'highlight.js/lib/languages/ruby';
import rust from 'highlight.js/lib/languages/rust';
import scss from 'highlight.js/lib/languages/scss';
import sql from 'highlight.js/lib/languages/sql';
import swift from 'highlight.js/lib/languages/swift';
import typescript from 'highlight.js/lib/languages/typescript';
import xml from 'highlight.js/lib/languages/xml';
import yaml from 'highlight.js/lib/languages/yaml';
import { esc } from './format';

const LANGUAGES = {
  bash, c, cpp, csharp, css, dart, dockerfile, go, ini, java, javascript, json, kotlin, less, makefile, markdown,
  php, python, ruby, rust, scss, sql, swift, typescript, xml, yaml,
};
for (const [name, def] of Object.entries(LANGUAGES)) hljs.registerLanguage(name, def);

/** One side of a hunk above this many characters is shown as plain text. */
export const MAX_HIGHLIGHT_CHARS = 500_000;

const BY_EXT: Record<string, string> = {
  ts: 'typescript', tsx: 'typescript', mts: 'typescript', cts: 'typescript',
  js: 'javascript', jsx: 'javascript', mjs: 'javascript', cjs: 'javascript',
  json: 'json', jsonc: 'json',
  html: 'xml', htm: 'xml', xml: 'xml', svg: 'xml', vue: 'xml',
  css: 'css', scss: 'scss', less: 'less',
  md: 'markdown', markdown: 'markdown',
  yml: 'yaml', yaml: 'yaml',
  sh: 'bash', bash: 'bash', zsh: 'bash',
  py: 'python', go: 'go', rs: 'rust', java: 'java', kt: 'kotlin', kts: 'kotlin', swift: 'swift',
  c: 'c', h: 'c', cpp: 'cpp', cc: 'cpp', cxx: 'cpp', hpp: 'cpp', hh: 'cpp',
  cs: 'csharp', php: 'php', rb: 'ruby', sql: 'sql', dart: 'dart',
  ini: 'ini', toml: 'ini', cfg: 'ini', properties: 'ini',
  mk: 'makefile',
};
const BY_NAME: Record<string, string> = { dockerfile: 'dockerfile', makefile: 'makefile' };

/** highlight.js language of a repo-relative path, or null (unknown → shown as plain text). */
export function languageFor(path: string): string | null {
  const base = path.slice(path.lastIndexOf('/') + 1).toLowerCase();
  const byName = BY_NAME[base];
  if (byName) return byName;
  const dot = base.lastIndexOf('.');
  if (dot < 0) return null;
  return BY_EXT[base.slice(dot + 1)] ?? null;
}

const TOKEN = /<span class="([^"]*)">|<\/span>|\n/g;

/** Splits highlight.js HTML at line breaks, closing the open spans at the end of a line and reopening them on the next. */
function splitHtml(html: string): string[] {
  const lines: string[] = [];
  const open: string[] = [];
  let cur = '';
  let at = 0;
  const close = (): string => '</span>'.repeat(open.length);
  const reopen = (): string => open.map((cls) => `<span class="${cls}">`).join('');
  for (const m of html.matchAll(TOKEN)) {
    cur += html.slice(at, m.index);
    at = m.index + m[0].length;
    if (m[0] === '\n') {
      lines.push(cur + close());
      cur = reopen();
    } else if (m[0] === '</span>') {
      open.pop();
      cur += m[0];
    } else {
      open.push(m[1]);
      cur += m[0];
    }
  }
  lines.push(cur + html.slice(at) + close());
  return lines;
}

const plain = (lines: readonly string[]): string[] => lines.map(esc);

/**
 * Highlights `lines` (one side of a hunk) as one block and returns one HTML string per line.
 * Falls back to escaped plain text on an unknown language, an exception, a line-count mismatch or an oversized block.
 */
export function highlightLines(lines: readonly string[], lang: string | null): string[] {
  if (!lang || lines.length === 0 || !hljs.getLanguage(lang)) return plain(lines);
  const code = lines.join('\n');
  if (code.length > MAX_HIGHLIGHT_CHARS) return plain(lines);
  try {
    const out = splitHtml(hljs.highlight(code, { language: lang, ignoreIllegals: true }).value);
    return out.length === lines.length ? out : plain(lines);
  } catch {
    return plain(lines);
  }
}
