import * as assert from 'node:assert/strict';
import { before, describe, it } from 'mocha';
import * as vscode from 'vscode';

const EXTENSION_ID = 'highskai.skout';

function fileUri(name: string): vscode.Uri {
  const folder = vscode.workspace.workspaceFolders?.[0];
  assert.ok(folder, 'test-workspace should be open');
  return vscode.Uri.joinPath(folder.uri, 'scripts', name);
}

/** Waits until `check` passes on the document's diagnostics, or fails with the last ones seen. */
async function diagnosticsFor(uri: vscode.Uri, check: (codes: string[]) => boolean): Promise<string[]> {
  let last: string[] = [];
  for (let i = 0; i < 100; i++) {
    last = vscode.languages
      .getDiagnostics(uri)
      // Hints (deprecated syntax) are advice, not problems; tests that want them look for them.
      .filter((d) => d.source === 'skout' && d.severity !== vscode.DiagnosticSeverity.Hint)
      .map((d) => `${String(typeof d.code === 'object' ? d.code.value : d.code)}@${d.range.start.line + 1}`)
      .sort();
    if (check(last)) return last;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.fail(`Diagnostics never matched. Last seen: ${JSON.stringify(last)}`);
}

/** Position just inside the first occurrence of `needle` in the document. */
async function positionOf(uri: vscode.Uri, needle: string, offset = 1): Promise<vscode.Position> {
  const document = await vscode.workspace.openTextDocument(uri);
  const index = document.getText().indexOf(needle);
  assert.ok(index !== -1, `${needle} not found`);
  return document.positionAt(index + offset);
}

const short = (loc: vscode.Location | vscode.LocationLink) => {
  const uri = 'uri' in loc ? loc.uri : loc.targetUri;
  const range = 'range' in loc ? loc.range : loc.targetRange;
  return `${uri.path.slice(uri.path.lastIndexOf('/') + 1)}:${range.start.line + 1}`;
};

let api: { client: { sendRequest<T>(method: string, params?: unknown): Promise<T> } };

describe('Skout extension', () => {
  before(async () => {
    const extension = vscode.extensions.getExtension(EXTENSION_ID);
    assert.ok(extension, `${EXTENSION_ID} should be installed`);
    api = await extension.activate();
    // The workspace is indexed in the background; requests wait for it.
    const status = await api.client.sendRequest<{ files: number }>('skout/status');
    assert.equal(status.files, 4);
  });

  it('registers .sk files as Skript', async () => {
    const document = await vscode.workspace.openTextDocument(fileUri('shop.sk'));
    assert.equal(document.languageId, 'skript');
  });

  it('reports every planted problem in broken.sk, and nothing else', async () => {
    const uri = fileUri('broken.sk');
    await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(uri));
    const expected = [
      'accidental-comment@3',
      'empty-section@12',
      'indent-unexpected@10',
      'missing-colon@6',
      'unclosed-bracket@9',
      'unclosed-percent@8',
      'unclosed-string@16',
    ];
    const codes = await diagnosticsFor(uri, (c) => c.length === expected.length);
    assert.deepEqual(codes, expected);
  });

  it('reports nothing for valid scripts', async () => {
    for (const name of ['shop.sk', 'quests.sk']) {
      const uri = fileUri(name);
      await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(uri));
      // Give the server time to publish; an empty list is the expected end state.
      await new Promise((resolve) => setTimeout(resolve, 500));
      assert.deepEqual(await diagnosticsFor(uri, () => true), [], name);
    }
  });

  it('marks deprecated entries with a struck-through hint', async () => {
    const uri = fileUri('shop.sk');
    await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(uri));
    let hint: vscode.Diagnostic | undefined;
    for (let i = 0; i < 50 && !hint; i++) {
      hint = vscode.languages.getDiagnostics(uri).find((d) => d.code === 'deprecated-entry');
      if (!hint) await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.ok(hint, 'permission message is deprecated in 2.17');
    assert.equal(hint.severity, vscode.DiagnosticSeverity.Hint);
    assert.deepEqual(hint.tags, [vscode.DiagnosticTag.Deprecated]);
  });

  it('serves the Environment view', async () => {
    const env = await api.client.sendRequest<{ skript: { target: string; from: string }; server?: unknown; addons: unknown[] }>('skout/environment');
    assert.equal(env.skript.from, 'bundled');
    assert.equal(env.server, undefined, 'the test workspace is not a server folder');
    await vscode.commands.executeCommand('skout.environment.focus');
  });

  it('updates diagnostics as the document is edited', async () => {
    const uri = fileUri('shop.sk');
    const editor = await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(uri));
    const end = editor.document.lineAt(editor.document.lineCount - 1).range.end;
    await editor.edit((edit) => edit.insert(end, '\n\t\tsend "typing'));
    assert.deepEqual(await diagnosticsFor(uri, (c) => c.length > 0), [`unclosed-string@${editor.document.lineCount}`]);
    await vscode.commands.executeCommand('undo');
    assert.deepEqual(await diagnosticsFor(uri, (c) => c.length === 0), []);
  });

  it('turns a diagnostic category off through skout.* settings', async () => {
    const uri = fileUri('broken.sk');
    const config = vscode.workspace.getConfiguration('skout');
    await config.update('diagnostics.emptySection', false, vscode.ConfigurationTarget.Workspace);
    try {
      const codes = await diagnosticsFor(uri, (c) => !c.includes('empty-section@12'));
      assert.ok(codes.includes('missing-colon@6'), 'other categories stay on');
    } finally {
      await config.update('diagnostics.emptySection', undefined, vscode.ConfigurationTarget.Workspace);
    }
    await diagnosticsFor(uri, (c) => c.includes('empty-section@12'));
  });

  it('provides an outline of structures and options', async () => {
    const symbols = await vscode.commands.executeCommand<vscode.DocumentSymbol[]>('vscode.executeDocumentSymbolProvider', fileUri('shop.sk'));
    assert.deepEqual(
      symbols.map((s) => s.name),
      ['options', 'command /shop [<integer>]', 'function openShop(p: player, page: integer = 1)', 'on inventory click'],
    );
    assert.deepEqual(
      symbols[0].children.map((c) => `${c.name}=${c.detail}`),
      ['prefix=&8[&6Shop&8]&r', 'accent=<#f5c542>', 'max-page=3'],
    );
  });
});

