import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildContext } from '../src/core/context.js';

describe('context ranking', () => {
  it('ranks goal-matching entrypoints and symbols under budget', async () => {
    const root = path.resolve('tests/fixtures/typescript-project');
    const data = await buildContext(root, { goal: 'change server create request handling', budget: 2000 });

    expect(data.items.length).toBeGreaterThan(0);
    expect(data.items[0].path).toContain('server');
    expect(data.usedTokens).toBeLessThanOrEqual(2000);
  });

  it('keeps returning context when oversized files are omitted', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codebone-context-large-'));
    await fs.mkdir(path.join(root, 'app'));
    await fs.writeFile(path.join(root, 'app/service.py'), 'class BillingService:\n    def charge(self):\n        return True\n');
    await fs.writeFile(path.join(root, 'app/huge.py'), 'x'.repeat(2_000_001));

    const data = await buildContext(root, { goal: 'billing charge', path: 'app', budget: 2000 });

    expect(data.items.some((item) => item.path === 'app/service.py')).toBe(true);
    expect(data.omitted).toContainEqual(expect.objectContaining({ path: 'app/huge.py', reason: 'file_too_large' }));
    expect(data.warnings.some((warning) => warning.includes('app/huge.py'))).toBe(true);
  });

  it('reports heuristic test relations', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codebone-context-tests-'));
    await fs.mkdir(path.join(root, 'app'));
    await fs.mkdir(path.join(root, 'tests'));
    await fs.writeFile(path.join(root, 'app/user_dao.py'), 'class UserDao:\n    pass\n');
    await fs.writeFile(path.join(root, 'tests/test_user_dao.py'), 'from app.user_dao import UserDao\n\ndef test_user_dao():\n    assert UserDao\n');

    const data = await buildContext(root, { goal: 'user dao', budget: 4000 });

    expect(data.testRelations).toContainEqual(expect.objectContaining({ test: 'tests/test_user_dao.py', source: 'app/user_dao.py' }));
  });
});
