import { createReadStream } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { loadConfig } from './config.js';

const secretPatterns: Array<[RegExp, string]> = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, '[REDACTED_PRIVATE_KEY]'],
  [/\b((?:api|access|secret|private|auth)[_-]?key|token|password)\s*[:=]\s*['"]?[^'"\s]+/gi, '$1=[REDACTED_SECRET]'],
  [/\b[A-Za-z0-9_=-]{32,}\.[A-Za-z0-9_=-]{16,}\.[A-Za-z0-9_=-]{16,}\b/g, '[REDACTED_JWT]'],
];

export async function readTextFileSafe(absolutePath: string, maxBytes = 2_000_000, root?: string): Promise<{ text: string; warnings: string[] }> {
  const stat = await validateReadableFile(absolutePath, root);
  if (stat.size > maxBytes) throw new Error(`File too large: ${stat.size} bytes`);
  const buffer = await fs.readFile(absolutePath);
  if (isProbablyBinary(buffer)) throw new Error('Binary file is not supported');
  return { text: redactSecrets(buffer.toString('utf8')), warnings: [] };
}

export async function readTextFileLinesSafe(absolutePath: string, startLine: number, endLine: number, root?: string): Promise<{ text: string; lineCount: number; warnings: string[] }> {
  await validateReadableFile(absolutePath, root);
  const stream = createReadStream(absolutePath, { encoding: 'utf8' });
  const selected: string[] = [];
  let pending = '';
  let lineNo = 0;
  let checkedBinary = false;

  for await (const chunk of stream) {
    const text = String(chunk);
    if (!checkedBinary) {
      if (text.slice(0, 512).includes('\0')) throw new Error('Binary file is not supported');
      checkedBinary = true;
    }
    pending += text;
    const parts = pending.split(/\r?\n/);
    pending = parts.pop() ?? '';
    for (const line of parts) {
      lineNo += 1;
      if (lineNo >= startLine && lineNo <= endLine) selected.push(line);
    }
  }

  if (pending.length > 0) {
    lineNo += 1;
    if (lineNo >= startLine && lineNo <= endLine) selected.push(pending);
  }

  return { text: redactSecrets(selected.join('\n')), lineCount: lineNo, warnings: [] };
}

async function validateReadableFile(absolutePath: string, root?: string) {
  if (root && !isInside(root, absolutePath)) throw new Error('Path is outside project root');
  const linkStat = await fs.lstat(absolutePath);
  if (linkStat.isSymbolicLink()) {
    const config = root ? await loadConfig(root) : undefined;
    if (!config?.security.followSymlinks) throw new Error('Symlink is not allowed');
    const real = await fs.realpath(absolutePath);
    if (root && !isInside(root, real)) throw new Error('Symlink target is outside project root');
  }
  return fs.stat(absolutePath);
}

function isInside(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

export function redactSecrets(input: string): string {
  return secretPatterns.reduce((text, [pattern, replacement]) => text.replace(pattern, replacement), input);
}

function isProbablyBinary(buffer: Buffer): boolean {
  return buffer.subarray(0, Math.min(buffer.length, 512)).includes(0);
}
