/**
 * Extracts what the workspace index needs from one parsed script: function
 * definitions and calls, variables with whether each use reads or writes,
 * `{@option}` references and commands.
 */
import { LineKind, type ScannedLine } from '../parser/lines';
import type { OptionEntry, ParsedScript, SkNode } from '../parser/types';
import { nextToken, parseArguments, parseSignature } from '../skript/functions';
import { isPlural } from '../skript/plural';
import type { Version } from '../skript/version';
import type { CommandDef, FileIndex, FunctionCall, FunctionDef, OptionRef, Segment, VariableOccurrence } from './types';

export function extract(uri: string, script: ParsedScript, version: Version): FileIndex {
  return new Extractor(uri, script, version).run();
}

interface RawVariable {
  start: number;
  end: number;
  depth: number;
}

interface LineScan {
  variables: RawVariable[];
  /** The line with string text and variable-name text blanked, for finding calls. */
  masked: string;
  /** The line with whole top-level strings and variable names blanked, for reading its shape. */
  flat: string;
}

/**
 * Statement shapes that assign to the variables in the captured span. They
 * come from the patterns of Skript's changers (EffChange, EffCopy) and the
 * `for each` section (SecFor), plus addon effects that "store … in" a variable.
 */
const WRITE_SHAPES: RegExp[] = [
  /^set\s+(.+?)\s+to\s/di,
  /^(?:add|give)\s+.+?\s+to\s+(.+)$/di,
  /^(?:increase|reduce|decrease)\s+(.+?)\s+by\s/di,
  /^(?:remove|subtract)\s+(?:(?:all|every)\s+)?.+?\s+from\s+(.+)$/di,
  /^(?:delete|clear|reset)\s+(.+)$/di,
  /^copy\s+.+?\s+(?:in)?to\s+(.+)$/di,
  /^(?:for(?:\s+each)?|loop)\s+(?:(?:value|key|index)\s+)?(.+?)\s+in\s/di,
  /\b(?:store|stored|save|saved)\b.*?\b(?:in|into)\s+(\{.*)$/di,
];

const CALL = /([\p{Alphabetic}_][\p{Alphabetic}\d_]*)\(/gu;
/** A named command argument: `<target: player>`, `<amounts: numbers>`, `<x: number above 5>`. */
const COMMAND_ARGUMENT = /<\s*([^<>:]+?)\s*:\s*([^<>]+)>/g;
const IDENTIFIER_CHAR = /[\p{Alphabetic}\d_.]/u;
const OPTION_REFERENCE = /\{@(.+?)\}/g;

class Extractor {
  private readonly functions: FunctionDef[] = [];
  private readonly calls: FunctionCall[] = [];
  private readonly variables: VariableOccurrence[] = [];
  private readonly optionRefs: OptionRef[] = [];
  private readonly commands: CommandDef[] = [];

  constructor(
    private readonly uri: string,
    private readonly script: ParsedScript,
    private readonly version: Version,
  ) {}

  run(): FileIndex {
    for (const structure of this.script.structures) this.structure(structure);
    return {
      uri: this.uri,
      script: this.script,
      functions: this.functions,
      calls: this.calls,
      variables: this.variables,
      optionRefs: this.optionRefs,
      commands: this.commands,
    };
  }

  private structure(node: SkNode): void {
    const kind = node.structure;
    if (kind === 'options' || kind === 'aliases') return; // raw text, never substituted or parsed

    if (kind === 'function') this.functionDef(node);
    else this.line(node, node.line, false);
    if (kind === 'command') this.command(node);

    const visit = (child: SkNode) => {
      if (kind === 'command' && child.parent === node && child.kind === 'simple') {
        this.commandEntry(child, node.line);
      } else if (kind === 'variables' && child.parent === node) {
        this.defaultVariable(child, node.line);
      } else {
        this.line(child, node.line, false);
      }
      child.children.forEach(visit);
    };
    node.children.forEach(visit);
  }

  private functionDef(node: SkNode): void {
    const line = this.lineAt(node.line);
    this.optionReferences(line);
    const header = substituteOptions(node.key, this.script.options);
    const result = parseSignature(header, this.version);
    const literalHeader = header === node.key;
    const nameText = result.ok ? result.signature.name : result.name;
    let start = line.start;
    if (nameText) {
      const offset = result.ok ? result.signature.nameOffset : result.nameOffset;
      start = literalHeader && offset !== undefined ? line.start + offset : Math.max(line.start, line.text.indexOf(nameText, line.start));
    }
    const def: FunctionDef = {
      uri: this.uri,
      line: node.line,
      start,
      end: start + (nameText?.length ?? 0),
      name: nameText ?? '',
      local: /^local\s/i.test(header),
      signature: result.ok ? result.signature : undefined,
      error: result.ok ? undefined : result.message,
      header: node.key,
      doc: this.docAbove(node.line),
    };
    this.functions.push(def);

    // Parameters are local variables set on entry.
    if (result.ok && literalHeader) {
      for (const p of result.signature.parameters) {
        const nameStart = line.start + p.offset + (header.slice(p.offset).length - header.slice(p.offset).trimStart().length);
        this.variables.push({
          uri: this.uri,
          line: node.line,
          start: nameStart,
          end: nameStart + p.name.length,
          raw: p.variable,
          segments: segmentsOf(p.variable, nameStart),
          local: true,
          write: true,
          scope: node.line,
          key: keyOf(segmentsOf(p.variable, nameStart)),
          parameter: true,
          topLevel: true,
        });
      }
    }
  }

  private command(node: SkNode): void {
    const line = this.lineAt(node.line);
    const m = /^command\s+\/?([^\s<[:]+)/i.exec(node.key);
    if (!m) return;
    const start = line.start + node.key.indexOf(m[1], 'command'.length);
    const aliasEntry = node.children.find((c) => c.kind === 'simple' && /^aliases\s*:/i.test(c.key));
    const aliases = aliasEntry
      ? aliasEntry.key
          .slice(aliasEntry.key.indexOf(':') + 1)
          .split(',')
          .map((a) => a.trim().replace(/^\//, ''))
          .filter(Boolean)
      : [];
    this.commands.push({ uri: this.uri, line: node.line, start, end: start + m[1].length, name: m[1].toLowerCase(), aliases });

    // Named arguments (`<target: player>`) become local variables in the command,
    // including those of `subcommand` sections.
    this.commandArguments(node, node.line);
    for (const child of node.children) {
      if (child.kind === 'section' && /^subcommand\b/i.test(child.key)) this.commandArguments(child, node.line);
    }
  }

  /** `<name: type>` in a command or subcommand header: `{_name}`, or `{_name::*}` for a plural type. */
  private commandArguments(node: SkNode, scope: number): void {
    const line = this.lineAt(node.line);
    for (const m of node.key.matchAll(COMMAND_ARGUMENT)) {
      const name = m[1].trim();
      const type = m[2].replace(/\s*=.*$/, '').replace(/\s+(?:above|below|between|from|in|of)\b.*$/i, '').trim();
      const variable = isPlural(type).plural ? `_${name}::*` : `_${name}`;
      const start = line.start + m.index + m[0].indexOf(name);
      const segments = segmentsOf(variable, start);
      this.variables.push({
        uri: this.uri,
        line: node.line,
        start,
        end: start + name.length,
        raw: variable,
        segments,
        local: true,
        write: true,
        scope,
        key: keyOf(segments),
        parameter: true,
        topLevel: true,
      });
    }
  }

  /** Command entries are raw text, except that options are substituted and `cooldown storage` names a variable. */
  private commandEntry(node: SkNode, scope: number): void {
    const line = this.lineAt(node.line);
    this.optionReferences(line);
    if (/^cooldown storage\s*:/i.test(node.key)) this.line(node, scope, true);
  }

  /** `variables:` entries are `{name} = default value`: the left side is set. */
  private defaultVariable(node: SkNode, scope: number): void {
    const line = this.lineAt(node.line);
    const eq = line.text.indexOf('=', line.start);
    this.line(node, scope, false, eq === -1 ? undefined : [line.start, eq]);
  }

  /**
   * Indexes one line. `allWrites` marks every top-level variable as written;
   * `writeSpan` marks those starting inside it.
   */
  private line(node: SkNode, scope: number, allWrites: boolean, writeSpan?: [number, number]): void {
    const line = this.lineAt(node.line);
    this.optionReferences(line);
    const scan = scanLine(line.text, line.start, line.end);

    let span = writeSpan;
    if (!span && !allWrites) {
      let code = scan.flat.slice(line.start, line.end);
      if (node.kind === 'section' && code.endsWith(':')) code = code.slice(0, -1).trimEnd();
      for (const shape of WRITE_SHAPES) {
        const m = shape.exec(code);
        const indices = m?.indices?.[1];
        if (indices) {
          span = [line.start + indices[0], line.start + indices[1]];
          break;
        }
      }
    }

    for (const v of scan.variables) {
      if (line.text[v.start + 1] === '@') continue;
      const raw = line.text.slice(v.start + 1, v.end - 1);
      const segments = segmentsOf(raw, v.start + 1);
      const topLevel = v.depth === 0;
      const write = topLevel && (allWrites || (span !== undefined && v.start >= span[0] && v.start < span[1]));
      this.variables.push({
        uri: this.uri,
        line: line.index,
        start: v.start,
        end: v.end,
        raw,
        segments,
        local: raw.startsWith('_'),
        write,
        scope,
        key: keyOf(segments),
        topLevel,
      });
    }

    // A function header nested in a block (Skript's own tests do this inside `parse:`) is not a call.
    if (!/^(?:local\s+)?function\s/i.test(node.key)) this.findCalls(line, scan.masked);
  }

  private findCalls(line: ScannedLine, masked: string): void {
    CALL.lastIndex = line.start;
    for (let m = CALL.exec(masked); m && m.index < line.end; m = CALL.exec(masked)) {
      const start = m.index;
      if (start > 0 && IDENTIFIER_CHAR.test(masked[start - 1])) continue;
      // skript-reflect: `new ArrayList()` constructs a Java object; `x.method()` is a Java call.
      if (/\bnew\s+$/i.test(masked.slice(Math.max(0, start - 8), start))) continue;
      const name = m[1];
      const open = start + name.length;
      const after = nextToken(line.text, open);
      const closed = after !== -1 && after <= line.end;
      const close = closed ? after : line.end;
      const argsText = line.text.slice(open + 1, closed ? close - 1 : close);
      this.calls.push({
        uri: this.uri,
        line: line.index,
        start,
        end: open,
        name,
        args: parseArguments(argsText).map((a) => ({ ...a, start: a.start + open + 1, end: a.end + open + 1 })),
        open,
        close,
        closed,
      });
    }
  }

  private optionReferences(line: ScannedLine): void {
    const code = line.text.slice(0, line.end);
    OPTION_REFERENCE.lastIndex = line.start;
    for (let m = OPTION_REFERENCE.exec(code); m; m = OPTION_REFERENCE.exec(code)) {
      this.optionRefs.push({ uri: this.uri, line: line.index, start: m.index, end: m.index + m[0].length, name: m[1] });
    }
  }

  private docAbove(lineIndex: number): string | undefined {
    const docs: string[] = [];
    for (let i = lineIndex - 1; i >= 0; i--) {
      const l = this.script.lines[i];
      if (l.kind !== LineKind.Comment) break;
      docs.unshift(l.text.trim().replace(/^#+\s?/, ''));
    }
    return docs.length > 0 ? docs.join('\n') : undefined;
  }

  private lineAt(index: number): ScannedLine {
    return this.script.lines[index];
  }
}

/**
 * Walks one line's code, tracking strings, `%…%` expressions and variables.
 * Inside a string only `%…%` is code; inside a variable name only `%…%` is.
 */
export function scanLine(text: string, from: number, to: number): LineScan {
  const masked = text.split('');
  const flat = text.split('');
  const variables: RawVariable[] = [];
  const stack: { type: 'string' | 'expr' | 'var'; start: number }[] = [];
  const varDepth = () => stack.reduce((n, s) => n + (s.type === 'var' ? 1 : 0), 0);

  for (let i = from; i < to; i++) {
    const c = text[i];
    const top = stack.length > 0 ? stack[stack.length - 1].type : undefined;

    if (top === 'string') {
      if (c === '"') {
        if (text[i + 1] === '"' && i + 1 < to) {
          masked[i] = masked[i + 1] = ' ';
          i++;
        } else {
          const open = stack.pop()!;
          if (stack.length === 0) for (let k = open.start + 1; k < i; k++) flat[k] = ' ';
        }
      } else if (c === '%') {
        if (text[i + 1] === '%' && i + 1 < to) {
          masked[i] = masked[i + 1] = ' ';
          i++;
        } else {
          stack.push({ type: 'expr', start: i });
        }
      } else {
        masked[i] = ' ';
      }
      continue;
    }

    if (top === 'var') {
      if (c === '%') {
        stack.push({ type: 'expr', start: i });
      } else if (c === '}') {
        const open = stack.pop()!;
        const depth = varDepth();
        variables.push({ start: open.start, end: i + 1, depth });
        if (depth === 0 && !stack.some((s) => s.type === 'string')) for (let k = open.start + 1; k < i; k++) flat[k] = 'x';
      } else if (c === '{') {
        stack.push({ type: 'var', start: i });
      } else {
        masked[i] = ' ';
      }
      continue;
    }

    // Code, or an expression inside a string or variable name.
    if (c === '"') {
      stack.push({ type: 'string', start: i });
    } else if (c === '{') {
      if (text[i + 1] === '@') {
        const close = text.indexOf('}', i);
        if (close !== -1 && close < to) i = close; // an option reference, substituted as text
      } else {
        stack.push({ type: 'var', start: i });
      }
    } else if (c === '%' && top === 'expr') {
      stack.pop();
    }
  }
  return { variables, masked: masked.join(''), flat: flat.join('') };
}

/** Splits a variable name at `::` outside `%…%` and nested braces. */
export function segmentsOf(raw: string, offset: number): Segment[] {
  const segments: Segment[] = [];
  let depth = 0;
  let inExpr = false;
  let start = 0;
  const push = (end: number) => {
    const text = raw.slice(start, end);
    const kind = text === '*' ? 'wildcard' : /[%{]/.test(text) ? 'dynamic' : 'literal';
    segments.push({ text, start: offset + start, end: offset + end, kind, norm: kind === 'literal' ? text.toLowerCase() : text });
  };
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i];
    if (c === '%') inExpr = !inExpr;
    else if (!inExpr && c === '{') depth++;
    else if (!inExpr && c === '}') depth--;
    else if (!inExpr && depth === 0 && c === ':' && raw[i + 1] === ':') {
      push(i);
      start = i + 2;
      i++;
    }
  }
  push(raw.length);
  return segments;
}

export function keyOf(segments: readonly Segment[]): string {
  return segments.map((s) => (s.kind === 'literal' ? s.norm : s.kind === 'wildcard' ? '*' : '%')).join('::');
}

/** ScriptLoader#replaceOptions: plain-text substitution of `{@name}`. Unknown options are left as written. */
export function substituteOptions(text: string, options: ReadonlyMap<string, OptionEntry>): string {
  if (!text.includes('{@')) return text;
  return text.replace(OPTION_REFERENCE, (whole, name: string) => options.get(name)?.value ?? whole);
}
