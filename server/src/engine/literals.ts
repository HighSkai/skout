/**
 * Literals whose type Skout can recognise with certainty, ported from Skript
 * 2.17.1's parsers:
 *
 * - numbers: JavaClasses.DECIMAL_PATTERN (`-1`, `2_000`, `0.5`, `50%`,
 *   `1e3`, `90 degrees`, `3 in radians`);
 * - booleans: default.lang `boolean.true.pattern` / `boolean.false.pattern`;
 * - time spans: Timespan#parse in the default context (`5 seconds`,
 *   `a minute and 30 seconds`, `2 real minutes`, `1:30`).
 *
 * Anything else that is not an expression (item types such as `diamond sword`,
 * colours, entity types…) is an "unparsed literal" whose type Skout cannot
 * know without the server's aliases, so it is left unknown.
 */

const NUMBER = /^-?\d+(?:_\d+)*(?:\.\d+(?:_\d+)*)?%?(?:[eE][+-]?\d+)?(?: (?:in )?(?:rad(?:ian)?|deg(?:ree)?)s?)?$/;

export function isNumberLiteral(text: string): boolean {
  return NUMBER.test(text);
}

const BOOLEAN = /^(?:true|yes|on|false|no|off)$/i;

export function isBooleanLiteral(text: string): boolean {
  return BOOLEAN.test(text);
}

/** default.lang `time:`: each unit's full name (singular and plural) and short form. */
const UNITS = new Set([
  'millisecond', 'milliseconds', 'ms',
  'tick', 'ticks', 't',
  'second', 'seconds', 's',
  'minute', 'minutes', 'm',
  'hour', 'hours', 'h',
  'day', 'days', 'd',
  'week', 'weeks', 'w',
  'month', 'months', 'mo',
  'year', 'years', 'y',
]);
const REAL = new Set(['real', 'rl', 'irl']);
const MINECRAFT = new Set(['mc', 'minecraft']);
const CLOCK = /^\d+:\d\d(?::\d\d){0,2}(?:\.\d{1,4})?$/;
const AMOUNT = /^\d+(?:\.\d+)?$/;

/**
 * Timespan#parse. Skout additionally requires an amount (a number or `a`/`an`)
 * somewhere, so a bare unit word such as `second` or `m`, which Skript would
 * also read as a time span, is left to other syntax.
 */
export function isTimespanLiteral(text: string): boolean {
  const value = text.trim().toLowerCase();
  if (value === '') return false;
  if (CLOCK.test(value)) return true;
  const words = value.split(/\s+/);
  let amounts = 0;
  let realSet = false;
  let minecraft = false;
  for (let i = 0; i < words.length; i++) {
    let word = words[i];
    if (word === 'and') {
      if (i === 0 || i === words.length - 1) return false;
      continue;
    }
    if (word === 'a' || word === 'an' || AMOUNT.test(word)) {
      if (i === words.length - 1) return false;
      amounts++;
      word = words[++i];
    }
    if (REAL.has(word)) {
      if (i === words.length - 1 || (realSet && minecraft)) return false;
      word = words[++i];
    } else if (MINECRAFT.has(word)) {
      if (i === words.length - 1 || (realSet && !minecraft)) return false;
      minecraft = true;
      word = words[++i];
    }
    if (word.endsWith(',')) word = word.slice(0, -1);
    if (!UNITS.has(word)) return false;
    realSet = true;
  }
  return amounts > 0;
}
