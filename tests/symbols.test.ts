import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildIndex } from '../src/core/indexer.js';
import { findSymbols } from '../src/core/symbols.js';

const root = path.resolve('tests/fixtures/typescript-project');

describe('symbols search', () => {
  it('does not return imports for definition searches', async () => {
    const data = await findSymbols(root, 'src', { query: 'Router', kind: 'definition', useIndex: false, includeImports: true });

    expect(data.matches).toContainEqual(expect.objectContaining({ kind: 'definition', symbolKind: 'class', file: 'src/router.ts' }));
    expect(data.matches.some((match) => match.kind === 'import')).toBe(false);
  });

  it('returns imports when import kind is requested', async () => {
    const data = await findSymbols(root, 'src', { query: 'Router', kind: 'import', useIndex: false });

    expect(data.matches).toContainEqual(expect.objectContaining({ kind: 'import', file: 'src/server.ts' }));
    expect(data.matches.every((match) => match.kind === 'import')).toBe(true);
  });

  it('excludes imports from all searches when includeImports is false', async () => {
    const data = await findSymbols(root, 'src', { query: 'Router', kind: 'all', useIndex: false, includeImports: false });

    expect(data.matches.some((match) => match.kind === 'import')).toBe(false);
  });

  it('uses indexed definitions for exact qualified names', async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'codebone-symbols-index-'));
    await fs.cp(root, tempRoot, { recursive: true });
    await buildIndex(tempRoot, 'src', { clear: true });

    const data = await findSymbols(tempRoot, 'src', { query: 'Server.start', kind: 'definition' });

    expect(data.matches).toHaveLength(1);
    expect(data.matches[0]).toMatchObject({ kind: 'definition', symbolKind: 'method', file: 'src/server.ts' });
  });

  it('honors limit across reference results', async () => {
    const data = await findSymbols(root, 'src', { query: 'handleRequest', kind: 'reference', limit: 1 });

    expect(data.matches).toHaveLength(1);
    expect(data.truncated).toBe(true);
  });
});
