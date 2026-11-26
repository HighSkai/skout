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

describe('Skout extension', () => {
  before(async () => {
    const extension = vscode.extensions.getExtension(EXTENSION_ID);
    assert.ok(extension, `${EXTENSION_ID} should be installed`);
    await extension.activate();
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
