import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { walkSourceFilesDetailed } from '../src/utils/file-walker.js';
import { cacheStats, clearRuntimeCache } from '../src/utils/runtime-cache.js';

describe('file discovery', () => {
  it('caches discovery results and invalidates them when a visited directory changes', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codebone-walk-cache-'));
    await fs.mkdir(path.join(root, 'src'));
    await fs.writeFile(path.join(root, 'src/a.ts'), 'export const a = 1;\n');
    clearRuntimeCache();

    const first = await walkSourceFilesDetailed(root, '.');
    const cachedEntries = cacheStats().entries;
    const second = await walkSourceFilesDetailed(root, '.');

    expect(first.files.map((file) => file.relativePath)).toEqual(['src/a.ts']);
    expect(second.files.map((file) => file.relativePath)).toEqual(['src/a.ts']);
    expect(cachedEntries).toBeGreaterThan(0);
    expect(cacheStats().entries).toBe(cachedEntries);

    await fs.writeFile(path.join(root, 'src/b.ts'), 'export const b = 2;\n');
    const now = new Date();
    await fs.utimes(path.join(root, 'src'), now, now);
    const updated = await walkSourceFilesDetailed(root, '.');

    expect(updated.files.map((file) => file.relativePath)).toEqual(['src/a.ts', 'src/b.ts']);
  });
});
