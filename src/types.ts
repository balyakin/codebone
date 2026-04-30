export const SCHEMA_VERSION = 'codebone.v1';

export type Format = 'text' | 'json';

export type SymbolKind =
  | 'import'
  | 'export'
  | 'class'
  | 'interface'
  | 'type'
  | 'enum'
  | 'struct'
  | 'trait'
  | 'impl'
  | 'function'
  | 'method'
  | 'property'
  | 'variable'
  | 'constant'
  | 'test'
  | 'route'
  | 'table'
  | 'dependency';

export interface Range {
  startLine: number;
  startColumn: number;
  endLine: number;
  endColumn: number;
  startByte: number;
  endByte: number;
}

export interface CodeSymbol extends Range {
  symbolId: string;
  contentHash: string;
  kind: SymbolKind;
  name: string;
  qualifiedName: string;
  signature: string;
  exported: boolean;
  confidence: 'high' | 'medium' | 'low';
  parameters?: Array<{ name: string; type?: string }>;
  returnType?: string;
  visibility?: 'public' | 'private' | 'protected';
  source?: string;
  language: string;
  file: string;
  children?: CodeSymbol[];
}

export interface SkeletonData {
  schemaVersion: typeof SCHEMA_VERSION;
  file: string;
  language: string;
  totalLines: number;
  symbols: CodeSymbol[];
  omitted?: Array<{ path: string; reason: string }>;
  warnings: string[];
  truncated: boolean;
  tokenEstimate: number;
}

export interface Envelope<T> {
  schemaVersion: typeof SCHEMA_VERSION;
  root: string;
  request: Record<string, unknown>;
  data: T;
  warnings: string[];
  truncated: boolean;
  tokenEstimate: number;
  elapsedMs: number;
}

export interface RuntimeOptions {
  root: string;
  format?: Format;
  budget?: number;
  quiet?: boolean;
  verbose?: boolean;
}

export interface FileEntry {
  absolutePath: string;
  relativePath: string;
  language: string;
  size: number;
  mtimeMs: number;
}
