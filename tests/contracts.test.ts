import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { readCode } from '../src/core/reader.js';
import { skeletonPath } from '../src/core/skeleton.js';

const tsRoot = path.resolve('tests/fixtures/typescript-project');

describe('public contracts', () => {
  it('returns stable skeleton contract fields and ranges', async () => {
    const data = await skeletonPath(tsRoot, 'src/server.ts');
    expect(data.schemaVersion).toBe('codebone.v1');
    expect(data.warnings).toEqual([]);
    expect(data.truncated).toBe(false);
    expect(data.tokenEstimate).toBeGreaterThan(0);

    for (const symbol of data.symbols) {
      expect(symbol.symbolId).toMatch(/^src\/server\.ts#[a-z]+:.+@\d+:\d+-\d+:\d+:[a-f0-9]{8}$/);
      expect(symbol.startLine).toBeGreaterThan(0);
      expect(symbol.endLine).toBeGreaterThanOrEqual(symbol.startLine);
      expect(symbol.endByte).toBeGreaterThanOrEqual(symbol.startByte);
    }
  });

  it('recovers read by symbolId qualified name when range hash differs', async () => {
    const data = await readCode(tsRoot, 'src/server.ts', {
      symbolId: 'src/server.ts#function:createServer@1:0-1:1:deadbeef',
    });
    expect(data.warnings).toContain('symbol_id_recovered');
    expect(data.text).toContain('return new Server(config)');
  });
});
