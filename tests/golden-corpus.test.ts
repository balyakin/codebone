import fs from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { flattenSymbols, skeletonPath } from '../src/core/skeleton.js';

interface GoldenSymbol {
  kind: string;
  name: string;
  qualifiedName: string;
}

interface GoldenFile {
  fixtureRoot: string;
  file: string;
  language: string;
  expectedSymbols: GoldenSymbol[];
}

const goldenFiles = [
  'tests/golden/typescript-server.json',
  'tests/golden/python-app.json',
  'tests/golden/go-main.json',
  'tests/golden/rust-lib.json',
];

describe('golden precision/recall corpus', () => {
  it.each(goldenFiles)('matches %s', async (goldenPath) => {
    const golden = JSON.parse(await fs.readFile(path.resolve(goldenPath), 'utf8')) as GoldenFile;
    const skeleton = await skeletonPath(path.resolve(golden.fixtureRoot), golden.file);
    const actual = flattenSymbols(skeleton.symbols).map((symbol) => ({ kind: symbol.kind, name: symbol.name, qualifiedName: symbol.qualifiedName }));
    const actualKeys = new Set(actual.map(symbolKey));
    const expectedKeys = new Set(golden.expectedSymbols.map(symbolKey));
    const recalled = golden.expectedSymbols.filter((symbol) => actualKeys.has(symbolKey(symbol))).length;
    const precise = actual.filter((symbol) => expectedKeys.has(symbolKey(symbol))).length;
    const recall = recalled / golden.expectedSymbols.length;
    const precision = actual.length === 0 ? 0 : precise / actual.length;

    expect(skeleton.language).toBe(golden.language);
    expect({ actual, expected: golden.expectedSymbols, recall, precision }).toMatchSnapshot();
    expect(recall).toBeGreaterThanOrEqual(0.95);
    expect(precision).toBeGreaterThanOrEqual(0.98);
  });
});

function symbolKey(symbol: GoldenSymbol): string {
  return `${symbol.kind}:${symbol.qualifiedName}`;
}
