import { DiagnosticSeverity, type Diagnostic } from 'vscode-languageserver';
import type { Issue, ParsedScript, Severity } from '../parser/types';
import type { SkoutSettings } from '../settings';

const SEVERITY: Record<Severity, DiagnosticSeverity> = {
  error: DiagnosticSeverity.Error,
  warning: DiagnosticSeverity.Warning,
  information: DiagnosticSeverity.Information,
  hint: DiagnosticSeverity.Hint,
};

export function toDiagnostics(script: ParsedScript, settings: SkoutSettings): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  for (const issue of script.issues) {
    if (!settings.diagnostics[issue.category]) continue;
    diagnostics.push(toDiagnostic(issue));
  }
  return diagnostics;
}

function toDiagnostic(issue: Issue): Diagnostic {
  return {
    range: {
      start: { line: issue.line, character: issue.start },
      end: { line: issue.line, character: issue.end },
    },
    severity: SEVERITY[issue.severity],
    code: issue.code,
    source: 'skout',
    message: issue.message,
  };
}
