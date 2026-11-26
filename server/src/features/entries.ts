/**
 * Entries of structures that Skript validates with an EntryValidator: today
 * the entries of `command` (StructCommand). An entry Skript does not expect is
 * an error, with a quick fix when it is a misspelling of one it does
 * (`atrigger:` → `trigger:`).
 *
 * Rules, from Skript's source:
 *
 * - EntryValidator#validate: every node must match an entry that is still
 *   expected, else "Unexpected entry '<key>'. Check whether it's spelled
 *   correctly or remove it". An entry that may appear once is no longer
 *   expected after it matched. A required entry that never matched gives
 *   "Required entry '<key>' is missing".
 * - KeyValueEntryData#canCreateWith: a line `<key>: <value>`, the key compared
 *   case-insensitively, options replaced. SectionEntryData#canCreateWith: a
 *   section `<key>:`.
 * - The entries: ch.njol.skript.structures.StructCommand (2.14.3 to 2.16.2,
 *   where `trigger` is required) and SubCommandEntryData.SUB_COMMAND_VALIDATOR
 *   (2.17.1, where `trigger` is optional and subcommands and `suggestions`
 *   were added).
 */
import { substituteOptions } from '../index/extract';
import type { Issue, ParsedScript, SkNode } from '../parser/types';
import { atLeast, type Version } from '../skript/version';
import { distance } from './syntax';

interface EntrySpec {
  readonly key: string;
  /** `value` for `key: value`, `section` for `key:` with lines below. */
  readonly form: 'value' | 'section';
  readonly required?: boolean;
  /** May appear more than once. */
  readonly multiple?: boolean;
  /** `subcommand <name>:`: the key is a prefix. */
  readonly prefix?: boolean;
  /** Accepted but ignored, with the release that said so. */
  readonly deprecated?: { readonly since: string; readonly note: string };
}

const v = (key: string): EntrySpec => ({ key, form: 'value' });

const COMMAND_214: readonly EntrySpec[] = [
  v('usage'),
  v('description'),
  v('prefix'),
  v('permission'),
  v('permission message'),
  v('aliases'),
  v('executable by'),
  v('cooldown'),
  v('cooldown message'),
  v('cooldown bypass'),
  v('cooldown storage'),
  { key: 'trigger', form: 'section', required: true },
];

const COMMAND_217: readonly EntrySpec[] = [
  v('aliases'),
  v('description'),
  v('usage'),
  v('prefix'),
  { key: 'suggestions', form: 'section' },
  v('permission'),
  v('executable by'),
  v('cooldown'),
  v('cooldown message'),
  v('cooldown bypass'),
  v('cooldown storage'),
  { key: 'trigger', form: 'section' },
  { key: 'subcommand', form: 'section', multiple: true, prefix: true },
  { key: 'subcommands', form: 'section', multiple: true },
  {
    ...v('permission message'),
    deprecated: { since: '2.17', note: 'Skript 2.17 ignores it: players without the permission no longer see the command at all' },
  },
];

export function commandEntries(version: Version): readonly EntrySpec[] {
  return atLeast(version, 2, 17) ? COMMAND_217 : COMMAND_214;
}

/** The entry a node would be read as: its key, and whether it is a section. */
function entryOf(node: SkNode, script: ParsedScript): { key: string; form: 'value' | 'section' | 'plain' } {
  const key = substituteOptions(node.key, script.options);
  if (node.kind === 'section') return { key, form: 'section' };
  const separator = key.indexOf(': ');
  if (separator === -1) return { key, form: 'plain' };
  return { key: key.slice(0, separator).trim(), form: 'value' };
}

function accepts(spec: EntrySpec, entry: { key: string; form: string }): boolean {
  if (spec.form !== entry.form) return false;
  const key = entry.key.toLowerCase();
  return spec.prefix ? key.startsWith(`${spec.key} `) : key === spec.key;
}

export function entryIssues(script: ParsedScript, version: Version): Issue[] {
  const issues: Issue[] = [];
  for (const structure of script.structures) {
    if (structure.structure !== 'command' || structure.invalid) continue;
    const seen = validate(structure, commandEntries(version), script, issues, true, version);
    commandRules(structure, seen, script, version, issues);
  }
  return issues;
}

/**
 * What StructCommand (2.14.3 to 2.16.2) and SubCommandEntryData (2.17.1) check
 * after the entries are known, with their messages.
 */
