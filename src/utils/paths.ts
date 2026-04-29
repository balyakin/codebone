import path from 'node:path';

export function normalizeRoot(root?: string): string {
  return path.resolve(root ?? process.cwd());
}

export function toRelative(root: string, absolutePath: string): string {
  return path.relative(root, absolutePath).split(path.sep).join('/');
}

export function resolveInsideRoot(root: string, inputPath = '.'): string {
  const absolutePath = path.resolve(root, inputPath);
  const relative = path.relative(root, absolutePath);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`Path is outside project root: ${inputPath}`);
  }
  return absolutePath;
}

export function encodeResourcePath(value: string): string {
  return encodeURIComponent(value);
}

export function decodeResourcePath(value: string): string {
  return decodeURIComponent(value);
}
