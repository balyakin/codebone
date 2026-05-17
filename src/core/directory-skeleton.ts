import { walkSourceFilesDetailed } from '../utils/file-walker.js';
import { skeletonPath, renderSkeleton } from './skeleton.js';
import { estimateTokens, TOKEN_ESTIMATOR } from './budget.js';

export async function skeletonDirectory(root: string, inputPath: string, options: { maxFiles?: number; maxFileBytes?: number; budget?: number; publicOnly?: boolean; publicApiOnly?: boolean; symbolsOnly?: boolean; includePrivate?: boolean; includeRoutes?: boolean; detail?: 'rpc_api' | 'lifecycle' | 'app_dependencies' | 'public_methods'; include?: string[]; exclude?: string[]; sort?: string; changedOnly?: boolean; respectAiIgnore?: boolean; mode?: 'full' | 'summary' | 'public_api'; signatures?: boolean } = {}) {
  const discovery = await walkSourceFilesDetailed(root, inputPath, { maxFiles: options.maxFiles ?? 100, maxFileBytes: options.maxFileBytes, include: options.include, exclude: options.exclude, respectAiIgnore: options.respectAiIgnore });
  const files = sortFiles(discovery.files, options.sort ?? 'path');
  const skeletons = [];
  let used = 0;
  let truncated = false;
  for (const file of files) {
    const skeleton = await skeletonPath(root, file.relativePath, { publicOnly: options.publicOnly, publicApiOnly: options.publicApiOnly || options.mode === 'public_api', symbolsOnly: options.symbolsOnly, includePrivate: options.includePrivate, includeRoutes: options.includeRoutes, detail: options.detail, noImports: options.mode === 'public_api', budget: options.budget, signatures: options.signatures, maxFileBytes: options.maxFileBytes });
    const cost = skeleton.tokenEstimate;
    if (options.budget && skeletons.length > 0 && used + cost > options.budget) {
      truncated = true;
      break;
    }
    skeletons.push(skeleton);
    used += cost;
  }
  const warnings = [...discovery.warnings];
  if (options.changedOnly) warnings.push('IMPORT_RESOLUTION_LIMITED:changedOnly is unavailable without shelling out to git');
  return { files: skeletons.length, skeletons, mode: options.mode ?? 'full', warnings, truncated: truncated || discovery.truncated, tokenEstimate: used, tokenEstimator: TOKEN_ESTIMATOR };
}

export function renderDirectorySkeleton(data: Awaited<ReturnType<typeof skeletonDirectory>>): string {
  if (data.mode === 'summary' || data.mode === 'public_api') return renderDirectorySummary(data);
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

function sortFiles(files: Awaited<ReturnType<typeof walkSourceFilesDetailed>>['files'], mode: string) {
  if (mode === 'size') return [...files].sort((a, b) => b.size - a.size || a.relativePath.localeCompare(b.relativePath));
  if (mode === 'changed') return [...files].sort((a, b) => a.relativePath.localeCompare(b.relativePath));
  return [...files].sort((a, b) => a.relativePath.localeCompare(b.relativePath));
}
