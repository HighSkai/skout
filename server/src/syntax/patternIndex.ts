/**
 * Finds the patterns worth trying on a piece of text without trying them all.
 *
 * Most patterns start with fixed words (`[the] name[s] of %objects%`); those
 * are filed under every word they can start with, so only patterns that can
 * start with the text's first word are tried. Patterns that can start with a
 * slot (`%objects% is %objects%`) are tried on any text, but only when it
 * contains the words every match must contain.
 */
import type { CompiledPattern, Element } from './pattern';

interface Keyword {
  readonly word: string;
  /** Its letter pairs, hashed to 64 bits: a text without all of them cannot contain the word. */
  readonly lo: number;
  readonly hi: number;
}

interface Entry<T> {
  readonly item: T;
  readonly order: number;
  /** Every match contains at least one word of each set. */
  readonly keywords: readonly (readonly Keyword[])[];
}

/** A bloom filter of the letter pairs in a text. */
interface Mask {
  readonly text: string;
  readonly lo: number;
  readonly hi: number;
}

function maskOf(text: string): Mask {
  let lo = 0;
  let hi = 0;
  for (let i = 0; i + 1 < text.length; i++) {
    const h = (text.charCodeAt(i) * 31 + text.charCodeAt(i + 1)) & 63;
    if (h < 32) lo |= 1 << h;
    else hi |= 1 << (h - 32);
  }
  return { text, lo, hi };
}

export class PatternIndex<T> {
  /** Keys by their first character, with the patterns filed under them. */
  private readonly byFirst = new Map<string, { key: string; entries: Entry<T>[] }[]>();
  private readonly anywhere: Entry<T>[] = [];
  private readonly cache = new Map<string, Entry<T>[]>();

  constructor(items: readonly { readonly item: T; readonly pattern: CompiledPattern }[]) {
    this.size = items.length;
    items.forEach(({ item, pattern }, order) => {
      // Longest words first: they rule a pattern out soonest.
      const keywords = keywordSets(pattern.elements)
        .sort((a, b) => Math.min(...b.map((w) => w.length)) - Math.min(...a.map((w) => w.length)))
        .map((set) => set.map((word) => ({ word, lo: maskOf(word).lo, hi: maskOf(word).hi })));
      const entry: Entry<T> = { item, order, keywords };
      const keys = leads(pattern.elements);
      if (!keys || keys.size === 0) {
        this.anywhere.push(entry);
        return;
      }
      for (const key of keys) {
        let list = this.byFirst.get(key[0]);
        if (!list) this.byFirst.set(key[0], (list = []));
        let slot = list.find((k) => k.key === key);
        if (!slot) list.push((slot = { key, entries: [] }));
        slot.entries.push(entry);
      }
    });
  }

  private size = 0;

  /** Patterns that may match `lower` (lower-case, trimmed), in their original order. */
  candidates(lower: string): readonly T[] {
    const result: T[] = [];
    const mask = maskOf(lower);
    for (const e of this.entriesFor(lower)) if (hasKeywords(e, mask)) result.push(e.item);
    return result;
  }

  /**
   * A view for the parts of one line: a pattern whose words are not in the
   * whole line cannot match any part of it, which is checked once per line.
   */
  scope(line: string): { candidates(lower: string): readonly T[] } {
    const known = new Uint8Array(this.size); // 0 unknown, 1 in the line, 2 not in the line
    const whole = maskOf(line);
    return {
      candidates: (lower: string) => {
        const result: T[] = [];
        const mask = maskOf(lower);
        for (const e of this.entriesFor(lower)) {
          let state = known[e.order];
          if (state === 0) known[e.order] = state = hasKeywords(e, whole) ? 1 : 2;
          if (state === 1 && hasKeywords(e, mask)) result.push(e.item);
        }
        return result;
      },
    };
  }

  private entriesFor(lower: string): Entry<T>[] {
    const key = spanKey(lower);
    let entries = this.cache.get(key);
    if (!entries) {
      const found = new Set<Entry<T>>(this.anywhere);
      for (const { key: k, entries: list } of this.byFirst.get(key[0]) ?? []) {
        if (key.startsWith(k)) for (const e of list) found.add(e);
      }
      entries = [...found].sort((a, b) => a.order - b.order);
      if (this.cache.size > 5000) this.cache.clear();
      this.cache.set(key, entries);
    }
    return entries;
  }
}

function hasKeywords(entry: { readonly keywords: readonly (readonly Keyword[])[] }, mask: Mask): boolean {
  for (const set of entry.keywords) {
    let found = false;
    for (const w of set) {
      if ((w.lo & ~mask.lo) === 0 && (w.hi & ~mask.hi) === 0 && mask.text.includes(w.word)) {
        found = true;
        break;
      }
    }
    if (!found) return false;
  }
  return true;
}

/** The first word of a text: a run of letters and digits, or its first character. */
function spanKey(lower: string): string {
  const m = /^[\p{L}\d]+/u.exec(lower);
  return m ? m[0] : lower.slice(0, 1);
}

/** The words a match can start with, or null when it can start with a slot or a regex. */
function leads(seq: readonly Element[]): Set<string> | null {
  for (let i = 0; i < seq.length; i++) {
    const e = seq[i];
    switch (e.t) {
      case 'tag':
        continue;
      case 'lit': {
        const text = e.text.replace(/^\s+/, '');
        if (text === '') continue;
        return new Set([spanKey(text)]);
      }
      case 'opt': {
        const inside = leads([...e.body, ...seq.slice(i + 1)]);
        const after = leads(seq.slice(i + 1));
        if (!inside || !after) return null;
        return new Set([...inside, ...after]);
      }
      case 'group':
        return leads([...e.body, ...seq.slice(i + 1)]);
      case 'choice': {
        const all = new Set<string>();
        for (const alt of e.alts) {
          const keys = leads([...alt, ...seq.slice(i + 1)]);
          if (!keys) return null;
          keys.forEach((k) => all.add(k));
        }
        return all;
      }
      case 'type':
      case 'regex':
        return null;
    }
  }
  return new Set(); // can match empty text
}

/** For each part every match must contain, the words one of which must appear. */
function keywordSets(seq: readonly Element[]): string[][] {
  const sets: string[][] = [];
  for (const e of seq) {
    if (e.t === 'lit') {
      // Words, and single symbols such as `~` or `?`, which are rare in scripts.
      for (const w of e.text.trim().split(/\s+/)) if (w.length >= 2 || /^[^\p{L}\d\s]$/u.test(w)) sets.push([w]);
    } else if (e.t === 'group') {
      sets.push(...keywordSets(e.body));
    } else if (e.t === 'choice') {
      // Each alternative needs one of its own words, so the text needs one of all of them.
      const options = new Set<string>();
      for (const alt of e.alts) {
        const required = strongest(keywordSets(alt));
        if (!required) {
          options.clear();
          break;
        }
        required.forEach((w) => options.add(w));
      }
      if (options.size > 0) sets.push([...options]);
    }
  }
  return sets;
}

/** The most selective requirement of an alternative: the fewest, longest words. */
function strongest(sets: readonly (readonly string[])[]): readonly string[] | undefined {
  let best: readonly string[] | undefined;
  const score = (set: readonly string[]) => Math.min(...set.map((w) => w.length)) / set.length;
  for (const set of sets) if (!best || score(set) > score(best)) best = set;
  return best;
}
