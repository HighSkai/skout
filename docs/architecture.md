# How Skout works

Skout is a language server. The VS Code extension in `client/` only starts it and adds commands and views; everything below lives in `server/src/`, which never imports `vscode`, so any editor that speaks LSP can use it.

This page explains the layers, the decisions behind them, and what each one cannot do yet.

## Principles

1. **Syntax comes from data.** Every pattern Skout knows comes from a syntax dump: Skript's own `docs.json` (bundled for 2.14 to 2.17), a dump the user generated on their server, or SkriptHub's catalog. Skout never contains hand-written Skript patterns. What Skout does hard-code is Skript's *rules*, ported from Skript's source, each with the class it comes from in a comment.
2. **A false positive is worse than a miss.** An error means "Skript will refuse this". When Skout cannot be sure, it says nothing, or says less (a hint instead of an error).
3. **Unknown is not invalid.** A line or sub-expression that no known syntax explains is *unknown*: it may belong to an addon whose syntax Skout has no dump for. Unknown parts are accepted everywhere, and they count against any reading that relies on them.
4. **Verified against Skript's own scripts.** Skript's 587 test and example scripts (pinned to 2.17.1, `npm run corpus`) all load in Skript, so every check must report nothing on them, except where Skript's tests themselves expect an error; there, Skout must report exactly that error.

## Layers

```
text ─▶ lines ─▶ tree ─▶ index ─▶ syntax registry ─▶ engine ─▶ diagnostics, hover, completion…
```

| Layer | Files | What it does |
|---|---|---|
| Lines | `parser/lines.ts`, `parser/brackets.ts` | Splits comments the way `Node#splitLine` does, finds unclosed strings, brackets and `%` |
| Tree | `parser/parser.ts` | Builds sections from indentation like `SectionNode#load_i`, with error recovery |
| Index | `index/` | Functions, calls, variables, options and commands per file; the workspace index answers cross-file questions |
| Syntax | `syntax/` | Dump importers, the bundled catalog, a port of Skript's pattern compiler, and the registry with a pattern index |
| Engine | `engine/` | Types, the recursive expression parser, line analysis, context checks |
| Environment | `environment/` | The server folder: plugin jars, generated dumps, Skript's own reload errors from the log |
| Features | `features/` | LSP features built on the layers above |

Each layer is incremental: a keystroke re-scans and re-parses one file (under 10 ms for 2,000 lines); everything derived from syntax is cached by line text, so only the edited line is analysed again.

## The engine

### Types (`engine/types.ts`)

Types are Skript's ClassInfos as far as the dumps describe them. Their English names (`a text`, `an integer`, `a boolean (yes/no)`) come from Skript's `default.lang`, generated into `engine/typeNames.generated.ts` by `npm run dumps`. A slot word such as `%entity types%` is resolved like `SkriptParser#createExprInfo`: split off the English plural with a port of `Utils#getEnglishPlural`, then look the singular up by name.

**Decision: closed-world type checking.** Skout only says "these types cannot meet" inside a small set of types whose conversions it knows completely from Skript's `DefaultConverters` and `DefaultOperations`: numbers, text, booleans, time spans, dates and vectors. Any other pair is "unknown" and never an error, because any addon can register a converter (say, text to its own type) that Skout cannot see. This catches the common mistakes (`5 + "hello"`, `wait "5 seconds"`, `length of 5`) without guessing about the rest.

### The expression parser (`engine/expressions.ts`)

`SkriptParser#parseSingleExpr`, recursively, for any span of a line:

1. `(…)` around the whole span: the inside, including a list.
2. `{…}`: a variable (its type is unknown at parse time, like in Skript).
3. `name(…)`: a function call; arguments are checked against the parameter types of the user's functions.
4. `"…"`: text, with every `%expression%` inside parsed too.
5. Expression patterns: every pattern that fits, each slot parsed recursively against the slot's types; plus arithmetic (`ExprArithmetic`), implemented natively because its documented return type is `Object`.
6. Literals Skout can recognise: numbers (`JavaClasses.DECIMAL_PATTERN`), booleans, time spans (`Timespan#parse`).

Results are memoized per span. A span usually has several readings; they are ranked by how many unknown parts each rests on.

**Decision: certainty decides.** Every problem carries a *doubt*: the number of parts of its reading Skout could not verify. Only problems without doubt are reported. And a reading that known syntax explains completely and that fails beats readings that only work because some words were taken as something unverifiable: `length of 5` is `ExprLength` on a number (an error), not the armour slot "length" of the entity 5.

**Decision: generic patterns last.** Patterns such as ExprEntity's `[the] [event-]<.+>` or ExprSets' `[the] %*type%` fit nearly any words; Skript sorts them out in `init`, which Skout cannot run. They are tried only when nothing more specific fits a span.

### Lines (`engine/engine.ts`)

