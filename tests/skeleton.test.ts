import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { renderDirectorySkeleton, skeletonDirectory } from '../src/core/directory-skeleton.js';
import { buildIndex } from '../src/core/indexer.js';
import { readCode } from '../src/core/reader.js';
import { flattenSymbols, skeletonPath } from '../src/core/skeleton.js';
import { findSymbols } from '../src/core/symbols.js';

const root = path.resolve('tests/fixtures/typescript-project');

describe('codebone core', () => {
  it('extracts a TypeScript skeleton', async () => {
    const data = await skeletonPath(root, 'src/server.ts');
    expect(data.language).toBe('typescript');
    expect(data.symbols.some((symbol) => symbol.kind === 'class' && symbol.name === 'Server')).toBe(true);
    expect(data.symbols.some((symbol) => symbol.kind === 'function' && symbol.name === 'createServer')).toBe(true);
  });

  it('keeps class members only as children and respects publicOnly', async () => {
    const data = await skeletonPath(root, 'src/server.ts');
    expect(data.symbols.filter((symbol) => symbol.kind === 'method' || symbol.kind === 'property')).toHaveLength(0);

    const publicOnly = await skeletonPath(root, 'src/server.ts', { publicOnly: true });
    const symbols = flattenSymbols(publicOnly.symbols);
    expect(symbols.some((symbol) => symbol.name === 'ServerConfig')).toBe(false);
    expect(symbols.some((symbol) => symbol.qualifiedName === 'Server.router')).toBe(false);
    expect(symbols.some((symbol) => symbol.qualifiedName === 'Server.start')).toBe(true);
  });

  it('finds symbol definitions and references', async () => {
    const data = await findSymbols(root, 'src', { query: 'handleRequest', fuzzy: false });
    expect(data.matches.some((match) => match.kind === 'export' || match.kind === 'definition')).toBe(true);
    expect(data.matches.some((match) => match.kind === 'reference')).toBe(true);
  });

  it('uses indexed definitions without returning export as the match kind', async () => {
    await buildIndex(root, 'src', { clear: true });
    const data = await findSymbols(root, 'src', { query: 'createServer' });
    expect(data.matches.some((match) => match.kind === 'definition' && match.symbolKind === 'function')).toBe(true);
    expect(data.matches.some((match) => match.kind === 'export')).toBe(false);
  });

  it('reads a symbol body by name', async () => {
    const data = await readCode(root, 'src/server.ts', { symbol: 'createServer' });
    expect(data.content).toContain('return new Server(config)');
  });

  it('requires an explicit read selector and validates symbolId path', async () => {
    await expect(readCode(root, 'src/server.ts', {})).rejects.toThrow(/symbol-id|symbol|lines/i);
    const router = await skeletonPath(root, 'src/router.ts');
    const routerSymbolId = flattenSymbols(router.symbols).find((symbol) => symbol.kind === 'class')?.symbolId;
    await expect(readCode(root, 'src/server.ts', { symbolId: routerSymbolId })).rejects.toThrow(/path does not match/);
  });

  it('omits imports when noImports is enabled', async () => {
    const data = await skeletonPath(root, 'src/server.ts', { noImports: true });

    expect(flattenSymbols(data.symbols).some((symbol) => symbol.kind === 'import')).toBe(false);
  });

  it('marks skeleton output as truncated when budget omits symbols', async () => {
    const data = await skeletonPath(root, 'src/server.ts', { budget: 1 });

    expect(data.truncated).toBe(true);
    expect(data.omitted?.[0]?.reason).toMatch(/budget_exceeded/);
  });

  it('keeps symbol ids stable between repeated skeleton reads', async () => {
    const first = flattenSymbols((await skeletonPath(root, 'src/server.ts')).symbols).map((symbol) => symbol.symbolId);
    const second = flattenSymbols((await skeletonPath(root, 'src/server.ts')).symbols).map((symbol) => symbol.symbolId);

    expect(second).toEqual(first);
  });

  it('extracts Python framework landmarks', async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'codebone-python-framework-'));
    await fs.mkdir(path.join(tempRoot, 'app'));
    await fs.writeFile(path.join(tempRoot, 'app/api.py'), [
      'import sqlalchemy as sa',
      'routes = web.RouteTableDef()',
      '',
      'users = sa.Table(',
      '    "users", metadata,',
      ')',
      '',
      '@routes.get("/users/{user_id}")',
      'async def rpc_get_user(request):',
      '    request.app["dao"]',
      '    return None',
      '',
    ].join('\n'));

    const skeleton = await skeletonPath(tempRoot, 'app/api.py');
    expect(skeleton.symbols).toContainEqual(expect.objectContaining({ kind: 'table', name: 'users' }));
    expect(skeleton.symbols).toContainEqual(expect.objectContaining({ kind: 'route', name: 'GET /users/{user_id}' }));
    expect(skeleton.symbols).toContainEqual(expect.objectContaining({ kind: 'dependency', name: 'dao' }));
    expect(skeleton.symbols).toContainEqual(expect.objectContaining({ kind: 'function', name: 'rpc_get_user' }));
  });

  it('renders summary mode for directory skeletons', async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'codebone-summary-'));
    await fs.mkdir(path.join(tempRoot, 'app'));
    await fs.writeFile(path.join(tempRoot, 'app/api.py'), 'class UserApi:\n    def rpc_get_user(self):\n        pass\n');

    const data = await skeletonDirectory(tempRoot, 'app', { mode: 'summary' });
    const rendered = renderDirectorySkeleton(data);

    expect(rendered).toContain('CLASS      UserApi');
    expect(rendered).toContain('METHOD   rpc_get_user');
    expect(rendered).not.toContain('IMPORT');
  });
});
