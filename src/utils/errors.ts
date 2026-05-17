export type ErrorCode =
  | 'INVALID_INPUT'
  | 'CONFIG_INVALID'
  | 'CONFIG_UNKNOWN_KEY'
  | 'PATH_NOT_FOUND'
  | 'PATH_OUTSIDE_ROOT'
  | 'AMBIGUOUS_SYMBOL'
  | 'SYMBOL_NOT_FOUND'
  | 'UNSUPPORTED_FORMAT'
  | 'UNKNOWN_TOOL'
  | 'LIMIT_EXCEEDED'
  | 'TIMEOUT'
  | 'INTERNAL_ERROR';

export type WarningCode =
  | 'CONFIG_UNKNOWN_KEY'
  | 'BUDGET_TOO_SMALL'
  | 'TIMEOUT'
  | 'IMPORT_RESOLUTION_LIMITED'
  | 'PARSE_FALLBACK'
  | 'PARSE_ERROR'
  | 'TRUNCATED'
  | 'IGNORED_FILES_SKIPPED'
  | 'SYMBOL_NOT_FOUND';

export class CodeboneError extends Error {
  readonly code: ErrorCode;
  readonly details?: unknown;

  constructor(code: ErrorCode, message: string, details?: unknown) {
    super(message);
    this.name = 'CodeboneError';
    this.code = code;
    this.details = details;
  }
}

export function isCodeboneError(error: unknown): error is CodeboneError {
  return error instanceof CodeboneError;
}

export function toCodeboneError(error: unknown): CodeboneError {
  if (isCodeboneError(error)) return error;
  const message = error instanceof Error ? error.message : String(error);
  return new CodeboneError('INTERNAL_ERROR', message || 'Internal error');
}

export function warning(code: WarningCode, message: string): string {
  return `${code}:${message}`;
}
