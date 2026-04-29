export interface RankingInput {
  path: string;
  haystack: string;
  terms: string[];
  isEntrypoint?: boolean;
  isChanged?: boolean;
  isRelatedTest?: boolean;
  isLarge?: boolean;
}

export function scoreContextCandidate(input: RankingInput): { score: number; reasons: string[] } {
  const reasons: string[] = [];
  let score = input.terms.reduce((sum, term) => sum + (input.haystack.includes(term) ? 1 : 0), 0) / Math.max(1, input.terms.length);
  if (score > 0) reasons.push('goal terms match path, symbols, or imports');
  if (input.isEntrypoint) { score += 0.35; reasons.push('entrypoint'); }
  if (input.isChanged) { score += 0.35; reasons.push('changed file'); }
  if (input.isRelatedTest) { score += 0.3; reasons.push('related test proximity'); }
  if (input.isLarge) score -= 0.3;
  return { score, reasons };
}
