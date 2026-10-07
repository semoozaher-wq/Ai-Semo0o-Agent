/**
 * phase2-core/reasoning.mjs — Deep Codebase Reasoning.
 *
 * A reasoning layer over the project index produced by `buildProjectIntelligence`
 * (platform.mjs). It answers structural questions about the codebase — where a
 * symbol is defined, who references it, how one file reaches another through the
 * import graph, and free-form "explain" questions — using only the index plus an
 * optional file reader for lexical reference scanning.
 *
 * It deliberately does NOT re-index anything: `CodebaseReasoner.from(root)` builds
 * the index with the existing `buildProjectIntelligence` and then reasons over it.
 * When no reader is supplied, references are structural only (honest: no invented
 * line numbers). When a reader is supplied, lexical matches are added with real
 * line numbers.
 */

import { buildProjectIntelligence } from './platform.mjs';
import { buildForwardGraph, buildReverseGraph, normalizePath } from './impact.mjs';

const identifierPattern = /[A-Za-z_$][\w$]*/g;

// Common English words that appear in questions but are never code identifiers.
const STOPWORDS = new Set([
  'where', 'is', 'are', 'the', 'a', 'an', 'of', 'in', 'on', 'for', 'to', 'from', 'at', 'by',
  'what', 'who', 'whom', 'which', 'how', 'does', 'do', 'did', 'can', 'could', 'would',
  'defined', 'define', 'declared', 'declaration', 'definition', 'defines',
  'uses', 'use', 'used', 'calls', 'call', 'called', 'references', 'reference', 'referenced', 'usages', 'callers',
  'explain', 'describe', 'tell', 'me', 'about', 'structure', 'overview', 'show', 'list',
  'and', 'or', 'not', 'with', 'this', 'that', 'these', 'those', 'it', 'its', 'i',
  'path', 'reach', 'reaches', 'gets', 'get', 'goes', 'go', 'depends', 'depend', 'dependencies', 'dependency',
]);

function tokenize(text) {
  return String(text ?? '').match(identifierPattern) ?? [];
}

