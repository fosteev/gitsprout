// Pure helpers of the settings page: the schema read from the manifest, value validation, the shown value, message checks.
import type { FromSettings, SettingSchema, SettingsCategory, SettingsScope, SettingType } from './protocol';

export const SETTINGS_PREFIX = 'gitsprout.';

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
const order = (o: unknown): number => num(isObj(o) ? o.order : undefined) ?? 0;

function typeOf(p: Record<string, unknown>): SettingType | undefined {
  if (p.type === 'boolean' || p.type === 'number' || p.type === 'string') return p.type;
  if (p.type === 'array' && isObj(p.items) && p.items.type === 'string') return 'stringArray';
  if (p.type === 'object' && isObj(p.additionalProperties) && p.additionalProperties.type === 'string') return 'stringMap';
  return undefined;
}

/**
 * The categories of `contributes.configuration` (an array of `{ title, order, properties }`; a single object is accepted too),
 * sorted by `order`. Properties outside `gitsprout.` or of an unsupported shape are skipped.
 */
export function categoriesFromManifest(configuration: unknown): SettingsCategory[] {
  const blocks = (Array.isArray(configuration) ? configuration : [configuration]).filter(isObj);
  return blocks
    .map((b, i) => ({ b, i }))
    .sort((x, y) => order(x.b) - order(y.b) || x.i - y.i)
    .map(({ b }): SettingsCategory => {
      const props = isObj(b.properties) ? Object.entries(b.properties) : [];
      const settings = props
        .filter(([k]) => k.startsWith(SETTINGS_PREFIX) && k.length > SETTINGS_PREFIX.length)
        .map(([k, p], i) => ({ k, p, i }))
        .sort((x, y) => order(x.p) - order(y.p) || x.i - y.i)
        .flatMap(({ k, p }): SettingSchema[] => {
          if (!isObj(p)) return [];
          const type = typeOf(p);
          if (!type) return [];
          const s: SettingSchema = { key: k.slice(SETTINGS_PREFIX.length), type, default: p.default, description: typeof p.description === 'string' ? p.description : '' };
          if (type === 'string' && Array.isArray(p.enum) && p.enum.every((e) => typeof e === 'string')) {
            s.enum = p.enum as string[];
            if (Array.isArray(p.enumDescriptions)) s.enumDescriptions = p.enumDescriptions.map((d) => (typeof d === 'string' ? d : ''));
          }
          if (type === 'number') {
            const min = num(p.minimum), max = num(p.maximum);
            if (min !== undefined) s.minimum = min;
            if (max !== undefined) s.maximum = max;
          }
          return [s];
        });
      return { title: typeof b.title === 'string' ? b.title : '', settings };
    })
    .filter((c) => c.settings.length > 0);
}

/** `ok: false` carries the reason for the log line; the value is dropped. */
export type Checked = { ok: true; value: unknown } | { ok: false; reason: string };

export function validateValue(s: SettingSchema, v: unknown): Checked {
  const bad = (reason: string): Checked => ({ ok: false, reason });
  switch (s.type) {
    case 'boolean': return typeof v === 'boolean' ? { ok: true, value: v } : bad('not a boolean');
    case 'number':
      if (typeof v !== 'number' || !Number.isFinite(v)) return bad('not a number');
      if (s.minimum !== undefined && v < s.minimum) return bad(`below the minimum ${s.minimum}`);
      if (s.maximum !== undefined && v > s.maximum) return bad(`above the maximum ${s.maximum}`);
      return { ok: true, value: v };
    case 'string':
      if (typeof v !== 'string') return bad('not a string');
      if (s.enum && !s.enum.includes(v)) return bad('not one of the allowed values');
      return { ok: true, value: v };
    case 'stringArray':
      return Array.isArray(v) && v.every((x) => typeof x === 'string') ? { ok: true, value: [...v] } : bad('not an array of strings');
    case 'stringMap': {
      if (!isObj(v)) return bad('not an object');
      const out: Record<string, string> = {};
      for (const [k, x] of Object.entries(v)) {
        if (typeof x !== 'string') return bad('not an object of strings');
        if (k === '__proto__' || !k) return bad('bad key');
        out[k] = x;
      }
      return { ok: true, value: out };
    }
  }
}

/** The part of `WorkspaceConfiguration.inspect()` that matters here. */
export interface Inspected { defaultValue?: unknown; globalValue?: unknown; workspaceValue?: unknown }

/** The value the page shows for `scope`, and whether that scope sets it itself. */
export function shownValue(def: unknown, i: Inspected | undefined, scope: SettingsScope): { value: unknown; modified: boolean } {
  const own = scope === 'user' ? i?.globalValue : i?.workspaceValue;
  if (own !== undefined) return { value: own, modified: true };
  if (scope === 'workspace' && i?.globalValue !== undefined) return { value: i.globalValue, modified: false };
  return { value: i?.defaultValue ?? def, modified: false };
}

const isScope = (v: unknown): v is SettingsScope => v === 'user' || v === 'workspace';
const isKey = (v: unknown): v is string => typeof v === 'string' && /^[A-Za-z][A-Za-z0-9.]{0,80}$/.test(v);

/** Narrows an untrusted message from the settings webview, or undefined. Values are checked later against the schema. */
export function parseFromSettings(m: unknown): FromSettings | undefined {
  const o = m as { type?: unknown; scope?: unknown; key?: unknown; value?: unknown; family?: unknown } | null;
  if (!o || typeof o !== 'object') return undefined;
  switch (o.type) {
    case 'ready': case 'openNative': case 'downloadFont': return { type: o.type };
    case 'scope': return isScope(o.scope) ? { type: 'scope', scope: o.scope } : undefined;
    case 'openJson': return isScope(o.scope) ? { type: 'openJson', scope: o.scope } : undefined;
    case 'set': return isKey(o.key) && isScope(o.scope) ? { type: 'set', key: o.key, value: o.value, scope: o.scope } : undefined;
    case 'reset': return isKey(o.key) && isScope(o.scope) ? { type: 'reset', key: o.key, scope: o.scope } : undefined;
    case 'removeFont': return typeof o.family === 'string' && o.family.length > 0 && o.family.length <= 100 ? { type: 'removeFont', family: o.family } : undefined;
    default: return undefined;
  }
}
