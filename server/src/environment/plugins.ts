/**
 * What a server runs: the plugins in its `plugins/` folder, read from the
 * `plugin.yml` (or `paper-plugin.yml`) inside each jar. Skout only reads
 * these files; it never runs anything from them.
 *
 * Jars are ZIP files. Only what is needed to find and inflate one entry is
 * implemented: the end-of-central-directory record, central directory
 * headers and local file headers (PKWARE APPNOTE 4.3), with "stored" and
 * "deflated" entries.
 */
import { open, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { inflateRawSync } from 'node:zlib';

export interface PluginInfo {
  readonly name: string;
  readonly version: string;
  /** The jar's file name. */
  readonly file: string;
  readonly depend: readonly string[];
  readonly softdepend: readonly string[];
}

const EOCD = 0x06054b50;
const CENTRAL = 0x02014b50;
const LOCAL = 0x04034b50;
const MAX_ENTRY = 1 << 20; // plugin.yml files are small; refuse anything absurd

/** The contents of `names[i]` (the first that exists) inside a ZIP file, or undefined. */
export async function readZipEntry(path: string, names: readonly string[]): Promise<string | undefined> {
  const file = await open(path, 'r');
  try {
    const { size } = await file.stat();
    // The end-of-central-directory record is in the last 64 KiB + 22 bytes.
    const tailLength = Math.min(size, 65_557);
    const tail = Buffer.alloc(tailLength);
    await file.read(tail, 0, tailLength, size - tailLength);
    let eocd = -1;
    for (let i = tailLength - 22; i >= 0; i--) {
      if (tail.readUInt32LE(i) === EOCD) {
        eocd = i;
        break;
      }
    }
    if (eocd === -1) return undefined;
    const entries = tail.readUInt16LE(eocd + 10);
    const directorySize = tail.readUInt32LE(eocd + 12);
    const directoryOffset = tail.readUInt32LE(eocd + 16);
    if (directoryOffset + directorySize > size) return undefined;
    const directory = Buffer.alloc(directorySize);
    await file.read(directory, 0, directorySize, directoryOffset);

    const found = new Map<string, { method: number; compressed: number; uncompressed: number; local: number }>();
    for (let p = 0, n = 0; n < entries && p + 46 <= directory.length; n++) {
      if (directory.readUInt32LE(p) !== CENTRAL) break;
      const method = directory.readUInt16LE(p + 10);
      const compressed = directory.readUInt32LE(p + 20);
      const uncompressed = directory.readUInt32LE(p + 24);
      const nameLength = directory.readUInt16LE(p + 28);
      const extraLength = directory.readUInt16LE(p + 30);
      const commentLength = directory.readUInt16LE(p + 32);
      const local = directory.readUInt32LE(p + 42);
      const name = directory.toString('utf8', p + 46, p + 46 + nameLength);
      if (names.includes(name)) found.set(name, { method, compressed, uncompressed, local });
      p += 46 + nameLength + extraLength + commentLength;
    }
    for (const name of names) {
      const entry = found.get(name);
      if (!entry || entry.compressed > MAX_ENTRY || entry.uncompressed > MAX_ENTRY) continue;
      const header = Buffer.alloc(30);
      await file.read(header, 0, 30, entry.local);
      if (header.readUInt32LE(0) !== LOCAL) continue;
      const start = entry.local + 30 + header.readUInt16LE(26) + header.readUInt16LE(28);
      const data = Buffer.alloc(entry.compressed);
      await file.read(data, 0, entry.compressed, start);
      if (entry.method === 0) return data.toString('utf8');
      if (entry.method === 8) return inflateRawSync(data).toString('utf8');
    }
    return undefined;
  } finally {
    await file.close();
  }
}

/**
 * The top-level keys of a plugin.yml that matter here. Only plain
 * `key: value` and `key: [a, b]` or `- item` lists are read; anything more
 * complex is ignored rather than guessed.
 */
export function parsePluginYml(text: string): Omit<PluginInfo, 'file'> | undefined {
  const values = new Map<string, string>();
  const lists = new Map<string, string[]>();
  let listKey: string | undefined;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/\s+#.*$/, '');
    const item = /^\s+-\s*(.+?)\s*$/.exec(line);
    if (item && listKey) {
      lists.get(listKey)!.push(unquote(item[1]));
      continue;
    }
    const m = /^([A-Za-z-]+):\s*(.*?)\s*$/.exec(line);
    if (!m) {
      if (/^\S/.test(line)) listKey = undefined;
      continue;
    }
    const key = m[1].toLowerCase();
    const value = m[2];
    listKey = undefined;
    if (value === '') {
      listKey = key;
      lists.set(key, []);
    } else if (value.startsWith('[')) {
      lists.set(key, value.replace(/^\[|\]$/g, '').split(',').map((s) => unquote(s.trim())).filter(Boolean));
    } else {
      values.set(key, unquote(value));
    }
  }
  const name = values.get('name');
  if (!name) return undefined;
  const softdepend = [...(lists.get('softdepend') ?? [])];
  // paper-plugin.yml lists dependencies as nested keys: dependencies: / server: / Skript:
  if (/^dependencies:/m.test(text) && /^\s+Skript:\s*$/m.test(text)) softdepend.push('Skript');
  return { name, version: values.get('version') ?? '', depend: lists.get('depend') ?? [], softdepend };
}

function unquote(text: string): string {
  return text.replace(/^(['"])(.*)\1$/, '$2');
}

/** Every plugin jar in `<server>/plugins`, with its plugin.yml. Jars that cannot be read are skipped. */
export async function readPlugins(serverRoot: string): Promise<PluginInfo[]> {
  const folder = join(serverRoot, 'plugins');
  let names: string[];
  try {
    names = (await readdir(folder)).filter((n) => n.toLowerCase().endsWith('.jar'));
  } catch {
    return [];
  }
  const plugins: PluginInfo[] = [];
  for (const file of names.sort()) {
    try {
      const yml = await readZipEntry(join(folder, file), ['plugin.yml', 'paper-plugin.yml']);
      const info = yml && parsePluginYml(yml);
      if (info) plugins.push({ ...info, file });
    } catch {
      // not a readable jar
    }
  }
  return plugins;
}

/** A Skript addon: a plugin that depends on Skript. */
export function isSkriptAddon(plugin: PluginInfo): boolean {
  return [...plugin.depend, ...plugin.softdepend].some((d) => d.toLowerCase() === 'skript');
}
