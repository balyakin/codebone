export type DiagnosticWarning = string;

export function warning(code: string, detail?: string): DiagnosticWarning {
  return detail ? `${code}:${detail}` : code;
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
