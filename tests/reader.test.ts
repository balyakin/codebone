import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { readCode } from '../src/core/reader.js';
import { flattenSymbols, skeletonPath } from '../src/core/skeleton.js';

const root = path.resolve('tests/fixtures/typescript-project');

describe('reader', () => {
  it('reads a class method by exact short name', async () => {
    const data = await readCode(root, 'src/server.ts', { symbol: 'start' });

    expect(data.label).toContain('method Server.start');
    expect(data.content).toContain('this.router.handleRequest');
  });

  it('reads a symbol with surrounding context lines', async () => {
    const data = await readCode(root, 'src/server.ts', { symbol: 'createServer', context: 1 });

    expect(data.startLine).toBe(18);
    expect(data.endLine).toBe(22);
    expect(data.content).toContain('export function createServer');
  });

  it('rejects partial symbol names instead of fuzzy substring matching', async () => {
    await expect(readCode(root, 'src/server.ts', { symbol: 'art' })).rejects.toThrow(/not found/);
  });

  it('reads by a current symbolId without recovery warnings', async () => {
    const skeleton = await skeletonPath(root, 'src/server.ts');
    const symbolId = flattenSymbols(skeleton.symbols).find((symbol) => symbol.qualifiedName === 'Server.start')?.symbolId;

    const data = await readCode(root, 'src/server.ts', { symbolId });

    expect(data.symbolId).toBe(symbolId);
    expect(data.warnings).not.toContain('symbol_id_recovered');
  });

  it('validates line ranges against file length', async () => {
    await expect(readCode(root, 'src/server.ts', { lines: '20:19' })).rejects.toThrow(/Invalid line range/);
    await expect(readCode(root, 'src/server.ts', { lines: '1:999' })).rejects.toThrow(/Invalid line range/);
  });

  it('preserves complete unicode characters when truncating formatted output', async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'codebone-reader-'));
    await fs.mkdir(path.join(tempRoot, 'src'));
    await fs.writeFile(path.join(tempRoot, 'src/unicode.ts'), 'export const message = "Привет мир";\n');

    const data = await readCode(tempRoot, 'src/unicode.ts', { lines: '1:1', maxBytes: 47 });

    expect(data.truncated).toBe(true);
    expect(Buffer.byteLength(data.content)).toBeLessThanOrEqual(47);
    expect(data.content).not.toContain('\uFFFD');
  });
});
