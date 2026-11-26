import type { ScannedLine } from './lines';

/** What a top-level node is, read from Skript's own structure patterns (StructEvent, StructCommand, …). */
export type StructureKind = 'event' | 'command' | 'function' | 'options' | 'variables' | 'aliases' | 'using' | 'other';

export interface SkNode {
  /** 0-based line of the header or statement. */
  readonly line: number;
  /** `section` when the line opens a block (ends with `:`), otherwise `simple`. */
  kind: 'section' | 'simple';
  /** Trimmed code. For sections the trailing `:` is removed. */
  key: string;
  readonly children: SkNode[];
  readonly parent: SkNode | null;
  /** 0 for top-level structures. */
  readonly depth: number;
  /** Set on top-level nodes only. */
  structure?: StructureKind;
  /** The line had an indentation error and was attached at the closest plausible place. */
  invalid?: boolean;
  /** Parsed as a section only because error recovery decided so (a missing `:`). */
  recovered?: boolean;
  /** Last line covered by this node, including its children (void lines excluded). */
  lastLine: number;
}

export type IssueCategory =
  | 'indentation'
  | 'missingColon'
  | 'unclosed'
  | 'emptySection'
  | 'comments'
  | 'undefinedFunction'
  | 'argumentCount'
  | 'duplicateFunction'
  | 'functionSignature'
  | 'unknownOption'
  | 'unsetVariable';

export type IssueCode =
  | 'indent-mixed'
  | 'indent-unexpected'
  | 'indent-style'
  | 'missing-colon'
  | 'unclosed-string'
  | 'unclosed-percent'
  | 'unclosed-bracket'
  | 'unmatched-bracket'
  | 'empty-section'
  | 'unclosed-block-comment'
  | 'accidental-comment'
  | 'undefined-function'
  | 'argument-count'
  | 'duplicate-function'
  | 'invalid-function'
  | 'unknown-option'
  | 'unset-variable';

export type Severity = 'error' | 'warning' | 'information' | 'hint';

export interface RelatedLocation {
  readonly uri: string;
  readonly line: number;
  readonly start: number;
  readonly end: number;
  readonly message: string;
}

export interface Issue {
  readonly code: IssueCode;
  readonly category: IssueCategory;
  readonly severity: Severity;
  readonly message: string;
  readonly line: number;
  readonly start: number;
  readonly end: number;
  readonly related?: readonly RelatedLocation[];
}

export interface OptionEntry {
  /** Full key as used in `{@key}`; nested option sections join with `.`. */
  readonly key: string;
  readonly value: string;
  readonly line: number;
}

export interface ParsedScript {
  readonly lines: ScannedLine[];
  /** Top-level nodes in file order. */
  readonly structures: SkNode[];
  readonly issues: Issue[];
  /** Entries of this file's `options:` structures (Skript options are per script). */
  readonly options: Map<string, OptionEntry>;
}
