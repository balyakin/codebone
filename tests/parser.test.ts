import fs from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { queryCaptures } from '../src/core/parser.js';

describe('tree-sitter parser adapter', () => {
  it('loads TypeScript WASM and runs codebone captures', async () => {
    const root = path.resolve('tests/fixtures/typescript-project');
    const source = await fs.readFile(path.join(root, 'src/server.ts'), 'utf8');
    const query = await fs.readFile(path.resolve('src/languages/queries/typescript.scm'), 'utf8');
    const captures = await queryCaptures('typescript', source, query);

    expect(captures.some((capture) => capture.name === 'class.name' && capture.text === 'Server')).toBe(true);
    expect(captures.some((capture) => capture.name === 'function.name' && capture.text === 'createServer')).toBe(true);
    expect(captures.some((capture) => capture.name === 'method.name' && capture.text === 'start')).toBe(true);
  });

  it.each([
    ['python', 'tests/fixtures/python-project/app.py', 'src/languages/queries/python.scm', 'class.name', 'Service'],
    ['go', 'tests/fixtures/go-project/main.go', 'src/languages/queries/go.scm', 'function.name', 'NewServer'],
    ['rust', 'tests/fixtures/rust-project/src/lib.rs', 'src/languages/queries/rust.scm', 'function.name', 'create_server'],
  ])('loads %s WASM and runs codebone captures', async (language, fixture, queryPath, captureName, text) => {
    const source = await fs.readFile(path.resolve(fixture), 'utf8');
    const query = await fs.readFile(path.resolve(queryPath), 'utf8');
    const captures = await queryCaptures(language, source, query);

    expect(captures.some((capture) => capture.name === captureName && capture.text === text)).toBe(true);
  });
});
