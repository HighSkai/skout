/**
 * Builds the indentation tree of a script and reports structural problems.
 *
 * The indentation rules are a port of `ch.njol.skript.config.SectionNode#load_i`
 * (Skript 2.17), which is what `/sk reload` runs before any syntax is parsed:
 *
 * - The first indented line inside each top-level structure sets the indent
 *   unit (all tabs or all spaces). Each structure sets it again, so one event
 *   may use tabs and the next 4 spaces.
 * - A line must be indented by exactly `unit × depth`. Fewer whole units close
 *   sections; extra whitespace or a partial unit is an indentation error.
 * - A line whose code ends with `:` opens a section; a section with nothing
 *   under it gets Skript's "empty configuration section" warning.
 *
 * The parser never throws and always produces a tree. Lines with errors are
 * attached where they most plausibly belong, so later features (outline,
 * index, completion) keep working while the user is mid-edit.
 */
import { checkBrackets } from './brackets';
import { describeWhitespace, LineKind, scanLines, type ScannedLine } from './lines';
import type { Issue, IssueCategory, IssueCode, OptionEntry, ParsedScript, Severity, SkNode, StructureKind } from './types';

interface OpenSection {
  readonly node: SkNode;
  /** Whether this top-level structure has set the indent unit yet. */
  indentSet: boolean;
  /** Whether anything other than blank lines and comments is under it. */
  hasContent: boolean;
}

export function parseScript(text: string): ParsedScript {
  return new TreeBuilder(scanLines(text)).build();
}

class TreeBuilder {
  private readonly issues: Issue[] = [];
  private readonly structures: SkNode[] = [];
  private readonly stack: OpenSection[] = [];
  /** One level of indentation. Skript's default before any structure sets it. */
  private unit = '\t';
  /** The code line placed immediately before the current one. */
  private previous: SkNode | null = null;
  /** Indent unit chosen by each top-level structure, for the style hint. */
  private readonly styles: { unit: string; line: number }[] = [];

  constructor(private readonly lines: ScannedLine[]) {}

  build(): ParsedScript {
    let blockCommentOpenedAt = -1;

    for (const line of this.lines) {
      if (line.kind === LineKind.BlockCommentDelimiter) {
        blockCommentOpenedAt = blockCommentOpenedAt === -1 ? line.index : -1;
        continue;
      }
      if (line.kind !== LineKind.Code) continue;
      this.place(line);
    }
    while (this.stack.length > 0) this.close();

    if (blockCommentOpenedAt !== -1) {
      const line = this.lines[blockCommentOpenedAt];
      this.report('unclosed-block-comment', 'comments', 'error', line.index, 0, line.text.length,
        'This block comment (###) is never closed, so Skript ignores the rest of the file.');
    }

    for (const node of this.structures) node.structure = classify(node);
    const options = collectOptions(this.structures);
    this.checkLines(options);
    this.checkIndentStyles();

    this.issues.sort((a, b) => a.line - b.line || a.start - b.start);
    return { lines: this.lines, structures: this.structures, issues: this.issues, options };
  }

  private place(line: ScannedLine): void {
    const ws = line.indent;
    const top = this.stack[this.stack.length - 1];

    // The first indented line of a top-level structure sets the indent unit.
    if (this.stack.length === 1 && !top.indentSet && ws.length > 0) {
      if (isPureIndent(ws)) {
        this.setUnit(ws, line.index);
        top.indentSet = true;
      } else {
        this.reportMixed(line);
        this.attach(line, this.stack.length, true);
        return;
      }
    }

    for (;;) {
      const depth = this.stack.length;
      const expected = this.unit.repeat(depth);

      if (ws === expected) {
        this.attach(line, depth, false);
        return;
      }

      const wholeUnits = ws.length % this.unit.length === 0 && ws === this.unit.repeat(ws.length / this.unit.length);
      if (ws.startsWith(expected) || !wholeUnits) {
        this.misindented(line, depth, expected);
        return;
      }

      // Fewer whole units than expected: the line belongs to an outer section.
      this.close();
    }
  }

