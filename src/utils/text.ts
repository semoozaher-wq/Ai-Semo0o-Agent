export function slugify(input: string): string {
  return input
    .toLowerCase()
    .trim()
    .replace(/[^\w\u0600-\u06FF\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-');
}

export function tokenize(input: string): string[] {
  return input
    .toLowerCase()
    .replace(/[^\w\u0600-\u06FF\s]/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
}

/** Very rough token estimate (≈4 chars/token for latin, ≈2 for CJK/Arabic). */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  const arabic = (text.match(/[\u0600-\u06FF]/g) || []).length;
  const rest = text.length - arabic;
  return Math.ceil(arabic / 2 + rest / 4);
}

export function highlightRanges(
  text: string,
  query: string,
): { text: string; match: boolean }[] {
  if (!query.trim()) return [{ text, match: false }];
  const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // `split` needs the global flag, but a global regex is stateful: calling
  // `.test()` on it advances `lastIndex`, which would mis-flag consecutive
  // matches (e.g. highlightRanges('abab', 'ab')). Use a separate, anchored,
  // non-global matcher so every segment is tested independently.
  const splitter = new RegExp(`(${escaped})`, 'gi');
  const matcher = new RegExp(`^${escaped}$`, 'i');
  return text
    .split(splitter)
    .filter((part) => part.length > 0)
    .map((part) => ({ text: part, match: matcher.test(part) }));
}

export function stripMarkdown(input: string): string {
  return input
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[*_~#>]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export function titleFromPrompt(prompt: string, max = 48): string {
  const clean = stripMarkdown(prompt).trim();
  if (!clean) return 'محادثة جديدة';
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}
