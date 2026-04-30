import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { walkSourceFiles } from '../utils/file-walker.js';
import { skeletonPath, renderSkeleton } from './skeleton.js';
import { estimateTokens } from './budget.js';

const execFileAsync = promisify(execFile);

export async function skeletonDirectory(root: string, inputPath: string, options: { maxFiles?: number; budget?: number; publicOnly?: boolean; include?: string[]; exclude?: string[]; sort?: string; changedOnly?: boolean; respectAiIgnore?: boolean; mode?: 'full' | 'summary' } = {}) {
  const files = await sortFiles(root, await walkSourceFiles(root, inputPath, { maxFiles: options.maxFiles ?? 100, include: options.include, exclude: options.exclude, respectAiIgnore: options.respectAiIgnore }), options.sort ?? 'path', Boolean(options.changedOnly));
  const skeletons = [];
  let used = 0;
  let truncated = false;
  for (const file of files) {
    const skeleton = await skeletonPath(root, file.relativePath, { publicOnly: options.publicOnly, budget: options.budget });
    const cost = skeleton.tokenEstimate;
    if (options.budget && skeletons.length > 0 && used + cost > options.budget) {
      truncated = true;
      break;
    }
    skeletons.push(skeleton);
    used += cost;
  }
  return { files: skeletons.length, skeletons, mode: options.mode ?? 'full', warnings: [], truncated: truncated || files.length >= (options.maxFiles ?? 100), tokenEstimate: used };
}

export function renderDirectorySkeleton(data: Awaited<ReturnType<typeof skeletonDirectory>>): string {
  if (data.mode === 'summary') return renderDirectorySummary(data);
  return data.skeletons.map((skeleton) => {
    const hidden = Math.max(0, estimateTokens('x'.repeat(skeleton.totalLines * 80)) - skeleton.tokenEstimate);
    const rendered = renderSkeleton(skeleton);
    const body = rendered.includes('\n\n') ? rendered.slice(rendered.indexOf('\n\n') + 2) : '';
    return `═══ ${skeleton.file} (${skeleton.totalLines} lines, ~${hidden} tokens hidden) ═══${body ? `\n${body}` : ''}`;
  }).join('\n\n');
}

function renderDirectorySummary(data: Awaited<ReturnType<typeof skeletonDirectory>>): string {
  return data.skeletons.map((skeleton) => {
    const lines = [`═══ ${skeleton.file} (${skeleton.totalLines} lines) ═══`];
    for (const symbol of skeleton.symbols) {
      if (symbol.kind === 'import' || symbol.kind === 'variable' || symbol.kind === 'constant' || symbol.kind === 'property') continue;
      lines.push(`${String(symbol.startLine).padStart(4)}  ${symbol.kind.toUpperCase().padEnd(10)} ${symbol.qualifiedName}`);
      for (const child of symbol.children ?? []) {
        if (child.visibility === 'private' && !child.name.startsWith('rpc_')) continue;
        lines.push(`${String(child.startLine).padStart(4)}    ${child.kind.toUpperCase().padEnd(8)} ${child.name}`);
      }
    }
    return lines.join('\n');
  }).join('\n\n');
}

async function sortFiles(root: string, files: Awaited<ReturnType<typeof walkSourceFiles>>, mode: string, changedOnly: boolean) {
  if (changedOnly) {
    const changed = await getChangedFiles(root);
    return files.filter((file) => changed.has(file.relativePath)).sort((a, b) => a.relativePath.localeCompare(b.relativePath));
  }
  if (mode === 'size') return [...files].sort((a, b) => b.size - a.size || a.relativePath.localeCompare(b.relativePath));
  if (mode === 'changed') {
    const changed = await getChangedFiles(root);
    return [...files].sort((a, b) => Number(changed.has(b.relativePath)) - Number(changed.has(a.relativePath)) || a.relativePath.localeCompare(b.relativePath));
  }
  return [...files].sort((a, b) => a.relativePath.localeCompare(b.relativePath));
}

async function getChangedFiles(root: string): Promise<Set<string>> {
  try {
    const { stdout } = await execFileAsync('git', ['status', '--short', '--untracked-files=all'], { cwd: root, timeout: 2000 });
    return new Set(stdout.split('\n').map((line) => line.slice(3).trim()).filter(Boolean).map((file) => file.replace(/\\/g, '/')));
  } catch {
    return new Set();
  }
}
