import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { skeletonDirectory } from '../src/core/directory-skeleton.js';
import { effectiveConfig } from '../src/utils/config.js';

describe('codebone config', () => {
  it('loads .codebone.json and applies include/exclude to file walking', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codebone-config-'));
    await fs.mkdir(path.join(root, 'src'));
    await fs.writeFile(path.join(root, '.codebone.json'), JSON.stringify({
      schemaVersion: 'codebone.config.v1',
      include: ['src/**/*.ts'],
      exclude: ['src/ignored.ts'],
      budgets: { maxFiles: 10 },
    }));
    await fs.writeFile(path.join(root, 'src/ignored.ts'), 'export function ignored() {}\n');
    await fs.writeFile(path.join(root, 'src/kept.ts'), 'export function kept() {}\n');
    await fs.writeFile(path.join(root, 'src/not-python.py'), 'def skipped():\n    pass\n');

    const config = await effectiveConfig(root);
    const skeletons = await skeletonDirectory(root, '.');

    expect(config.budgets.maxFiles).toBe(10);
    expect(skeletons.skeletons.map((item) => item.file)).toEqual(['src/kept.ts']);
  });

  it('applies language extension overrides', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codebone-config-ext-'));
    await fs.mkdir(path.join(root, 'src'));
    await fs.writeFile(path.join(root, '.codebone.json'), JSON.stringify({
      schemaVersion: 'codebone.config.v1',
      languages: { python: { extensions: ['.workflow'] } },
    }));
    await fs.writeFile(path.join(root, 'src/task.workflow'), 'def run():\n    pass\n');

    const skeletons = await skeletonDirectory(root, '.');

    expect(skeletons.skeletons).toHaveLength(1);
    expect(skeletons.skeletons[0].language).toBe('python');
  });
});
