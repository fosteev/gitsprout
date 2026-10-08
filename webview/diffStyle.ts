// Applies the host's `DiffStyle` (gitsprout.diff.*) to the document. CSSOM only: the webview CSP has no 'unsafe-inline'.
import { TOKEN_KINDS, type DiffStyle } from '../src/graph/protocol';

/** Face URLs already registered (a face is added to `document.fonts` once). */
const loadedFaces = new Set<string>();

/** First family of a CSS font-family list, unquoted: the name a downloaded Google font is registered under. */
function firstFamily(list: string): string {
  const first = list.split(',')[0].trim();
  return first.replace(/^["']|["']$/g, '');
}

export function applyDiffStyle(style: DiffStyle, doc: Document = document): void {
  const root = doc.documentElement.style;
  // `auto` without resolved tokens (not resolved yet / unreadable theme) looks like `simple`.
  const auto = style.theme === 'auto' && style.tokens !== null;
  doc.body.dataset.hlTheme = style.theme === 'auto' && !auto ? 'simple' : style.theme;
  for (const k of TOKEN_KINDS) {
    const t = auto ? style.tokens?.[k] : undefined;
    const set = (suffix: string, value: string | undefined): void => {
      if (value) root.setProperty(`--tok-${k}${suffix}`, value);
      else root.removeProperty(`--tok-${k}${suffix}`);
    };
    set('', t?.color);
    set('-i', t?.italic ? 'italic' : undefined);
    set('-b', t?.bold ? 'bold' : undefined);
  }
  // a missing family falls back to the editor font, not the browser's default serif
  if (style.fontFamily) root.setProperty('--diff-font', `${style.fontFamily}, var(--mono)`); else root.removeProperty('--diff-font');
  if (style.fontSize > 0) root.setProperty('--diff-size', `${style.fontSize}px`); else root.removeProperty('--diff-size');
  if (typeof FontFace === 'undefined' || !doc.fonts) return;
  const family = firstFamily(style.fontFamily);
  for (const f of style.fontFaces) {
    if (!family || loadedFaces.has(f.url)) continue;
    loadedFaces.add(f.url);
    const face = new FontFace(family, `url("${f.url}")`, { weight: String(f.weight), style: f.style, ...(f.unicodeRange ? { unicodeRange: f.unicodeRange } : {}) });
    doc.fonts.add(face);
    face.load().catch(() => loadedFaces.delete(f.url));
  }
}