A line is checked like `SkriptParser#parse` loads it: every pattern of the kinds allowed there (an event, an effect, a condition, a section) is tried, with each slot parsed. The line is fine as soon as one pattern accepts it. It is an error only when patterns fit its shape but each fails for a reason Skout is sure of. The outcome is one of `ok`, `error`, `doubtful` (fails only through unknown parts: reported as nothing), `unmatched` (handled by `unrecognized-syntax`) or `incomplete` (over the step budget: reported as nothing).

The pattern index (`syntax/patternIndex.ts`) keeps this fast: patterns are filed under every word they can start with, and each pattern lists words every match must contain, checked first against the whole line (once) and then against the span, with a 64-bit letter-pair filter in front of the substring search.

### Context (`engine/context.ts`)

Checks that depend on the sections around a line: `else` without `if`, `then` placement, multiline `if` rules (`SecConditional`), `continue` outside loops (`EffContinue`), `exit` levels (`EffExit`), `loop-value` outside a `loop` (`ExprLoopValue`), `return` placement, return type and delays (`EffReturn`), and unreachable code (`ScriptLoader#loadItems`), honouring `suppress unreachable code warnings`. A section Skout does not recognise may be an addon's loop or return handler, so every rule that depends on enclosing sections is skipped inside one.

### Entries (`features/entries.ts`)

`EntryValidator#validate` for `command` structures, with the entries of each version (`StructCommand` up to 2.16, `SubCommandEntryData` in 2.17), and the checks Skript runs afterwards (cooldown entries without a cooldown, root-only entries in subcommands, a trigger or a subcommand in 2.17).

## The server environment (`environment/`)

When Skout knows the server folder (`skout.server.folder`, or a workspace that is the server folder or inside `plugins/Skript/scripts`), it reads, and only reads:

- each plugin jar's `plugin.yml` (or `paper-plugin.yml`), with a small ZIP reader: the Skript version sets the target version unless `skout.skriptVersion` is set, and plugins that depend on Skript are listed as addons;
- the syntax dumps the server generated, which are loaded like `skout.syntaxDumps`;
- `logs/latest.log`, polled every two seconds.

The **Skout** view shows which addons have syntax loaded. An addon without it is the reason a line is left unchecked, and the view says so.

### Runtime validation

The user asked whether scripts could be validated by a real Skript in an isolated server. Skout's answer is to read what the user's own server already says:

- Skript prints every load and reload error as `Line N: (script)`, the message, and `Line: <code>` (english.lang, `skript command.reload`), between `Reloading …` and `Successfully reloaded …` / `Encountered N errors while reloading …`. Skout parses that, keeps each script's latest result, and shows its errors as "Skript (server)" problems.
- An error is only shown on a line that still holds the code Skript quoted (the line it named, or the nearest one that matches), so an old log or an edited file never puts an error in the wrong place.

**Decision: Skout does not start a server itself.** Launching a headless server would mean accepting Mojang's EULA on the user's behalf, needing a matching Java and server jar, generating worlds, and running every plugin's start-up code, for tens of seconds per check. The user's own test server, reloaded with `/sk reload`, already gives the authoritative answer with every addon in place; Skout's part is to put that answer on the right lines. Static analysis stays the primary, interactive check.

## Performance

Measured by `server/test/performance.test.ts` on a 2,000-line script:

| Work | Time |
|---|---|
| Re-parse and re-index the file on a keystroke | under 10 ms |
| Type-check the whole file the first time | about 80 ms |
| Type-check it again after a keystroke (one changed line) | about 11 ms |
| Cross-file checks over 100,000 lines | about 40 ms |

Skript's own 20,000 lines are type-checked in about 2.5 s from cold. Open files are analysed at once; the rest of the workspace is analysed in the background in 25 ms slices, so the server keeps answering. A line that would need more than 150,000 matching steps is left unchecked rather than slowing the editor down.

## Limitations

These are known gaps, not bugs. Each is safe: it makes Skout report less, never wrongly.

- **Variables are untyped**, as they are in Skript by default. Skript's experimental `using local variable type hints` is not followed yet.
- **Event values are not checked against the event.** `player` in a function or an event without a player is not reported, because Skout does not know every event's values with certainty (addons add them through converters and `EventValues`).
- **Built-in functions' arguments are not type-checked**, because Skript's docs omit their overloads; their return types are used.
- **Conversions involving addon or Bukkit types are never errors** (see closed-world type checking).
- **Plural values** are only checked for list variables (`{_list::*}`) and function calls where a single value is required.
- **`init` checks are not run.** Skript's elements reject some inputs in their own `init` methods (wrong entity types, unsupported combinations); Skout only knows what the patterns and types say.
- **Syntax Skout has no dump for is not validated.** Lines that use an addon without a loaded dump are left alone; give Skout the addon's dump (see `skout.syntaxDumps`) to check them.