describe('Skout project awareness (M2)', () => {
  it('goes to a function defined in another file', async () => {
    const uri = fileUri('admin.sk');
    const locations = await vscode.commands.executeCommand<(vscode.Location | vscode.LocationLink)[]>(
      'vscode.executeDefinitionProvider',
      uri,
      await positionOf(uri, 'completeQuest('),
    );
    assert.deepEqual(locations.map(short), ['quests.sk:16']);
  });

  it('finds references across files', async () => {
    const uri = fileUri('quests.sk');
    const locations = await vscode.commands.executeCommand<vscode.Location[]>(
      'vscode.executeReferenceProvider',
      uri,
      await positionOf(uri, 'function completeQuest', 'function '.length + 1),
    );
    assert.deepEqual(locations.map(short).sort(), ['admin.sk:13', 'quests.sk:16', 'quests.sk:29']);
  });

  it('shows the signature on hover', async () => {
    const uri = fileUri('admin.sk');
    const hovers = await vscode.commands.executeCommand<vscode.Hover[]>('vscode.executeHoverProvider', uri, await positionOf(uri, 'completeQuest('));
    const text = hovers.flatMap((h) => h.contents.map((c) => (typeof c === 'string' ? c : c.value))).join('\n');
    assert.match(text, /function completeQuest\(p: player, quest: text\)/);
  });

  it('shows where a variable is set and read on hover', async () => {
    const uri = fileUri('shop.sk');
    const hovers = await vscode.commands.executeCommand<vscode.Hover[]>('vscode.executeHoverProvider', uri, await positionOf(uri, '{shop::items::*}', 2));
    const text = hovers.flatMap((h) => h.contents.map((c) => (typeof c === 'string' ? c : c.value))).join('\n');
    assert.match(text, /\*\*Set\*\* in 1 place: \[admin\.sk:5\]/);
  });

  it('renames a function across files', async () => {
    const uri = fileUri('admin.sk');
    const edit = await vscode.commands.executeCommand<vscode.WorkspaceEdit>('vscode.executeDocumentRenameProvider', uri, await positionOf(uri, 'completeQuest('), 'finishQuest');
    const changed = edit.entries().map(([u, edits]) => `${u.path.slice(u.path.lastIndexOf('/') + 1)}×${edits.length}`).sort();
    assert.deepEqual(changed, ['admin.sk×1', 'quests.sk×2']);
  });

  it('renames a variable namespace across files', async () => {
    const uri = fileUri('admin.sk');
    const edit = await vscode.commands.executeCommand<vscode.WorkspaceEdit>('vscode.executeDocumentRenameProvider', uri, await positionOf(uri, '{shop::price', 2), 'store');
    const changed = edit.entries().map(([u, edits]) => `${u.path.slice(u.path.lastIndexOf('/') + 1)}×${edits.length}`).sort();
    // {shop::items::*} and {shop::price::…}: 2 in admin.sk, 4 in shop.sk
    assert.deepEqual(changed, ['admin.sk×2', 'shop.sk×4']);
  });

  it('reports cross-file problems as you type, and clears them', async () => {
    const uri = fileUri('admin.sk');
    const editor = await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(uri));
    const end = editor.document.lineAt(editor.document.lineCount - 1).range.end;
    await editor.edit((e) => e.insert(end, '\n\t\tcompleteQuest(player)\n\t\tcompleteQuests(player, "x")\n\t\tsend {quest::goal::x} to player'));
    try {
      const last = editor.document.lineCount; // 1-based number of the last inserted line
      const codes = await diagnosticsFor(uri, (c) => c.length >= 3);
      assert.deepEqual(codes, [`argument-count@${last - 2}`, `undefined-function@${last - 1}`, `unset-variable@${last}`]);
    } finally {
      await vscode.commands.executeCommand('undo');
    }
    assert.deepEqual(await diagnosticsFor(uri, (c) => c.length === 0), []);
  });

  it('keeps the valid scripts free of project problems', async () => {
    for (const name of ['shop.sk', 'quests.sk', 'admin.sk']) {
      const uri = fileUri(name);
      await vscode.workspace.openTextDocument(uri);
      await new Promise((resolve) => setTimeout(resolve, 300));
      assert.deepEqual(await diagnosticsFor(uri, () => true), [], name);
    }
  });

  it('finds functions and commands as workspace symbols', async () => {
    const symbols = await vscode.commands.executeCommand<vscode.SymbolInformation[]>('vscode.executeWorkspaceSymbolProvider', 'openShop');
    assert.ok(symbols.some((s) => s.name === 'openShop' && s.location.uri.path.endsWith('shop.sk')));
  });

  it('serves the Variables view grouped by namespace', async () => {
    const roots = await api.client.sendRequest<{ label: string; children?: { label: string }[] }[]>('skout/variables');
    assert.deepEqual(roots.map((r) => r.label), ['coins', 'quest', 'shop', 'stats', 'Local variables'].filter((l) => roots.some((r) => r.label === l)));
    const shop = roots.find((r) => r.label === 'shop');
    assert.deepEqual(shop?.children?.map((c) => c.label), ['items', 'price']);
    await vscode.commands.executeCommand('skout.variables.focus');
  });
});

