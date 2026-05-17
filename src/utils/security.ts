import { createReadStream } from 'node:fs';
import fs from 'node:fs/promises';
import { loadConfig } from './config.js';
import { CodeboneError } from './errors.js';
import { cachedValue } from './runtime-cache.js';
import { isInsideRoot } from './paths.js';

const secretPatterns: Array<[RegExp, string]> = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, '[REDACTED_PRIVATE_KEY]'],
  [/\b((?:api|access|secret|private|auth)[_-]?key|token|password)\s*[:=]\s*['"]?[^'"\s]+/gi, '$1=[REDACTED_SECRET]'],
  [/\b[A-Za-z0-9_=-]{32,}\.[A-Za-z0-9_=-]{16,}\.[A-Za-z0-9_=-]{16,}\b/g, '[REDACTED_JWT]'],
];

export async function readTextFileSafe(absolutePath: string, maxBytes = 2_000_000, root?: string): Promise<{ text: string; warnings: string[] }> {
  const stat = await validateReadableFile(absolutePath, root);
  if (stat.size > maxBytes) throw new CodeboneError('LIMIT_EXCEEDED', `File too large: ${stat.size} bytes`);
  if (await filePrefixLooksBinary(absolutePath)) throw new CodeboneError('UNSUPPORTED_FORMAT', 'Binary file is not supported');
  const cacheKey = `read:${absolutePath}:${stat.mtimeMs}:${stat.size}:${maxBytes}`;
  const buffer = root
    ? await cachedValue(root, cacheKey, Math.min(stat.size, maxBytes), () => fs.readFile(absolutePath))
    : await fs.readFile(absolutePath);
  if (isProbablyBinary(buffer)) throw new CodeboneError('UNSUPPORTED_FORMAT', 'Binary file is not supported');
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
      if (text.slice(0, 8192).includes('\0')) throw new CodeboneError('UNSUPPORTED_FORMAT', 'Binary file is not supported');
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
  if (root && !isInsideRoot(root, absolutePath)) throw new CodeboneError('PATH_OUTSIDE_ROOT', 'Path is outside project root');
  let linkStat;
  try {
    linkStat = await fs.lstat(absolutePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new CodeboneError('PATH_NOT_FOUND', `Path not found: ${absolutePath}`);
    if (isPermissionError(error)) throw new CodeboneError('INVALID_INPUT', `File is not readable: ${absolutePath}`);
    throw error;
  }
  if (linkStat.isSymbolicLink()) {
    const config = root ? await loadConfig(root) : undefined;
    if (!config?.security.followSymlinks) throw new CodeboneError('INVALID_INPUT', 'Symlink is not allowed');
    const real = await fs.realpath(absolutePath);
    if (root && !isInsideRoot(root, real)) throw new CodeboneError('PATH_OUTSIDE_ROOT', 'Symlink target is outside project root');
  }
  try {
    return await fs.stat(absolutePath);
  } catch (error) {
    if (isPermissionError(error)) throw new CodeboneError('INVALID_INPUT', `File is not readable: ${absolutePath}`);
    throw error;
  }
}

export function redactSecrets(input: string): string {
  return secretPatterns.reduce((text, [pattern, replacement]) => text.replace(pattern, replacement), input);
}

function isProbablyBinary(buffer: Buffer): boolean {
  return buffer.subarray(0, Math.min(buffer.length, 8192)).includes(0);
}

async function filePrefixLooksBinary(absolutePath: string): Promise<boolean> {
  let handle;
  try {
    handle = await fs.open(absolutePath, 'r');
  } catch (error) {
    if (isPermissionError(error)) throw new CodeboneError('INVALID_INPUT', `File is not readable: ${absolutePath}`);
    throw error;
  }
  try {
    const buffer = Buffer.alloc(8192);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    return buffer.subarray(0, bytesRead).includes(0);
  } finally {
    await handle.close();
  }
}

function isPermissionError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code;
  return code === 'EACCES' || code === 'EPERM';
}
