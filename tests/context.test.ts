import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildContext } from '../src/core/context.js';

describe('context ranking', () => {
  it('ranks goal-matching entrypoints and symbols under budget', async () => {
    const root = path.resolve('tests/fixtures/typescript-project');
    const data = await buildContext(root, { goal: 'change server create request handling', budget: 2000 });

    expect(data.items.length).toBeGreaterThan(0);
    expect(data.items[0].path).toContain('server');
    expect(data.usedTokens).toBeLessThanOrEqual(2000);
  });
});
