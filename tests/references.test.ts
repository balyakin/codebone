import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { readCode } from '../src/core/reader.js';
import { findSymbols } from '../src/core/symbols.js';

describe('references and symbol suggestions', () => {
  it('uses AST references when query captures are available', async () => {
    const root = path.resolve('tests/fixtures/typescript-project');
    const data = await findSymbols(root, 'src', { query: 'handleRequest', kind: 'reference' });

    expect(data.matches).toContainEqual(expect.objectContaining({ kind: 'reference', source: 'ast', file: 'src/server.ts' }));
  });

  it('orders nearest symbol suggestions first', async () => {
    const root = path.resolve('tests/fixtures/typescript-project');

    await expect(readCode(root, 'src/server.ts', { symbol: 'Server.starts' })).rejects.toThrow(/Server\.start/);
  });
});
