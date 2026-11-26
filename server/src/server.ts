/**
 * Skout language server.
 *
 * Editor-agnostic: nothing here imports `vscode`. Any LSP client can start it
 * with `node dist/server.js --stdio` (or `--node-ipc` / `--socket=<port>`).
 *
 * Every `.sk` file in the workspace is indexed in the background. Editing a
 * file re-parses only that file and publishes its own diagnostics at once;
 * cross-file diagnostics follow shortly after, debounced.
 */
import { join } from 'node:path';
import {
  createConnection,
  DidChangeConfigurationNotification,
  DidChangeWatchedFilesNotification,
  FileChangeType,
  ProposedFeatures,
  TextDocuments,
  TextDocumentSyncKind,
  CodeActionKind,
  type CodeAction,
  type Diagnostic,
  type InitializeParams,
  type InitializeResult,
  type WorkDoneProgressServerReporter,
} from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { completions, resolveCompletion } from './features/completion';
import { toDiagnostics } from './features/diagnostics';
import { definition, hover, references, targetAt, workspaceSymbols } from './features/navigation';
import { documentSymbols, foldingRanges } from './features/outline';
import { projectIssues } from './features/project';
import { prepareRename, rename } from './features/rename';
import { syntaxHover, unrecognizedIssues } from './features/syntax';
import { variablesTree } from './features/variablesTree';
import { findScripts, isDisabledScript, normalizeUri, readScript, toPath, toUri } from './index/files';
import type { FileIndex } from './index/types';
import { WorkspaceIndex } from './index/workspace';
import type { Issue, SkNode } from './parser/types';
import { defaultSettings, resolveSettings, type SkoutSettings } from './settings';
import { parseVersion, type Version } from './skript/version';
import { SyntaxCatalog } from './syntax/catalog';
import { loadDumps } from './syntax/load';
import { SyntaxRegistry, type LoadedDump } from './syntax/registry';

const connection = createConnection(ProposedFeatures.all);
const documents = new TextDocuments(TextDocument);

// dist/server.js → dumps/ next to dist/.
const catalog = SyntaxCatalog.fromDirectory(join(__dirname, '..', 'dumps'));

let settings: SkoutSettings = defaultSettings;
/** Everything Skout knows about syntax: bundled Skript for the target version plus the user's dumps. */
let syntax = new SyntaxRegistry(catalog.forVersion(undefined));
let userDumps: LoadedDump[] = [];
let targetVersion: Version = syntax.version;
const index = new WorkspaceIndex(targetVersion);

let canPullConfiguration = false;
let canWatchFiles = false;
let canAnnotateEdits = false;
let canReportProgress = false;
let workspaceFolders: string[] = [];
let indexing: Promise<void> | undefined;
let indexed = false;

/** Cross-file issues from the last project pass, by URI. */
let lastProject = new Map<string, Issue[]>();
/** What was last published per URI, to skip unchanged re-sends. */
const published = new Map<string, string>();

// --- configuration ------------------------------------------------------------

async function applySettings(next: SkoutSettings): Promise<void> {
  const versionChanged = next.skriptVersion !== settings.skriptVersion;
  const dumpsChanged = JSON.stringify(next.syntaxDumps) !== JSON.stringify(settings.syntaxDumps);
  const modeChanged = next.unrecognizedSyntax !== settings.unrecognizedSyntax;
  settings = next;
  if (dumpsChanged) await reloadDumps(false);
  if (versionChanged || dumpsChanged || modeChanged) rebuildSyntax();
  if (versionChanged) index.setVersion(targetVersion);
  scheduleProject(0);
}

/** Reads the dumps in skout.syntaxDumps, reporting the ones that fail. */
async function reloadDumps(rebuild = true): Promise<void> {
  const result = await loadDumps(settings.syntaxDumps, workspaceFolders);
  userDumps = result.dumps;
  for (const error of result.errors) connection.console.warn(`Skout: syntax dump ${error}`);
  if (result.errors.length > 0) {
    void connection.window.showWarningMessage(`Skout could not load ${result.errors.length} syntax dump(s): ${result.errors[0]}${result.errors.length > 1 ? ' (see the Skout output for the rest)' : ''}`);
  }
  if (rebuild) {
    rebuildSyntax();
    scheduleProject(0);
  }
}