function contentTokens(text) {
  return tokenize(text).filter((token) => !STOPWORDS.has(token.toLowerCase()));
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export class CodebaseReasoner {
  /**
   * @param {object} intelligence  Output of `buildProjectIntelligence`.
   * @param {object} [options]
   * @param {(path: string) => Promise<string>|string} [options.read]  Optional file reader for lexical references.
   */
  constructor(intelligence = {}, options = {}) {
    this.intelligence = intelligence;
    this.files = (intelligence.files ?? []).map(normalizePath);
    this.symbols = (intelligence.symbols ?? []).map((symbol) => ({ ...symbol, file: normalizePath(symbol.file) }));
    this.testMapping = intelligence.testMapping ?? [];
    this.read = typeof options.read === 'function' ? options.read : null;

    const edges = intelligence.importGraph ?? intelligence.dependencyGraph ?? [];
    this.forward = buildForwardGraph(edges);
    this.reverse = buildReverseGraph(edges);

    this.symbolsByName = new Map();
    this.symbolsByFile = new Map();
    for (const symbol of this.symbols) {
      const key = symbol.name;
      if (!this.symbolsByName.has(key)) this.symbolsByName.set(key, []);
      this.symbolsByName.get(key).push(symbol);
      if (!this.symbolsByFile.has(symbol.file)) this.symbolsByFile.set(symbol.file, []);
      this.symbolsByFile.get(symbol.file).push(symbol);
    }
  }

  /** Build the index for a workspace root and return a ready reasoner. */
  static async from(root, options = {}) {
    const intelligence = await buildProjectIntelligence(root, options);
    return new CodebaseReasoner(intelligence, options);
  }

  /** Find where a symbol is defined (exact match first, then case-insensitive). */
  definition(name) {
    const query = String(name ?? '').trim();
    if (!query) return { name: query, matches: [] };
    let matches = this.symbolsByName.get(query) ?? [];
    if (matches.length === 0) {
      const lower = query.toLowerCase();
      matches = this.symbols.filter((symbol) => symbol.name.toLowerCase() === lower);
    }
    if (matches.length === 0) {
      const lower = query.toLowerCase();
      matches = this.symbols.filter((symbol) => symbol.name.toLowerCase().includes(lower));
    }
    return {
      name: query,
      matches: matches.map((symbol) => ({ file: symbol.file, line: symbol.line, kind: symbol.kind, parser: symbol.parser })),
    };
  }

  /** Files that reference a symbol: structural importers + optional lexical hits. */
  async references(name) {
    const query = String(name ?? '').trim();
    const definition = this.definition(query);
    const definingFiles = [...new Set(definition.matches.map((match) => match.file))];

    const structural = new Set();
    for (const file of definingFiles) {
      for (const importer of this.reverse.get(file) ?? []) structural.add(importer);
    }

    const lexical = [];
    if (this.read && query) {
      const pattern = new RegExp(`\\b${escapeRegExp(query)}\\b`);
      for (const file of this.files) {
        if (definingFiles.includes(file)) continue;
        let content;
        try {
          content = await this.read(file);
        } catch {
          continue;
        }
        const lines = String(content ?? '').split('\n');
        for (let index = 0; index < lines.length; index += 1) {
          if (pattern.test(lines[index])) lexical.push({ file, line: index + 1 });
        }
      }
    }

    return {
      name: query,
      definitions: definition.matches,
      structural: [...structural].sort(),
      lexical,
      referenced: structural.size > 0 || lexical.length > 0,
    };
  }

  /** Shortest import path from one file to another (BFS over forward edges). */
  trace(from, to) {
    const start = normalizePath(from);
    const target = normalizePath(to);
    if (!start || !target) return { from: start, to: target, path: null, reachable: false };
    if (start === target) return { from: start, to: target, path: [start], reachable: true };

    const queue = [start];
    const previous = new Map([[start, null]]);
    while (queue.length) {
      const node = queue.shift();
      for (const next of this.forward.get(node) ?? []) {
        if (previous.has(next)) continue;
        previous.set(next, node);
        if (next === target) {
          const path = [];
          let cursor = target;
          while (cursor) {
            path.unshift(cursor);
            cursor = previous.get(cursor);
          }
          return { from: start, to: target, path, reachable: true };
        }
        queue.push(next);
      }
    }
    return { from: start, to: target, path: null, reachable: false };
  }

  /** Tests that import a given file (directly or via its dependents). */
  testsFor(file) {
    const target = normalizePath(file);
    return this.testMapping
      .filter((entry) => [...(entry.importedSources ?? []), ...(entry.likelySources ?? [])].map(normalizePath).includes(target))
      .map((entry) => entry.test);
  }

  /** Structured explanation of a file or a symbol. */
  async explain(target) {
    const query = String(target ?? '').trim();
    const asFile = normalizePath(query);
    if (this.files.includes(asFile)) {
      return {
        kind: 'file',
        file: asFile,
        symbols: (this.symbolsByFile.get(asFile) ?? []).map((symbol) => ({ name: symbol.name, line: symbol.line, kind: symbol.kind })),
        imports: [...(this.forward.get(asFile) ?? [])].sort(),
        importedBy: [...(this.reverse.get(asFile) ?? [])].sort(),
        tests: this.testsFor(asFile),
      };
    }
    const definition = this.definition(query);
    if (definition.matches.length) {
      const references = await this.references(query);
      const tests = [...new Set(definition.matches.flatMap((match) => this.testsFor(match.file)))];
      return { kind: 'symbol', name: query, definitions: definition.matches, references, tests };
    }
    return { kind: 'unknown', name: query, definitions: [], references: null, tests: [] };
  }

  /** Ranked symbol/file search for free-form queries. */
  search(query, limit = 10) {
    const tokens = contentTokens(query).map((token) => token.toLowerCase());
    if (!tokens.length) return [];
    const scored = [];
    for (const symbol of this.symbols) {
      const name = symbol.name.toLowerCase();
      let score = 0;
      for (const token of tokens) {
        if (name === token) score += 10;
        else if (name.includes(token)) score += 5;
        else if (token.includes(name)) score += 3;
      }
      if (score > 0) scored.push({ type: 'symbol', name: symbol.name, file: symbol.file, line: symbol.line, score });
    }
    for (const file of this.files) {
      const lower = file.toLowerCase();
      let score = 0;
      for (const token of tokens) if (lower.includes(token)) score += 2;
      if (score > 0) scored.push({ type: 'file', name: file, file, line: null, score });
    }
    return scored.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name)).slice(0, limit);
  }

  /** Classify a natural-language question and answer it with real evidence. */
  async answer(question) {
    const text = String(question ?? '').trim();
    const lower = text.toLowerCase();

    const fileMention = this.files.find((file) => lower.includes(file.toLowerCase()));
    const quoted = text.match(/[`'"]([^`'"]+)[`'"]/);
    const identifiers = quoted ? [quoted[1]] : contentTokens(text);

    if (/trace|path|reach|how does .* (get|reach)|from .* to /.test(lower) && fileMention) {
      const others = this.files.filter((file) => file !== fileMention && lower.includes(file.toLowerCase()));
      if (others.length) {
        const trace = this.trace(fileMention, others[0]);
        return { question: text, intent: 'trace', answer: trace.reachable ? `Path: ${trace.path.join(' -> ')}` : `${fileMention} does not reach ${others[0]}`, evidence: trace };
      }
    }

    if (/who (uses|calls|references)|references|usages|callers|depend(s|encies) on/.test(lower)) {
      const name = identifiers[0] ?? '';
      const references = await this.references(name);
      const where = references.structural.slice(0, 5).join(', ');
      return { question: text, intent: 'references', answer: references.referenced ? `${name} is referenced in ${references.structural.length} file(s)${where ? ` (${where})` : ''} via imports${references.lexical.length ? ` and ${references.lexical.length} lexical hit(s)` : ''}` : `no references found for ${name}`, evidence: references };
    }

    if (/where is .* defined|definition of|define|declared/.test(lower)) {
      const name = identifiers[0] ?? '';
      const definition = this.definition(name);
      return { question: text, intent: 'definition', answer: definition.matches.length ? `${name} is defined in ${definition.matches.map((match) => `${match.file}:${match.line}`).join(', ')}` : `no definition found for ${name}`, evidence: definition };
    }

    if (/explain|describe|what is|tell me about|structure of/.test(lower) && (fileMention || identifiers.length)) {
      const target = fileMention ?? identifiers[0];
      const explanation = await this.explain(target);
      return { question: text, intent: 'explain', answer: summarizeExplanation(explanation), evidence: explanation };
    }

    const results = this.search(text);
    return { question: text, intent: 'search', answer: results.length ? `best matches: ${results.slice(0, 3).map((item) => `${item.name} (${item.type})`).join(', ')}` : 'no matches found', evidence: { results } };
  }
}

function summarizeExplanation(explanation) {
  if (explanation.kind === 'file') {
    return `${explanation.file} defines ${explanation.symbols.length} symbol(s), imports ${explanation.imports.length} file(s), is imported by ${explanation.importedBy.length} file(s), covered by ${explanation.tests.length} test(s)`;
  }
  if (explanation.kind === 'symbol') {
    return `${explanation.name} is defined in ${explanation.definitions.map((match) => match.file).join(', ')} and referenced by ${explanation.references?.structural?.length ?? 0} file(s)`;
  }
  return `no code entity matched "${explanation.name}"`;
}
