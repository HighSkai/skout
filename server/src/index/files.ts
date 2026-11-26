import { readdir, readFile } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { URI } from 'vscode-uri';

/** Folders never worth indexing. Hidden folders (`.git`, `.vscode`, …) are skipped too. */
const SKIPPED = new Set(['node_modules', 'out', 'dist', 'build', 'target']);

/**
 * Lists every `.sk` file under the given folders. Yields between directories
 * so a large workspace does not block the server.
 *
 * Skript loads scripts only from `plugins/Skript/scripts/`. When a workspace
 * contains Skript's data folder (recognised by `config.sk` next to a
 * `scripts` folder), only that `scripts` folder is indexed, so Skript's own
 * `config.sk` and `features.sk` are never read as scripts.
 */
export async function findScripts(folders: string[]): Promise<string[]> {
  const found: string[] = [];
  const pending = [...folders];
  while (pending.length > 0) {
    const dir = pending.pop()!;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      continue; // unreadable or vanished
    }
    const isSkriptDataFolder =
      entries.some((e) => e.isFile() && e.name.toLowerCase() === 'config.sk') && entries.some((e) => e.isDirectory() && e.name === 'scripts');
    if (isSkriptDataFolder) {
      pending.push(join(dir, 'scripts'));
      continue;
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!SKIPPED.has(entry.name)) pending.push(path);
      } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.sk')) {
        found.push(path);
      }
    }
  }
  return found.sort();
}

/**
 * Skript skips scripts and folders whose name starts with `-` (ScriptLoader's
 * DISABLED_SCRIPT_PREFIX). Checked below the workspace folder only.
 */
export function isDisabledScript(path: string, folders: string[]): boolean {
  const root = folders.filter((f) => path.startsWith(f)).sort((a, b) => b.length - a.length)[0];
  const rest = root ? relative(root, path) : path;
  return rest.split(sep).some((part) => part.startsWith('-'));
}

export async function readScript(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, 'utf8');
  } catch {
    return undefined;
  }
}

/** The URI form editors use (VS Code writes `file:///c%3A/…` on Windows). */
export function toUri(path: string): string {
  return URI.file(path).toString();
}

export function toPath(uri: string): string | undefined {
  const parsed = URI.parse(uri);
  return parsed.scheme === 'file' ? parsed.fsPath : undefined;
}

/** Re-serializes a client URI so it matches `toUri` for the same file. */
export function normalizeUri(uri: string): string {
  return URI.parse(uri).toString();
}
