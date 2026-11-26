/**
 * Port of `ch.njol.skript.util.Utils#isPlural` (Skript 2.17.1). Skript uses it
 * to decide whether a function parameter type such as `numbers` is a list,
 * which changes how calls are matched and when two functions are duplicates.
 */

interface WordEnding {
  readonly singular: string;
  readonly plural: string;
  /** Only matches the whole word, never a suffix. */
  readonly complete: boolean;
}

const e = (singular: string, plural: string, complete = false): WordEnding => ({ singular, plural, complete });

// Same order as Skript: earlier entries win.
const PLURALS: readonly WordEnding[] = [
  e('axe', 'axes'),
  e('x', 'xes'),
  e('ay', 'ays'),
  e('ey', 'eys'),
  e('iy', 'iys'),
  e('oy', 'oys'),
  e('uy', 'uys'),
  e('kie', 'kies'),
  e('zombie', 'zombies', true),
  e('y', 'ies'),
  e('wife', 'wives', true),
  e('life', 'lives'),
  e('knife', 'knives', true),
  e('ive', 'ives'),
  e('lf', 'lves'),
  e('thief', 'thieves', true),
  e('ief', 'iefs'),
  e('hoof', 'hooves'),
  e('fe', 'ves'),
  e('h', 'hes'),
  e('man', 'men'),
  e('ui', 'uis'),
  e('api', 'apis'),
  e('us', 'i'),
  e('hoe', 'hoes', true),
  e('toe', 'toes', true),
  e('foe', 'foes', true),
  e('woe', 'woes', true),
  e('o', 'oes'),
  e('alias', 'aliases', true),
  e('gas', 'gases', true),
  e('child', 'children'),
  e('sheep', 'sheep', true),
  e('', 's'),
];

export interface PluralResult {
  /** The singular form. */
  readonly updated: string;
  readonly plural: boolean;
}

function couldBeSingular(word: string): boolean {
  const lower = word.toLowerCase();
  for (const ending of PLURALS) {
    if (ending.singular === '') continue;
    if (ending.complete && ending.singular.length !== word.length) continue;
    if (word.endsWith(ending.singular) || lower.endsWith(ending.singular)) return true;
  }
  return false;
}

export function isPlural(word: string): PluralResult {
  if (word === '') return { updated: '', plural: false };
  if (couldBeSingular(word)) return { updated: word, plural: false };

  for (const ending of PLURALS) {
    if (ending.complete && word.length !== ending.plural.length) continue;
    const base = word.length - ending.plural.length;
    if (word.endsWith(ending.plural)) return { updated: word.slice(0, base) + ending.singular, plural: true };
    if (word.endsWith(ending.plural.toUpperCase())) return { updated: word.slice(0, base) + ending.singular.toUpperCase(), plural: true };
  }
  return { updated: word, plural: false };
}
