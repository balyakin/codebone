import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { buildContext } from '../src/core/context.js';
import { buildIndex } from '../src/core/indexer.js';
import { projectMap } from '../src/core/map.js';
import { readCode } from '../src/core/reader.js';
import { renderSkeleton, skeletonPath } from '../src/core/skeleton.js';

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codebone-bench-'));
await fs.mkdir(path.join(root, 'src'));
const file = 'src/server.ts';
await fs.writeFile(path.join(root, file), `
import { Router } from './router';

export class Server {
  private router: Router;

  constructor(router: Router) {
    this.router = router;
  }

  async start(): Promise<void> {
${Array.from({ length: 80 }, (_, index) => `    await this.router.handleRequest('/${index}');`).join('\n')}
  }
}

export function createServer(router: Router): Server {
${Array.from({ length: 30 }, () => '  const server = new Server(router);').join('\n')}
  return new Server(router);
}
`);
await fs.writeFile(path.join(root, 'src/router.ts'), 'export class Router { async handleRequest(path: string): Promise<string> { return path; } }\n');
for (let index = 0; index < 150; index += 1) {
  await fs.writeFile(path.join(root, 'src', `feature-${index}.ts`), `import { Router } from './router';\nexport function feature${index}(router: Router): Promise<string> {\n  return router.handleRequest('/feature-${index}');\n}\n`);
}

const skeleton = await measure('skeleton file', 750, () => skeletonPath(root, file));
await measure('read symbol', 150, () => readCode(root, file, { symbol: 'createServer' }));
await measure('context pack', 8000, () => buildContext(root, { goal: 'server request handling', budget: 4000 }));
await measure('project map 150 files', 3500, () => projectMap(root, '.', 1200));
await measure('index 150 files', 4000, () => buildIndex(root, '.'));

const fullSource = await fs.readFile(path.join(root, file), 'utf8');
const compression = fullSource.length / Math.max(1, renderSkeleton(skeleton.result).length);
if (compression < 1.2) throw new Error(`Token compression smoke failed: ${compression.toFixed(2)}x`);

process.stdout.write(`Smoke benchmarks ok\n  files: 152\n  skeleton: ${skeleton.elapsedMs.toFixed(1)}ms\n  compression: ${compression.toFixed(2)}x\n`);

async function measure<T>(name: string, maxMs: number, fn: () => Promise<T>): Promise<{ result: T; elapsedMs: number }> {
  const started = performance.now();
  const result = await fn();
  const elapsedMs = performance.now() - started;
  if (elapsedMs > maxMs) throw new Error(`${name} SLO failed: ${elapsedMs.toFixed(1)}ms > ${maxMs}ms`);
  return { result, elapsedMs };
}
