import type { UnrecognizedMode } from './features/syntax';
import type { IssueCategory } from './parser/types';

/** Mirrors the `skout.*` settings contributed in package.json. */
export interface SkoutSettings {
  /** The Skript version scripts target, e.g. `2.16.2`. Empty means the newest bundled version. */
  skriptVersion: string;
  /** Functions provided by addons, which Skout cannot see yet. */
  knownFunctions: string[];
  /** Installed addon versions, e.g. { "SkBee": "3.11.0" }, for upgrade reports. */
  addonVersions: Record<string, string>;
  /** Syntax dump files or folders, absolute or relative to a workspace folder. */
  syntaxDumps: string[];
  /** How eagerly lines matching no known syntax are reported. */
  unrecognizedSyntax: UnrecognizedMode;
  diagnostics: Record<IssueCategory, boolean>;
}

export const defaultSettings: SkoutSettings = {
  skriptVersion: '',
  knownFunctions: [],
  addonVersions: {},
  syntaxDumps: [],
  unrecognizedSyntax: 'typos',
  diagnostics: {
    indentation: true,
    missingColon: true,
    unclosed: true,
    emptySection: true,
    comments: true,
    undefinedFunction: true,
    argumentCount: true,
    duplicateFunction: true,
    functionSignature: true,
    unknownOption: true,
    unsetVariable: true,
    unrecognizedSyntax: true,
  },
};

/** Merges whatever the client sent over the defaults, ignoring values of the wrong type. */
export function resolveSettings(raw: unknown): SkoutSettings {
  const source = (raw ?? {}) as { skriptVersion?: unknown; knownFunctions?: unknown; addonVersions?: unknown; syntaxDumps?: unknown; unrecognizedSyntax?: unknown; diagnostics?: Record<string, unknown> };
  const result: SkoutSettings = {
    skriptVersion: typeof source.skriptVersion === 'string' ? source.skriptVersion.trim() : '',
    knownFunctions: Array.isArray(source.knownFunctions) ? source.knownFunctions.filter((f): f is string => typeof f === 'string') : [],
    addonVersions: Object.fromEntries(
      Object.entries(source.addonVersions && typeof source.addonVersions === 'object' ? (source.addonVersions as Record<string, unknown>) : {}).filter(
        (e): e is [string, string] => typeof e[1] === 'string',
      ),
    ),
    syntaxDumps: Array.isArray(source.syntaxDumps) ? source.syntaxDumps.filter((f): f is string => typeof f === 'string' && f.trim() !== '') : [],
    unrecognizedSyntax: source.unrecognizedSyntax === 'off' || source.unrecognizedSyntax === 'all' ? source.unrecognizedSyntax : 'typos',
    diagnostics: { ...defaultSettings.diagnostics },
  };
  const diagnostics = source.diagnostics;
  if (diagnostics && typeof diagnostics === 'object') {
    for (const key of Object.keys(result.diagnostics) as IssueCategory[]) {
      if (typeof diagnostics[key] === 'boolean') result.diagnostics[key] = diagnostics[key] as boolean;
    }
  }
  return result;
}
