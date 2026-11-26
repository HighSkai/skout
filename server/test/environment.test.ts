import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deflateRawSync } from 'node:zlib';
import { afterAll, describe, expect, it } from 'vitest';
import { findServerRoot, readEnvironment, scriptName } from '../src/environment/environment';
import { isSkriptAddon, parsePluginYml, readPlugins, readZipEntry } from '../src/environment/plugins';
import { locate, parseServerLog, sameScript } from '../src/environment/serverLog';

/** A minimal ZIP file (APPNOTE 4.3) with deflated or stored entries, like a plugin jar. */
function zip(entries: Record<string, string>, deflate = true): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const [name, text] of Object.entries(entries)) {
    const raw = Buffer.from(text, 'utf8');
    const data = deflate ? deflateRawSync(raw) : raw;
    const nameBytes = Buffer.from(name, 'utf8');
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(deflate ? 8 : 0, 8);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(deflate ? 8 : 0, 10);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, nameBytes, data);
    centrals.push(central, nameBytes);
    offset += 30 + nameBytes.length + data.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(entries).length, 8);
  end.writeUInt16LE(Object.keys(entries).length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

const root = mkdtempSync(join(tmpdir(), 'skout-server-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

function server(): string {
  const plugins = join(root, 'plugins');
  mkdirSync(join(plugins, 'Skript', 'scripts', 'games'), { recursive: true });
  mkdirSync(join(plugins, 'Skript', 'docs'), { recursive: true });
  mkdirSync(join(plugins, 'SkriptHubDocsTool', 'documentation'), { recursive: true });
  mkdirSync(join(root, 'logs'), { recursive: true });
  writeFileSync(join(plugins, 'Skript-2.16.2.jar'), zip({ 'META-INF/MANIFEST.MF': 'x', 'plugin.yml': 'name: Skript\nversion: 2.16.2\nmain: ch.njol.skript.Skript\n' }));
  writeFileSync(join(plugins, 'Fizz.jar'), zip({ 'plugin.yml': "name: Fizz\nversion: '1.4.0'\ndepend: [Skript]\n" }, false));
  writeFileSync(join(plugins, 'Buzz.jar'), zip({ 'plugin.yml': 'name: Buzz\nversion: 0.9\nsoftdepend:\n  - WorldGuard\n  - Skript\n' }));
  writeFileSync(join(plugins, 'Paperish.jar'), zip({ 'paper-plugin.yml': 'name: Paperish\nversion: 2\ndependencies:\n  server:\n    Skript:\n      load: BEFORE\n' }));
  writeFileSync(join(plugins, 'Other.jar'), zip({ 'plugin.yml': 'name: Other\nversion: 5\n' }));
  writeFileSync(join(plugins, 'broken.jar'), 'not a zip');
  writeFileSync(join(plugins, 'Skript', 'docs', 'docs.json'), '{}');
  writeFileSync(join(plugins, 'SkriptHubDocsTool', 'documentation', 'Fizz.json'), '[]');
  writeFileSync(join(root, 'logs', 'latest.log'), '');
  return root;
}

describe('plugins', () => {
  it('reads plugin.yml from stored and deflated jars', async () => {
    const path = join(server(), 'plugins', 'Fizz.jar');
    expect(await readZipEntry(path, ['plugin.yml'])).toContain('name: Fizz');
    expect(await readZipEntry(join(root, 'plugins', 'Skript-2.16.2.jar'), ['plugin.yml'])).toContain('version: 2.16.2');
    expect(await readZipEntry(path, ['missing.yml'])).toBeUndefined();
  });

  it('parses the plugin.yml keys it needs, in every list form', () => {
    expect(parsePluginYml("name: A\nversion: '1.0' # comment\ndepend: [Skript, Vault]\nsoftdepend:\n  - X\n")).toEqual({ name: 'A', version: '1.0', depend: ['Skript', 'Vault'], softdepend: ['X'] });
    expect(parsePluginYml('version: 1')).toBeUndefined();
  });

  it('lists the plugins of a server and tells addons apart', async () => {
    const plugins = await readPlugins(server());
    expect(plugins.map((p) => `${p.name} ${p.version}${isSkriptAddon(p) ? ' (addon)' : ''}`)).toEqual([
      'Buzz 0.9 (addon)',
      'Fizz 1.4.0 (addon)',
      'Other 5',
      'Paperish 2 (addon)',
      'Skript 2.16.2',
    ]);
  });
});

describe('environment', () => {
  it('finds the server from the workspace, also from inside plugins/Skript/scripts', () => {
    server();
    expect(findServerRoot('', [root])).toEqual({ root, source: 'workspace' });
    expect(findServerRoot('', [join(root, 'plugins', 'Skript', 'scripts')])?.root).toBe(root);
    expect(findServerRoot('', [join(root, 'plugins')])).toBeUndefined();
    expect(findServerRoot(root, [])).toEqual({ root, source: 'setting' });
    expect(findServerRoot(join(root, 'logs'), [])).toBeUndefined();
  });

  it('reads the Skript version, the addons, the generated dumps and the log', async () => {
    const env = await readEnvironment(server(), 'workspace');
    expect(env.skript?.version).toBe('2.16.2');
    expect(env.addons.map((a) => a.name)).toEqual(['Buzz', 'Fizz', 'Paperish']);
    expect(env.dumps.map((d) => d.slice(root.length + 1).replace(/\\/g, '/'))).toEqual(['plugins/Skript/docs/docs.json', 'plugins/SkriptHubDocsTool/documentation/Fizz.json']);
    expect(env.log).toBe(join(root, 'logs', 'latest.log'));
  });

  it('names scripts as Skript does: relative to the scripts folder', () => {
    expect(scriptName(join(root, 'plugins', 'Skript', 'scripts', 'games', 'shop.sk'), root)).toBe('games/shop.sk');
    expect(scriptName(join(root, 'elsewhere', 'shop.sk'), root)).toBe('shop.sk');
  });
});

/** A log as Paper writes it, with Skript's reload messages (english.lang) and a colour code. */
const LOG = [
  '[12:00:00] [Server thread/INFO]: [Skript] Loading variables...',
  '[12:00:01] [Server thread/ERROR]: [Skript] Line 3: (shop.sk)',
  "    Can't understand this condition/effect: sned \"hi\"",
  '    Line: sned "hi"',
  ' ',
  '[12:00:01] [Server thread/WARN]: [Skript] Line 7: (games/arena.sk)',
  '    Unreachable code. The previous statement stops further execution.',
  '    Line: send "never"',
  ' ',
  '[12:00:02] [Server thread/INFO]: [Skript] Loaded 2 scripts with a total of 4 structures in 0.12 seconds',
  '[12:05:00] [Server thread/INFO]: [Skript] Reloading §6shop.sk§r...',
  '[12:05:00] [Server thread/INFO]: [Skript] Successfully reloaded §6shop.sk§a. §7(§63ms§7)',
].join('\n');

describe('server log', () => {
  it('keeps only what the latest load or reload of each script reported', () => {
    const result = parseServerLog(LOG);
    expect(result.reloads).toBe(2);
    expect([...result.problems.keys()]).toEqual(['games/arena.sk']); // shop.sk was fixed and reloaded
    expect(result.problems.get('games/arena.sk')).toEqual([
      { script: 'games/arena.sk', line: 7, message: 'Unreachable code. The previous statement stops further execution.', code: 'send "never"', severity: 'warning' },
    ]);
  });

  it('reads errors of a failed reload, and a reload of all scripts covers every script', () => {
    const failed = parseServerLog(
      [
        '[Skript] Reloading shop.sk...',
        '[12:06:00 ERROR]: [Skript] Line 3: (shop.sk)',
        "    Can't understand this condition/effect: sned \"hi\"",
        '    Line: sned "hi"',
        '[Skript] Encountered 1 error while reloading shop.sk! (4ms)',
      ].join('\n'),
    );
    expect(failed.problems.get('shop.sk')?.map((p) => `${p.line} ${p.severity} ${p.message}`)).toEqual([`3 error Can't understand this condition/effect: sned "hi"`]);
    const all = parseServerLog(`${LOG}\n[Skript] Reloading all scripts...\n[Skript] Successfully reloaded all scripts. (40ms)`);
    expect(all.problems.size).toBe(0);
  });

  it('matches script names by path tail', () => {
    expect(sameScript('games/arena.sk', 'games/arena.sk')).toBe(true);
    expect(sameScript('arena.sk', 'games/arena.sk')).toBe(true);
    expect(sameScript('shop.sk', 'games/arena.sk')).toBe(false);
  });

  it('puts a problem on the line that still holds the quoted code, or nowhere', () => {
    const problem = { script: 'shop.sk', line: 3, message: 'x', code: 'sned "hi"', severity: 'error' as const };
    expect(locate(problem, ['on join:', '\tsend "a"', '\tsned "hi"'])).toBe(2);
    expect(locate(problem, ['# new line', 'on join:', '\tsend "a"', '\tsned "hi"'])).toBe(3);
    expect(locate(problem, ['on join:', '\tsend "hi"'])).toBeUndefined();
  });
});
