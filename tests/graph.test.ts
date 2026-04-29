import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildImportGraph } from '../src/core/graph.js';
import { projectMap } from '../src/core/map.js';

describe('import/export graph', () => {
  it('resolves local TypeScript imports and reports map summary', async () => {
    const root = path.resolve('tests/fixtures/typescript-project');
    const graph = await buildImportGraph(root, '.');

    expect(graph.edges).toContainEqual(expect.objectContaining({ from: 'src/server.ts', source: './router', resolved: 'src/router.ts' }));
    expect(graph.exports.some((entry) => entry.name === 'createServer')).toBe(true);

    const map = await projectMap(root, '.');
    expect(map.graph.resolvedImports).toBeGreaterThan(0);
  });
});
