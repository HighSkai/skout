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
import { basename, dirname, join, relative, sep } from 'node:path';
import {
  createConnection,
  DidChangeConfigurationNotification,
  DidChangeWatchedFilesNotification,
  FileChangeType,
  ProposedFeatures,
  TextDocuments,
  TextDocumentSyncKind,
  ResponseError,
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
import { functionLookup, semanticIssues } from './engine/analyze';
import { entryIssues } from './features/entries';
import { formatDocument, signatureHelp } from './features/format';
import { contextIssues } from './engine/context';
import { findServerRoot, readEnvironment, scriptName, type Environment } from './environment/environment';
import { locate, parseServerLog, sameScript, type LogResult } from './environment/serverLog';
import { readFile as readFileAsync } from 'node:fs/promises';
import { unwatchFile, watchFile } from 'node:fs';
import { Engine } from './engine/engine';
import { expressionHover } from './engine/hover';
import { variablesTree } from './features/variablesTree';
import { findScripts, isDisabledScript, normalizeUri, readScript, toPath, toUri } from './index/files';
import type { FileIndex } from './index/types';
import { WorkspaceIndex } from './index/workspace';
import type { Issue, SkNode } from './parser/types';
import { defaultSettings, resolveSettings, type SkoutSettings } from './settings';
import { parseVersion, type Version } from './skript/version';
import { SyntaxCatalog } from './syntax/catalog';
import { loadDumps } from './syntax/load';
import { isSkriptDump, SyntaxRegistry, type LoadedDump } from './syntax/registry';
import { checkUpgrade, type UpgradeScope, type UpgradeSide } from './upgrade/check';
import { renderReport } from './upgrade/report';

const SKOUT_VERSION = '0.5.0';
const connection = createConnection(ProposedFeatures.all);
const documents = new TextDocuments(TextDocument);

// dist/server.js → dumps/ next to dist/.
const catalog = SyntaxCatalog.fromDirectory(join(__dirname, '..', 'dumps'));

let settings: SkoutSettings = defaultSettings;
/** Everything Skout knows about syntax: bundled Skript for the target version plus the user's dumps. */
let syntax = new SyntaxRegistry(catalog.forVersion(undefined));
/** The language engine over that syntax: types, expressions, line analysis. */
let engine = new Engine(syntax);
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
  const serverChanged = next.serverFolder !== settings.serverFolder || !environmentRead;
  const logChanged = next.readServerLog !== settings.readServerLog;
  let versionChanged = next.skriptVersion !== settings.skriptVersion;
  let dumpsChanged = JSON.stringify(next.syntaxDumps) !== JSON.stringify(settings.syntaxDumps);
  const modeChanged = next.unrecognizedSyntax !== settings.unrecognizedSyntax;
  settings = next;
  if (serverChanged && workspaceFolders.length > 0) {
    const before = { version: skriptVersionSetting(), dumps: environment?.dumps.join('|') };
    await detectEnvironment();
    versionChanged ||= skriptVersionSetting() !== before.version;
    dumpsChanged ||= environment?.dumps.join('|') !== before.dumps;
  }
  if (serverChanged || logChanged) watchServerLog();
  if (dumpsChanged) await reloadDumps(false);
  if (versionChanged || dumpsChanged || modeChanged) rebuildSyntax();
  if (versionChanged) index.setVersion(targetVersion);
  scheduleProject(0);
  notifyEnvironment();
}

// --- the server -----------------------------------------------------------------

/** The Minecraft server this workspace belongs to, when Skout found one. */
let environment: Environment | undefined;
let environmentRead = false;
/** What Skript last reported in the server's log. */
let serverLog: LogResult | undefined;
let watchedLog: string | undefined;

async function detectEnvironment(): Promise<void> {
  const found = findServerRoot(settings.serverFolder, workspaceFolders);
  try {
    environment = found ? await readEnvironment(found.root, found.source) : undefined;
  } catch (e) {
    environment = undefined;
    connection.console.warn(`Skout could not read the server folder ${found?.root}: ${String(e)}`);
  }
  environmentRead = true;
  if (environment) {
    const addons = environment.addons.map((a) => `${a.name} ${a.version}`).join(', ') || 'none';
    connection.console.log(`Skout found a server at ${environment.root}: Skript ${environment.skript?.version ?? '(not installed)'}, addons: ${addons}, ${environment.dumps.length} syntax dump(s).`);
  } else if (settings.serverFolder) {
    void connection.window.showWarningMessage(`Skout: '${settings.serverFolder}' is not a server folder (it has no plugins/Skript folder).`);
  }
}

