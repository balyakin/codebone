export function objectSchema(properties: Record<string, string>, required: string[] = []) {
  return { type: 'object', properties: Object.fromEntries(Object.entries(properties).map(([key, type]) => [key, propertySchema(key, type)])), required, additionalProperties: false };
}

export function looseOutputSchema() {
  return { type: 'object', additionalProperties: true };
}

function propertySchema(key: string, type: string) {
  const schema: Record<string, unknown> = { type, description: descriptions[key] ?? key };
  if (key in defaults) schema.default = defaults[key];
  if (key in enums) schema.enum = enums[key];
  return schema;
}

const descriptions: Record<string, string> = {
  path: 'File or directory path relative to the project root.',
  budget: 'Approximate token budget for the returned context.',
  publicOnly: 'Return only exported or public symbols.',
  noImports: 'Hide import symbols.',
  maxFiles: 'Maximum number of files to scan for directory operations.',
  query: 'Symbol name or qualified name to search for.',
  kind: 'Type of symbol result to return.',
  exact: 'Require exact symbol name or qualified name matches.',
  fuzzy: 'Allow substring/fuzzy symbol matches.',
  limit: 'Maximum number of matches to return.',
  includeImports: 'Include import symbols in non-import searches.',
  symbolId: 'Stable symbol id from a skeleton or symbols response.',
  symbol: 'Symbol name to read when symbolId is unavailable.',
  lines: 'Line range in start:end form.',
  context: 'Number of surrounding lines to include.',
  maxBytes: 'Maximum file bytes to read.',
  goal: 'Task goal used to rank related files.',
  includeTests: 'Include test and spec files in context selection.',
  changedOnly: 'Only include files changed in git status.',
  clear: 'Remove the previous index before rebuilding.',
  mode: 'Output mode. Use architecture for compact Python service summaries where supported.',
  productionOnly: 'Exclude test files from context and architecture summaries.',
  testsOnly: 'Include only test files.',
  includeMocks: 'Include mock, fake, and fixture files.',
  includeConfig: 'Include configuration files.',
  includeMigrations: 'Include migration files.',
  symbolsOnly: 'Hide imports, constants, variables, and properties.',
  includePrivate: 'Include private members in filtered skeleton modes.',
  includeRoutes: 'Include route symbols in skeleton output.',
};

const defaults: Record<string, unknown> = {
  path: '.',
  budget: 12000,
  publicOnly: false,
  maxFiles: 50,
  kind: 'all',
  exact: true,
  fuzzy: false,
  limit: 100,
  includeImports: true,
  context: 0,
  maxBytes: 65536,
  includeTests: true,
  changedOnly: false,
  clear: false,
  productionOnly: false,
  testsOnly: false,
  includeMocks: false,
  includeConfig: false,
  includeMigrations: false,
};

const enums: Record<string, string[]> = {
  kind: ['all', 'definition', 'reference', 'export', 'import'],
};