function rebuildSyntax(): void {
  syntax = new SyntaxRegistry(catalog.forVersion(settings.skriptVersion || undefined), userDumps);
  targetVersion = parseVersion(settings.skriptVersion) ?? syntax.version;
  syntaxIssues = new WeakMap();
  published.clear();
}

async function refreshSettings(): Promise<void> {
  if (canPullConfiguration) await applySettings(resolveSettings(await connection.workspace.getConfiguration('skout')));
}

// --- indexing -----------------------------------------------------------------

function isOpen(uri: string): boolean {
  return documents.get(uri) !== undefined;
}

async function indexWorkspace(): Promise<void> {
  let progress: WorkDoneProgressServerReporter | undefined;
  if (canReportProgress) {
    progress = await connection.window.createWorkDoneProgress();
    progress.begin('Skout', 0, 'Finding scripts…', false);
  }
  const paths = await findScripts(workspaceFolders);
  let done = 0;
  for (const path of paths) {
    const uri = toUri(path);
    if (!isOpen(uri)) {
      const text = await readScript(path);
      if (text !== undefined) index.update(uri, text, isDisabledScript(path, workspaceFolders));
    }
    done++;
    if (done % 25 === 0) {
      progress?.report(Math.round((done / paths.length) * 100), `Indexing ${done}/${paths.length} scripts`);
      await new Promise((resolve) => setImmediate(resolve));
    }
  }
  progress?.done();
  indexed = true;
  connection.console.log(`Skout indexed ${paths.length} script(s); Skript ${targetVersion.text} rules, built-ins from bundled ${syntax.version.text}.`);
  scheduleProject(0);
}

async function reloadFromDisk(uri: string): Promise<void> {
  const path = toPath(uri);
  const text = path ? await readScript(path) : undefined;
  if (text === undefined) {
    if (index.delete(uri)) clearDiagnostics(uri);
  } else {
    index.update(uri, text, path ? isDisabledScript(path, workspaceFolders) : false);
  }
  scheduleProject();
}

// --- diagnostics --------------------------------------------------------------

/** Unrecognized-syntax issues per indexed file; recomputed only when the file or the syntax changes. */
let syntaxIssues = new WeakMap<FileIndex, Issue[]>();

function unrecognized(file: FileIndex): Issue[] {
  let issues = syntaxIssues.get(file);
  if (!issues) {
    issues = settings.unrecognizedSyntax === 'off' ? [] : unrecognizedIssues(file, syntax, settings.unrecognizedSyntax);
    syntaxIssues.set(file, issues);
  }
  return issues;
}

function publish(uri: string, version?: number): void {
  const file = index.get(uri);
  if (!file) return;
  const issues = [...file.script.issues, ...unrecognized(file), ...(indexed ? lastProject.get(uri) ?? [] : [])];
  const diagnostics: Diagnostic[] = toDiagnostics(issues, settings);
  const key = JSON.stringify(diagnostics);
  if (published.get(uri) === key) return;
  published.set(uri, key);
  void connection.sendDiagnostics({ uri, version, diagnostics });
}

function clearDiagnostics(uri: string): void {
  published.delete(uri);
  lastProject.delete(uri);
  void connection.sendDiagnostics({ uri, diagnostics: [] });
}

let projectTimer: NodeJS.Timeout | undefined;

/** Recomputes cross-file diagnostics for every indexed file, debounced. */
function scheduleProject(delay = 150): void {
  if (projectTimer) clearTimeout(projectTimer);
  projectTimer = setTimeout(() => {
    projectTimer = undefined;
    if (indexed) {
      lastProject = projectIssues({ index, catalog, syntax, version: targetVersion, settings });
      void connection.sendNotification('skout/indexChanged', { files: index.size });
    }
    for (const uri of index.uris()) publish(uri, documents.get(uri)?.version);
  }, delay);
}

