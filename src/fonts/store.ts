import * as vscode from 'vscode';
import type { FontFaceSrc } from '../graph/protocol';
import {
  buildManifest, cssUrl, faceFile, familyError, firstFamily, GOOGLE_FONTS, GOOGLE_FONTS_UA, parseGoogleCss, parseManifest, slugFor,
  type FontManifest,
} from './google';

const changed = new vscode.EventEmitter<void>();
/** Fired after a font was downloaded or removed: graph tabs re-post `diffStyle`. */
export const onDidChangeFonts: vscode.Event<void> = changed.event;
export const notifyFontsChanged = (): void => changed.fire();

const fontsDir = (storage: vscode.Uri): vscode.Uri => vscode.Uri.joinPath(storage, 'fonts');
const dec = new TextDecoder();
const enc = new TextEncoder();

/** Downloaded families (from each folder's manifest). */
export async function downloadedFonts(storage: vscode.Uri): Promise<FontManifest[]> {
  let entries: [string, vscode.FileType][];
  try { entries = await vscode.workspace.fs.readDirectory(fontsDir(storage)); } catch { return []; }
  const out: FontManifest[] = [];
  for (const [name, type] of entries) {
    if (type !== vscode.FileType.Directory) continue;
    try {
      const m = parseManifest(dec.decode(await vscode.workspace.fs.readFile(vscode.Uri.joinPath(fontsDir(storage), name, 'manifest.json'))));
      if (m) out.push(m);
    } catch { /* unreadable folder: not a downloaded font */ }
  }
  return out;
}

/** Webview URIs of the downloaded family named by `fontFamily` (first family of the list); [] when not downloaded. */
export async function fontFaces(storage: vscode.Uri, fontFamily: string, webview: vscode.Webview): Promise<FontFaceSrc[]> {
  const family = firstFamily(fontFamily);
  if (!family) return [];
  const slug = slugFor(family);
  if (!slug) return [];
  let manifest: FontManifest | null;
  try {
    manifest = parseManifest(dec.decode(await vscode.workspace.fs.readFile(vscode.Uri.joinPath(fontsDir(storage), slug, 'manifest.json'))));
  } catch { return []; }
  if (!manifest || manifest.family.toLowerCase() !== family.toLowerCase()) return [];
  return manifest.faces.map((f) => ({
    weight: f.weight, style: f.style,
    url: webview.asWebviewUri(vscode.Uri.joinPath(fontsDir(storage), slug, f.file)).toString(),
    ...(f.unicodeRange ? { unicodeRange: f.unicodeRange } : {}),
  }));
}

async function get(url: string, text: boolean): Promise<Response> {
  return fetch(url, text ? { headers: { 'User-Agent': GOOGLE_FONTS_UA } } : undefined);
}

/** Downloads every subset of `family` into globalStorage; returns the family name as stored. Throws with a user-facing message. */
export async function downloadGoogleFont(storage: vscode.Uri, family: string, progress?: (msg: string) => void): Promise<string> {
  family = family.trim().split(/\s+/).join(' ');
  const bad = familyError(family);
  if (bad) throw new Error(bad);
  let res = await get(cssUrl(family, true), true);
  if (res.status === 400) res = await get(cssUrl(family, false), true); // no 400/700 axis: regular only
  if (!res.ok) throw new Error(`Google Fonts has no family “${family}”`);
  const faces = parseGoogleCss(await res.text());
  if (!faces.length) throw new Error(`Google Fonts has no family “${family}”`);
  const dir = vscode.Uri.joinPath(fontsDir(storage), slugFor(family));
  await vscode.workspace.fs.createDirectory(dir);
  for (let i = 0; i < faces.length; i++) {
    progress?.(`${i + 1} / ${faces.length}`);
    const file = await get(faces[i].url, false);
    if (!file.ok) throw new Error(`Downloading “${family}” failed: HTTP ${file.status}`);
    await vscode.workspace.fs.writeFile(vscode.Uri.joinPath(dir, faceFile(i)), new Uint8Array(await file.arrayBuffer()));
  }
  // manifest last: a half-downloaded family is not listed
  await vscode.workspace.fs.writeFile(vscode.Uri.joinPath(dir, 'manifest.json'), enc.encode(JSON.stringify(buildManifest(family, faces), null, 2)));
  return family;
}

export async function removeGoogleFont(storage: vscode.Uri, family: string): Promise<void> {
  await vscode.workspace.fs.delete(vscode.Uri.joinPath(fontsDir(storage), slugFor(family)), { recursive: true, useTrash: false });
}

const OTHER = 'Other family…';

/** Quick pick for the download command; undefined = cancelled. */
export async function pickFamilyToDownload(storage: vscode.Uri): Promise<string | undefined> {
  const have = new Set((await downloadedFonts(storage)).map((m) => m.family.toLowerCase()));
  const items: vscode.QuickPickItem[] = [
    ...GOOGLE_FONTS.map((f) => ({ label: f, description: have.has(f.toLowerCase()) ? 'downloaded' : undefined })),
    { label: OTHER },
  ];
  const pick = await vscode.window.showQuickPick(items, { placeHolder: 'Google Font to download for the graph diff' });
  if (!pick) return undefined;
  if (pick.label !== OTHER) return pick.label;
  return vscode.window.showInputBox({
    prompt: 'Google Fonts family name',
    placeHolder: 'e.g. Noto Sans Mono',
    validateInput: (v) => familyError(v.trim()) || undefined,
  }).then((v) => v?.trim() || undefined);
}
