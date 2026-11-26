/**
 * Checks one line of code for unclosed strings, `%…%` expressions, variables
 * and brackets. Only the code part of a line is scanned (comments are already
 * split off), and nothing here spans lines because Skript has no line
 * continuation.
 *
 * Contexts nest the way Skript reads them:
 *
 *   code      `"` opens a string, `{` a variable, `(` and `[` brackets.
 *             A bare `%` in code is ordinary text (`chance of 50%`).
 *   string    `""` and `%%` are escapes; `%` opens an expression.
 *   expr      code inside `%…%`; it may hold nested strings and variables.
 *   variable  `{…}`; `%` opens an expression for dynamic names like
 *             `{coins::%uuid of player%}`.
 */

export type BracketIssueCode = 'unclosed-string' | 'unclosed-percent' | 'unclosed-bracket' | 'unmatched-bracket';

export interface BracketIssue {
  code: BracketIssueCode;
  /** The offending character: `"`, `%`, `{`, `}`, `(`, `)`, `[` or `]`. */
  char: string;
  /** Column of the offending character. */
  column: number;
}

type Context = 'string' | 'expr' | 'var' | 'paren' | 'square';

interface Open {
  type: Context;
  column: number;
}

const OPENER: Record<Exclude<Context, 'string' | 'expr'>, string> = { var: '{', paren: '(', square: '[' };
const CLOSER_TYPE: Record<string, Context> = { '}': 'var', ')': 'paren', ']': 'square' };

export function checkBrackets(text: string, from: number, to: number): BracketIssue[] {
  const issues: BracketIssue[] = [];
  const stack: Open[] = [];

  for (let i = from; i < to; i++) {
    const c = text[i];
    const top = stack.length > 0 ? stack[stack.length - 1].type : undefined;

    if (top === 'string') {
      if (c === '"') {
        if (text[i + 1] === '"') i++;
        else stack.pop();
      } else if (c === '%') {
        if (text[i + 1] === '%') i++;
        else stack.push({ type: 'expr', column: i });
      }
      continue;
    }

    switch (c) {
      case '"':
        // A quote inside a variable name (outside any expression) is literal text.
        if (top === 'var') break;
        if (text[i + 1] === '"' && top === undefined) {
          // `""` in plain code is an empty string.
          i++;
          break;
        }
        stack.push({ type: 'string', column: i });
        break;

      case '%': {
        if (text[i + 1] === '%') {
          i++;
          break;
        }
        if (top === 'expr') {
          stack.pop();
          break;
        }
        if (top === 'var') {
          stack.push({ type: 'expr', column: i });
          break;
        }
        // `%` while a bracket is open inside an expression: the expression ends
        // here, so whatever brackets it opened were never closed.
        const exprIndex = innermostExpression(stack);
        if (exprIndex !== -1) {
          reportUnclosedAbove(stack, exprIndex, issues);
          stack.length = exprIndex; // drop the brackets and the expression itself
        }
        // Otherwise a bare `%` in code, such as `chance of 50%`.
        break;
      }

      case '{':
        stack.push({ type: 'var', column: i });
        break;
      case '(':
        stack.push({ type: 'paren', column: i });
        break;
      case '[':
        stack.push({ type: 'square', column: i });
        break;

      case '}':
      case ')':
      case ']': {
        const want = CLOSER_TYPE[c];
        if (top === want) {
          stack.pop();
          break;
        }
        const index = findOpen(stack, want);
        if (index === -1) {
          issues.push({ code: 'unmatched-bracket', char: c, column: i });
        } else {
          reportUnclosedAbove(stack, index, issues);
          stack.length = index;
        }
        break;
      }
    }
  }

  issues.push(...reportAtEndOfLine(stack));
  issues.sort((a, b) => a.column - b.column);
  return issues;
}

/**
 * Reports what is still open when the line ends, without the cascade one
 * mistake causes. In `"50% off"` the stack ends as string, expr, string; only
 * the unescaped `%` is the real problem.
 */
function reportAtEndOfLine(stack: Open[]): BracketIssue[] {
  for (let i = 1; i < stack.length; i++) {
    if (stack[i].type === 'expr' && stack[i - 1].type === 'string') return [unclosed(stack[i])];
  }
  const firstString = stack.find((open) => open.type === 'string');
  if (firstString) return [unclosed(firstString)];
  return stack.map(unclosed);
}

/** Index of the innermost expression that is not shielded by a string or variable. */
function innermostExpression(stack: Open[]): number {
  for (let i = stack.length - 1; i >= 0; i--) {
    const t = stack[i].type;
    if (t === 'expr') return i;
    if (t === 'string' || t === 'var') return -1;
  }
  return -1;
}

/** Finds the opener a closer matches, without crossing a string, expression or variable boundary. */
function findOpen(stack: Open[], want: Context): number {
  for (let i = stack.length - 1; i >= 0; i--) {
    const t = stack[i].type;
    if (t === want) return i;
    if (t === 'string' || t === 'expr' || (t === 'var' && want !== 'var')) return -1;
  }
  return -1;
}

function reportUnclosedAbove(stack: Open[], index: number, issues: BracketIssue[]): void {
  for (let i = index + 1; i < stack.length; i++) issues.push(unclosed(stack[i]));
}

function unclosed(open: Open): BracketIssue {
  switch (open.type) {
    case 'string':
      return { code: 'unclosed-string', char: '"', column: open.column };
    case 'expr':
      return { code: 'unclosed-percent', char: '%', column: open.column };
    default:
      return { code: 'unclosed-bracket', char: OPENER[open.type], column: open.column };
  }
}
