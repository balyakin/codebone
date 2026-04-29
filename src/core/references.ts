import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { languageForPath } from '../languages/registry.js';
import { queryCaptures } from './parser.js';

export interface ReferenceMatch {
  kind: 'reference';
  file: string;
  line: number;
  column: number;
  symbolKind: 'reference';
  context: string;
  source: 'ast' | 'text';
}

export async function findReferencesInSource(relativePath: string, source: string, query: string, limit: number): Promise<ReferenceMatch[]> {
  const astMatches = await findAstReferences(relativePath, source, query, limit);
  if (astMatches.length > 0) return astMatches;
  return findTextReferences(relativePath, source, query, limit);
}

async function findAstReferences(relativePath: string, source: string, query: string, limit: number): Promise<ReferenceMatch[]> {
  const language = languageForPath(relativePath)?.id;
  if (!language) return [];
  try {
    const querySource = await readQuery(language);
    const captures = await queryCaptures(language, source, querySource);
    return captures
      .filter((capture) => capture.name === 'reference' && capture.text === query)
      .slice(0, limit)
      .map((capture) => ({ kind: 'reference', file: relativePath, line: capture.startLine, column: capture.startColumn, symbolKind: 'reference', context: lineAt(source, capture.startLine), source: 'ast' }));
  } catch {
    return [];
  }
}

function findTextReferences(relativePath: string, source: string, query: string, limit: number): ReferenceMatch[] {
  const lines = source.split(/\r?\n/);
  const re = new RegExp(`\\b${escapeRegex(query)}\\b`);
  const matches: ReferenceMatch[] = [];
  lines.forEach((line, index) => {
    if (matches.length >= limit) return;
    const column = line.search(re);
    if (column >= 0 && !/^\s*(import|from|export|function|class|interface|type|enum|def|func|fn)\b/.test(line)) {
      matches.push({ kind: 'reference', file: relativePath, line: index + 1, column, symbolKind: 'reference', context: line.trim(), source: 'text' });
    }
  });
  return matches;
}

async function readQuery(language: string): Promise<string> {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.resolve(here, '../languages/queries', `${language}.scm`),
    path.resolve(here, '../src/languages/queries', `${language}.scm`),
  ];
  for (const candidate of candidates) {
    try {
      return await fs.readFile(candidate, 'utf8');
    } catch {
      // Try next package layout.
    }
  }
  throw new Error(`Query not found for ${language}`);
}

function lineAt(source: string, line: number): string {
  return source.split(/\r?\n/)[line - 1]?.trim() ?? '';
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