  /** A line indented deeper than allowed, or by something other than whole units. */
  private misindented(line: ScannedLine, depth: number, expected: string): void {
    const ws = line.indent;
    const previous = this.previous;

    // A simple line followed by a line exactly one level deeper. The tree is
    // recovered as if the `:` were there, so only this line is reported.
    if (previous && previous.kind === 'simple' && !previous.invalid && previous.depth === depth) {
      const opensRoot = depth === 0 && isPureIndent(ws);
      if (opensRoot || (depth > 0 && ws === this.unit.repeat(depth + 1))) {
        const header = this.lines[previous.line];
        if (opensRoot || SECTION_KEYWORD.test(previous.key)) {
          this.report('missing-colon', 'missingColon', 'error', header.index, header.start, header.end,
            "Missing ':' at the end of this line. The lines below are indented as if it starts a section.");
        } else {
          // `send "a"` followed by a deeper line could be either mistake; say both.
          this.report('indent-unexpected', 'indentation', 'error', line.index, 0, ws.length,
            `Indentation error: expected ${describeWhitespace(expected)}, but found ${describeWhitespace(ws)}. ` +
              `If line ${header.index + 1} should start a section, it needs a ':' at the end.`);
        }
        previous.kind = 'section';
        previous.recovered = true;
        this.stack.push({ node: previous, indentSet: opensRoot, hasContent: false });
        if (opensRoot) this.setUnit(ws, line.index);
        this.attach(line, depth + 1, false);
        return;
      }
    }

    if (!isPureIndent(ws)) {
      this.reportMixed(line);
    } else {
      const found = describeWhitespace(ws);
      const want = depth === 0 ? 'no indentation' : describeWhitespace(expected);
      this.report('indent-unexpected', 'indentation', 'error', line.index, 0, Math.max(ws.length, 1),
        `Indentation error: expected ${want}, but found ${found}.`);
    }
    this.attach(line, depth, true);
  }

  private attach(line: ScannedLine, depth: number, invalid: boolean): void {
    const parentSection = depth > 0 ? this.stack[depth - 1] : undefined;
    const isSection = line.isSectionHeader && !invalid;
    const node: SkNode = {
      line: line.index,
      kind: line.isSectionHeader ? 'section' : 'simple',
      key: line.isSectionHeader ? line.value.slice(0, -1).trimEnd() : line.value,
      children: [],
      parent: parentSection ? parentSection.node : null,
      depth,
      lastLine: line.index,
    };
    if (invalid) node.invalid = true;

    if (parentSection) {
      parentSection.node.children.push(node);
      parentSection.hasContent = true;
    } else {
      this.structures.push(node);
    }
    for (let i = 0; i < depth && i < this.stack.length; i++) this.stack[i].node.lastLine = line.index;

    this.previous = node;
    if (isSection) this.stack.push({ node, indentSet: false, hasContent: false });
  }

  private close(): void {
    const section = this.stack.pop();
    if (!section || section.hasContent) return;
    const line = this.lines[section.node.line];
    this.report('empty-section', 'emptySection', 'warning', line.index, line.start, line.end,
      "Empty section: nothing is indented under this line. Indent the lines that belong to it, or remove the ':' if it should not start a section.");
  }

  private setUnit(unit: string, line: number): void {
    this.unit = unit;
    this.styles.push({ unit, line });
  }

  private reportMixed(line: ScannedLine): void {
    this.report('indent-mixed', 'indentation', 'error', line.index, 0, Math.max(line.indent.length, 1),
      `Indentation mixes tabs and spaces (found ${describeWhitespace(line.indent)}). Skript only accepts one kind.`);
  }

  /** Per-line checks that need to know where in the tree a line sits. */
  private checkLines(options: Map<string, OptionEntry>): void {
    const visit = (node: SkNode): void => {
      const line = this.lines[node.line];
      if (!takesRawText(node) && !optionsMayUnbalance(line.value, options)) {
        for (const issue of checkBrackets(line.text, line.start, line.end)) {
          const severity: Severity = issue.char === '[' || issue.char === ']' ? 'warning' : 'error';
          this.report(issue.code, 'unclosed', severity, line.index, issue.column, issue.column + 1, bracketMessage(issue.code, issue.char));
        }
      }
      if (line.commentStart > 0 && !/\s/.test(line.text[line.commentStart - 1])) {
        this.report('accidental-comment', 'comments', 'warning', line.index, line.commentStart, line.text.length,
          "'#' starts a comment here, so Skript ignores the rest of the line. Write '##' for a literal '#'.");
      }
      for (const child of node.children) visit(child);
    };
    for (const node of this.structures) visit(node);
  }

  /** Skript allows a different indent per structure; flag files that mix styles. */
  private checkIndentStyles(): void {
    if (this.styles.length < 2) return;
    const counts = new Map<string, number>();
    for (const s of this.styles) counts.set(s.unit, (counts.get(s.unit) ?? 0) + 1);
    if (counts.size < 2) return;

    let main = this.styles[0].unit;
    for (const [unit, n] of counts) if (n > (counts.get(main) ?? 0)) main = unit;

    for (const s of this.styles) {
      if (s.unit === main) continue;
      this.report('indent-style', 'indentation', 'information', s.line, 0, s.unit.length,
        `This structure is indented with ${describeWhitespace(s.unit)}, but most of this file uses ${describeWhitespace(main)}. ` +
          'Skript accepts a different indent per structure, but one style per file is easier to keep right.');
    }
  }