describe('Skout syntax intelligence (M3)', () => {
  /** Appends lines to admin.sk, runs `body`, then undoes the edit. */
  async function withLines(lines: string[], body: (editor: vscode.TextEditor, firstLine: number) => Promise<void>): Promise<void> {
    const uri = fileUri('admin.sk');
    const editor = await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(uri));
    const last = editor.document.lineCount - 1;
    const end = editor.document.lineAt(last).range.end;
    const prefix = editor.document.lineAt(last).text === '' ? '' : '\n';
    await editor.edit((e) => e.insert(end, prefix + lines.join('\n')));
    try {
      await body(editor, prefix ? last + 1 : last);
    } finally {
      await vscode.commands.executeCommand('undo');
    }
  }

  it('completes effects with snippets at the start of a statement', async () => {
    await withLines(['\t\tbroa'], async (editor, line) => {
      const list = await vscode.commands.executeCommand<vscode.CompletionList>(
        'vscode.executeCompletionItemProvider',
        editor.document.uri,
        new vscode.Position(line, 6),
      );
      const item = list.items.find((i) => (typeof i.label === 'string' ? i.label : i.label.label) === 'broadcast %objects%');
      assert.ok(item, 'broadcast is offered');
      const insert = item.insertText instanceof vscode.SnippetString ? item.insertText.value : String(item.insertText);
      assert.equal(insert, 'broadcast ${1:objects}');
    });
  });

  it('completes events after `on ` at the top level', async () => {
    await withLines(['on jo'], async (editor, line) => {
      const list = await vscode.commands.executeCommand<vscode.CompletionList>(
        'vscode.executeCompletionItemProvider',
        editor.document.uri,
        new vscode.Position(line, 5),
      );
      assert.ok(list.items.some((i) => (typeof i.label === 'string' ? i.label : i.label.label) === 'join'));
    });
  });

  it('shows the docs of the syntax a line matches on hover', async () => {
    const uri = fileUri('admin.sk');
    const hovers = await vscode.commands.executeCommand<vscode.Hover[]>('vscode.executeHoverProvider', uri, await positionOf(uri, 'send "Price set."', 1));
    const text = hovers.flatMap((h) => h.contents.map((c) => (typeof c === 'string' ? c : c.value))).join('\n');
    assert.match(text, /\*\*Message\*\* · Effect · Skript/);
  });

  it('flags a misspelled effect and fixes it with a quick fix', async () => {
    await withLines(['\t\tsned "hi" to player'], async (editor, line) => {
      const codes = await diagnosticsFor(editor.document.uri, (c) => c.includes(`unrecognized-syntax@${line + 1}`));
      assert.ok(codes.includes(`unrecognized-syntax@${line + 1}`));
      const actions = await vscode.commands.executeCommand<vscode.CodeAction[]>(
        'vscode.executeCodeActionProvider',
        editor.document.uri,
        new vscode.Range(line, 2, line, 6),
        vscode.CodeActionKind.QuickFix.value,
      );
      const fix = actions.find((a) => a.title === "Change to 'send'");
      assert.ok(fix?.edit, 'quick fix offered');
      await vscode.workspace.applyEdit(fix.edit);
      assert.equal(editor.document.lineAt(line).text, '\t\tsend "hi" to player');
      await vscode.commands.executeCommand('undo');
    });
  });

  it('loads an addon syntax dump from skout.syntaxDumps', async () => {
    const config = vscode.workspace.getConfiguration('skout');
    const dump = vscode.Uri.joinPath(vscode.workspace.workspaceFolders![0].uri, '..', 'server', 'test', 'fixtures', 'dumps', 'skripthub-Widgets.json').fsPath;
    await config.update('syntaxDumps', [dump], vscode.ConfigurationTarget.Workspace);
    try {
      await withLines(['\t\tspin widget "w"'], async (editor, line) => {
        let text = '';
        for (let attempt = 0; attempt < 50 && !text.includes('Widgets'); attempt++) {
          const hovers = await vscode.commands.executeCommand<vscode.Hover[]>('vscode.executeHoverProvider', editor.document.uri, new vscode.Position(line, 3));
          text = hovers.flatMap((h) => h.contents.map((c) => (typeof c === 'string' ? c : c.value))).join('\n');
          if (!text.includes('Widgets')) await new Promise((resolve) => setTimeout(resolve, 100));
        }
        assert.match(text, /\*\*Spin Widget\*\* · Effect · Widgets/);
      });
      const status = await api.client.sendRequest<{ addons: string[] }>('skout/status');
      assert.deepEqual(status.addons, ['Widgets']);
    } finally {
      await config.update('syntaxDumps', undefined, vscode.ConfigurationTarget.Workspace);
    }
  });
});

