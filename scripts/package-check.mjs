import fs from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const packageJson = JSON.parse(await fs.readFile('package.json', 'utf8'));
const forbiddenScripts = ['preinstall', 'install', 'postinstall'];
const missingForbidden = forbiddenScripts.filter((name) => packageJson.scripts?.[name]);
if (missingForbidden.length) throw new Error(`Forbidden lifecycle scripts: ${missingForbidden.join(', ')}`);

for (const file of [
  'src/languages/queries/typescript.scm',
  'src/languages/queries/python.scm',
  'src/languages/queries/go.scm',
  'src/languages/queries/rust.scm',
  'src/languages/wasm/tree-sitter-typescript.wasm',
  'src/languages/wasm/tree-sitter-tsx.wasm',
  'src/languages/wasm/tree-sitter-python.wasm',
  'src/languages/wasm/tree-sitter-go.wasm',
  'src/languages/wasm/tree-sitter-rust.wasm',
]) {
  await fs.access(file);
}

const { stdout } = await execFileAsync('npm', ['pack', '--dry-run', '--json']);
const [pack] = JSON.parse(stdout);
const unpackedSize = Number(pack.unpackedSize ?? 0);
const budgetBytes = 20 * 1024 * 1024;
if (unpackedSize > budgetBytes) throw new Error(`Package unpacked size ${unpackedSize} exceeds ${budgetBytes}`);

process.stdout.write('Package check ok\n');
