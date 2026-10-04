/** Pure helpers for commit messages (the WIP panel's summary + description <-> one git message). */

const normalize = (s: string): string => s.replace(/\r\n?/g, '\n');

/**
 * Summary + description -> the message passed to `git commit -F -`: `summary`, a blank line, `description` (both
 * trimmed, CRLF -> LF). null = the summary is empty (nothing to commit with, even if the description is not).
 */
export function commitMessage(summary: string, description: string): string | null {
  const s = normalize(summary).trim();
  if (!s) return null;
  const d = normalize(description).trim();
  return d ? `${s}\n\n${d}` : s;
}

/**
 * A commit body (`%B`) -> summary (the first line) and description (the rest, trimmed). The inverse of `commitMessage`
 * for a tidy message. A multi-line first paragraph keeps its other lines in the description, so the single-line summary
 * input never glues them together.
 */
export function splitMessage(body: string): { summary: string; description: string } {
  const text = normalize(body).trim();
  const nl = text.indexOf('\n');
  if (nl < 0) return { summary: text, description: '' };
  return { summary: text.slice(0, nl).trim(), description: text.slice(nl + 1).trim() };
}
