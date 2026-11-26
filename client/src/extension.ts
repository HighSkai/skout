import * as path from 'node:path';
import type { ExtensionContext } from 'vscode';
import { LanguageClient, TransportKind, type LanguageClientOptions, type ServerOptions } from 'vscode-languageclient/node';

let client: LanguageClient | undefined;

/** What `activate` returns; the integration tests use it to wait for the server. */
export interface SkoutApi {
  readonly client: LanguageClient;
}

export async function activate(context: ExtensionContext): Promise<SkoutApi> {
  const serverModule = context.asAbsolutePath(path.join('dist', 'server.js'));

  const serverOptions: ServerOptions = {
    run: { module: serverModule, transport: TransportKind.ipc },
    debug: {
      module: serverModule,
      transport: TransportKind.ipc,
      options: { execArgv: ['--nolazy', '--inspect=6011'] },
    },
  };

  const clientOptions: LanguageClientOptions = {
    documentSelector: [
      { scheme: 'file', language: 'skript' },
      { scheme: 'untitled', language: 'skript' },
    ],
    outputChannelName: 'Skout',
  };

  // The id `skout` makes the client honour the `skout.trace.server` setting.
  client = new LanguageClient('skout', 'Skout', serverOptions, clientOptions);
  await client.start();
  return { client };
}

export async function deactivate(): Promise<void> {
  await client?.stop();
  client = undefined;
}