// --- lifecycle ----------------------------------------------------------------

connection.onInitialize((params: InitializeParams): InitializeResult => {
  const caps = params.capabilities;
  canPullConfiguration = caps.workspace?.configuration === true;
  canWatchFiles = caps.workspace?.didChangeWatchedFiles?.dynamicRegistration === true;
  canAnnotateEdits = caps.workspace?.workspaceEdit?.documentChanges === true && caps.workspace?.workspaceEdit?.changeAnnotationSupport !== undefined;
  canReportProgress = caps.window?.workDoneProgress === true;

  workspaceFolders = (params.workspaceFolders ?? []).map((f) => toPath(f.uri)).filter((p): p is string => !!p);
  if (workspaceFolders.length === 0 && params.rootUri) {
    const root = toPath(params.rootUri);
    if (root) workspaceFolders = [root];
  }

  // Clients without workspace/configuration can pass settings at startup.
  const initial = (params.initializationOptions as { settings?: unknown } | undefined)?.settings;
  if (initial) void applySettings(resolveSettings(initial));

  return {
    capabilities: {
      textDocumentSync: TextDocumentSyncKind.Incremental,
      documentSymbolProvider: true,
      foldingRangeProvider: true,
      definitionProvider: true,
      referencesProvider: true,
      hoverProvider: true,
      workspaceSymbolProvider: true,
      renameProvider: { prepareProvider: true },
      completionProvider: { resolveProvider: true, triggerCharacters: ['{', '@', '%'] },
      codeActionProvider: { codeActionKinds: [CodeActionKind.QuickFix] },
      workspace: { workspaceFolders: { supported: true, changeNotifications: true } },
    },
    serverInfo: { name: 'skout', version: '0.3.0' },
  };
});

connection.onInitialized(async () => {
  if (canPullConfiguration) {
    void connection.client.register(DidChangeConfigurationNotification.type, { section: 'skout' });
    await refreshSettings();
  }
  if (canWatchFiles) {
    void connection.client.register(DidChangeWatchedFilesNotification.type, { watchers: [{ globPattern: '**/*.sk' }] });
  }
  connection.workspace.onDidChangeWorkspaceFolders((event) => {
    for (const removed of event.removed) {
      const root = normalizeUri(removed.uri);
      for (const uri of index.uris()) if (uri.startsWith(root) && index.delete(uri)) clearDiagnostics(uri);
      workspaceFolders = workspaceFolders.filter((f) => toUri(f) !== root);
    }
    for (const added of event.added) {
      const path = toPath(added.uri);
      if (path) workspaceFolders.push(path);
    }
    indexing = indexWorkspace();
  });
  indexing = indexWorkspace();
});

connection.onDidChangeConfiguration((change) => {
  if (canPullConfiguration) void refreshSettings();
  else void applySettings(resolveSettings((change.settings as { skout?: unknown } | undefined)?.skout));
});

connection.onDidChangeWatchedFiles(async (params) => {
  for (const change of params.changes) {
    const uri = normalizeUri(change.uri);
    if (isOpen(uri)) continue; // the editor's buffer is the truth while open
    if (change.type === FileChangeType.Deleted) {
      if (index.delete(uri)) clearDiagnostics(uri);
      scheduleProject();
    } else {
      await reloadFromDisk(uri);
    }
  }
});

documents.onDidChangeContent((event) => {
  const uri = normalizeUri(event.document.uri);
  const path = toPath(uri);
  index.update(uri, event.document.getText(), path ? isDisabledScript(path, workspaceFolders) : false);
  publish(uri, event.document.version); // this file's own problems, immediately
  scheduleProject();
});

documents.onDidClose((event) => {
  // The saved file on disk replaces the editor buffer, or the entry goes if there is none.
  void reloadFromDisk(normalizeUri(event.document.uri));
});

// --- features -----------------------------------------------------------------

function fileFor(uri: string): FileIndex | undefined {
  return index.get(normalizeUri(uri));
}

