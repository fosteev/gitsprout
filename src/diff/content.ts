import { Repo } from '../git/repo';
import type { DiffTarget } from './uri';

/** Like git: a NUL in the first 8000 bytes means binary. */
export function looksBinary(text: string): boolean {
  return text.slice(0, 8000).includes('\0');
}

/** Stand-in text for a binary blob; the id keeps two different binaries from diffing as equal. */
export function binaryPlaceholder(info: { oid: string; size: number } | undefined): string {
  return info ? `Binary file ${info.oid.slice(0, 7)} (${info.size} bytes)\n` : 'Binary file\n';
}

/** Text of a diff side (no `vscode`, so it is testable on temp repos): `''` ref = empty, `:` = index, missing = empty. */
export async function readTarget(t: DiffTarget, gitPath?: string): Promise<string> {
  if (t.ref === '') return '';
  const repo = new Repo(t.root, gitPath);
  const text = await repo.show(t.ref, t.path);
  if (!looksBinary(text)) return text;
  return binaryPlaceholder(await repo.blobInfo(t.ref, t.path).catch(() => undefined));
}
