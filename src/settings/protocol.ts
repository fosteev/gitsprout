// Messages of the settings page (webview/settings) <-> its host (panel.ts). Imported by both sides.
import type { FontFaceSrc, TokenKind, TokenStyle } from '../graph/protocol';

export type SettingsScope = 'user' | 'workspace';

/** What a control edits; derived from the JSON schema in `contributes.configuration`. */
export type SettingType = 'boolean' | 'number' | 'string' | 'stringArray' | 'stringMap';

/** One `gitsprout.*` property of the manifest. `key` is without the `gitsprout.` prefix. */
export interface SettingSchema {
  key: string;
  type: SettingType;
  default: unknown;
  description: string;
  enum?: string[];
  enumDescriptions?: string[];
  minimum?: number;
  maximum?: number;
}

export interface SettingsCategory { title: string; settings: SettingSchema[] }

export interface SettingsState {
  categories: SettingsCategory[];
  scope: SettingsScope;
  /** false = no workspace folder open: the Workspace tab is disabled */
  hasWorkspace: boolean;
  /** key -> the value shown for `scope`: the scope's own value, else (Workspace only) the User value, else the default */
  values: Record<string, unknown>;
  /** keys set in `scope` itself (the blue bar, Reset) */
  modified: string[];
  /** label of the active VS Code colour theme ("Now: ..." under Highlight Theme = auto) */
  themeLabel: string;
  /** families downloaded from Google Fonts */
  downloadedFonts: string[];
  /** token styles of the active theme for the preview (null = not resolved) */
  tokens: Partial<Record<TokenKind, TokenStyle>> | null;
  /** faces of the downloaded font named by the shown `diff.fontFamily` */
  fontFaces: FontFaceSrc[];
}

export type ToSettings = { type: 'state'; state: SettingsState };

export type FromSettings =
  | { type: 'ready' }
  | { type: 'scope'; scope: SettingsScope }
  | { type: 'set'; key: string; value: unknown; scope: SettingsScope }
  | { type: 'reset'; key: string; scope: SettingsScope }
  /** "Open in VS Code Settings" */
  | { type: 'openNative' }
  /** "Edit in settings.json" (User or Workspace file) */
  | { type: 'openJson'; scope: SettingsScope }
  /** The "Google Fonts..." button: runs `gitsprout.downloadGoogleFont`. */
  | { type: 'downloadFont' }
  /** "Remove download": runs `gitsprout.removeGoogleFont` with the family. */
  | { type: 'removeFont'; family: string };
