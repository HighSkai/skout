import { DiagnosticSeverity, type Diagnostic } from 'vscode-languageserver';
import type { Issue, Severity } from '../parser/types';
import type { SkoutSettings } from '../settings';

const SEVERITY: Record<Severity, DiagnosticSeverity> = {
  error: DiagnosticSeverity.Error,
  warning: DiagnosticSeverity.Warning,
  information: DiagnosticSeverity.Information,
  hint: DiagnosticSeverity.Hint,
};

export function toDiagnostics(issues: readonly Issue[], settings: SkoutSettings): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  for (const issue of issues) {
    if (settings.diagnostics[issue.category] === false) continue;
    diagnostics.push(toDiagnostic(issue));
  }
  return diagnostics;
}

function toDiagnostic(issue: Issue): Diagnostic {
  const diagnostic: Diagnostic = {
    range: {
      start: { line: issue.line, character: issue.start },
      end: { line: issue.line, character: issue.end },
    },
    severity: SEVERITY[issue.severity],
    code: issue.code,
    source: 'skout',
    message: issue.message,
  };
  if (issue.related?.length) {
    diagnostic.relatedInformation = issue.related.map((r) => ({
      location: { uri: r.uri, range: { start: { line: r.line, character: r.start }, end: { line: r.line, character: r.end } } },
      message: r.message,
    }));
  }
  return diagnostic;
}
