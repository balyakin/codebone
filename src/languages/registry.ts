export interface LanguageSpec {
  id: string;
  displayName: string;
  extensions: string[];
  lineComment?: string;
}

export const languages: LanguageSpec[] = [
  { id: 'typescript', displayName: 'TypeScript', extensions: ['.ts', '.tsx', '.mts', '.cts'] },
  { id: 'javascript', displayName: 'JavaScript', extensions: ['.js', '.jsx', '.mjs', '.cjs'] },
  { id: 'python', displayName: 'Python', extensions: ['.py', '.pyi'] },
  { id: 'go', displayName: 'Go', extensions: ['.go'] },
  { id: 'rust', displayName: 'Rust', extensions: ['.rs'] },
  { id: 'java', displayName: 'Java', extensions: ['.java'] },
  { id: 'cpp', displayName: 'C++', extensions: ['.cc', '.cpp', '.cxx', '.hpp', '.hh', '.hxx'] },
  { id: 'c', displayName: 'C', extensions: ['.c', '.h'] },
  { id: 'csharp', displayName: 'C#', extensions: ['.cs'] },
  { id: 'ruby', displayName: 'Ruby', extensions: ['.rb'] },
  { id: 'php', displayName: 'PHP', extensions: ['.php'] },
  { id: 'swift', displayName: 'Swift', extensions: ['.swift'] },
  { id: 'kotlin', displayName: 'Kotlin', extensions: ['.kt', '.kts'] },
  { id: 'lua', displayName: 'Lua', extensions: ['.lua'] },
];

let byExtension = buildExtensionMap(languages);

export function configureLanguageExtensions(overrides: Record<string, { extensions?: string[] }>): void {
  const configured = languages.map((language) => ({
    ...language,
    extensions: overrides[language.id]?.extensions?.length ? overrides[language.id]!.extensions! : language.extensions,
  }));
  byExtension = buildExtensionMap(configured);
}

export function languageForPath(path: string): LanguageSpec | undefined {
  const lower = path.toLowerCase();
  const ext = [...byExtension.keys()].sort((a, b) => b.length - a.length).find((candidate) => lower.endsWith(candidate));
  return ext ? byExtension.get(ext) : undefined;
}

export function isSupportedPath(path: string): boolean {
  return Boolean(languageForPath(path));
}

function buildExtensionMap(source: LanguageSpec[]): Map<string, LanguageSpec> {
  return new Map(source.flatMap((language) => language.extensions.map((ext) => [ext.toLowerCase(), language] as const)));
}
