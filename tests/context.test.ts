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

  it('builds a compact Python architecture summary', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codebone-context-architecture-'));
    await fs.mkdir(path.join(root, 'app/api'), { recursive: true });
    await fs.mkdir(path.join(root, 'app/dao'), { recursive: true });
    await fs.mkdir(path.join(root, 'tests'));
    await fs.writeFile(path.join(root, 'app/dao/user.py'), 'class UserDao:\n    pass\n');
    await fs.writeFile(path.join(root, 'app/db.py'), [
      'import sqlalchemy as sa',
      'users = sa.Table(',
      '    "users", metadata,',
      ')',
      '',
    ].join('\n'));
    await fs.writeFile(path.join(root, 'app/api/users.py'), [
      'from app.dao.user import UserDao',
      'routes = web.RouteTableDef()',
      '',
      '@routes.get("/users/{user_id}")',
      'async def rpc_get_user(request):',
      '    request.app["dao"]',
      '    return None',
      '',
      'def setup(app):',
      '    app["dao"] = UserDao()',
      '    app.router.add_routes([',
      '        web.post("/rpc", rpc_get_user),',
      '    ])',
      '',
    ].join('\n'));
    await fs.writeFile(path.join(root, 'tests/__init__.py'), '');
    await fs.writeFile(path.join(root, 'tests/test_user.py'), 'from app.dao.user import UserDao\n\ndef test_user():\n    assert UserDao\n');

    const data = await buildContext(root, { goal: 'user api architecture', mode: 'architecture', budget: 1000 });
    const content = data.items[0].content;

    expect(data.mode).toBe('architecture');
    expect(content).toContain('Routes -> handlers');
    expect(content).toContain('GET /users/{user_id} -> rpc_get_user');
    expect(content).toContain('POST /rpc -> rpc_get_user');
    expect(content).toContain('RPC summary');
    expect(content).toContain('rpc_get_user');
    expect(content).toContain('App dependency graph');
    expect(content).toContain('app["dao"] created: app/api/users.py');
    expect(content).toContain('SQLAlchemy tables:\n  users');
    expect((content.match(/users \(app\/db\.py/g) ?? [])).toHaveLength(1);
    expect(content).toContain('Suggested tests');
    expect(content).not.toContain('tests/__init__.py');
  });
});
