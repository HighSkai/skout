# Changelog

All notable changes to Skout are listed here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/).

## [Unreleased]

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

[Unreleased]: https://github.com/HighSkai/skout/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/HighSkai/skout/releases/tag/v0.1.0
