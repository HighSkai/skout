/**
 * Changes a syntax dump cannot show, because the syntax still exists but
 * behaves differently or is deprecated in prose only. Each one is taken from
 * Skript's release notes, linked in the finding.
 */
import type { SkNode } from '../parser/types';

export interface KnownChange {
  /** The release that made the change. */
  readonly version: string;
  readonly id: string;
  readonly severity: 'error' | 'warning' | 'information';
  readonly message: string;
  readonly suggestion: string;
  readonly link: string;
  /** Whether the change concerns this line; `code` has strings blanked out. */
  readonly applies: (line: { node: SkNode; text: string; code: string; inCommandEntry: boolean }) => boolean;
}

const RELEASE = (version: string) => `https://github.com/SkriptLang/Skript/releases/tag/${version}`;

export const KNOWN_CHANGES: readonly KnownChange[] = [
  {
    version: '2.17.0',
    id: 'permission-message',
    severity: 'warning',
    message: "Skript 2.17 deprecates the 'permission message' command entry and ignores it: a player without permission now gets Minecraft's \"unknown command\" instead.",
    suggestion: 'Check the permission at the start of the trigger and send the message yourself, e.g. `if player does not have permission "x": send "…" to player` then `stop`.',
    link: RELEASE('2.17.0'),
    applies: ({ text, inCommandEntry }) => inCommandEntry && /^permission message\s*:/i.test(text),
  },
  {
    version: '2.17.0',
    id: 'executor',
    severity: 'information',
    message: "In Skript 2.17 'the executor' returns the command's executor, which can differ from the sender (for example with /execute as).",
    suggestion: "If you meant whoever ran the command, use 'sender' (or 'player') instead.",
    link: RELEASE('2.17.0'),
    applies: ({ code }) => /\bexecutor\b/i.test(code),
  },
  {
    version: '2.16.0',
    id: 'chat-format-placeholders',
    severity: 'warning',
    message: "Skript 2.16 deprecates the [player] and [message] placeholders in the chat format expression.",
    suggestion: "Use the 'player' and 'chat message' expressions inside %…% instead, e.g. \"%player%: %chat message%\".",
    link: RELEASE('2.16.0'),
    applies: ({ code, text }) => /\bchat[ -]?format\b/i.test(code) && /\[(player|message)\]/i.test(text),
  },
];
