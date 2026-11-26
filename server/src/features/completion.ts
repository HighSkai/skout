/**
 * Context-aware completion. What is offered depends on where the cursor is:
 *
 *   top level                 events (`on …:`) and structures
 *   after `on `               events
 *   statement start           effects, conditions, sections, functions
 *   after `if`/`else if`/`while`  conditions
 *   later in a line, or in %…%   expressions and functions
 *   after `{`                 variables in scope
 *   after `{@`                this script's options
 *   directly in a command     command entries (trigger:, permission:, …)
 *
 * Patterns become snippets with a tab stop per `%type%` slot; optional parts
 * are left out and the first of each choice is used.
 */
import {
  CompletionItemKind,
  InsertTextFormat,
  MarkupKind,
  type CompletionItem,
  type Range,
} from 'vscode-languageserver';
import type { FileIndex } from '../index/types';
import type { WorkspaceIndex } from '../index/workspace';
import { formatSignature } from '../skript/functions';
import type { SyntaxKind } from '../syntax/schema';
import type { PatternRef, SyntaxRegistry } from '../syntax/registry';
import { describeEntry } from './syntax';

const KIND: Record<SyntaxKind, CompletionItemKind> = {
  event: CompletionItemKind.Event,
  effect: CompletionItemKind.Method,
  condition: CompletionItemKind.Operator,
  section: CompletionItemKind.Struct,
  expression: CompletionItemKind.Value,
  function: CompletionItemKind.Function,
  structure: CompletionItemKind.Module,
  type: CompletionItemKind.TypeParameter,
};

/** StructCommand's entries (Skript 2.17.1). */
const COMMAND_ENTRIES = [
  ['trigger', 'trigger:\n\t$0'],
  ['permission', 'permission: ${1:plugin.command}'],
  ['permission message', 'permission message: ${1:&cYou do not have permission.}'],
  ['description', 'description: ${1:What the command does}'],
  ['usage', 'usage: ${1:/command <argument>}'],
  ['aliases', 'aliases: ${1:alias}'],
  ['executable by', 'executable by: ${1|players,console,players and console|}'],
  ['cooldown', 'cooldown: ${1:5 seconds}'],
  ['cooldown message', 'cooldown message: ${1:&cWait %remaining time%.}'],
  ['cooldown bypass', 'cooldown bypass: ${1:plugin.cooldown.bypass}'],
  ['cooldown storage', 'cooldown storage: {${1:cooldowns}::%player%}'],
  ['prefix', 'prefix: ${1:myplugin}'],
] as const;

const STRUCTURES: [string, string, string][] = [
  ['command', 'command /${1:name}:\n\ttrigger:\n\t\t$0', 'A command, with its trigger'],
  ['function', 'function ${1:name}(${2:p}: ${3:player}):\n\t$0', 'A function'],
  ['local function', 'local function ${1:name}(${2:p}: ${3:player}):\n\t$0', 'A function visible only in this script'],
  ['options', 'options:\n\t${1:name}: ${2:value}', 'Options for {@name} references'],
  ['variables', 'variables:\n\t{${1:name}} = ${2:0}', 'Default values for variables'],
  ['every', 'every ${1:5 minutes}:\n\t$0', 'A periodic event'],
];

export interface CompletionContext {
  readonly index: WorkspaceIndex;
  readonly registry: SyntaxRegistry;
  readonly file: FileIndex;
  /** The current line, as the editor has it. */
  readonly lineText: string;
  readonly line: number;
  readonly character: number;
}

