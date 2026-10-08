// Shared helpers for the Creation Intelligence layer.

/** Extract the first balanced JSON object/array from a model response. */
export function extractJson(text) {
  if (typeof text !== 'string') return null;
  const trimmed = text.trim();
  // Strip ```json fences.
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1].trim() : trimmed;
  const start = candidate.search(/[[{]/);
  if (start === -1) return null;
  const open = candidate[start];
  const close = open === '{' ? '}' : ']';
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = start; i < candidate.length; i++) {
    const ch = candidate[i];
    if (inString) {
      if (escape) escape = false;
      else if (ch === '\\') escape = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === open) depth++;
    else if (ch === close) {
      depth--;
      if (depth === 0) {
        try {
          return JSON.parse(candidate.slice(start, i + 1));
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

export function slugify(text, fallback = 'creation') {
  const slug = String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9\u0600-\u06ff]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  return slug || fallback;
}

export function clampText(text, max) {
  const s = String(text || '').trim();
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

export function clampNumber(v, min, max, fallback) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

/** Split a goal into sentences/clauses for lightweight analysis. */
export function sentences(text) {
  return String(text || '')
    .split(/[.!?؟\n]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

export function titleCase(text) {
  return String(text || '')
    .split(/\s+/)
    .map((w) => (w.length > 2 ? w[0].toUpperCase() + w.slice(1) : w))
    .join(' ');
}

/** A tiny, dependency-free keyword extractor (English + Arabic aware). */
export function keywords(text, limit = 8) {
  const stop = new Set([
    'the', 'a', 'an', 'and', 'or', 'for', 'with', 'to', 'of', 'in', 'on', 'at', 'by',
    'is', 'are', 'be', 'this', 'that', 'it', 'as', 'we', 'you', 'your', 'our', 'make',
    'create', 'video', 'about', 'into', 'from', 'will', 'can', 'how', 'what', 'why',
    'في', 'من', 'على', 'عن', 'الى', 'إلى', 'مع', 'هذا', 'هذه', 'التي', 'الذي', 'أن', 'او', 'أو',
  ]);
  const counts = new Map();
  for (const raw of String(text || '').toLowerCase().split(/[^\p{L}\p{N}]+/u)) {
    const w = raw.trim();
    if (!w || w.length < 3 || stop.has(w)) continue;
    counts.set(w, (counts.get(w) || 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || b[0].length - a[0].length)
    .slice(0, limit)
    .map(([w]) => w);
}

/** Call an LLM and parse a JSON response, returning null on any failure. */
export async function llmJson(llm, { model, system, user, signal, maxTokens }) {
  if (!llm || typeof llm.complete !== 'function') return null;
  try {
    const messages = [];
    if (system) messages.push({ role: 'system', content: system });
    messages.push({ role: 'user', content: user });
    const result = await llm.complete({ model, messages, signal, maxTokens });
    return extractJson(result?.text);
  } catch {
    return null;
  }
}

/** Call an LLM and return text, or null on failure. */
export async function llmText(llm, { model, system, user, signal, maxTokens }) {
  if (!llm || typeof llm.complete !== 'function') return null;
  try {
    const messages = [];
    if (system) messages.push({ role: 'system', content: system });
    messages.push({ role: 'user', content: user });
    const result = await llm.complete({ model, messages, signal, maxTokens });
    return typeof result?.text === 'string' ? result.text : null;
  } catch {
    return null;
  }
}

export function unique(list) {
  return [...new Set(list.filter(Boolean))];
}