/** The Skript version to target: the setting, else the version of the server's Skript jar. */
function skriptVersionSetting(): string {
  return settings.skriptVersion || environment?.skript?.version || '';
}

function watchServerLog(): void {
  const next = settings.readServerLog ? environment?.log : undefined;
  if (watchedLog === next) return;
  if (watchedLog) unwatchFile(watchedLog);
  watchedLog = next;
  serverLog = undefined;
  serverIssueCache = new WeakMap();
  if (!next) {
    republishAll();
    return;
  }
  const read = () => {
    void readFileAsync(next, 'utf8').then(
      (text) => {
        serverLog = parseServerLog(text);
        serverIssueCache = new WeakMap();
        republishAll();
        notifyEnvironment();
      },
      () => undefined,
    );
  };
  watchFile(next, { interval: 2000 }, read);
  read();
}

function republishAll(): void {
  for (const uri of index.uris()) publish(uri, documents.get(uri)?.version);
}

let serverIssueCache = new WeakMap<FileIndex, Issue[]>();

/** Problems Skript itself reported for this file on the server, on the line that still holds the code it quoted. */
function serverIssues(file: FileIndex): Issue[] {
  if (!serverLog || !environment) return [];
  let issues = serverIssueCache.get(file);
  if (issues) return issues;
  issues = [];
  const path = toPath(file.uri);
  const name = path ? scriptName(path, environment.root) : undefined;
  if (name) {
    const code = file.script.lines.map((l) => l.value);
    const text = file.script.lines.map((l) => l.text);
    for (const [script, problems] of serverLog.problems) {
      if (!sameScript(script, name)) continue;
      for (const p of problems) {
        const at = locate(p, code) ?? locate(p, text);
        if (at === undefined) continue;
        const line = file.script.lines[at];
        issues.push({ code: 'skript-reported', category: 'server', severity: p.severity, message: p.message, line: at, start: line.start, end: line.end, source: 'Skript (server)' });
      }
    }
  }
  serverIssueCache.set(file, issues);
  return issues;
}

function notifyEnvironment(): void {
  void connection.sendNotification('skout/environmentChanged', {});
}

