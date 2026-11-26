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
      .filter((d) => d.source === 'skout')
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
