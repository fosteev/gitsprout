// Pure text helpers of the graph UI (no DOM): escaping, relative dates, subject parsing.

export function esc(s: string): string {
  return s.replace(/[&<>"']/g, (ch) => (ch === '&' ? '&amp;' : ch === '<' ? '&lt;' : ch === '>' ? '&gt;' : ch === '"' ? '&quot;' : '&#39;'));
}

/** Minutes → `now`, `5m`, `3h`, `12d`, `4mo`, `2y`. */
export function fmtAgo(min: number): string {
  if (min < 1) return 'now';
  if (min < 60) return `${min}m`;
  if (min < 1440) return `${Math.round(min / 60)}h`;
  const d = Math.round(min / 1440);
  if (d < 60) return `${d}d`;
  if (d < 730) return `${Math.round(d / 30)}mo`;
  return `${Math.round(d / 365)}y`;
}

export function fmtAgoLong(min: number): string {
  if (min < 1) return 'just now';
  if (min < 60) return `${min} ${min === 1 ? 'minute' : 'minutes'} ago`;
  if (min < 1440) { const h = Math.round(min / 60); return `${h} ${h === 1 ? 'hour' : 'hours'} ago`; }
  const d = Math.round(min / 1440);
  return `${d} ${d === 1 ? 'day' : 'days'} ago`;
}

/** Whole minutes between a unix time (seconds) and `nowMs`, never negative. */
export function minutesAgo(unixSeconds: number, nowMs: number): number {
  return Math.max(0, Math.floor((nowMs - unixSeconds * 1000) / 60000));
}

export interface ParsedSubject {
  /** `P7-4040` (project key + id) or ''. */
  key: string;
  /** Project part of the key. */
  project: string;
  /** Numeric id; only all-digit ids link to Jira. */
  numeric: boolean;
  /** `FIX` from a `[ FIX ]` tag or ''. */
  kind: string;
  rest: string;
}

/** Splits `KEY-123 [ KIND ] text` as the prototype's msgHtml() did. */
export function parseSubject(msg: string): ParsedSubject {
  let rest = msg;
  let key = '', project = '', numeric = false, kind = '';
  const mk = rest.match(/^([A-Z][A-Z0-9]*)-([A-Za-z0-9]+)\s+/);
  if (mk) { project = mk[1]; key = `${mk[1]}-${mk[2]}`; numeric = /^\d+$/.test(mk[2]); rest = rest.slice(mk[0].length); }
  const mt = rest.match(/^\[\s*([A-Z]+)\s*\]\s*/);
  if (mt) { kind = mt[1]; rest = rest.slice(mt[0].length); }
  return { key, project, numeric, kind, rest };
}

/** Jira link for a parsed subject, or undefined (unknown project, non-numeric id, or no base configured). */
export function jiraUrl(p: ParsedSubject, jira: Record<string, string>): string | undefined {
  const base = p.key && p.numeric ? jira[p.project] : undefined;
  return base ? base + p.key : undefined;
}

/** A matcher for CI subjects from `gitsprout.ciPattern`; an empty or invalid pattern matches nothing. */
export function ciMatcher(pattern: string): (subject: string) => boolean {
  if (!pattern) return () => false;
  try {
    const re = new RegExp(pattern);
    return (s) => re.test(s);
  } catch {
    return () => false;
  }
}

export function splitPath(p: string): [dir: string, base: string] {
  const i = p.lastIndexOf('/');
  return [i >= 0 ? p.slice(0, i) : '', p.slice(i + 1)];
}
