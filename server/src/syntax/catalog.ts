/**
 * The bundled syntax dumps (dumps/skript-<version>.json), and the built-in
 * functions of the Skript version the user targets.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { isPlural } from '../skript/plural';
import { compareVersions, earliestSince, parseVersion, type Version } from '../skript/version';
import { splitTopLevel, type Parameter, type Signature } from '../skript/functions';
import type { SyntaxDump, SyntaxEntry } from './schema';

export interface BuiltinFunction {
  readonly name: string;
  /** One per documented pattern; several patterns are overloads. */
  readonly signatures: readonly Signature[];
  readonly entry: SyntaxEntry;
}

export interface SkriptSyntax {
  /** The bundled version actually used, e.g. `2.16.2` for a requested `2.16.0`. */
  readonly version: Version;
  readonly dump: SyntaxDump;
  readonly functions: ReadonlyMap<string, BuiltinFunction>;
}

export class SyntaxCatalog {
  private readonly dumps: { version: Version; dump: SyntaxDump }[] = [];
  private readonly cache = new Map<string, SkriptSyntax>();
  /** Built-in function name → the first bundled version that has it. */
  private readonly firstSeen = new Map<string, Version>();

  constructor(dumps: SyntaxDump[]) {
    for (const dump of dumps) {
      const version = parseVersion(dump.skriptVersion);
      if (version) this.dumps.push({ version, dump });
    }
    this.dumps.sort((a, b) => compareVersions(a.version, b.version));
    for (const { version, dump } of this.dumps) {
      for (const entry of dump.entries) {
        if (entry.kind === 'function' && !this.firstSeen.has(entry.id)) this.firstSeen.set(entry.id, version);
      }
    }
  }

  static fromDirectory(dir: string): SyntaxCatalog {
    const dumps: SyntaxDump[] = [];
    for (const file of readdirSync(dir)) {
      if (/^skript-.+\.json$/.test(file)) dumps.push(JSON.parse(readFileSync(join(dir, file), 'utf8')) as SyntaxDump);
    }
    return new SyntaxCatalog(dumps);
  }

  get versions(): Version[] {
    return this.dumps.map((d) => d.version);
  }

  get latest(): Version {
    return this.dumps[this.dumps.length - 1].version;
  }

  /**
   * The syntax for a requested version: the same version if bundled, else the
   * closest bundled release of the same minor version, else the nearest older
   * one, else the oldest bundled.
   */
  forVersion(requested: string | undefined): SkriptSyntax {
    const wanted = parseVersion(requested) ?? this.latest;
    const key = wanted.text || 'latest';
    const cached = this.cache.get(key);
    if (cached) return cached;

    const sameMinor = this.dumps.filter((d) => d.version.major === wanted.major && d.version.minor === wanted.minor);
    const older = this.dumps.filter((d) => compareVersions(d.version, wanted) <= 0);
    const chosen = sameMinor.at(-1) ?? older.at(-1) ?? this.dumps[0];

    const functions = new Map<string, BuiltinFunction>();
    for (const entry of chosen.dump.entries) {
      if (entry.kind !== 'function') continue;
      const signatures = entry.patterns.map(parseDocSignature).filter((s): s is Signature => !!s);
      functions.set(entry.id, { name: entry.id, signatures, entry });
    }
    const result: SkriptSyntax = { version: chosen.version, dump: chosen.dump, functions };
    this.cache.set(key, result);
    return result;
  }

  /**
   * For a function missing from the target version: the version that added it,
   * from its documented `since` when that parses, else the first bundled
   * version that has it.
   */
  addedIn(name: string): Version | undefined {
    const first = this.firstSeen.get(name);
    if (!first) return undefined;
    const entry = this.dumps.find((d) => compareVersions(d.version, first) === 0)?.dump.entries.find((e) => e.kind === 'function' && e.id === name);
    return earliestSince(entry?.since) ?? first;
  }
}

/**
 * Parses a documented built-in signature such as
 * `location(x: number, y: number, z: number, world: optional world)` or
 * `rgb(red: integer between 0 and 255, alpha: optional integer between 0 and 255)`.
 * The docs describe parameters for people, so `optional`, ranges and
 * `(yes/no)` notes are read leniently instead of with the script grammar.
 */
export function parseDocSignature(pattern: string): Signature | undefined {
  const m = /^([\p{Alphabetic}_][\p{Alphabetic}\d_]*)\((.*)\)$/u.exec(pattern.trim());
  if (!m) return undefined;
  const [, name, args] = m;
  const parameters: Parameter[] = [];
  if (args.trim().length > 0) {
    for (const part of splitTopLevel(args) ?? []) {
      const colon = part.text.indexOf(':');
      if (colon === -1) return undefined;
      const paramName = part.text.slice(0, colon).trim();
      let rest = part.text.slice(colon + 1).trim();
      let defaultValue: string | undefined;
      const eq = rest.indexOf('=');
      if (eq !== -1) {
        defaultValue = rest.slice(eq + 1).trim();
        rest = rest.slice(0, eq).trim();
      }
      if (/^optional\s/i.test(rest)) {
        rest = rest.replace(/^optional\s+/i, '');
        defaultValue ??= '(optional)';
      }
      const type = rest.replace(/\s+between\s.*$/i, '').replace(/\s*\(.*\)\s*$/, '').trim();
      const plural = isPlural(type).plural;
      parameters.push({ name: paramName, variable: `_${paramName}`, type, plural, defaultValue, offset: part.start });
    }
  }
  return { name, local: false, parameters, nameOffset: 0 };
}

/** The earliest Skript version a built-in's `since` field mentions. */
export function builtinSince(fn: BuiltinFunction): Version | undefined {
  return earliestSince(fn.entry.since);
}
