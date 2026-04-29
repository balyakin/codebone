import { defineConfig } from 'tsup';

const common = {
  format: ['esm'] as const,
  target: 'node18',
  dts: true,
  splitting: false,
  sourcemap: true,
};

export default defineConfig([
  {
    ...common,
    entry: ['src/index.ts'],
    clean: true,
    banner: {
      js: '#!/usr/bin/env node',
    },
  },
  {
    ...common,
    entry: ['src/mcp-server.ts'],
    clean: false,
  },
]);