  private report(code: IssueCode, category: IssueCategory, severity: Severity, line: number, start: number, end: number, message: string): void {
    this.issues.push({ code, category, severity, line, start, end, message });
  }
}

/**
 * Lines that can only be section headers, so a missing `:` is certain. Taken
 * from the patterns of Skript's built-in sections (SecConditional, SecLoop,
 * SecWhile, SecFor, SecCatchErrors, SecFilter) and the command `trigger` entry.
 * Addon sections are not listed; for those the indentation error is reported.
 */
const SECTION_KEYWORD = /^(?:else\s+parse\s+if|else\s+if|else|parse\s+if|if|loop|do\s+while|while|for(?:\s+each)?|catch(?:\s+run\s*time)?\s+errors?|filter|trigger)(?:\s|$)/i;

function isPureIndent(ws: string): boolean {
  return /^(?: +|\t+)$/.test(ws);
}

/** Classifies a top-level node using the patterns of Skript's built-in structures. */
function classify(node: SkNode): StructureKind {
  const key = node.key.trim().toLowerCase();
  if (node.kind === 'simple') return /^using\s/.test(key) ? 'using' : 'other';
  if (key === 'options') return 'options';
  if (key === 'variables') return 'variables';
  if (key === 'aliases') return 'aliases';
  if (/^command\s/.test(key)) return 'command';
  if (/^(local\s+)?function\s/.test(key)) return 'function';
  // StructEvent's pattern ends in `<.+>`, so every other section is an event.
  return 'event';
}

/**
 * Lines whose value is raw text rather than code: everything under `options:`
 * and `aliases:`, and command entries such as `usage:` or `permission message:`.
 * Quotes and brackets in them do not have to balance.
 */
function takesRawText(node: SkNode): boolean {
  let top = node;
  while (top.parent) top = top.parent;
  if (top === node) return false;
  if (top.structure === 'options' || top.structure === 'aliases') return true;
  return top.structure === 'command' && node.parent === top && node.kind === 'simple';
}

/**
 * Collects `options:` entries the way StructOptions#loadOptions does: an entry
 * is `key: value` split at the first `:`, and a nested section prefixes its
 * entries with `section.`.
 */
function collectOptions(structures: readonly SkNode[]): Map<string, OptionEntry> {
  const options = new Map<string, OptionEntry>();
  const load = (section: SkNode, prefix: string) => {
    for (const child of section.children) {
      if (child.kind === 'section') {
        load(child, `${prefix}${child.key.trim()}.`);
        continue;
      }
      const colon = child.key.indexOf(':');
      if (colon === -1) continue;
      const key = prefix + child.key.slice(0, colon).trim();
      options.set(key, { key, value: child.key.slice(colon + 1).trim(), line: child.line });
    }
  };
  for (const node of structures) if (node.structure === 'options') load(node, '');
  return options;
}

const OPTION_REFERENCE = /\{@(.+?)\}/g;
const BRACKET_CHARS = /["%{}()[\]]/;

/**
 * Skript substitutes `{@option}` as plain text before parsing a line, so an
 * option whose value holds a quote or bracket can legitimately balance (or
 * unbalance) the line. Such lines are not checked; neither are lines using an
 * option this file does not define, since its value is unknown.
 */
function optionsMayUnbalance(value: string, options: Map<string, OptionEntry>): boolean {
  if (!value.includes('{@')) return false;
  for (const match of value.matchAll(OPTION_REFERENCE)) {
    const option = options.get(match[1]);
    if (!option || BRACKET_CHARS.test(option.value)) return true;
  }
  return false;
}

function bracketMessage(code: IssueCode, char: string): string {
  switch (code) {
    case 'unclosed-string':
      return 'Unclosed string: this " has no closing quote on the same line.';
    case 'unclosed-percent':
      return "Unclosed '%' in a string. Close the expression with another '%', or write '%%' for a literal percent sign.";
    case 'unclosed-bracket':
      return `Unclosed '${char}'.`;
    default:
      return `Unmatched '${char}': nothing opens it on this line.`;
  }
}

/** Visits every node in document order. */
export function walk(nodes: readonly SkNode[], fn: (node: SkNode) => void): void {
  for (const node of nodes) {
    fn(node);
    walk(node.children, fn);
  }
}