connection.onDocumentSymbol((params) => {
  const file = fileFor(params.textDocument.uri);
  return file ? documentSymbols(file.script) : [];
});

connection.onFoldingRanges((params) => {
  const file = fileFor(params.textDocument.uri);
  return file ? foldingRanges(file.script) : [];
});

connection.onDefinition(async (params) => {
  await indexing;
  const file = fileFor(params.textDocument.uri);
  const target = file && targetAt(file, params.position.line, params.position.character);
  return file && target ? definition(index, file, target) : null;
});

connection.onReferences(async (params) => {
  await indexing;
  const file = fileFor(params.textDocument.uri);
  const target = file && targetAt(file, params.position.line, params.position.character);
  return file && target ? references(index, file, target, params.context.includeDeclaration) : null;
});

connection.onHover(async (params) => {
  await indexing;
  const file = fileFor(params.textDocument.uri);
  if (!file) return null;
  const target = targetAt(file, params.position.line, params.position.character);
  if (target) return hover(index, file, target, syntax) ?? null;
  // Otherwise, the syntax the whole line matched.
  const node = nodeAt(file, params.position.line);
  return node ? syntaxHover(file, node, syntax) ?? null : null;
});

function nodeAt(file: FileIndex, line: number): SkNode | undefined {
  let found: SkNode | undefined;
  const visit = (node: SkNode) => {
    if (node.line === line) found = node;
    else if (node.line < line && node.lastLine >= line) node.children.forEach(visit);
  };
  file.script.structures.forEach(visit);
  return found;
}

connection.onCompletion(async (params) => {
  await indexing;
  const file = index.get(normalizeUri(params.textDocument.uri));
  const document = documents.get(params.textDocument.uri);
  if (!file || !document) return [];
  const lineText = document
    .getText({ start: { line: params.position.line, character: 0 }, end: { line: params.position.line + 1, character: 0 } })
    .replace(/\r?\n$/, '');
  return completions({ index, registry: syntax, file, lineText, line: params.position.line, character: params.position.character });
});

connection.onCompletionResolve((item) => resolveCompletion(item, syntax));

connection.onCodeAction((params) => {
  const actions: CodeAction[] = [];
  for (const diagnostic of params.context.diagnostics) {
    const fix = (diagnostic.data as { fix?: Issue['fix'] } | undefined)?.fix;
    if (diagnostic.source !== 'skout' || !fix) continue;
    actions.push({
      title: `Change to '${fix.text}'`,
      kind: CodeActionKind.QuickFix,
      diagnostics: [diagnostic],
      isPreferred: true,
      edit: {
        changes: {
          [params.textDocument.uri]: [{ range: { start: { line: fix.line, character: fix.start }, end: { line: fix.line, character: fix.end } }, newText: fix.text }],
        },
      },
    });
  }
  return actions;
});

connection.onRequest('skout/reloadDumps', async () => {
  await reloadDumps();
  return { addons: syntax.addons, skript: syntax.skriptSource };
});

connection.onWorkspaceSymbol(async (params) => {
  await indexing;
  return workspaceSymbols(index, params.query);
});

connection.onPrepareRename(async (params) => {
  await indexing;
  const file = fileFor(params.textDocument.uri);
  return file ? prepareRename(index, file, params.position.line, params.position.character, syntax) : null;
});

connection.onRenameRequest(async (params) => {
  await indexing;
  const file = fileFor(params.textDocument.uri);
  if (!file) return null;
  return rename(index, file, params.position.line, params.position.character, params.newName, syntax, {
    annotations: canAnnotateEdits,
    versionOf: (uri) => documents.get(uri)?.version ?? null,
  });
});

connection.onRequest('skout/variables', async () => {
  await indexing;
  return variablesTree(index);
});

connection.onRequest('skout/status', async () => {
  await indexing;
  return {
    files: index.size,
    targetVersion: targetVersion.text,
    builtinsVersion: syntax.version.text,
    bundledVersions: catalog.versions.map((v) => v.text),
    skriptSyntax: syntax.skriptSource,
    addons: syntax.addons,
  };
});

documents.listen(connection);
connection.listen();
