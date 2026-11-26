/**
 * Where a statement may stand: checks that depend on the sections around a
 * line rather than on the line itself. Each rule and message comes from
 * Skript 2.17.1:
 *
 * - SecConditional#init: `else` / `else if` need a preceding `if`; `then`
 *   needs a multiline `if`; a multiline `if` needs a `then` after it and two
 *   or more conditions, and no sections, inside.
 * - EffContinue: only inside a loop (LoopSection: `loop`, `while`, `for`).
 * - EffExit: `exit loop` / `exit section` / `exit conditional` need one.
 * - ExprLoopValue: `loop-value` and `loop-<type>` need a `loop` (SecLoop).
 * - EffReturn: needs a return handler (a function, or a 2.17 command
 *   trigger); the function must declare a return type; no delay before it.
 * - ScriptLoader#loadItems: "Unreachable code" after a statement that stops
 *   execution (return, stop/exit, continue).
 *
 * Sections Skout does not recognise may be addon sections that change all of
 * this (an addon loop, a return handler), so a rule is skipped whenever such
 * a section encloses the line.
 */
import { isConditional } from '../features/syntax';
import { scanLine, substituteOptions } from '../index/extract';
import type { FileIndex } from '../index/types';
import type { Issue, IssueCode, SkNode } from '../parser/types';
import { atLeast, type Version } from '../skript/version';
import type { SyntaxRegistry } from '../syntax/registry';

type Role =
  | 'if'
  | 'multi-if'
  | 'else-if'
  | 'multi-else-if'
  | 'else'
  | 'then'
  /** A section header that is a condition: SecConditional's implicit `<condition>:`. */
  | 'implicit-if'
  | 'loop'
  | 'while'
  /** A known section or statement that is none of the above. */
  | 'other'
  /** Matches no known syntax: may be an addon's. */
  | 'unknown';

interface Context {
  readonly structure: 'event' | 'function' | 'command';
  /** SecLoop / SecFor: what `loop-value` needs. */
  readonly loops: number;
  /** LoopSection: loops and `while`, what `continue` and `exit loop` need. */
  readonly loopSections: number;
  readonly conditionals: number;
  readonly sections: number;
  /** An unrecognised section encloses this block. */
  readonly uncertain: boolean;
  /** A delay certainly ran before this block started. */
  readonly delayed: boolean;
  /** The function's declared return type, for functions. */
  readonly returns?: string | null;
  readonly functionName?: string;
}

export function contextIssues(file: FileIndex, registry: SyntaxRegistry, version: Version): Issue[] {
  const checker = new ContextChecker(file, registry, version);
  for (const structure of file.script.structures) {
    if (structure.invalid) continue;
    const base = { loops: 0, loopSections: 0, conditionals: 0, sections: 0, uncertain: false, delayed: false };
    if (structure.structure === 'event') checker.block(structure.children, { ...base, structure: 'event' });
    else if (structure.structure === 'function') {
      const def = file.functions.find((f) => f.line === structure.line);
      if (def?.signature) checker.block(structure.children, { ...base, structure: 'function', returns: def.signature.returnType ?? null, functionName: def.signature.name });
    } else if (structure.structure === 'command') {
      for (const trigger of commandTriggers(structure)) checker.block(trigger.children, { ...base, structure: 'command' });
    }
  }
  return checker.issues;
}

/** The `trigger:` and `suggestions:` sections of a command and of its subcommands. */
function commandTriggers(command: SkNode): SkNode[] {
  const out: SkNode[] = [];
  for (const child of command.children) {
    if (child.kind !== 'section' || child.invalid) continue;
    if (/^(?:trigger|suggestions)$/i.test(child.key)) out.push(child);
    else if (/^subcommands?\b/i.test(child.key)) out.push(...commandTriggers(child));
  }
  return out;
}

const STOPS = new Set(['EffReturn', 'EffExit', 'EffContinue']);

class ContextChecker {
  readonly issues: Issue[] = [];
  /** EffSuppressWarnings turns this on and off as Skript loads the script, top to bottom. */
  private suppressUnreachable = false;
  private readonly roles = new Map<SkNode, Role>();
  private readonly ids = new Map<SkNode, string | undefined>();

  constructor(
    private readonly file: FileIndex,
    private readonly registry: SyntaxRegistry,
    private readonly version: Version,
  ) {}

