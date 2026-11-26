/**
 * Skout language server.
 *
 * Editor-agnostic: nothing here imports `vscode`. Any LSP client can start it
 * with `node dist/server.js --stdio` (or `--node-ipc` / `--socket=<port>`).
 */
import {
  createConnection,
  DidChangeConfigurationNotification,
  ProposedFeatures,
  TextDocuments,
  TextDocumentSyncKind,
  type InitializeParams,
  type InitializeResult,
} from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { toDiagnostics } from './features/diagnostics';
import { documentSymbols, foldingRanges } from './features/outline';
import { parseScript } from './parser/parser';
import type { ParsedScript } from './parser/types';
import { defaultSettings, resolveSettings, type SkoutSettings } from './settings';

const connection = createConnection(ProposedFeatures.all);
const documents = new TextDocuments(TextDocument);

let settings: SkoutSettings = defaultSettings;
let canPullConfiguration = false;

/** Parsed scripts by URI, reparsed only when the document version changes. */
const parsed = new Map<string, { version: number; script: ParsedScript }>();
/** URIs with a validation queued for the next tick, so a burst of edits validates once. */
const pending = new Set<string>();

function getScript(document: TextDocument): ParsedScript {
  const cached = parsed.get(document.uri);
  if (cached && cached.version === document.version) return cached.script;
  const script = parseScript(document.getText());
  parsed.set(document.uri, { version: document.version, script });
  return script;
}

function scheduleValidation(document: TextDocument): void {
  if (pending.has(document.uri)) return;
  pending.add(document.uri);
  setImmediate(() => {
    pending.delete(document.uri);
    const current = documents.get(document.uri);
    if (!current) return;
    void connection.sendDiagnostics({
      uri: current.uri,
      version: current.version,
      diagnostics: toDiagnostics(getScript(current), settings),
    });
  });
}

async function refreshSettings(): Promise<void> {
  if (canPullConfiguration) {
    settings = resolveSettings(await connection.workspace.getConfiguration('skout'));
  }
  documents.all().forEach(scheduleValidation);
}

connection.onInitialize((params: InitializeParams): InitializeResult => {
  canPullConfiguration = params.capabilities.workspace?.configuration === true;
  // Clients without workspace/configuration can pass settings at startup.
  const initial = (params.initializationOptions as { settings?: unknown } | undefined)?.settings;
  if (initial) settings = resolveSettings(initial);

  return {
    capabilities: {
      textDocumentSync: TextDocumentSyncKind.Incremental,
      documentSymbolProvider: true,
      foldingRangeProvider: true,
    },
    serverInfo: { name: 'skout', version: '0.1.0' },
  };
});

connection.onInitialized(() => {
  if (canPullConfiguration) {
    void connection.client.register(DidChangeConfigurationNotification.type, { section: 'skout' });
    void refreshSettings();
  }
});

connection.onDidChangeConfiguration((change) => {
  if (canPullConfiguration) {
    void refreshSettings();
  } else {
    settings = resolveSettings((change.settings as { skout?: unknown } | undefined)?.skout);
    documents.all().forEach(scheduleValidation);
  }
});

documents.onDidChangeContent((event) => scheduleValidation(event.document));

documents.onDidClose((event) => {
  parsed.delete(event.document.uri);
  void connection.sendDiagnostics({ uri: event.document.uri, diagnostics: [] });
});

connection.onDocumentSymbol((params) => {
  const document = documents.get(params.textDocument.uri);
  return document ? documentSymbols(getScript(document)) : [];
});

connection.onFoldingRanges((params) => {
  const document = documents.get(params.textDocument.uri);
  return document ? foldingRanges(getScript(document)) : [];
});

documents.listen(connection);
connection.listen();
