import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { handleMcpRequest } from '../src/mcp-server.js';

const root = path.resolve('tests/fixtures/sample-repo');

describe('MCP schema compatibility', () => {
  it('exposes all public tools including impact', async () => {
    const response = await handleMcpRequest(root, { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} });
    const names = ((response?.result as { tools: Array<{ name: string }> }).tools).map((tool) => tool.name);

    expect(names).toEqual(expect.arrayContaining([
      'codebone_map',
      'codebone_skeleton',
      'codebone_symbols',
      'codebone_read',
      'codebone_context',
      'codebone_index',
      'codebone_batch',
      'codebone_doctor',
      'codebone_impact',
    ]));
  });

  it('keeps tool schemas forward-compatible for resource limits', async () => {
    const response = await handleMcpRequest(root, { jsonrpc: '2.0', id: 4, method: 'tools/list', params: {} });
    const tools = ((response?.result as { tools: Array<{ name: string; inputSchema: Record<string, unknown> }> }).tools);
    const contextTool = tools.find((tool) => tool.name === 'codebone_context');
    const batchTool = tools.find((tool) => tool.name === 'codebone_batch');

    expect(contextTool?.inputSchema).toMatchObject({
      additionalProperties: true,
      properties: expect.objectContaining({ maxFiles: expect.any(Object), maxFileBytes: expect.any(Object), timeoutMs: expect.any(Object), ignore: expect.any(Object) }),
    });
    expect(batchTool?.inputSchema).toMatchObject({ additionalProperties: true });
  });

  it('wraps successful tool results with v1 schema and token estimator', async () => {
    const response = await handleMcpRequest(root, {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: { name: 'codebone_map', arguments: { path: '.', limit: 2, offset: 0 } },
    });

    expect(response?.result).toMatchObject({
      structuredContent: {
        schemaVersion: 'codebone.v1',
        tokenEstimator: 'char-div-4',
        data: expect.objectContaining({ limit: 2, offset: 0, total: expect.any(Number), hasMore: expect.any(Boolean) }),
      },
      isError: false,
    });
  });

  it('returns typed structured errors for unknown tools', async () => {
    const response = await handleMcpRequest(root, {
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: { name: 'missing_tool', arguments: {} },
    });

    expect(response?.result).toMatchObject({
      structuredContent: { schemaVersion: 'codebone.v1', error: 'UNKNOWN_TOOL' },
      isError: true,
    });
  });
});
