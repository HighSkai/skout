/**
 * Loads the syntax dumps listed in `skout.syntaxDumps`: files, or folders
 * whose `.json` files are all read (for example a server's
 * plugins/SkriptHubDocsTool/documentation folder). Relative paths are
 * resolved against each workspace folder.
 */
import { readdir, readFile, stat } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { importDump, parseDumpText } from './importers';
import type { LoadedDump } from './registry';

interface CacheEntry {
  readonly mtime: number;
  readonly size: number;
  readonly dump: LoadedDump;
}

const cache = new Map<string, CacheEntry>();

export interface LoadResult {
  readonly dumps: LoadedDump[];
  readonly errors: string[];
}

export async function loadDumps(paths: readonly string[], roots: readonly string[]): Promise<LoadResult> {
  const dumps: LoadedDump[] = [];
  const errors: string[] = [];
  for (const configured of paths) {
    const candidates = isAbsolute(configured) ? [configured] : roots.map((r) => join(r, configured));
    let found = false;
    for (const candidate of candidates) {
      const info = await stat(candidate).catch(() => undefined);
      if (!info) continue;
      found = true;
      const files = info.isDirectory()
        ? (await readdir(candidate)).filter((f) => f.toLowerCase().endsWith('.json')).sort().map((f) => join(candidate, f))
        : [candidate];
      for (const file of files) {
        try {
          dumps.push(await loadFile(file));
        } catch (error) {
          errors.push(`${file}: ${(error as Error).message}`);
        }
      }
      break;
    }
    if (!found) errors.push(`${configured}: not found`);
  }
  return { dumps, errors };
}

async function loadFile(path: string): Promise<LoadedDump> {
  const info = await stat(path);
  const cached = cache.get(path);
  if (cached && cached.mtime === info.mtimeMs && cached.size === info.size) return cached.dump;
  const dump = { path, dump: importDump(parseDumpText(await readFile(path, 'utf8')), path) };
  cache.set(path, { mtime: info.mtimeMs, size: info.size, dump });
  return dump;
}
