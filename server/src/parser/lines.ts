/**
 * Line scanner.
 *
 * Splits every line into indentation, code and comment exactly the way Skript
 * does before it parses anything. The comment rules are a port of
 * `ch.njol.skript.config.Node#splitLine` (Skript 2.17):
 *
 * - a line that is exactly `###` (after trimming) toggles a block comment;
 * - a line whose trimmed text starts with `#` is a whole-line comment;
 * - otherwise the first `#` outside a string starts a comment, `##` outside a
 *   string is an escaped `#`, and doubled `""` and `%%` are skipped.
 *
 * Inside a string, `%…%` switches back to code, so `"%{_x}#%"` really does start
 * a comment at the `#`. That is Skript's behaviour, not a bug in this port.
 */

export const enum LineKind {
  Blank,
  /** A whole-line `#` comment. */
  Comment,
  /** A line that is exactly `###`, opening or closing a block comment. */
  BlockCommentDelimiter,
  /** A line inside a `###` block comment. */
  BlockComment,
  Code,
}

export interface ScannedLine {
  /** 0-based line number. */
  readonly index: number;
  readonly text: string;
  readonly kind: LineKind;
  /** Leading whitespace of a code line (empty for other kinds). */
  readonly indent: string;
  /** Column of the first code character. */
  readonly start: number;
  /** Column just past the last non-whitespace code character. */
  readonly end: number;
  /** Column of the `#` that starts an inline comment, or -1. */
  readonly commentStart: number;
  /** Trimmed code, with `##` outside strings unescaped to `#` as Skript does. */
  readonly value: string;
  /** Skript treats a line whose code ends with `:` as a section header. */
  readonly isSectionHeader: boolean;
}

const HASH = 0x23; // #
const QUOTE = 0x22; // "
const PERCENT = 0x25; // %

const enum SplitState {
  Halt,
  Code,
  String,
}

/**
 * Returns the column of the `#` that starts an inline comment, or -1.
 * Also returns the value with `##` (outside strings) collapsed to `#`.
 */
export function splitComment(line: string): { commentStart: number; unescaped: string } {
  let state = SplitState.Code;
  // The state before entering a `%…%` part, restored when it closes.
  let previous = SplitState.Code;
  let unescaped = '';
  let copiedUpTo = 0;
  const length = line.length;

  for (let i = 0; i < length; i++) {
    const c = line.charCodeAt(i);
    if (c !== PERCENT && c !== QUOTE && c !== HASH) continue;

    // Doubled characters are escapes. `##` only counts outside strings.
    if ((c !== HASH || state !== SplitState.String) && i + 1 < length && line.charCodeAt(i + 1) === c) {
      if (c === HASH) {
        unescaped += line.slice(copiedUpTo, i + 1);
        copiedUpTo = i + 2;
      }
      i++;
      continue;
    }

    const before = state;
    state = update(c, state, previous);
    if (state === SplitState.Halt) {
      return { commentStart: i, unescaped: unescaped + line.slice(copiedUpTo, i) };
    }
    if (c === PERCENT && state === SplitState.Code) previous = before;
  }
  return { commentStart: -1, unescaped: unescaped + line.slice(copiedUpTo) };
}

function update(c: number, state: SplitState, previous: SplitState): SplitState {
  switch (c) {
    case PERCENT:
      return state === SplitState.Code ? previous : SplitState.Code;
    case QUOTE:
      if (state === SplitState.Code) return SplitState.String;
      if (state === SplitState.String) return SplitState.Code;
      return state;
    case HASH:
      return state === SplitState.String ? SplitState.String : SplitState.Halt;
  }
  return state;
}

/** Skript's legacy exception: a line whose comment starts with `#-#` never opens a section. */
const FULL_LINE_PATTERN = /^([^#]|##)*#-#(\s.*)?$/;

export function scanLines(text: string): ScannedLine[] {
  const raw = text.split(/\r\n|\r|\n/);
  // Skript strips a UTF-8 byte order mark from the first line (ConfigReader).
  if (raw.length > 0 && raw[0].charCodeAt(0) === 0xfeff) raw[0] = raw[0].slice(1);

  const lines: ScannedLine[] = new Array(raw.length);
  let inBlockComment = false;

  for (let index = 0; index < raw.length; index++) {
    const lineText = raw[index];
    const trimmed = lineText.trim();

    if (trimmed === '###') {
      inBlockComment = !inBlockComment;
      lines[index] = voidLine(index, lineText, LineKind.BlockCommentDelimiter);
      continue;
    }
    if (trimmed.startsWith('#')) {
      lines[index] = voidLine(index, lineText, LineKind.Comment);
      continue;
    }
    if (inBlockComment) {
      lines[index] = voidLine(index, lineText, LineKind.BlockComment);
      continue;
    }
    if (trimmed === '') {
      lines[index] = voidLine(index, lineText, LineKind.Blank);
      continue;
    }

    const { commentStart, unescaped } = splitComment(lineText);
    const codeText = commentStart === -1 ? lineText : lineText.slice(0, commentStart);
    const indentLength = codeText.length - codeText.trimStart().length;
    const end = codeText.trimEnd().length;

    if (end <= indentLength) {
      // Only whitespace before an inline comment: Skript treats this as a void line.
      lines[index] = voidLine(index, lineText, LineKind.Comment);
      continue;
    }

    const value = unescaped.trim();
    const isSectionHeader =
      value.endsWith(':') && !(lineText.includes('#') && FULL_LINE_PATTERN.test(lineText));

    lines[index] = {
      index,
      text: lineText,
      kind: LineKind.Code,
      indent: lineText.slice(0, indentLength),
      start: indentLength,
      end,
      commentStart,
      value,
      isSectionHeader,
    };
  }
  return lines;
}

function voidLine(index: number, text: string, kind: LineKind): ScannedLine {
  return { index, text, kind, indent: '', start: 0, end: 0, commentStart: -1, value: '', isSectionHeader: false };
}

/** "4 spaces", "1 tab", or "1 tab, 2 spaces" for mixed runs. */
export function describeWhitespace(ws: string): string {
  if (ws.length === 0) return 'no indentation';
  const runs: string[] = [];
  let i = 0;
  while (i < ws.length) {
    const ch = ws[i];
    let j = i;
    while (j < ws.length && ws[j] === ch) j++;
    const n = j - i;
    const name = ch === '\t' ? 'tab' : ch === ' ' ? 'space' : 'other whitespace character';
    runs.push(`${n} ${name}${n === 1 ? '' : 's'}`);
    i = j;
  }
  return runs.join(', ');
}
