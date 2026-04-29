import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { handleMcpRequest } from '../src/mcp-server.js';

const root = path.resolve('tests/fixtures/typescript-project');

describe('MCP protocol compatibility smoke', () => {
  it('initializes and lists tools/resources/prompts', async () => {
    const initialize = await handleMcpRequest(root, { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
    expect(initialize?.result).toMatchObject({ serverInfo: { name: 'codebone' } });

    const tools = await handleMcpRequest(root, { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
    expect(JSON.stringify(tools)).toContain('codebone_skeleton');

    const resources = await handleMcpRequest(root, { jsonrpc: '2.0', id: 3, method: 'resources/list', params: {} });
    expect(JSON.stringify(resources)).toContain('codebone://project/map');

    const prompts = await handleMcpRequest(root, { jsonrpc: '2.0', id: 4, method: 'prompts/list', params: {} });
    expect(JSON.stringify(prompts)).toContain('codebone_explore_before_edit');
  });

  it('executes a structured tool call', async () => {
    const response = await handleMcpRequest(root, {
      jsonrpc: '2.0',
      id: 5,
      method: 'tools/call',
      params: { name: 'codebone_skeleton', arguments: { path: 'src/server.ts' } },
    });
    expect(JSON.stringify(response)).toContain('structuredContent');
    expect(JSON.stringify(response)).toContain('createServer');
  });

  it('advertises skeleton schema without non-contract noImports option', async () => {
    const response = await handleMcpRequest(root, { jsonrpc: '2.0', id: 6, method: 'tools/list', params: {} });
    const tools = (response?.result as { tools: Array<{ name: string; inputSchema: { properties: Record<string, unknown> } }> }).tools;
    const skeleton = tools.find((tool) => tool.name === 'codebone_skeleton');

    expect(skeleton?.inputSchema.properties).not.toHaveProperty('noImports');
    expect(skeleton?.inputSchema.properties).toHaveProperty('publicOnly');
  });

  it('returns errors for unknown tools as tool results', async () => {
    const response = await handleMcpRequest(root, {
      jsonrpc: '2.0',
      id: 7,
      method: 'tools/call',
      params: { name: 'codebone_missing', arguments: {} },
    });

    expect(response?.result).toMatchObject({ isError: true });
    expect(JSON.stringify(response)).toContain('Unknown tool');
  });
});
