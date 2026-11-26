import type { IssueCategory } from './parser/types';

/** Mirrors the `skout.*` settings contributed in package.json. */
export interface SkoutSettings {
  /** The Skript version scripts target, e.g. `2.16.2`. Empty means the newest bundled version. */
  skriptVersion: string;
  /** Functions provided by addons, which Skout cannot see yet. */
  knownFunctions: string[];
  diagnostics: Record<IssueCategory, boolean>;
}

export const defaultSettings: SkoutSettings = {
  skriptVersion: '',
  knownFunctions: [],
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
  },
};

/** Merges whatever the client sent over the defaults, ignoring values of the wrong type. */
export function resolveSettings(raw: unknown): SkoutSettings {
  const source = (raw ?? {}) as { skriptVersion?: unknown; knownFunctions?: unknown; diagnostics?: Record<string, unknown> };
  const result: SkoutSettings = {
    skriptVersion: typeof source.skriptVersion === 'string' ? source.skriptVersion.trim() : '',
    knownFunctions: Array.isArray(source.knownFunctions) ? source.knownFunctions.filter((f): f is string => typeof f === 'string') : [],
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
