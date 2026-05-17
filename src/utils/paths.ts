import path from 'node:path';
import fs from 'node:fs';
import { CodeboneError } from './errors.js';

export function normalizeRoot(root?: string): string {
  const absolute = path.resolve(root ?? process.cwd());
  try {
    return fs.realpathSync.native(absolute);
  } catch {
    return absolute;
  }
}

export function toRelative(root: string, absolutePath: string): string {
  const normalizedRoot = normalizeRoot(root);
  const resolvedPath = path.resolve(absolutePath);
  return path.relative(normalizedRoot, resolvedPath).split(path.sep).join('/');
}

export function resolveInsideRoot(root: string, inputPath = '.'): string {
  const normalizedRoot = normalizeRoot(root);
  const absolutePath = path.resolve(normalizedRoot, inputPath);
  assertInsideRoot(normalizedRoot, absolutePath, inputPath);
  return absolutePath;
}

export function isInsideRoot(root: string, target: string): boolean {
  const normalizedRoot = normalizeRoot(root);
  const resolvedTarget = path.resolve(target);
  const relative = path.relative(normalizedRoot, resolvedTarget);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function assertInsideRoot(root: string, target: string, inputPath: string): void {
  if (!isInsideRoot(root, target)) {
    throw new CodeboneError('PATH_OUTSIDE_ROOT', `Path is outside project root: ${inputPath}`);
  }
}

export function encodeResourcePath(value: string): string {
  return encodeURIComponent(value);
}

export function decodeResourcePath(value: string): string {
  return decodeURIComponent(value);
}
