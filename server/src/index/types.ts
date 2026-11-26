import type { ParsedScript } from '../parser/types';
import type { CallArgument, Signature } from '../skript/functions';

export interface Span {
  readonly line: number;
  readonly start: number;
  readonly end: number;
}

export interface FunctionDef extends Span {
  readonly uri: string;
  /** Name as written; `start`/`end` cover it. */
  readonly name: string;
  readonly local: boolean;
  /** Undefined when the signature is invalid; see `error`. */
  readonly signature?: Signature;
  readonly error?: string;
  /** The header as written, without the trailing `:`. */
  readonly header: string;
  /** Comment lines directly above the definition. */
  readonly doc?: string;
}

export interface FunctionCall extends Span {
  readonly uri: string;
  readonly name: string;
  readonly args: readonly CallArgument[];
  /** Column of the `(`. */
  readonly open: number;
  /** Column just past the `)`, or the end of the line if it is never closed. */
  readonly close: number;
  readonly closed: boolean;
}

export type SegmentKind = 'literal' | 'dynamic' | 'wildcard';

export interface Segment {
  readonly text: string;
  readonly start: number;
  readonly end: number;
  readonly kind: SegmentKind;
  /** Lower-case literal text (Skript variables are case-insensitive by default). */
  readonly norm: string;
}

export interface VariableOccurrence extends Span {
  readonly uri: string;
  /** Text between the braces. */
  readonly raw: string;
  readonly segments: readonly Segment[];
  /** `{_x}`; scoped to its top-level structure. */
  readonly local: boolean;
  /** Assigned here (`set`, `add … to`, `delete`, `for each … in`, a parameter, `variables:`…). */
  readonly write: boolean;
  /** Line of the top-level structure, the scope of local variables. */
  readonly scope: number;
  /** Normalized name: literals lower-cased, dynamic parts as `%`, e.g. `quest::%::active::*`. */
  readonly key: string;
  /** A function parameter, pointing at its declaration. */
  readonly parameter?: boolean;
  /** Not nested in another variable's name. */
  readonly topLevel: boolean;
}

export interface OptionRef extends Span {
  readonly uri: string;
  readonly name: string;
}

export interface CommandDef extends Span {
  readonly uri: string;
  readonly name: string;
  readonly aliases: readonly string[];
}

export interface FileIndex {
  readonly uri: string;
  /** Skript skips files and folders whose name starts with `-`; their functions are invisible to other scripts. */
  readonly disabled?: boolean;
  readonly script: ParsedScript;
  readonly functions: readonly FunctionDef[];
  readonly calls: readonly FunctionCall[];
  readonly variables: readonly VariableOccurrence[];
  readonly optionRefs: readonly OptionRef[];
  readonly commands: readonly CommandDef[];
}