  block(nodes: readonly SkNode[], context: Context): void {
    let stopped: SkNode | undefined;
    let delayed = context.delayed;
    for (let i = 0; i < nodes.length; i++) {
      const node = nodes[i];
      if (node.invalid) continue;
      // The effect switches the warning off or on from here; the section form only inside it.
      const suppress = /^(un)?suppress\s+(?:the\s+)?unreachable\s+code\s+warnings?$/i.exec(this.text(node));
      const outer = this.suppressUnreachable;
      if (suppress) this.suppressUnreachable = !suppress[1];
      if (stopped && !this.suppressUnreachable) {
        this.report(node, 'unreachable-code', 'warning', 'Unreachable code. The previous statement stops further execution.', true);
      }
      stopped = undefined;
      const role = this.role(node);
      const here = { ...context, delayed };
      this.loopValues(node, here);

      if (node.kind === 'section') {
        this.conditional(node, role, nodes, i);
        const inner: Context = {
          ...here,
          sections: here.sections + 1,
          loops: here.loops + (role === 'loop' ? 1 : 0),
          loopSections: here.loopSections + (role === 'loop' || role === 'while' ? 1 : 0),
          conditionals: here.conditionals + (role.includes('if') || role === 'else' || role === 'then' ? 1 : 0),
          uncertain: here.uncertain || role === 'unknown' || role === 'other',
        };
        // A multiline `if` holds conditions, not statements.
        if (role !== 'multi-if' && role !== 'multi-else-if') this.block(node.children, inner);
        if (suppress) this.suppressUnreachable = outer;
        continue;
      }

      const id = this.idOf(node);
      const before = this.issues.length;
      if (id === 'EffContinue') this.continueCheck(node, here);
      else if (id === 'EffExit') this.exitCheck(node, here);
      else if (id === 'EffReturn') this.returnCheck(node, here);
      // A statement that fails to load does not stop anything (ScriptLoader skips it).
      if (this.issues.length > before) continue;
      // EffDoIf (2.17): `return false if <condition>` only stops when the condition holds.
      if (id && STOPS.has(id) && !this.inlineCondition(node)) stopped = node;
      if (id === 'Delay') delayed = true;
    }
  }

  // --- conditionals -------------------------------------------------------------------

  private conditional(node: SkNode, role: Role, siblings: readonly SkNode[], index: number): void {
    if (role === 'else' || role === 'else-if' || role === 'multi-else-if') {
      const found = this.preceding(siblings, index, (r) => r === 'if' || r === 'multi-if' || r === 'implicit-if', (r) => r === 'else-if' || r === 'multi-else-if' || r === 'then');
      if (found === false) {
        const what = role === 'else' ? "'else'" : "'else if'";
        this.report(node, 'misplaced-conditional', 'error', `${what} has to be placed just after another 'if' or 'else if' section`);
      }
    } else if (role === 'then') {
      // The most recent conditional section must be a multiline 'if' or 'else if'.
      const found = this.preceding(siblings, index, (r) => r === 'multi-if' || r === 'multi-else-if', () => false, (r) => r === 'if' || r === 'else-if' || r === 'implicit-if' || r === 'then');
      if (found === false) this.report(node, 'misplaced-conditional', 'error', "'then' has to placed just after a multiline 'if' or 'else if' section");
    }
    if (role === 'multi-if' || role === 'multi-else-if') {
      const name = /\b(?:any|at\s+least\s+one)\b/i.test(node.key) ? "'if any'" : "'if all'";
      const conditions = node.children.filter((c) => !c.invalid);
      if (conditions.length < 2) this.report(node, 'misplaced-conditional', 'error', `${name} sections must contain at least two conditions`);
      else if (conditions.some((c) => c.kind === 'section')) this.report(node, 'misplaced-conditional', 'error', `${name} sections may not contain other sections`);
      if (role === 'multi-if') {
        const next = siblings.slice(index + 1).find((s) => !s.invalid);
        if (!next || this.role(next) !== 'then') this.report(node, 'misplaced-conditional', 'error', `${name} has to be placed just before a 'then' section`);
      }
    }
  }

  /**
   * SecConditional#getPrecedingConditional, over the previous siblings: true
   * if `match` comes first (skipping `skip`), false if something else does,
   * undefined when an unknown line makes it impossible to tell.
   */
  private preceding(siblings: readonly SkNode[], index: number, match: (r: Role) => boolean, skip: (r: Role) => boolean, fail?: (r: Role) => boolean): boolean | undefined {
    for (let j = index - 1; j >= 0; j--) {
      const sibling = siblings[j];
      if (sibling.invalid) continue;
      const role = this.role(sibling);
      if (role === 'unknown') return undefined;
      if (match(role)) return true;
      if (fail?.(role)) return false;
      if (skip(role)) continue;
      return false;
    }
    return false;
  }

  // --- statements -----------------------------------------------------------------------

  private continueCheck(node: SkNode, context: Context): void {
    if (context.loopSections === 0 && !context.uncertain) this.report(node, 'misplaced-statement', 'error', "The 'continue' effect may only be used in loops");
  }

