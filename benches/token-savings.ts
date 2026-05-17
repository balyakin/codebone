import path from 'node:path';
import { buildContext } from '../src/core/context.js';
import { estimateTokens, TOKEN_ESTIMATOR } from '../src/core/budget.js';
import { walkSourceFilesDetailed } from '../src/utils/file-walker.js';
import { readTextFileSafe } from '../src/utils/security.js';
import { normalizeRoot } from '../src/utils/paths.js';

const args = parseArgs(process.argv.slice(2));
const root = normalizeRoot(args.root ?? '.');
const goal = args.goal ?? 'understand MCP server implementation';

const baseline = await baselineScan(root, goal);
const context = await buildContext(root, { goal, budget: Number(args.budget ?? 8000) });
const codeboneFiles = context.files.length;
const codeboneSymbols = context.files.reduce((sum, file) => sum + file.symbols.length, 0);
const codeboneTokens = context.tokenEstimate;
const reduction = baseline.tokens > 0 ? ((baseline.tokens - codeboneTokens) / baseline.tokens) * 100 : 0;

process.stdout.write(`Token estimator: ${TOKEN_ESTIMATOR}

| Mode | Files touched | Symbols returned | Estimated tokens | Notes |
| --- | ---: | ---: | ---: | --- |
| Baseline full-file scan | ${baseline.files} | n/a | ${baseline.tokens} | ${baseline.note} |
| codebone context pack | ${codeboneFiles} | ${codeboneSymbols} | ${codeboneTokens} | budgeted symbol-aware context |

Estimated token reduction: ${Math.max(0, reduction).toFixed(1)}%
`);

async function baselineScan(repoRoot: string, query: string): Promise<{ files: number; tokens: number; note: string }> {
  const terms = termsForGoal(query);
  const discovery = await walkSourceFilesDetailed(repoRoot, '.', { maxFiles: 10000 });
  const candidates: Array<{ path: string; text: string; score: number; size: number }> = [];
  for (const file of discovery.files) {
    try {
      const { text } = await readTextFileSafe(file.absolutePath, file.size + 1, repoRoot);
      const haystack = `${file.relativePath}\n${text}`.toLowerCase();
      const score = terms.reduce((sum, term) => sum + (haystack.includes(term) ? 1 : 0), 0);
      if (score > 0) candidates.push({ path: file.relativePath, text, score, size: file.size });
    } catch {
      // Baseline is a local scan demo; unreadable files are skipped like runtime discovery.
    }
  }
  let selected = candidates.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path)).slice(0, 12);
  let note = 'naive local scan';
  if (!selected.length) {
    selected = discovery.files.sort((a, b) => a.size - b.size || a.relativePath.localeCompare(b.relativePath)).slice(0, 5).map((file) => ({ path: file.relativePath, text: '', score: 0, size: file.size }));
    const withText = [];
    for (const item of selected) {
      const file = discovery.files.find((entry) => entry.relativePath === item.path);
      if (!file) continue;
      try {
        withText.push({ ...item, text: (await readTextFileSafe(file.absolutePath, file.size + 1, repoRoot)).text });
      } catch {
        // Keep fallback robust on tiny or odd repositories.
      }
    }
    selected = withText;
    note = 'fallback: smallest files';
  }
  return { files: selected.length, tokens: estimateTokens(selected.map((item) => `# ${item.path}\n${item.text}`).join('\n\n')), note };
}

function termsForGoal(value: string): string[] {
  const stop = new Set(['the', 'and', 'for', 'with', 'from', 'into', 'about', 'understand', 'implementation']);
  return [...new Set(value.toLowerCase().split(/[^a-z0-9_]+/).filter((term) => term.length > 2 && !stop.has(term)))];
}

function parseArgs(values: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let index = 0; index < values.length; index += 1) {
    const arg = values[index];
    if (!arg.startsWith('--')) continue;
    out[arg.slice(2)] = values[index + 1] && !values[index + 1].startsWith('--') ? values[++index] : 'true';
  }
  if (!path.isAbsolute(out.root ?? '.')) out.root = path.resolve(out.root ?? '.');
  return out;
}
