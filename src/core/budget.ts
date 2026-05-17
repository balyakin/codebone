export const TOKEN_ESTIMATOR = 'char-div-4';

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export function applyBudget<T>(items: T[], render: (item: T) => string, budget?: number): { items: T[]; truncated: boolean; tokenEstimate: number } {
  if (!budget || budget <= 0) {
    return { items, truncated: false, tokenEstimate: estimateTokens(items.map(render).join('\n')) };
  }
  const kept: T[] = [];
  let tokens = 0;
  for (const item of items) {
    const next = estimateTokens(render(item));
    if (kept.length > 0 && tokens + next > budget) return { items: kept, truncated: true, tokenEstimate: tokens };
    kept.push(item);
    tokens += next;
  }
  return { items: kept, truncated: false, tokenEstimate: tokens };
}
