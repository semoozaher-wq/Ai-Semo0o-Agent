export function modelCost(model, usage = {}) {
  const prices = { 'gpt-5-nano': [0.05, 0.40], 'gpt-5-mini': [0.25, 2.00], 'gpt-5': [1.25, 10.00], 'gpt-5.5': [5.00, 30.00], 'gemini-3-flash-preview': [0.50, 3.00], 'gemini-3.1-pro-preview': [2.00, 12.00], 'claude-haiku-4-5': [1.00, 5.00], 'claude-sonnet-4-6': [3.00, 15.00], 'claude-opus-4-7': [5.00, 25.00] };
  const [input, output] = prices[model] ?? [0, 0];
  return ((Number(usage.promptTokens) || 0) / 1_000_000) * input + ((Number(usage.completionTokens) || 0) / 1_000_000) * output;
}
