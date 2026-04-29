import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { skeletonPath } from '../src/core/skeleton.js';

describe('language skeleton golden coverage', () => {
  it.each([
    [path.resolve('tests/fixtures/typescript-project'), 'src/server.ts', ['Server', 'createServer']],
    [path.resolve('tests/fixtures/python-project'), 'app.py', ['Service', 'create_service']],
    [path.resolve('tests/fixtures/go-project'), 'main.go', ['Server', 'NewServer']],
    [path.resolve('tests/fixtures/rust-project'), 'src/lib.rs', ['Server', 'create_server']],
  ])('extracts expected symbols from %s/%s', async (root, file, expected) => {
    const data = await skeletonPath(root, file);
    const names = data.symbols.map((symbol) => symbol.name);
    for (const name of expected) expect(names).toContain(name);
  });
});