describe('Skout upgrade checker (M4)', () => {
  it('registers the upgrade commands', async () => {
    const commands = await vscode.commands.getCommands(true);
    assert.ok(commands.includes('skout.checkUpgrade'));
    assert.ok(commands.includes('skout.clearUpgradeResults'));
  });

  it('checks the workspace against a newer Skript and writes a report', async () => {
    const config = vscode.workspace.getConfiguration('skout');
    await config.update('skriptVersion', '2.16.2', vscode.ConfigurationTarget.Workspace);
    try {
      // The server picks up the version change; wait until it reports it.
      for (let i = 0; i < 50; i++) {
        const status = await api.client.sendRequest<{ targetVersion: string }>('skout/status');
        if (status.targetVersion === '2.16.2') break;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      const folder = vscode.workspace.workspaceFolders![0].uri;
      const reportPath = vscode.Uri.joinPath(folder, '.skout', 'reports', 'test-report.md').fsPath;
      const response = await api.client.sendRequest<{
        result: { from: string; to: string; findings: { uri: string; line: number; kind: string; message: string }[] };
        markdown: string;
      }>('skout/upgrade', { skriptVersion: '2.17.1', reportPath });
      assert.equal(response.result.from, 'Skript 2.16.2');
      assert.equal(response.result.to, 'Skript 2.17.1');
      const found = response.result.findings.map((f) => `${f.kind}@${f.uri.slice(f.uri.lastIndexOf('/') + 1)}:${f.line + 1}`);
      assert.deepEqual(found, ['behaviour@shop.sk:10']);
      assert.match(response.markdown, /^# Upgrade check: Skript 2\.16\.2 → Skript 2\.17\.1/);
      assert.match(response.markdown, /\[scripts\/shop\.sk:10\]\(\.\.\/\.\.\/scripts\/shop\.sk#L10\)/);
    } finally {
      await config.update('skriptVersion', undefined, vscode.ConfigurationTarget.Workspace);
    }
  });
});
