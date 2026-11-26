import type { IssueCategory } from './parser/types';

/** Mirrors the `skout.*` settings contributed in package.json. */
export interface SkoutSettings {
  diagnostics: Record<IssueCategory, boolean>;
}

export const defaultSettings: SkoutSettings = {
  diagnostics: {
    indentation: true,
    missingColon: true,
    unclosed: true,
    emptySection: true,
    comments: true,
  },
};

/** Merges whatever the client sent over the defaults, ignoring values of the wrong type. */
export function resolveSettings(raw: unknown): SkoutSettings {
  const result: SkoutSettings = { diagnostics: { ...defaultSettings.diagnostics } };
  const diagnostics = (raw as { diagnostics?: Record<string, unknown> } | null | undefined)?.diagnostics;
  if (diagnostics && typeof diagnostics === 'object') {
    for (const key of Object.keys(result.diagnostics) as IssueCategory[]) {
      if (typeof diagnostics[key] === 'boolean') result.diagnostics[key] = diagnostics[key] as boolean;
    }
  }
  return result;
}
