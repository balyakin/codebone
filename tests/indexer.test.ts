import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildIndex } from '../src/core/indexer.js';

describe('incremental indexer', () => {
  it('reuses unchanged shards on repeated indexing', async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'codebone-index-'));
    await writeIndexFixture(tempRoot);

    const first = await buildIndex(tempRoot, '.');
    const second = await buildIndex(tempRoot, '.');

    expect(first.incremental.updated).toBeGreaterThan(0);
    expect(second.incremental.reused).toBeGreaterThan(0);
    expect(second.symbols).toBe(first.symbols);
  });

  it('removes stale shards and reports deleted files', async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'codebone-index-delete-'));
    await writeIndexFixture(tempRoot);

    await buildIndex(tempRoot, '.');
    await fs.rm(path.join(tempRoot, 'src/router.ts'));
    const updated = await buildIndex(tempRoot, '.');

    expect(updated.incremental.deleted).toBe(1);
    expect(updated.fileMeta.map((meta) => meta.relativePath)).not.toContain('src/router.ts');
  });

  it('builds dictionaries for names, paths, exports, and imports', async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'codebone-index-dicts-'));
    await writeIndexFixture(tempRoot);

    await buildIndex(tempRoot, '.', { clear: true });
    const indexRoot = path.join(tempRoot, '.codebone/index.v1/dictionaries');
    const byName = JSON.parse(await fs.readFile(path.join(indexRoot, 'by-name.json'), 'utf8'));
    const byPath = JSON.parse(await fs.readFile(path.join(indexRoot, 'by-path.json'), 'utf8'));
    const imports = JSON.parse(await fs.readFile(path.join(indexRoot, 'imports.json'), 'utf8'));
    const exports = JSON.parse(await fs.readFile(path.join(indexRoot, 'exports.json'), 'utf8'));

    expect(byName.Server).toEqual(expect.arrayContaining([expect.stringContaining('src/server.ts#class:Server')]));
    expect(byPath['src/server.ts'].length).toBeGreaterThan(0);
    expect(imports['src/server.ts']).toContain('./router');
    expect(exports['src/server.ts'].length).toBeGreaterThan(0);
  });
});

async function writeIndexFixture(root: string): Promise<void> {
  await fs.mkdir(path.join(root, 'src'), { recursive: true });
  await fs.writeFile(path.join(root, 'src/router.ts'), [
    'export class Router {',
    '  handleRequest(path: string): string {',
    '    return path;',
    '  }',
    '}',
  ].join('\n'));
  await fs.writeFile(path.join(root, 'src/server.ts'), [
    "import { Router } from './router';",
    '',
    'export class Server {',
    '  private router: Router;',
    '',
    '  constructor() {',
    '    this.router = new Router();',
    '  }',
    '}',
  ].join('\n'));
}
