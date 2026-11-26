/**
 * Errors the real Skript reported, read from the server's log. This is
 * Skout's runtime check: static analysis stays the primary one, and what the
 * server says is shown next to it, labelled as coming from the server.
 *
 * The format is Skript 2.17.1's english.lang, `skript command.reload`:
 *
 *   error line info:  Line %s: (%s)
 *   error details:        %s
 *   line details:         Line: %s
 *   reloading:        Reloading %s...
 *   reloaded:         Successfully reloaded %s. (%2$sms)
 *   error:            Encountered %2$s error(s) while reloading %1$s! (%3$sms)
 *
 * and, at start-up, `scripts loaded: Loaded %s script(s) with a total of …`
 * or `no errors: All scripts loaded without errors.`
 *
 * Log lines may carry a logger prefix (`[12:00:00 ERROR]: [Skript] `) and
 * colour codes; both are removed. A reported error is only trusted when the
 * code Skript quotes (`Line: …`) is still in the workspace file, so an old
 * log or a renumbered file never puts an error on the wrong line.
 */

export interface LoggedProblem {
  /** The script as Skript names it, e.g. `shop.sk` or `games/shop.sk`. */
  readonly script: string;
  /** 1-based, as Skript prints it. */
  readonly line: number;
  readonly message: string;
  /** The code Skript quoted. */
  readonly code: string;
  readonly severity: 'error' | 'warning';
}

/** Which scripts a reload covered: everything, a folder, or one script. */
type Scope = { readonly all: true } | { readonly folder: string } | { readonly script: string };

export interface LogResult {
  /** The current problems per script: from the most recent load or reload that covered it. */
  readonly problems: ReadonlyMap<string, readonly LoggedProblem[]>;
  /** Scripts that a reload covered, even without problems. */
  readonly loaded: ReadonlySet<string>;
  /** Whether a whole-server load or reload was seen, which covers every script. */
  readonly loadedAll: boolean;
  readonly reloads: number;
}

const ANSI = /\u001b\[[0-9;]*[A-Za-z]/g;
const SECTION_CODES = /§[0-9a-fk-orx]/gi;
const PREFIX = /^(?:\[[^\]]*\]\s*)+:?\s*/;
const SKRIPT_PREFIX = /^\[Skript\]\s*/i;

function clean(raw: string): { text: string; warning: boolean } {
  const text = raw.replace(ANSI, '').replace(SECTION_CODES, '');
  const warning = /^(?:\[[^\]]*\]\s*)*\[[^\]]*\bWARN(?:ING)?\b[^\]]*\]/i.test(text);
  return { text: text.replace(PREFIX, '').replace(SKRIPT_PREFIX, ''), warning };
}

export function parseServerLog(log: string): LogResult {
  const lines = log.split(/\r?\n/);
  const problems = new Map<string, LoggedProblem[]>();
  const loaded = new Set<string>();
  let loadedAll = false;
  let reloads = 0;
  let pending: LoggedProblem[] = [];

  const finish = (scope: Scope) => {
    reloads++;
    const covers = (script: string) =>
      'all' in scope ? true : 'folder' in scope ? normal(script).startsWith(`${normal(scope.folder)}/`) : sameScript(script, scope.script);
    // Scripts this reload covered start over, with only what it reported.
    for (const script of [...problems.keys()]) if (covers(script)) problems.delete(script);
    if ('all' in scope) {
      loadedAll = true;
      loaded.clear();
    } else if ('script' in scope) {
      loaded.add(scope.script);
    }
    for (const p of pending) if (covers(p.script)) (problems.get(p.script) ?? problems.set(p.script, []).get(p.script)!).push(p);
    pending = [];
  };

  for (let i = 0; i < lines.length; i++) {
    const { text, warning } = clean(lines[i]);
    const info = /^Line (\d+):\s*\((.+)\)\s*$/.exec(text);
    if (info) {
      const message: string[] = [];
      let code = '';
      let j = i + 1;
      for (; j < lines.length && j < i + 8; j++) {
        const next = clean(lines[j]).text.trim();
        const quoted = /^Line:\s*(.*)$/.exec(next);
        if (quoted) {
          code = quoted[1].trim();
          break;
        }
        if (next !== '') message.push(next);
      }
      if (code !== '' && message.length > 0) {
        pending.push({ script: info[2].trim(), line: Number(info[1]), message: message.join(' '), code, severity: warning ? 'warning' : 'error' });
        i = j;
      }
      continue;
    }
    const done = /^(?:Successfully (?:automatically )?reloaded (.+?)\.\s*\(\d+ms\)|Encountered \d+ errors? while reloading (.+?)! \(\d+ms\))\s*$/.exec(text);
    if (done) {
      finish(scopeOf(done[1] ?? done[2]));
      continue;
    }
    if (/^Loaded \d+ scripts? with a total of /.test(text) || /^All scripts loaded without errors\.$/.test(text)) finish({ all: true });
  }
  // Problems after the last completed reload belong to one still in progress, or to a script loaded some other way.
  return { problems, loaded, loadedAll, reloads };
}

/** The target in "Successfully reloaded %s" (english.lang `reload.*` names). */
function scopeOf(target: string): Scope {
  const t = target.trim();
  if (/^(?:the config, aliases and all scripts|all scripts)$/i.test(t)) return { all: true };
  const folder = /^all scripts in (.+)$/i.exec(t) ?? /^\d+ scripts? in (.+)$/i.exec(t);
  if (folder) return { folder: folder[1].trim() };
  return { script: t };
}

function normal(path: string): string {
  return path.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '').toLowerCase();
}

/** Skript names a script by its path below `scripts/`; Skout compares the tail of the path. */
export function sameScript(logged: string, script: string): boolean {
  const a = normal(logged);
  const b = normal(script);
  return a === b || a.endsWith(`/${b}`) || b.endsWith(`/${a}`);
}

/**
 * The line a logged problem refers to in the current text: the line Skript
 * named if it still holds the quoted code, else the nearest line that does.
 */
export function locate(problem: LoggedProblem, lines: readonly string[]): number | undefined {
  const want = problem.code.trim();
  const matches = (i: number) => i >= 0 && i < lines.length && lines[i].trim() === want;
  const named = problem.line - 1;
  if (matches(named)) return named;
  for (let d = 1; d <= 200; d++) {
    if (matches(named - d)) return named - d;
    if (matches(named + d)) return named + d;
  }
  return undefined;
}