export function completions(ctx: CompletionContext): CompletionItem[] {
  const prefix = ctx.lineText.slice(0, ctx.character);
  // Options are substituted everywhere in a line, strings included.
  const option = /\{@([^{}]*)$/.exec(prefix);
  if (option) return optionItems(ctx, ctx.character - option[1].length);
  if (inStringText(prefix) || /(^|[^#])#(?!#)/.test(stripStrings(prefix))) return [];
  const variable = /\{([^{}%"]*)$/.exec(prefix);
  if (variable && !insideExpression(prefix)) return variableItems(ctx, ctx.character - variable[1].length);

  const indent = /^\s*/.exec(prefix)![0];
  const statement = prefix.slice(indent.length);
  const fromStatementStart = range(ctx.line, indent.length, ctx.character);

  if (indent.length === 0) {
    const on = /^on\s+(.*)$/i.exec(statement);
    if (on) return syntaxItems(ctx.registry, 'event', range(ctx.line, ctx.character - on[1].length, ctx.character), { suffix: ':\n\t$0' });
    return [
      ...STRUCTURES.map(([label, snippet, detail]) => snippetItem(label, snippet, detail, CompletionItemKind.Module, fromStatementStart, `0_${label}`)),
      ...syntaxItems(ctx.registry, 'event', fromStatementStart, { prefix: 'on ', suffix: ':\n\t$0' }),
      ...syntaxItems(ctx.registry, 'structure', fromStatementStart, { exclude: (r) => /^Struct(Event|Command|Function|Options|Variables|Aliases)$/.test(r.entry.id) }),
    ];
  }

  // Which structure is the cursor in? The last top-level node that starts above it.
  const structure = [...ctx.file.script.structures].reverse().find((s) => s.line < ctx.line);
  if (!structure || structure.structure === 'options' || structure.structure === 'aliases' || structure.structure === 'variables') return [];
  // A direct child of a command is an entry; deeper lines are in its trigger.
  const firstChild = structure.children[0];
  const entryIndent = firstChild ? ctx.file.script.lines[firstChild.line].indent.length : indent.length;
  if (structure.structure === 'command' && indent.length <= entryIndent) {
    return COMMAND_ENTRIES.map(([label, snippet]) => snippetItem(label, snippet, 'Command entry', CompletionItemKind.Property, fromStatementStart, `0_${label}`));
  }

  const conditional = /^((?:else\s+)?(?:parse\s+)?if|(?:do\s+)?while)\s+(.*)$/i.exec(statement);
  if (conditional) {
    return syntaxItems(ctx.registry, 'condition', range(ctx.line, ctx.character - conditional[2].length, ctx.character), { suffix: ':\n\t$0' });
  }

  const wordStart = ctx.character - (/[\p{L}\d_'-]*$/u.exec(prefix)?.[0].length ?? 0);
  const word = range(ctx.line, wordStart, ctx.character);
  const items: CompletionItem[] = [];
  if (!insideExpression(prefix)) {
    items.push(
      snippetItem('if', 'if ${1:condition}:\n\t$0', 'Conditional section', CompletionItemKind.Keyword, fromStatementStart, '0_if'),
      snippetItem('else if', 'else if ${1:condition}:\n\t$0', 'Conditional section', CompletionItemKind.Keyword, fromStatementStart, '0_else if'),
      snippetItem('else', 'else:\n\t$0', 'Conditional section', CompletionItemKind.Keyword, fromStatementStart, '0_else'),
      ...syntaxItems(ctx.registry, 'effect', fromStatementStart),
      ...syntaxItems(ctx.registry, 'condition', fromStatementStart),
      ...syntaxItems(ctx.registry, 'section', fromStatementStart, { suffix: ':\n\t$0', exclude: (r) => r.entry.id === 'SecConditional' }),
      ...functionItems(ctx, fromStatementStart),
    );
  }
  // Past the first word, or inside %…%, an expression may be wanted.
  if (statement.includes(' ') || insideExpression(prefix)) {
    items.push(...syntaxItems(ctx.registry, 'expression', word), ...functionItems(ctx, word));
  }
  return items;
}

/** Fills in the documentation of a syntax item when VS Code shows it. */
export function resolveCompletion(item: CompletionItem, registry: SyntaxRegistry): CompletionItem {
  const data = item.data as { kind?: SyntaxKind; id?: string; addon?: string; index?: number } | undefined;
  if (!data?.kind) return item;
  const ref = registry.patterns(data.kind).find((r) => r.entry.id === data.id && r.entry.addon === data.addon && r.index === data.index);
  if (ref) item.documentation = { kind: MarkupKind.Markdown, value: describeEntry(ref) };
  return item;
}

// --- item builders ---------------------------------------------------------------

interface SyntaxItemOptions {
  readonly prefix?: string;
  readonly suffix?: string;
  readonly exclude?: (ref: PatternRef) => boolean;
}

function syntaxItems(registry: SyntaxRegistry, kind: SyntaxKind, at: Range, options: SyntaxItemOptions = {}): CompletionItem[] {
  const seen = new Set<string>();
  const items: CompletionItem[] = [];
  for (const ref of registry.patterns(kind)) {
    if (options.exclude?.(ref)) continue;
    const core = ref.entry.addon.toLowerCase() === 'skript';
    for (const variant of ref.variants) {
      if (variant.label === '' || variant.label === '…' || (variant.label.startsWith('%') && kind !== 'expression' && kind !== 'condition')) continue;
      const label = `${options.prefix ?? ''}${variant.label}`;
      if (seen.has(label)) continue;
      seen.add(label);
      items.push({
        label,
        kind: KIND[kind],
        detail: `${ref.entry.name || ref.entry.id} · ${kind}${core ? '' : ` · ${ref.entry.addon}`}`,
        labelDetails: { description: core ? undefined : ref.entry.addon },
        textEdit: { range: at, newText: `${options.prefix ?? ''}${variant.snippet}${options.suffix ?? ''}` },
        insertTextFormat: InsertTextFormat.Snippet,
        // Slots filter by their type name, so typing "player is" finds "%offline players% is op".
        filterText: label.replace(/%([^%]*)%/g, '$1'),
        sortText: `${core ? '1' : '2'}_${label.toLowerCase()}`,
        tags: ref.entry.deprecated ? [1] : undefined,
        data: { kind, id: ref.entry.id, addon: ref.entry.addon, index: ref.index },
      });
    }
  }
  return items;
}

function functionItems(ctx: CompletionContext, at: Range): CompletionItem[] {
  const items: CompletionItem[] = [];
  const seen = new Set<string>();
  const add = (name: string, params: string[], detail: string, doc?: string) => {
    if (seen.has(name)) return;
    seen.add(name);
    const args = params.map((p, i) => `\${${i + 1}:${p.replace(/[\\$}]/g, '')}}`).join(', ');
    items.push({
      label: `${name}()`,
      kind: CompletionItemKind.Function,
      detail,
      documentation: doc ? { kind: MarkupKind.Markdown, value: doc } : undefined,
      textEdit: { range: at, newText: `${name}(${args})` },
      insertTextFormat: InsertTextFormat.Snippet,
      filterText: name,
      sortText: `1_${name.toLowerCase()}`,
    });
  };
  for (const file of ctx.index.all()) {
    for (const def of file.functions) {
      if (!def.signature || (def.local && def.uri !== ctx.file.uri) || (file.disabled && file.uri !== ctx.file.uri)) continue;
      add(def.name, def.signature.parameters.map((p) => p.name), formatSignature(def.signature), def.doc);
    }
  }
  for (const fn of ctx.registry.functions.values()) {
    const signature = fn.signatures[0];
    add(fn.name, signature ? signature.parameters.filter((p) => p.defaultValue === undefined).map((p) => p.name) : [], `${fn.entry.patterns[0] ?? fn.name} · ${fn.entry.addon}`);
  }
  return items;
}

function variableItems(ctx: CompletionContext, start: number): CompletionItem[] {
  const at = range(ctx.line, start, ctx.character);
  const closes = ctx.lineText[ctx.character] === '}';
  // Variables visible here: all globals, and locals of the structure the cursor is in.
  const scope = [...ctx.file.script.structures].reverse().find((s) => s.line <= ctx.line)?.line ?? -1;
  const items = new Map<string, CompletionItem>();
  for (const file of ctx.index.all()) {
    for (const v of file.variables) {
      if (v.local && (v.uri !== ctx.file.uri || v.scope !== scope)) continue;
      if (v.uri === ctx.file.uri && v.line === ctx.line && v.start < ctx.character && v.end >= ctx.character) continue; // the one being typed
      const existing = items.get(v.key);
      if (existing) continue;
      items.set(v.key, {
        label: `{${v.raw}}`,
        kind: CompletionItemKind.Variable,
        detail: v.local ? 'Local variable' : 'Global variable',
        textEdit: { range: at, newText: v.raw + (closes ? '' : '}') },
        filterText: v.raw,
        sortText: `${v.local ? '0' : '1'}_${v.raw.toLowerCase()}`,
      });
    }
  }
  return [...items.values()];
}

function optionItems(ctx: CompletionContext, start: number): CompletionItem[] {
  const at = range(ctx.line, start, ctx.character);
  const closes = ctx.lineText[ctx.character] === '}';
  return [...ctx.file.script.options.values()].map((entry) => ({
    label: `{@${entry.key}}`,
    kind: CompletionItemKind.Constant,
    detail: entry.value,
    textEdit: { range: at, newText: entry.key + (closes ? '' : '}') },
    filterText: entry.key,
  }));
}

function snippetItem(label: string, snippet: string, detail: string, kind: CompletionItemKind, at: Range, sortText: string): CompletionItem {
  return {
    label,
    kind,
    detail,
    textEdit: { range: at, newText: snippet },
    insertTextFormat: InsertTextFormat.Snippet,
    filterText: label,
    sortText,
  };
}

// --- context helpers -------------------------------------------------------------------

function range(line: number, start: number, end: number): Range {
  return { start: { line, character: start }, end: { line, character: end } };
}

/** Is the cursor inside the plain text of a string (not inside a %…% expression)? */
function inStringText(prefix: string): boolean {
  let inString = false;
  let inExpression = false;
  for (let i = 0; i < prefix.length; i++) {
    const c = prefix[i];
    if (inString) {
      if (c === '"' && !inExpression) {
        if (prefix[i + 1] === '"') i++;
        else inString = false;
      } else if (c === '%') {
        if (prefix[i + 1] === '%' && !inExpression) i++;
        else inExpression = !inExpression;
      }
    } else if (c === '"') {
      inString = true;
      inExpression = false;
    }
  }
  return inString && !inExpression;
}

/** Is the cursor inside a `%…%` expression of a string or variable name? */
function insideExpression(prefix: string): boolean {
  let depth = 0;
  let inString = false;
  let open = 0;
  for (let i = 0; i < prefix.length; i++) {
    const c = prefix[i];
    if (c === '"' && open === 0) inString = !inString;
    else if (c === '{' && !inString) depth++;
    else if (c === '}' && !inString) depth = Math.max(0, depth - 1);
    else if (c === '%' && (inString || depth > 0)) open = open === 0 ? 1 : 0;
  }
  return open === 1;
}

function stripStrings(text: string): string {
  return text.replace(/"(?:[^"]|"")*"?/g, (s) => ' '.repeat(s.length));
}
