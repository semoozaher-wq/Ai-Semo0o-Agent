import { uid } from '../../utils/id';

export interface MemoryEntry {
  id: string;
  taskId: string;
  kind: 'observation' | 'decision' | 'fact' | 'reflection';
  content: string;
  createdAt: string;
  importance: number;
}

/**
 * Lightweight working memory for an agent run. In production this would be
 * backed by a vector store for semantic recall; here it provides an ordered,
 * inspectable scratchpad with keyword search.
 */
export class AgentMemory {
  private entries: MemoryEntry[] = [];

  constructor(public readonly taskId: string) {}

  add(
    kind: MemoryEntry['kind'],
    content: string,
    importance = 0.5,
  ): MemoryEntry {
    const entry: MemoryEntry = {
      id: uid('mem'),
      taskId: this.taskId,
      kind,
      content,
      createdAt: new Date().toISOString(),
      importance,
    };
    this.entries.push(entry);
    return entry;
  }

  all(): MemoryEntry[] {
    return [...this.entries];
  }

  recent(n = 5): MemoryEntry[] {
    return this.entries.slice(-n);
  }

  search(query: string): MemoryEntry[] {
    const q = query.toLowerCase();
    return this.entries.filter((e) => e.content.toLowerCase().includes(q));
  }

  summary(): string {
    if (this.entries.length === 0) return 'لا توجد ذكريات بعد.';
    return this.entries
      .map((e) => `[${e.kind}] ${e.content}`)
      .join('\n');
  }

  clear(): void {
    this.entries = [];
  }
}
