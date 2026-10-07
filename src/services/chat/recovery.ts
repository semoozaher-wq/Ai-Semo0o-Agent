import type { Conversation, Message } from '../../types/chat';

/**
 * Chat recovery orchestration — dependency-free.
 *
 * When the app (or the backend) dies mid-stream, an assistant turn is left
 * `streaming` forever. The backend exposes two endpoints to reconcile this:
 * `GET /chat/recoverable` (which threads hold a stuck turn) and
 * `POST /conversations/:id/recover` (sweep them to `interrupted`). The chat
 * store used to own that logic inline, but nothing ever called it, so the
 * endpoints were dead from the app's point of view.
 *
 * The logic lives here, with no react-native / zustand / storage imports, so it
 * can be unit-tested with plain fakes. `useChatStore` and `useBootstrap` are
 * thin adapters over these functions.
 */

export interface RecoverableConversationRef {
  conversationId: string;
}

export interface ChatRecoveryClient {
  getRecoverableChats(): Promise<{ conversations: RecoverableConversationRef[] }>;
  recoverChat(conversationId: string): Promise<{ recovered: unknown[] }>;
}

export interface ChatRecoverySweep {
  /** Total number of assistant turns swept across every thread. */
  recoveredCount: number;
  /** Backend conversation ids that were successfully swept. */
  recoveredBackendIds: string[];
}

/**
 * Ask the backend which threads hold a stuck assistant turn, then sweep each
 * one to `interrupted`. A single failing thread never aborts the sweep of the
 * rest, so one poisoned conversation cannot wedge startup recovery.
 */
export async function sweepInterruptedChats(client: ChatRecoveryClient): Promise<ChatRecoverySweep> {
  const { conversations } = await client.getRecoverableChats();
  if (!conversations.length) return { recoveredCount: 0, recoveredBackendIds: [] };
  const recoveredBackendIds: string[] = [];
  let recoveredCount = 0;
  for (const item of conversations) {
    try {
      const result = await client.recoverChat(item.conversationId);
      recoveredCount += Array.isArray(result.recovered) ? result.recovered.length : 0;
      recoveredBackendIds.push(item.conversationId);
    } catch {
      // Keep sweeping the rest — a single unrecoverable thread must not abort.
    }
  }
  return { recoveredCount, recoveredBackendIds };
}

/**
 * Mirror the backend sweep locally: any assistant turn still `streaming` or
 * `pending` in a thread the backend just recovered becomes `interrupted`, so the
 * UI can offer a retry instead of spinning forever.
 *
 * Pure: returns the original map untouched when nothing changed.
 */
export function markInterruptedMessages(
  messages: Record<string, Message[]>,
  conversations: Pick<Conversation, 'id' | 'backendId'>[],
  recoveredBackendIds: Iterable<string>,
): Record<string, Message[]> {
  const recovered = new Set(recoveredBackendIds);
  if (recovered.size === 0) return messages;
  let changed = false;
  const next: Record<string, Message[]> = { ...messages };
  for (const conversation of conversations) {
    if (!conversation.backendId || !recovered.has(conversation.backendId)) continue;
    const list = next[conversation.id];
    if (!list) continue;
    let listChanged = false;
    const swept = list.map((message) => {
      if (message.role === 'assistant' && (message.status === 'streaming' || message.status === 'pending')) {
        listChanged = true;
        return { ...message, status: 'interrupted' as const };
      }
      return message;
    });
    if (listChanged) {
      next[conversation.id] = swept;
      changed = true;
    }
  }
  return changed ? next : messages;
}

export interface InterruptedRetryPlan {
  /** The user prompt to replay. */
  content: string;
  /** How many messages to keep (everything up to and including the user turn). */
  keepCount: number;
}

/**
 * Work out how to retry the most recent interrupted assistant turn: replay the
 * user prompt that produced it and drop the dead reply. Returns `null` when the
 * thread holds no interrupted turn (nothing to retry).
 */
export function planInterruptedRetry(messages: Message[] | undefined): InterruptedRetryPlan | null {
  const list = messages ?? [];
  let interruptedIndex = -1;
  for (let index = list.length - 1; index >= 0; index -= 1) {
    const message = list[index];
    if (message && message.role === 'assistant' && message.status === 'interrupted') {
      interruptedIndex = index;
      break;
    }
  }
  if (interruptedIndex < 0) return null;
  let userIndex = -1;
  for (let index = interruptedIndex - 1; index >= 0; index -= 1) {
    const message = list[index];
    if (message && message.role === 'user') {
      userIndex = index;
      break;
    }
  }
  if (userIndex < 0) return null;
  return { content: list[userIndex]!.content, keepCount: userIndex + 1 };
}

export interface ChatRecoveryHost {
  recoverInterrupted(): Promise<number>;
}

/**
 * Startup glue: sweep interrupted threads once the stores are hydrated.
 * Best-effort by contract — it never throws and never blocks bootstrap, so a
 * backend that is offline or unconfigured cannot stop the app from loading.
 */
export async function runBootstrapRecovery(host: ChatRecoveryHost): Promise<number> {
  try {
    return await host.recoverInterrupted();
  } catch {
    return 0;
  }
}
