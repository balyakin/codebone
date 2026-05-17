import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildImportGraph } from '../src/core/graph.js';
import { projectMap } from '../src/core/map.js';
import { skeletonPath } from '../src/core/skeleton.js';

describe('import/export graph', () => {
  it('resolves local TypeScript imports and reports map summary', async () => {
    const root = path.resolve('tests/fixtures/typescript-project');
    const graph = await buildImportGraph(root, '.');

    expect(graph.edges).toContainEqual(expect.objectContaining({ from: 'src/server.ts', source: './router', resolved: 'src/router.ts' }));
    expect(graph.exports.some((entry) => entry.name === 'createServer')).toBe(true);

    const map = await projectMap(root, '.');
    expect(map.graph.resolvedImports).toBeGreaterThan(0);
    expect(map.suggestedNextReads[0]).toEqual(expect.objectContaining({ tool: expect.stringMatching(/^codebone_/), args: expect.any(Object), priority: expect.any(String) }));
  });

  it('extracts and resolves Python absolute and relative local imports', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codebone-python-graph-'));
    await fs.mkdir(path.join(root, 'app/api'), { recursive: true });
    await fs.mkdir(path.join(root, 'app/dao'), { recursive: true });
    await fs.mkdir(path.join(root, 'app/tasks'), { recursive: true });
    await fs.writeFile(path.join(root, 'app/__init__.py'), '');
    await fs.writeFile(path.join(root, 'app/api/__init__.py'), '');
    await fs.writeFile(path.join(root, 'app/dao/__init__.py'), '');
    await fs.writeFile(path.join(root, 'app/tasks/__init__.py'), '');
    await fs.writeFile(path.join(root, 'app/dao/user.py'), 'class UserDao:\n    pass\n');
    await fs.writeFile(path.join(root, 'app/tasks/worker.py'), 'def run():\n    pass\n');
    await fs.writeFile(path.join(root, 'app/api/users.py'), [
      'from app.dao.user import UserDao',
      'from ..tasks import worker',
      'import app.tasks.worker',
      '',
      'class UserApi:',
      '    pass',
      '',
    ].join('\n'));

    const skeleton = await skeletonPath(root, 'app/api/users.py');
    expect(skeleton.symbols).toContainEqual(expect.objectContaining({ kind: 'import', source: 'app.dao.user' }));
    expect(skeleton.symbols).toContainEqual(expect.objectContaining({ kind: 'import', source: '..tasks' }));
    expect(skeleton.symbols).toContainEqual(expect.objectContaining({ kind: 'import', source: 'app.tasks.worker' }));

    const graph = await buildImportGraph(root, '.');
    expect(graph.edges).toContainEqual(expect.objectContaining({ from: 'app/api/users.py', source: 'app.dao.user', resolved: 'app/dao/user.py' }));
    expect(graph.edges).toContainEqual(expect.objectContaining({ from: 'app/api/users.py', source: '..tasks', resolved: 'app/tasks/__init__.py' }));
    expect(graph.edges).toContainEqual(expect.objectContaining({ from: 'app/api/users.py', source: 'app.tasks.worker', resolved: 'app/tasks/worker.py' }));
    expect(graph.summary.resolvedImports).toBe(3);
  });

  it('does not resolve Python stdlib imports to test package name collisions', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codebone-python-stdlib-'));
    await fs.mkdir(path.join(root, 'app'), { recursive: true });
    await fs.mkdir(path.join(root, 'tests/logging'), { recursive: true });
    await fs.writeFile(path.join(root, 'app/service.py'), 'import logging\n\ndef run():\n    return logging.getLogger(__name__)\n');
    await fs.writeFile(path.join(root, 'tests/logging/__init__.py'), '');

    const graph = await buildImportGraph(root, '.');

    expect(graph.edges).toContainEqual(expect.objectContaining({ from: 'app/service.py', source: 'logging', resolved: undefined }));
  });
});