/** Reads the dumps in skout.syntaxDumps, reporting the ones that fail. */
async function reloadDumps(rebuild = true): Promise<void> {
  // The dumps the user listed, then those the server generated (`/sk gen-docs`, SkriptHub Docs Tool).
  const result = await loadDumps([...settings.syntaxDumps, ...(environment?.dumps ?? [])], workspaceFolders);
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
  syntax = new SyntaxRegistry(catalog.forVersion(skriptVersionSetting() || undefined), userDumps);
  engine = new Engine(syntax);
  semantic = new WeakMap();
  contexts = new WeakMap();
  lastTypeIssues.clear();
  targetVersion = parseVersion(skriptVersionSetting()) ?? syntax.version;
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

/** Type issues per file, valid while the workspace's function signatures stay the same. */
let semantic = new WeakMap<FileIndex, { key: string; issues: Issue[] }>();
let signatures: { generation: number; key: string } | undefined;

/** A fingerprint of every global function signature, so other files' type issues are only recomputed when one changes. */
function signaturesKey(): string {
  if (signatures?.generation !== index.generation) {
    const key = index.globalFunctions().map((f) => f.header).sort().join('\n');
    signatures = { generation: index.generation, key };
  }
  return signatures.key;
}

/**
 * Open files are analysed at once. Other files are analysed in the
 * background, a slice at a time, so the server keeps answering; until then
 * they keep their previous results.
 */
function typeIssues(file: FileIndex, now = isOpen(file.uri)): Issue[] {
  if (!settings.diagnostics.types) return [];
  const key = signaturesKey();
  const cached = semantic.get(file);
  if (cached?.key === key) return cached.issues;
  if (!now) {
    queueAnalysis(file.uri);
    return lastTypeIssues.get(file.uri) ?? [];
  }
  const issues = semanticIssues(file, syntax, engine, functionLookup(index, file.uri, syntax));
  semantic.set(file, { key, issues });
  lastTypeIssues.set(file.uri, issues);
  return issues;
}

const lastTypeIssues = new Map<string, Issue[]>();
const pendingAnalysis = new Set<string>();
let analysisTimer: NodeJS.Immediate | undefined;

function queueAnalysis(uri: string): void {
  pendingAnalysis.add(uri);
  analysisTimer ??= setImmediate(drainAnalysis);
}

function drainAnalysis(): void {
  analysisTimer = undefined;
  const deadline = performance.now() + 25;
  for (const uri of pendingAnalysis) {
    pendingAnalysis.delete(uri);
    const file = index.get(uri);
    if (file) {
      typeIssues(file, true);
      publish(uri, documents.get(uri)?.version);
    }
    if (performance.now() > deadline) break;
  }
  if (pendingAnalysis.size > 0) analysisTimer = setImmediate(drainAnalysis);
}

/** Context issues per file; they depend only on the file and the syntax. */
let contexts = new WeakMap<FileIndex, Issue[]>();

function contextOf(file: FileIndex): Issue[] {
  let issues = contexts.get(file);
  if (!issues) {
    issues = contextIssues(file, syntax, targetVersion);
    contexts.set(file, issues);
  }
  return issues;
}

function publish(uri: string, version?: number): void {
  const file = index.get(uri);
  if (!file) return;
  const issues = [...file.script.issues, ...serverIssues(file), ...entryIssues(file.script, targetVersion), ...contextOf(file), ...unrecognized(file), ...typeIssues(file), ...(indexed ? lastProject.get(uri) ?? [] : [])];
  const diagnostics: Diagnostic[] = toDiagnostics(issues, settings);
  const key = JSON.stringify(diagnostics);
  if (published.get(uri) === key) return;
  published.set(uri, key);
  void connection.sendDiagnostics({ uri, version, diagnostics });
}

function clearDiagnostics(uri: string): void {
  published.delete(uri);
  lastTypeIssues.delete(uri);
  pendingAnalysis.delete(uri);
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
      documentFormattingProvider: true,
      signatureHelpProvider: { triggerCharacters: ['(', ','], retriggerCharacters: [' '] },
      workspace: { workspaceFolders: { supported: true, changeNotifications: true } },
    },
    serverInfo: { name: 'skout', version: SKOUT_VERSION },
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
    environmentRead = false;
    void applySettings(settings);
  });
  indexing = indexWorkspace();
  // Clients that send no settings still get the server folder looked for.
  if (!environmentRead) await applySettings(settings);
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
  const node = nodeAt(file, params.position.line);
  if (!node) return null;
  // The sub-expression under the cursor, else the syntax the whole line matched.
  const inner = expressionHover(file, node, params.position.character, syntax, engine, functionLookup(index, file.uri, syntax));
  return inner ?? syntaxHover(file, node, syntax) ?? null;
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

connection.onDocumentFormatting((params) => {
  const file = fileFor(params.textDocument.uri);
  return file ? formatDocument(file, params.options) : [];
});

