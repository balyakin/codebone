import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { analyzeImpact } from '../src/core/impact.js';
import { handleMcpRequest } from '../src/mcp-server.js';

const root = path.resolve('tests/fixtures/sample-repo');

describe('impact analysis', () => {
  it('finds importedBy, references, and likely tests', async () => {
    const data = await analyzeImpact(root, 'src/billing.ts', { symbol: 'createInvoice', budget: 4000 });

    expect(data.schemaVersion).toBe('codebone.v1');
    expect(data.tokenEstimator).toBe('char-div-4');
    expect(data.importedBy).toContainEqual(expect.objectContaining({ path: 'src/index.ts' }));
    expect(data.references).toContainEqual(expect.objectContaining({ path: 'tests/billing.test.ts', symbolName: 'createInvoice' }));
    expect(data.likelyTests).toContainEqual(expect.objectContaining({ path: 'tests/billing.test.ts' }));
    expect(data.suggestedNextReads.length).toBeLessThanOrEqual(5);
  });

  it('validates mutually exclusive selectors', async () => {
    await expect(analyzeImpact(root, 'src/billing.ts', { symbol: 'createInvoice', lines: '1:2' })).rejects.toThrow(/at most one/);
  });

  it('returns typed missing-path errors', async () => {
    await expect(analyzeImpact(root, 'src/missing.ts')).rejects.toMatchObject({ code: 'PATH_NOT_FOUND' });
  });

  it('returns relationships for inheritance and overrides', async () => {
    const data = await analyzeImpact(root, 'src/relationships.ts', { symbol: 'BaseService', budget: 4000 });

    expect(data.related).toContainEqual(expect.objectContaining({ relationship: 'extends', path: 'src/relationships.ts' }));
    expect(data.related).toContainEqual(expect.objectContaining({ relationship: 'overrides', path: 'src/relationships.ts' }));
  });

  it('respects ignore rules', async () => {
    const data = await analyzeImpact(root, 'src/billing.ts', { budget: 4000 });
    const serialized = JSON.stringify(data);

    expect(serialized).not.toContain('generated.generated.ts');
  });

  it('reduces large importedBy-only results under budget without hanging', async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'codebone-impact-budget-'));
    await fs.mkdir(path.join(tempRoot, 'src'));
    await fs.writeFile(path.join(tempRoot, 'src/target.ts'), 'export const target = 1;\n');
    for (let index = 0; index < 160; index += 1) {
      await fs.writeFile(path.join(tempRoot, 'src', `importer-${index}.ts`), `import { target } from './target';\nexport const value${index} = target;\n`);
    }

    const data = await analyzeImpact(tempRoot, 'src/target.ts', { budget: 1000 });

    expect(data.importedBy.length).toBeLessThan(160);
    expect(data.truncated).toBe(true);
  });

  it('is exposed through MCP', async () => {
    const response = await handleMcpRequest(root, {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'codebone_impact', arguments: { path: 'src/billing.ts', symbol: 'createInvoice' } },
    });

    expect(response?.result).toMatchObject({ isError: false });
    expect(JSON.stringify(response)).toContain('"schemaVersion":"codebone.v1"');
  });
});
