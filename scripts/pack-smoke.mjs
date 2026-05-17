import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const { stdout } = await execFileAsync('npm', ['pack', '--json']);
const [pack] = JSON.parse(stdout);
const tarball = path.resolve(pack.filename);
const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'codebone-pack-smoke-'));

try {
  await execFileAsync('npm', ['init', '-y'], { cwd: temp });
  await execFileAsync('npm', ['install', tarball], { cwd: temp });
  const result = await execFileAsync('npx', ['codebone', 'doctor'], { cwd: temp });
  if (!result.stdout.includes('codebone 0.2.0')) throw new Error(result.stdout);
  process.stdout.write('Pack install smoke ok\n');
} finally {
  await fs.rm(tarball, { force: true });
}
