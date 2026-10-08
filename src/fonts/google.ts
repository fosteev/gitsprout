// Google Fonts, opt-in download (roadmap-settings decision 7). Pure part: CSS parsing, names, URLs, manifest.
// The host part (network, storage, quick picks) is in `store.ts`.

/** Curated families offered by the quick pick. */
export const GOOGLE_FONTS = [
  'JetBrains Mono', 'Fira Code', 'IBM Plex Mono', 'Source Code Pro', 'Roboto Mono',
  'Ubuntu Mono', 'Inconsolata', 'Space Mono', 'Red Hat Mono', 'Victor Mono',
] as const;

/** Desktop Chrome UA: with it Google serves woff2 split into `unicode-range` subsets. */
export const GOOGLE_FONTS_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

export interface CssFace { weight: number; style: string; url: string; unicodeRange?: string }
export interface ManifestFace { weight: number; style: string; file: string; unicodeRange?: string }
export interface FontManifest { family: string; faces: ManifestFace[] }

const FAMILY_RE = /^[A-Za-z0-9 ]{2,60}$/;

/** Error text for the "Other family…" input box; '' when valid. */
export function familyError(name: string): string {
  return FAMILY_RE.test(name) ? '' : 'Use 2-60 letters, digits and spaces.';
}

/** Folder name of a family: lower-case, runs of non-alphanumerics → '-'. */
export function slugFor(family: string): string {
  return family.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

/** css2 URL; `weights` false → the regular face only (retry after HTTP 400). */
export function cssUrl(family: string, weights = true): string {
  const name = family.trim().split(/\s+/).join('+');
  return `https://fonts.googleapis.com/css2?family=${name}${weights ? ':wght@400;700' : ''}&display=swap`;
}

/** Every `@font-face` block of a css2 response. Blocks without a woff2/url `src` are skipped; a weight range keeps its lower bound. */
export function parseGoogleCss(css: string): CssFace[] {
  const out: CssFace[] = [];
  const blocks = css.match(/@font-face\s*\{[^}]*\}/g) ?? [];
  for (const b of blocks) {
    const url = /src:[^;]*?url\(\s*['"]?([^'")\s]+)['"]?\s*\)/.exec(b)?.[1];
    if (!url) continue;
    const weight = Number(/font-weight:\s*(\d+)/.exec(b)?.[1] ?? 400);
    const style = /font-style:\s*([a-z]+)/.exec(b)?.[1] ?? 'normal';
    const unicodeRange = /unicode-range:\s*([^;]+);/.exec(b)?.[1]?.trim();
    out.push({ weight, style, url, ...(unicodeRange ? { unicodeRange } : {}) });
  }
  return out;
}

/** File name of face `n` inside the family folder. */
export function faceFile(n: number): string { return `${n}.woff2`; }

/** Manifest for downloaded faces (`faces[i]` was saved as `faceFile(i)`). */
export function buildManifest(family: string, faces: CssFace[]): FontManifest {
  return {
    family,
    faces: faces.map((f, i) => ({ weight: f.weight, style: f.style, file: faceFile(i), ...(f.unicodeRange ? { unicodeRange: f.unicodeRange } : {}) })),
  };
}

/** Defensive parse of `manifest.json`: null unless it has a family and at least one well-formed face. */
export function parseManifest(text: string): FontManifest | null {
  try {
    const m = JSON.parse(text) as Partial<FontManifest>;
    if (typeof m.family !== 'string' || !m.family || !Array.isArray(m.faces)) return null;
    const faces = m.faces.filter((f): f is ManifestFace =>
      !!f && typeof f.file === 'string' && /^[\w.-]+$/.test(f.file) && typeof f.weight === 'number' && typeof f.style === 'string');
    return faces.length ? { family: m.family, faces } : null;
  } catch { return null; }
}

/** First family of a CSS font-family list, unquoted (what `diff.fontFamily` holds after a download). */
export function firstFamily(list: string): string {
  return list.split(',')[0].trim().replace(/^["']|["']$/g, '');
}
