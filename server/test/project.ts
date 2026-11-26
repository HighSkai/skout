/** Builds a WorkspaceIndex over a fixture folder, the way the server does for a workspace. */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { projectIssues } from '../src/features/project';
import { WorkspaceIndex } from '../src/index/workspace';
import type { Issue } from '../src/parser/types';
import { defaultSettings, type SkoutSettings } from '../src/settings';
import { parseVersion } from '../src/skript/version';
import { SyntaxCatalog } from '../src/syntax/catalog';
import { FIXTURES } from './helpers';

export const catalog = SyntaxCatalog.fromDirectory(join(__dirname, '..', '..', 'dumps'));

export function uriOf(rel: string): string {
  return `file:///project/${rel}`;
}

export function loadProject(folder = 'project', version?: string, overrides: Partial<SkoutSettings> = {}) {
  const root = join(FIXTURES, folder);
  const syntax = catalog.forVersion(version);
  const target = parseVersion(version) ?? syntax.version;
  const index = new WorkspaceIndex(target);
  const walk = (dir: string): string[] =>
    readdirSync(dir).flatMap((name) => {
      const path = join(dir, name);
      return statSync(path).isDirectory() ? walk(path) : name.endsWith('.sk') ? [path] : [];
    });
  for (const path of walk(root)) {
    const rel = relative(root, path).split(sep).join('/');
    index.update(uriOf(rel), readFileSync(path, 'utf8'), rel.split('/').some((p) => p.startsWith('-')));
  }
  const settings = { ...defaultSettings, ...overrides };
  const issues = projectIssues({ index, catalog, syntax, version: target, settings });
  return { index, syntax, target, settings, issues };
}

/** `code@file:line` for every issue in the project, sorted. */
export function projectCodes(issues: Map<string, Issue[]>): string[] {
  const out: string[] = [];
  for (const [uri, list] of issues) {
    for (const i of list) out.push(`${i.code}@${uri.slice('file:///project/'.length)}:${i.line + 1}`);
  }
  return out.sort();
}

export function messagesFor(issues: Map<string, Issue[]>, rel: string, code: string): string[] {
  return (issues.get(uriOf(rel)) ?? []).filter((i) => i.code === code).map((i) => i.message);
}
