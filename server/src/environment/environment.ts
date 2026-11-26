/**
 * The Minecraft server a workspace belongs to, when Skout can find it: the
 * Skript version it runs, its addons, the syntax dumps they generated, and
 * its log. Everything is read from disk; nothing is started or downloaded.
 *
 * The server root is `skout.server.folder` when set. Otherwise it is found
 * from the workspace: a folder that contains `plugins/Skript/`, or the folder
 * three levels above a workspace that is (or is inside) `plugins/Skript/scripts`.
 */
import { existsSync, readdirSync, statSync } from 'node:fs';
import { isAbsolute, join, resolve, sep } from 'node:path';
import { isSkriptAddon, readPlugins, type PluginInfo } from './plugins';

export interface Environment {
  readonly root: string;
  /** How the root was found. */
  readonly source: 'setting' | 'workspace';
  readonly plugins: readonly PluginInfo[];
  readonly skript?: PluginInfo;
  /** Plugins that depend on Skript. */
  readonly addons: readonly PluginInfo[];
  /** Syntax dumps the server generated: `/sk gen-docs` and SkriptHub Docs Tool output. */
  readonly dumps: readonly string[];
  readonly log?: string;
}

/** The server root for these workspace folders, or undefined. */
export function findServerRoot(setting: string, workspaceFolders: readonly string[]): { root: string; source: Environment['source'] } | undefined {
  if (setting.trim()) {
    const path = isAbsolute(setting) ? setting : resolve(workspaceFolders[0] ?? '.', setting);
    return isServerRoot(path) ? { root: path, source: 'setting' } : undefined;
  }
  for (const folder of workspaceFolders) {
    if (isServerRoot(folder)) return { root: folder, source: 'workspace' };
    // Inside plugins/Skript/scripts (or plugins/Skript itself).
    const parts = resolve(folder).split(sep);
    const i = parts.map((p) => p.toLowerCase()).lastIndexOf('plugins');
    if (i > 0 && parts[i + 1]?.toLowerCase() === 'skript') {
      const root = parts.slice(0, i).join(sep);
      if (isServerRoot(root)) return { root, source: 'workspace' };
    }
  }
  return undefined;
}

function isServerRoot(path: string): boolean {
  try {
    return statSync(join(path, 'plugins', 'Skript')).isDirectory();
  } catch {
    return false;
  }
}

export async function readEnvironment(root: string, source: Environment['source']): Promise<Environment> {
  const plugins = await readPlugins(root);
  const skript = plugins.find((p) => p.name.toLowerCase() === 'skript');
  const addons = plugins.filter((p) => p !== skript && isSkriptAddon(p));
  const dumps: string[] = [];
  const genDocs = join(root, 'plugins', 'Skript', 'docs', 'docs.json');
  if (existsSync(genDocs)) dumps.push(genDocs);
  const docsTool = join(root, 'plugins', 'SkriptHubDocsTool', 'documentation');
  try {
    for (const name of readdirSync(docsTool).sort()) if (name.toLowerCase().endsWith('.json')) dumps.push(join(docsTool, name));
  } catch {
    // no SkriptHub Docs Tool output
  }
  const log = join(root, 'logs', 'latest.log');
  return { root, source, plugins, skript, addons, dumps, log: existsSync(log) ? log : undefined };
}

/** The `plugins/Skript/scripts` folder of a server root. */
export function scriptsFolder(root: string): string {
  return join(root, 'plugins', 'Skript', 'scripts');
}

/** A script's path as Skript names it in its log: relative to `scripts/`, with `/`. */
export function scriptName(path: string, root: string | undefined): string {
  const normalized = resolve(path);
  if (root) {
    const base = resolve(scriptsFolder(root)) + sep;
    if (normalized.toLowerCase().startsWith(base.toLowerCase())) return normalized.slice(base.length).split(sep).join('/');
  }
  return normalized.split(sep).pop() ?? normalized;
}
