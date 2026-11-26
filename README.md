<p align="center">
  <img src="images/banner.png" alt="Skout: scouts your Skript for problems before /sk reload" width="100%">
</p>

<p align="center">
  <a href="https://github.com/HighSkai/skout/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/HighSkai/skout/actions/workflows/ci.yml/badge.svg"></a>
  <a href="https://github.com/HighSkai/skout/releases/latest"><img alt="Latest release" src="https://img.shields.io/github/v/release/HighSkai/skout?label=release&color=22c55e"></a>
  <img alt="VS Code 1.91+" src="https://img.shields.io/badge/VS%20Code-1.91%2B-007ACC?logo=visualstudiocode&logoColor=white">
  <img alt="Skript 2.x" src="https://img.shields.io/badge/Skript-2.x-8B5CF6">
  <a href="LICENSE"><img alt="License" src="https://img.shields.io/github/license/HighSkai/skout?color=22c55e"></a>
</p>

**Skout** is a language server and VS Code extension for [Skript](https://github.com/SkriptLang/Skript), the scripting language Minecraft servers use to add features without writing Java. It catches the mistakes `/sk reload` would reject while you are still typing them. Later milestones add addon-aware completion, project navigation and an upgrade checker.

Most Skript extensions stop at syntax highlighting. Skout reads your scripts the way Skript does: its indentation and comment rules are ported from Skript's own config parser, so an error in the editor is an error on your server.

<p align="center">
  <img src="images/diagnostics.png" alt="Skout reporting a missing colon, an unclosed string, an unescaped percent sign and other problems in a Skript file" width="100%">
</p>

<!-- GIF: errors-as-you-type.gif. Record typing a line with a missing ':' and watching the squiggle appear and clear. -->

## Features

### Available now (0.1)

- **Errors before `/sk reload`.** Skout reports, as you type:
  - indentation Skript rejects: tabs mixed with spaces, a line deeper than its section allows, a partial indent;
  - a missing `:` on a line that has an indented block under it;
  - unclosed strings, an unescaped `%` inside a string, and unclosed or unmatched `{}`, `()` and `[]`;
  - empty sections;
  - unclosed `###` block comments, and a `#` that silently turns the rest of a value into a comment (`<#ff0000>` in `options:` is the classic).
- **Outline.** Events, commands, functions and `options:` entries appear in the Outline view and the breadcrumbs.
- **Folding.** Folding follows the real section structure and `###` block comments.
- **Highlighting.** A small TextMate grammar covers strings with `%expressions%`, variables, `{@options}`, colour codes, comments and structure headers.
- **Fast.** A 2,000-line file is fully reparsed in about 2 ms, so diagnostics keep up with every keystroke.
- **Works in other editors.** The language server has no VS Code dependency; see [Other editors](#other-editors).

### Roadmap

| Milestone | What it adds | Status |
|---|---|---|
| **M1: Foundation** | Parser, highlighting, structural diagnostics | ✅ Released in 0.1 |
| **M2: Project awareness** | Workspace index; go to definition, references and hover for functions; undefined function and argument count checks; a Variables view grouped by namespace; rename for functions and variable namespaces | Next |
| **M3: Syntax intelligence** | Completion and hover docs for events, effects, expressions and conditions, loaded from a JSON syntax dump of *your* server and addons; conservative "unrecognized syntax" hints | Planned |
| **M4: Upgrade checker** | "Skout: Check upgrade to version X" compares two syntax dumps and reports every line in your project that the new Skript or addon version removes, deprecates or changes | Planned |

<!-- GIF: go-to-definition.gif (M2) -->
<!-- GIF: completion.gif (M3) -->
<!-- GIF: upgrade-report.gif (M4) -->

## Install

**From a release (VSIX).** Download `skout-<version>.vsix` from the [latest release](https://github.com/HighSkai/skout/releases/latest), then either run **Extensions: Install from VSIX…** from the Command Palette, or:

```sh
code --install-extension skout-0.1.0.vsix
```

**From the Marketplace.** Not published yet. The extension id will be `highskai.skout`.

**From source.** See [CONTRIBUTING.md](CONTRIBUTING.md#getting-started).

Open any `.sk` file and Skout starts. If another Skript extension is installed, both register the `skript` language; disable the other one's diagnostics if you see duplicates.

## Settings

Every diagnostic category can be switched off.

| Setting | Default | What it controls |
|---|---|---|
| `skout.diagnostics.indentation` | `true` | Mixed tabs and spaces, wrong indentation depth, and (as information) a file mixing indent styles between structures |
| `skout.diagnostics.missingColon` | `true` | A line followed by an indented block that does not end with `:` |
| `skout.diagnostics.unclosed` | `true` | Unclosed quotes, `%` in strings, `{}`, `()` and `[]` |
| `skout.diagnostics.emptySection` | `true` | Sections with nothing indented under them |
| `skout.diagnostics.comments` | `true` | Unclosed `###` block comments and accidental `#` comments |
| `skout.trace.server` | `"off"` | Logs the messages between VS Code and the server to the **Skout** output channel |

## Diagnostics reference

| Code | Severity | Meaning |
|---|---|---|
| `indent-mixed` | Error | The indentation mixes tabs and spaces |
| `indent-unexpected` | Error | The line is indented deeper than its section allows, or by part of an indent unit |
| `indent-style` | Information | Structures in one file use different indents (Skript allows it, but it is easy to break) |
| `missing-colon` | Error | A section header like `if …` or `trigger` is missing its `:` |
| `unclosed-string` | Error | A `"` with no closing quote on the line |
| `unclosed-percent` | Error | An unescaped `%` in a string (write `%%` for a literal percent sign) |
| `unclosed-bracket` / `unmatched-bracket` | Error (`[]`: Warning) | A `{`, `(` or `[` is never closed, or a closer has no opener |
| `empty-section` | Warning | Nothing is indented under a line ending in `:` |
| `unclosed-block-comment` | Error | A `###` block comment is never closed |
| `accidental-comment` | Warning | A `#` right after other text starts a comment; write `##` for a literal `#` |

### How Skout knows what Skript accepts

Skout does not guess at Skript's rules; it ports them from Skript's source:

- Comments follow `Node#splitLine`: `###` alone on a line toggles a block comment, `##` outside a string is a literal `#`, and `#` inside a string never starts a comment.
- Indentation follows `SectionNode#load_i`: the first indented line of each top-level structure sets that structure's indent unit, so one event may use tabs and the next four spaces.
- `{@options}` are substituted as plain text before Skript parses a line, so Skout trusts option values that contain brackets or quotes.

Every change is checked against all 587 scripts in Skript's own repository: Skout must report no errors on any of them, except the lines Skript's tests expect to fail.

## Other editors

The server speaks plain LSP over stdio, IPC or a socket:

```sh
node dist/server.js --stdio
```

Point your editor's LSP client at that command for `*.sk` files; settings use the same `skout.*` keys. Clients without `workspace/configuration` can pass `{ "settings": { "diagnostics": { … } } }` as initialization options. A Neovim example:

```lua
vim.filetype.add({ extension = { sk = 'skript' } })
vim.lsp.config('skout', {
  cmd = { 'node', '/path/to/skout/dist/server.js', '--stdio' },
  filetypes = { 'skript' },
})
vim.lsp.enable('skout')
```

## Contributing

Bug reports, especially false positives, are very welcome. A false positive is a diagnostic on a line that Skript accepts. [CONTRIBUTING.md](CONTRIBUTING.md) covers the setup, the tests and the rules for adding diagnostics.

## Acknowledgements

- [SkriptLang/Skript](https://github.com/SkriptLang/Skript), whose config parser defines the rules Skout enforces, and whose test scripts are Skout's stress-test corpus.
- [SkriptHub Docs Tool](https://github.com/SkriptHub/SkriptHubDocsTool) and Skript's JSON docs generator, which will feed M3's syntax data.
- The existing Skript editor tools ([IntelliSkript](https://github.com/JohnHeikens/IntelliSkript), [Sk-VSC](https://github.com/AyhamAl-Ali/Sk-VSC), [r4tsk](https://github.com/RATR2/r4tsk), [SkriptZed](https://github.com/DaisyCatTs/SkriptZed)) for showing what Skript developers want from an editor.

## License

Skout is free software under the [GNU General Public License v3.0](LICENSE) (GPL-3.0-only), the same license as Skript. You may use, change and share it; if you distribute a modified version, it must stay under the GPL with its source available.
