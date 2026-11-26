/**
 * Skout's internal syntax schema. Every source format (Skript's docs.json,
 * SkriptHub Docs Tool exports, the SkriptHub API) is normalized into this.
 */

export type SyntaxKind = 'event' | 'effect' | 'expression' | 'condition' | 'type' | 'section' | 'function' | 'structure';

export interface SyntaxEntry {
  /** Unique within its addon, e.g. `EffSendResourcePack` or `floor`. */
  readonly id: string;
  readonly kind: SyntaxKind;
  readonly name: string;
  readonly patterns: readonly string[];
  /** Plain text; HTML from the source is kept as-is and cleaned up for display. */
  readonly description: string;
  readonly examples: readonly string[];
  /** Free text as published, e.g. `2.5.2, 2.9.0 (enforce)`. */
  readonly since?: string;
  /** `Skript` or the addon's name. */
  readonly addon: string;
  readonly deprecated?: boolean;
  /** Not published by any source; computed by comparing two dumps (M4). */
  readonly removedIn?: string;
  /** What an expression or function returns. */
  readonly returns?: string;
  /** Event values such as `player` for events. */
  readonly eventValues?: readonly string[];
  readonly cancellable?: boolean;
  /** Plugins or server versions the syntax needs. */
  readonly requirements?: readonly string[];
  readonly keywords?: readonly string[];
}

export interface SyntaxDump {
  readonly format: 'skout-dump@1';
  /** Where it came from: `skript-docs`, `skripthub-docs-tool` or `skripthub-api`. */
  readonly source: string;
  /** The Skript version the dump describes, when known. */
  readonly skriptVersion?: string;
  /** Addon name to version, when known. */
  readonly addons: Readonly<Record<string, string>>;
  readonly entries: readonly SyntaxEntry[];
}
