# Changelog

All notable changes to Skout are listed here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.2.0] - 2026-11-26

Milestone M2, Project awareness.

### Added

- A background index of every `.sk` file in the workspace, updated per file as you type or as files change on disk, with progress while it builds.
- Go to definition, find references and hover for functions (yours and Skript's built-ins), variables and `{@options}`.
- Workspace symbols for functions, commands and options.
- Cross-file diagnostics:
  - `undefined-function`, `argument-count` and `duplicate-function` (overload-aware from Skript 2.12);
  - `invalid-function`;
  - `unknown-option`;
  - `unset-variable`, with "did you mean" suggestions.
- Rename for functions and for variable names or namespace prefixes, shown in the Refactor Preview before it is applied.
- The **Skout: Variables** view: global variables by namespace and local variables by file and trigger, with every place each is set and read.
- `skout.skriptVersion`, and bundled built-in syntax for Skript 2.14.3, 2.15.4, 2.16.2 and 2.17.1.
- `skout.knownFunctions` for functions that addons provide.
- A language status item showing the targeted Skript version.
- Each new diagnostic category can be switched off under `skout.diagnostics.*`.

### Changed

- Scripts and folders whose names start with `-` are treated as disabled, as Skript does.
- Skript's `config.sk` is not indexed when a workspace contains the server folder.

## [0.1.0] - 2026-11-26

The first release: milestone M1, Foundation.

### Added

- `.sk` files are registered as the `skript` language, with a TextMate grammar, comment toggling, bracket pairs and indentation rules.
- A tolerant parser that builds structures, sections and statements from indentation. It follows the comment and indentation rules of Skript's own config parser.
- Diagnostics:
  - `indent-mixed`, `indent-unexpected` and `indent-style`;
  - `missing-colon`;
  - `unclosed-string`, `unclosed-percent`, `unclosed-bracket` and `unmatched-bracket`;
  - `empty-section`;
  - `unclosed-block-comment` and `accidental-comment`.
- A setting for each diagnostic category under `skout.diagnostics.*`.
- Outline and breadcrumbs for events, commands, functions and `options:` entries.
- Folding by section and `###` block comment.
- An editor-agnostic language server: `node dist/server.js --stdio`.

[Unreleased]: https://github.com/HighSkai/skout/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/HighSkai/skout/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/HighSkai/skout/releases/tag/v0.1.0