function commandRules(command: SkNode, seen: ReadonlyMap<string, SkNode>, script: ParsedScript, version: Version, issues: Issue[]): void {
  const modern = atLeast(version, 2, 17);
  const name = /^command\s+\/?(\S+)/i.exec(substituteOptions(command.key, script.options))?.[1] ?? '';
  const at = (node: SkNode, severity: 'error' | 'warning', message: string) => {
    const line = script.lines[node.line];
    issues.push({ code: 'command-entries', category: 'entries', severity, message, line: node.line, start: line.start, end: line.end });
  };
  for (const entry of ['cooldown message', 'cooldown bypass', 'cooldown storage']) {
    const node = seen.get(entry);
    if (node && !seen.has('cooldown')) at(node, 'warning', modern ? `There is a ${entry} set, but not a cooldown` : `command /${name} has a ${entry} set, but not a cooldown`);
  }
  if (!modern && seen.has('permission message') && !seen.has('permission')) {
    at(seen.get('permission message')!, 'warning', `command /${name} has a permission message set, but not a permission`);
  }
  if (modern && !seen.has('trigger') && !seen.has('subcommand') && !seen.has('subcommands')) {
    at(command, 'error', "You must have a 'trigger' entry if there are no subcommands!");
  }
}

function validate(section: SkNode, specs: readonly EntrySpec[], script: ParsedScript, issues: Issue[], top: boolean, version: Version): Map<string, SkNode> {
  const expected = [...specs];
  const seen = new Map<string, SkNode>();
  for (const node of section.children) {
    if (node.invalid) continue;
    const entry = entryOf(node, script);
    const index = expected.findIndex((spec) => accepts(spec, entry));
    const line = script.lines[node.line];
    if (index !== -1) {
      const spec = expected[index];
      if (!spec.multiple) expected.splice(index, 1);
      seen.set(spec.key, node);
      if (spec.deprecated) {
        issues.push({
          code: 'deprecated-entry',
          category: 'entries',
          severity: 'hint',
          message: `'${spec.key}' is deprecated since Skript ${spec.deprecated.since}. ${spec.deprecated.note}.`,
          line: node.line,
          start: line.start,
          end: line.start + spec.key.length,
          tags: ['deprecated'],
        });
      }
      // Subcommands are validated like commands, but some entries belong to the root only.
      if (!top && ROOT_ONLY.has(spec.key)) {
        issues.push({ code: 'command-entries', category: 'entries', severity: 'error', message: `Only the root of a command may have ${spec.key === 'aliases' ? 'aliases' : `a ${spec.key}`}.`, line: node.line, start: line.start, end: line.start + spec.key.length });
      }
      if (spec.prefix && spec.key === 'subcommand') validate(node, specs, script, issues, false, version);
      continue;
    }
    issues.push(unexpected(node, entry, specs, seen, script));
  }
  if (!top) return seen;
  for (const spec of expected) {
    if (!spec.required) continue;
    const line = script.lines[section.line];
    issues.push({
      code: 'missing-entry',
      category: 'entries',
      severity: 'error',
      message: `Required entry '${spec.key}' is missing`,
      line: section.line,
      start: line.start,
      end: line.end,
    });
  }
  return seen;
}

/** SubCommandEntryData#getValue: "Only the root of a command may have …". */
const ROOT_ONLY = new Set(['aliases', 'description', 'prefix']);

function unexpected(node: SkNode, entry: { key: string; form: 'value' | 'section' | 'plain' }, specs: readonly EntrySpec[], seen: Map<string, SkNode>, script: ParsedScript): Issue {
  const line = script.lines[node.line];
  const keyLength = entry.form === 'plain' ? line.end - line.start : entry.key.length;
  let message = `Unexpected entry '${entry.key}'. Check whether it's spelled correctly or remove it`;
  let fix: Issue['fix'];
  const lower = entry.key.toLowerCase();
  const same = specs.find((s) => s.key === lower || (s.prefix && lower.startsWith(`${s.key} `)));
  if (same && seen.has(same.key) && !same.multiple) {
    message += ` (it is already given on line ${seen.get(same.key)!.line + 1})`;
  } else if (same && same.form !== entry.form) {
    message += same.form === 'section' ? ` ('${same.key}' must be a section: end it with ':' and put its code on the lines below)` : ` ('${same.key}' takes a value on the same line: '${same.key}: …')`;
  } else if (entry.form === 'plain') {
    message += specs.some((s) => s.key === 'trigger') ? ". Code in a command goes under 'trigger:'" : '';
  } else {
    // A misspelled key: one or two edits from an entry of the same form.
    let best: EntrySpec | undefined;
    let bestDistance = 3;
    for (const spec of specs) {
      if (spec.form !== entry.form || spec.prefix) continue;
      const d = distance(lower, spec.key, 2);
      if (d < bestDistance && d <= (spec.key.length >= 6 ? 2 : 1)) {
        best = spec;
        bestDistance = d;
      }
    }
    if (best) {
      message += `. Did you mean '${best.key}'?`;
      fix = { line: node.line, start: line.start, end: line.start + entry.key.length, text: best.key };
    }
  }
  return {
    code: 'unknown-entry',
    category: 'entries',
    severity: 'error',
    message,
    line: node.line,
    start: line.start,
    end: line.start + keyLength,
    fix,
  };
}
