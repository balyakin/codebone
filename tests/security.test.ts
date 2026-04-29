import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { skeletonDirectory } from '../src/core/directory-skeleton.js';
import { readCode } from '../src/core/reader.js';
import { handleMcpRequest } from '../src/mcp-server.js';

describe('security guards', () => {
  it('redacts secrets from read output', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codebone-security-'));
    await fs.mkdir(path.join(root, 'src'));
    await fs.writeFile(path.join(root, 'src/secret.ts'), 'export const token = "super-secret-token-value-1234567890";\n');

    const data = await readCode(root, 'src/secret.ts', { lines: '1:1' });
    expect(data.text).toContain('[REDACTED_SECRET]');
    expect(data.text).not.toContain('super-secret-token-value');
  });

  it('redacts env, pem, and jwt-like secrets', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codebone-redact-'));
    await fs.mkdir(path.join(root, 'src'));
    await fs.writeFile(path.join(root, 'src/secrets.ts'), [
      'export const password = "hunter2";',
      'export const jwt = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.bbbbbbbbbbbbbbbbbbbb.cccccccccccccccccccc";',
      'export const pem = `-----BEGIN PRIVATE KEY-----\\nabc\\n-----END PRIVATE KEY-----`;',
    ].join('\n'));

    const data = await readCode(root, 'src/secrets.ts', { lines: '1:3', maxBytes: 10000 });

    expect(data.text).toContain('[REDACTED_SECRET]');
    expect(data.text).toContain('[REDACTED_JWT]');
    expect(data.text).toContain('[REDACTED_PRIVATE_KEY]');
    expect(data.text).not.toContain('hunter2');
  });

  it('rejects symlink reads by default', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codebone-symlink-'));
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'codebone-outside-'));
    await fs.writeFile(path.join(outside, 'outside.ts'), 'export function outside() {}\n');
    await fs.symlink(path.join(outside, 'outside.ts'), path.join(root, 'linked.ts'));

    await expect(readCode(root, 'linked.ts', { lines: '1:1' })).rejects.toThrow(/Symlink is not allowed/);
  });

  it('returns MCP errors for root jail violations', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codebone-mcp-jail-'));
    const response = await handleMcpRequest(root, {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'codebone_read', arguments: { path: '../outside.ts', lines: '1:1' } },
    });

    expect(response?.result).toMatchObject({ isError: true });
    expect(JSON.stringify(response)).toContain('outside project root');
  });

  it('respects codebone ignore files during directory skeleton', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codebone-ignore-'));
    await fs.mkdir(path.join(root, 'src'));
    await fs.writeFile(path.join(root, '.codeboneignore'), 'src/ignored.ts\n');
    await fs.writeFile(path.join(root, 'src/ignored.ts'), 'export function ignored() {}\n');
    await fs.writeFile(path.join(root, 'src/kept.ts'), 'export function kept() {}\n');

    const data = await skeletonDirectory(root, '.');
    expect(data.skeletons.map((item) => item.file)).toEqual(['src/kept.ts']);
  });

  it('respects gitignore negation patterns', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codebone-gitignore-'));
    await fs.mkdir(path.join(root, 'src'));
    await fs.writeFile(path.join(root, '.gitignore'), 'src/*.ts\n!src/kept.ts\n');
    await fs.writeFile(path.join(root, 'src/ignored.ts'), 'export function ignored() {}\n');
    await fs.writeFile(path.join(root, 'src/kept.ts'), 'export function kept() {}\n');

    const data = await skeletonDirectory(root, '.');
    expect(data.skeletons.map((item) => item.file)).toEqual(['src/kept.ts']);
  });

  it('truncates read output by utf8 bytes without splitting characters', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codebone-utf8-'));
    await fs.mkdir(path.join(root, 'src'));
    await fs.writeFile(path.join(root, 'src/text.ts'), 'export const text = "привет мир";\n');

    const data = await readCode(root, 'src/text.ts', { lines: '1:1', maxBytes: 44 });
    expect(Buffer.byteLength(data.text)).toBeLessThanOrEqual(44);
    expect(data.text).not.toContain('\uFFFD');
    expect(data.truncated).toBe(true);
  });
});