connection.onSignatureHelp(async (params) => {
  await indexing;
  const file = fileFor(params.textDocument.uri);
  return file ? signatureHelp(index, file, syntax, params.position.line, params.position.character) ?? null : null;
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

interface UpgradeParams {
  /** Upgrade Skript to this version (bundled syntax, or `dumpPath` when given). */
  readonly skriptVersion?: string;
  /** A syntax dump for the target: Skript's docs.json, or a newer dump of `addon`. */
  readonly dumpPath?: string;
  /** Upgrade this addon instead of Skript. */
  readonly addon?: string;
  /** Where the client will save the report, so links in it are relative to it. */
  readonly reportPath?: string;
}

connection.onRequest('skout/upgrade', async (params: UpgradeParams) => {
  await indexing;
  const loadTarget = async (path: string): Promise<LoadedDump> => {
    const loaded = await loadDumps([path], workspaceFolders);
    if (loaded.dumps.length === 0) throw new ResponseError(1, `Skout could not read the syntax dump: ${loaded.errors[0] ?? path}`);
    return loaded.dumps[0];
  };

  let from: UpgradeSide;
  let to: UpgradeSide;
  let scope: UpgradeScope;
  if (params.addon) {
    const addon = params.addon;
    if (!params.dumpPath) throw new ResponseError(1, 'Choose a syntax dump of the newer addon version.');
    const target = await loadTarget(params.dumpPath);
    // The other dumps stay as they are; only this addon's entries are swapped.
    const others = userDumps.map((d) => ({ path: d.path, dump: { ...d.dump, entries: d.dump.entries.filter((e) => e.addon !== addon) } }));
    const registry = new SyntaxRegistry(catalog.forVersion(settings.skriptVersion || undefined), [...others, target], { dropRemoved: true });
    const current = settings.addonVersions[addon] || userDumps.map((d) => d.dump.addons[addon]).find((v) => v) || 'current';
    const next = target.dump.addons[addon] || basename(params.dumpPath);
    from = { registry: syntax, version: targetVersion, label: `${addon} ${current}` };
    to = { registry, version: targetVersion, label: `${addon} ${next}` };
    scope = { kind: 'addon', addon };
  } else {
    const version = parseVersion(params.skriptVersion);
    if (!version) throw new ResponseError(1, 'Choose the Skript version to upgrade to.');
    const addons = userDumps.filter((d) => !isSkriptDump(d.dump));
    const dumps = params.dumpPath ? [await loadTarget(params.dumpPath), ...addons] : addons;
    const registry = new SyntaxRegistry(catalog.forVersion(version.text), dumps);
    const exact = params.dumpPath || registry.version.text === version.text;
    from = { registry: syntax, version: targetVersion, label: `Skript ${targetVersion.text}` };
    to = { registry, version, label: `Skript ${version.text}${exact ? '' : ` (syntax of ${registry.version.text})`}` };
    scope = { kind: 'skript' };
  }

  const result = checkUpgrade(index, from, to, scope);
  const reportDir = params.reportPath ? dirname(params.reportPath) : workspaceFolders[0];
  const markdown = renderReport(result, {
    linkFor: (uri, line) => {
      const path = toPath(uri);
      return path && reportDir ? `${encodeURI(relative(reportDir, path).split(sep).join('/'))}#L${line + 1}` : `${uri}#L${line + 1}`;
    },
    nameFor: (uri) => {
      const path = toPath(uri);
      const folder = path && workspaceFolders.find((f) => path.startsWith(f));
      return path && folder ? relative(folder, path).split(sep).join('/') : uri;
    },
    date: new Date().toISOString().slice(0, 10),
    skoutVersion: SKOUT_VERSION,
  });
  return { result, markdown };
});

/** What Skout knows about the environment, for the Skout view. */
connection.onRequest('skout/environment', async () => {
  await indexing;
  const loadedAddons = new Set(syntax.addons.map((a) => a.toLowerCase()));
  const entriesOf = (addon: string) => syntax.entries.filter((e) => e.addon.toLowerCase() === addon.toLowerCase()).length;
  let checked = 0;
  let typeErrors = 0;
  let serverReported = 0;
  for (const file of index.all()) {
    const cached = semantic.get(file);
    if (cached) {
      checked++;
      typeErrors += cached.issues.length;
    }
    serverReported += serverIssues(file).length;
  }
  return {
    server: environment && { root: environment.root, source: environment.source, log: environment.log },
    skript: {
      target: targetVersion.text,
      from: settings.skriptVersion ? 'setting' : environment?.skript ? 'server' : 'bundled',
      syntax: syntax.skriptSource,
      installed: environment?.skript?.version,
    },
    addons: (environment?.addons ?? []).map((a) => ({
      name: a.name,
      version: a.version,
      syntax: loadedAddons.has(a.name.toLowerCase()) ? 'loaded' : 'missing',
      entries: loadedAddons.has(a.name.toLowerCase()) ? entriesOf(a.name) : 0,
    })),
    dumps: userDumps.map((d) => d.path),
    syntaxAddons: syntax.addons,
    files: index.size,
    checked,
    typeErrors,
    log: environment?.log ? { path: environment.log, read: settings.readServerLog, reloads: serverLog?.reloads ?? 0, problems: serverReported } : undefined,
  };
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