  private exitCheck(node: SkNode, context: Context): void {
    const text = this.text(node);
    const one = /^(?:exit|stop)\s+(?:(?:1|a|the|this)\s+)?(section|loop|conditional)$/i.exec(text);
    const many = /^(?:exit|stop)\s+(\d+)\s+(section|loop|conditional)s$/i.exec(text);
    if (!one && !many) return;
    const kind = (one ? one[1] : many![2]).toLowerCase();
    const levels = one ? 1 : Number(many![1]);
    const present = kind === 'loop' ? context.loopSections : kind === 'section' ? context.sections : context.conditionals;
    // Unknown sections could be loops or conditionals, but they are sections all the same.
    if (context.uncertain && kind !== 'section') return;
    const names = `${kind}s`;
    if (present === 0) this.report(node, 'misplaced-statement', 'error', `Can't stop any ${names} as there are no ${names} present`);
    else if (levels > present) this.report(node, 'misplaced-statement', 'error', `Can't stop ${levels} ${names} as there are only ${present} ${names} present`);
  }

  private returnCheck(node: SkNode, context: Context): void {
    if (context.uncertain) return;
    if (context.structure === 'event' || (context.structure === 'command' && !atLeast(this.version, 2, 17))) {
      this.report(node, 'misplaced-statement', 'error', 'The return statement cannot be used here');
      return;
    }
    if (context.structure !== 'function') return;
    if (context.delayed) {
      this.report(node, 'misplaced-statement', 'error', "A return statement after a delay is useless, as the calling trigger will resume when the delay starts (and won't get any returned value)");
    } else if (context.returns === null) {
      this.report(node, 'misplaced-statement', 'error', `The function '${context.functionName}' doesn't return any value. Please use 'stop' or 'exit' if you want to stop the trigger.`);
    }
  }

  /** ExprLoopValue: `loop-value`, `loop-player`, `loop-value-2` need an enclosing `loop`. */
  private loopValues(node: SkNode, context: Context): void {
    if (context.loops > 0 || context.uncertain) return;
    const line = this.file.script.lines[node.line];
    const masked = scanLine(line.text, line.start, line.end).masked.slice(0, line.end);
    const re = /(?<![\w-])loop-([\p{L}][\p{L} ]*?)(?:-\d+)?(?=[^\p{L}]|$)/giu;
    for (const m of masked.matchAll(re)) {
      const of = m[1].toLowerCase();
      if (of === 'counter' || of === 'iteration' || of === 'index') continue; // ExprLoopIteration, and SecFor's loop-index
      this.issues.push({
        code: 'misplaced-statement',
        category: 'context',
        severity: 'error',
        message: `There's no loop that matches 'loop-${m[1]}'`,
        line: node.line,
        start: m.index,
        end: m.index + m[0].length,
      });
    }
  }

  // --- classification ---------------------------------------------------------------------

  private inlineCondition(node: SkNode): boolean {
    const line = this.file.script.lines[node.line];
    return / if /i.test(scanLine(line.text, line.start, line.end).flat.slice(line.start, line.end));
  }

  private text(node: SkNode): string {
    return substituteOptions(node.key, this.file.script.options).trim();
  }

  private idOf(node: SkNode): string | undefined {
    if (this.ids.has(node)) return this.ids.get(node);
    const id = this.registry.match(['effect', 'condition', 'section'], this.text(node), isConditional)?.entry.id;
    this.ids.set(node, id);
    return id;
  }

  private role(node: SkNode): Role {
    let role = this.roles.get(node);
    if (role) return role;
    role = this.classify(node);
    this.roles.set(node, role);
    return role;
  }

  private classify(node: SkNode): Role {
    const text = this.text(node);
    if (node.kind !== 'section') return this.idOf(node) ? 'other' : 'unknown';
    if (/^else$/i.test(text)) return 'else';
    if (/^then(?:\s+run)?$/i.test(text)) return 'then';
    if (/^else\s+(?:parse\s+)?if(?:\s+(?:any|at\s+least\s+one(?:\s+of)?|all))?$/i.test(text)) return 'multi-else-if';
    if (/^else\s+(?:parse\s+)?if\s+\S/i.test(text)) return 'else-if';
    if (/^(?:parse\s+)?if(?:\s+(?:any|at\s+least\s+one(?:\s+of)?|all))?$/i.test(text)) return 'multi-if';
    if (/^(?:parse\s+)?if\s+\S/i.test(text)) return 'if';
    if (/^(?:do\s+)?while\s+\S/i.test(text)) return 'while';
    const section = this.registry.match(['section', 'effect'], text, isConditional);
    if (section && (section.entry.id === 'SecLoop' || section.entry.id === 'SecFor')) return 'loop';
    // A header that is a condition is SecConditional's implicit form.
    if (this.registry.match(['condition'], text)) return 'implicit-if';
    return section ? 'other' : 'unknown';
  }

  private report(node: SkNode, code: IssueCode, severity: 'error' | 'warning', message: string, unnecessary = false): void {
    const line = this.file.script.lines[node.line];
    this.issues.push({
      code,
      category: 'context',
      severity,
      message,
      line: node.line,
      start: line.start,
      end: line.end,
      tags: unnecessary ? ['unnecessary'] : undefined,
    });
  }
}
