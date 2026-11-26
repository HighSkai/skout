/**
 * Launches VS Code with Skout loaded from this folder and opens test-workspace/.
 *
 * Uses the VS Code installed on this machine when it can find one, so the test
 * runs offline. Set VSCODE_EXECUTABLE to choose another build; if neither is
 * found, @vscode/test-electron downloads a stable build (CI does this).
 */
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { runTests } from '@vscode/test-electron';

function localVSCode(): string | undefined {
  if (process.env.VSCODE_EXECUTABLE) return process.env.VSCODE_EXECUTABLE;
  const candidates =
    process.platform === 'win32'
      ? [join(process.env.LOCALAPPDATA ?? '', 'Programs', 'Microsoft VS Code', 'Code.exe'), 'C:\\Program Files\\Microsoft VS Code\\Code.exe']
      : process.platform === 'darwin'
        ? ['/Applications/Visual Studio Code.app/Contents/MacOS/Electron']
        : ['/usr/share/code/code', '/usr/bin/code'];
  return candidates.find((path) => existsSync(path));
}

async function main(): Promise<void> {
  const root = resolve(__dirname, '..', '..');
  const vscodeExecutablePath = process.env.CI ? undefined : localVSCode();
  try {
    await runTests({
      vscodeExecutablePath,
      extensionDevelopmentPath: root,
      extensionTestsPath: join(root, 'dist', 'test', 'suite', 'index.js'),
      launchArgs: [
        join(root, 'test-workspace'),
        '--disable-extensions',
        '--disable-workspace-trust',
        '--skip-welcome',
        '--skip-release-notes',
        `--user-data-dir=${join(root, '.vscode-test', 'user-data')}`,
        `--extensions-dir=${join(root, '.vscode-test', 'extensions')}`,
      ],
    });
  } catch (error) {
    console.error('Integration tests failed:', error);
    process.exit(1);
  }
}

void main();
