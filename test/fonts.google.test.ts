import { describe, expect, it } from 'vitest';
import { buildManifest, cssUrl, familyError, firstFamily, parseGoogleCss, parseManifest, slugFor } from '../src/fonts/google';

const CSS = `/* cyrillic */
@font-face {
  font-family: 'JetBrains Mono';
  font-style: normal;
  font-weight: 400;
  font-display: swap;
  src: url(https://fonts.gstatic.com/s/jetbrainsmono/v18/cyr400.woff2) format('woff2');
  unicode-range: U+0301, U+0400-045F, U+0490-0491;
}
/* latin */
@font-face {
  font-family: 'JetBrains Mono';
  font-style: normal;
  font-weight: 400;
  font-display: swap;
  src: url(https://fonts.gstatic.com/s/jetbrainsmono/v18/lat400.woff2) format('woff2');
  unicode-range: U+0000-00FF, U+0131;
}
/* latin */
@font-face {
  font-family: 'JetBrains Mono';
  font-style: normal;
  font-weight: 700;
  font-display: swap;
  src: url("https://fonts.gstatic.com/s/jetbrainsmono/v18/lat700.woff2") format('woff2');
  unicode-range: U+0000-00FF, U+0131;
}
@font-face {
  font-family: 'JetBrains Mono';
  font-style: italic;
  font-weight: 100 800;
  src: url(https://fonts.gstatic.com/s/jetbrainsmono/v18/all.woff2) format('woff2');
}
`;

describe('parseGoogleCss', () => {
  const faces = parseGoogleCss(CSS);
  it('reads every subset with weight, style and url', () => {
    expect(faces).toHaveLength(4);
    expect(faces[0]).toEqual({ weight: 400, style: 'normal', url: 'https://fonts.gstatic.com/s/jetbrainsmono/v18/cyr400.woff2', unicodeRange: 'U+0301, U+0400-045F, U+0490-0491' });
    expect(faces[2].weight).toBe(700);
    expect(faces[2].url).toBe('https://fonts.gstatic.com/s/jetbrainsmono/v18/lat700.woff2');
  });
  it('a face without unicode-range has no key; a weight range keeps its lower bound', () => {
    expect(faces[3]).toEqual({ weight: 100, style: 'italic', url: 'https://fonts.gstatic.com/s/jetbrainsmono/v18/all.woff2' });
    expect('unicodeRange' in faces[3]).toBe(false);
  });
  it('garbage → no faces', () => {
    expect(parseGoogleCss('')).toEqual([]);
    expect(parseGoogleCss('@font-face { font-family: x; }')).toEqual([]);
  });
});

describe('helpers', () => {
  it('slugFor', () => {
    expect(slugFor('JetBrains Mono')).toBe('jetbrains-mono');
    expect(slugFor(' IBM  Plex Mono ')).toBe('ibm-plex-mono');
  });
  it('cssUrl', () => {
    expect(cssUrl('Fira Code')).toBe('https://fonts.googleapis.com/css2?family=Fira+Code:wght@400;700&display=swap');
    expect(cssUrl('Fira Code', false)).toBe('https://fonts.googleapis.com/css2?family=Fira+Code&display=swap');
  });
  it('familyError', () => {
    expect(familyError('Noto Sans Mono')).toBe('');
    for (const bad of ['', 'a', 'x'.repeat(61), 'Fira/Code', 'A&B', 'Évo']) expect(familyError(bad), bad).not.toBe('');
  });
  it('firstFamily', () => {
    expect(firstFamily('"Fira Code", monospace')).toBe('Fira Code');
    expect(firstFamily('Menlo')).toBe('Menlo');
  });
});

describe('manifest', () => {
  it('buildManifest numbers the files and round-trips', () => {
    const m = buildManifest('JetBrains Mono', parseGoogleCss(CSS));
    expect(m.faces.map((f) => f.file)).toEqual(['0.woff2', '1.woff2', '2.woff2', '3.woff2']);
    expect(m.faces[0].unicodeRange).toBe('U+0301, U+0400-045F, U+0490-0491');
    expect(parseManifest(JSON.stringify(m))).toEqual(m);
  });
  it('parseManifest rejects junk and path-like file names', () => {
    expect(parseManifest('nope')).toBeNull();
    expect(parseManifest('{"family":"X","faces":[]}')).toBeNull();
    expect(parseManifest('{"family":"X","faces":[{"weight":400,"style":"normal","file":"../../x"}]}')).toBeNull();
  });
});
