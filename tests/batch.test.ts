import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { runBatch } from '../src/core/batch.js';

const root = path.resolve('tests/fixtures/typescript-project');

describe('batch', () => {
  it('accepts codebone tool names and explains invalid operation shapes', async () => {
    const ok = await runBatch(root, [{ tool: 'codebone_skeleton', path: 'src/server.ts', mode: 'public_api' }]);
    expect(ok.results[0]).toEqual(expect.objectContaining({ success: true, op: 'skeleton' }));

    const bad = await runBatch(root, [{ tool: 'unknown_tool' }]);
    expect(bad.results[0]).toEqual(expect.objectContaining({ success: false }));
    expect(String((bad.results[0] as { error?: string }).error)).toContain('Expected operation shape');
    expect(bad.results[0]).toEqual(expect.objectContaining({ errorCode: 'UNKNOWN_TOOL' }));
  });
});
