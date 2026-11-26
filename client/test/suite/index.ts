import { join } from 'node:path';
import Mocha from 'mocha';

/** Entry point VS Code calls inside the extension host. */
export function run(): Promise<void> {
  const mocha = new Mocha({ ui: 'bdd', color: true, timeout: 30_000 });
  mocha.addFile(join(__dirname, 'extension.test.js'));
  return new Promise((resolve, reject) => {
    mocha.run((failures) => (failures > 0 ? reject(new Error(`${failures} integration test(s) failed.`)) : resolve()));
  });
}
