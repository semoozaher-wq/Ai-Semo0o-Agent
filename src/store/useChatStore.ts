import { create } from 'zustand';
import { Conversation, Message } from '../types/chat';
import { ChatCompletionMessage } from '../types/model';
import { aiService } from '../services/ai';
import { storage, STORAGE_KEYS } from '../services/storage';
import { uid } from '../utils/id';
import { titleFromPrompt } from '../utils/text';
import { DEFAULT_MODEL_ID } from '../../data/models';
import { useAgentsStore } from './useAgentsStore';

/** Monotonic token used to cancel an in-flight stream. */
let streamToken = 0;

interface ChatState {
  conversations: Conversation[];
  messages: Record<string, Message[]>;
  activeId: string | null;
  streaming: boolean;
  hydrated: boolean;
  hydrate(): Promise<void>;
  newConversation(model?: string): string;
  setActive(id: string): void;
  deleteConversation(id: string): Promise<void>;
  renameConversation(id: string, title: string): void;
  send(text: string, opts?: { model?: string }): Promise<void>;
  stop(): void;
  clear(): Promise<void>;
}

function nowIso(): string {
  return new Date().toISOString();
}

function requiresAgentExecution(content: string): boolean {
  return content.length >= 180 || /(حلل|افحص|أصلح|شغّل|شغل|اختبر|نفّذ|نفذ|مشروع|مستودع|ملفات|analy[sz]e|fix|run tests|repository|codebase|execute)/i.test(content);
}

export const useChatStore = create<ChatState>((set, get) => {
  const persist = () => {
    const { conversations, messages } = get();
    void storage.set(STORAGE_KEYS.conversations, conversations);
    void storage.set(STORAGE_KEYS.messages, messages);
  };

  const patchMessage = (
    conversationId: string,
    messageId: string,
    patch: Partial<Message>,
  ) => {
    set((state) => {
      const list = state.messages[conversationId] ?? [];
      return {
        messages: {
          ...state.messages,
          [conversationId]: list.map((m) =>
            m.id === messageId ? { ...m, ...patch } : m,
          ),
        },
      };
    });
  };

  return {
    conversations: [],
    messages: {},
    activeId: null,
    streaming: false,
    hydrated: false,

    async hydrate() {
      const conversations =
        (await storage.get<Conversation[]>(STORAGE_KEYS.conversations)) ?? [];
      const messages =
        (await storage.get<Record<string, Message[]>>(STORAGE_KEYS.messages)) ??
        {};
      set({
        conversations,
        messages,
        activeId: conversations[0]?.id ?? null,
        hydrated: true,
      });
    },

    newConversation(model) {
      const id = uid('conv');
      const conversation: Conversation = {
        id,
        title: 'محادثة جديدة',
        createdAt: nowIso(),
        updatedAt: nowIso(),
        model: model ?? get().conversations[0]?.model ?? DEFAULT_MODEL_ID,
        messageCount: 0,
      };
      set((state) => ({
        conversations: [conversation, ...state.conversations],
        messages: { ...state.messages, [id]: [] },
        activeId: id,
      }));
      persist();
      return id;
    },

    setActive(id) {
      set({ activeId: id });
    },

    async deleteConversation(id) {
      set((state) => {
        const conversations = state.conversations.filter((c) => c.id !== id);
        const messages = { ...state.messages };
        delete messages[id];
        return {
          conversations,
          messages,
          activeId: state.activeId === id ? conversations[0]?.id ?? null : state.activeId,
        };
      });
      persist();
    },

    renameConversation(id, title) {
      set((state) => ({
        conversations: state.conversations.map((c) =>
          c.id === id ? { ...c, title, updatedAt: nowIso() } : c,
        ),
      }));
      persist();
    },

    async send(text, opts) {
      const content = text.trim();
      if (!content) return;

      let conversationId = get().activeId;
      if (!conversationId) conversationId = get().newConversation(opts?.model);

      const conversation = get().conversations.find((c) => c.id === conversationId);
      const model = opts?.model ?? conversation?.model ?? DEFAULT_MODEL_ID;

      const userMessage: Message = {
        id: uid('msg'),
        conversationId,
        role: 'user',
        content,
        createdAt: nowIso(),
        status: 'complete',
      };
      const assistantId = uid('msg');
      const assistantMessage: Message = {
        id: assistantId,
        conversationId,
        role: 'assistant',
        content: '',
        createdAt: nowIso(),
        status: 'streaming',
        model,
      };

      set((state) => {
        const existing = state.messages[conversationId] ?? [];
        const isFirst = existing.length === 0;
        return {
          messages: {
            ...state.messages,
            [conversationId]: [...existing, userMessage, assistantMessage],
          },
          conversations: state.conversations.map((c) =>
            c.id === conversationId
              ? {
                  ...c,
                  title: isFirst ? titleFromPrompt(content) : c.title,
                  updatedAt: nowIso(),
                  messageCount: c.messageCount + 2,
                  lastMessagePreview: content.slice(0, 80),
                }
              : c,
          ),
          streaming: true,
        };
      });

      const token = ++streamToken;

      try {
        if (requiresAgentExecution(content)) {
          const task = useAgentsStore.getState().createTask(content, { model });
          patchMessage(conversationId, assistantId, {
            content: 'بدأت تشغيل الوكيل: التخطيط والتنفيذ والتحقق…',
            status: 'streaming',
            agentTaskId: task.id,
          });
          await useAgentsStore.getState().runTask(task.id, { model });
          const finished = useAgentsStore.getState().tasks.find((item) => item.id === task.id);
          const status = finished?.status ?? 'failed';
          const summary = finished?.result ?? finished?.error ?? 'لم ينتج الوكيل نتيجة قابلة للتحقق.';
          patchMessage(conversationId, assistantId, {
            content: `حالة الوكيل: ${status}\n\n${summary}`,
            status: status === 'completed' ? 'complete' : 'error',
            agentTaskId: task.id,
          });
          return;
        }
        const history: ChatCompletionMessage[] = (get().messages[conversationId] ?? [])
          .filter((m) => m.status !== 'streaming' && m.role !== 'tool')
          .map((m) => ({ role: m.role, content: m.content }));

        let acc = '';
        for await (const chunk of aiService.stream({ model, messages: history })) {
          if (token !== streamToken) break;
          if (chunk.delta) {
            acc += chunk.delta;
            patchMessage(conversationId, assistantId, {
              content: acc,
              status: 'streaming',
            });
          }
          if (chunk.done) break;
        }

        if (token === streamToken) {
          patchMessage(conversationId, assistantId, {
            content: acc,
            status: 'complete',
          });
        }
      } catch (error) {
        patchMessage(conversationId, assistantId, {
          status: 'error',
          error: error instanceof Error ? error.message : 'فشل توليد الرد',
          content: 'تعذّر توليد الرد. حاول مرة أخرى.',
        });
      } finally {
        if (token === streamToken) set({ streaming: false });
        persist();
      }
    },

    stop() {
      streamToken += 1;
      set({ streaming: false });
      set((state) => {
        const id = state.activeId;
        if (!id) return state;
        const list = state.messages[id] ?? [];
        return {
          messages: {
            ...state.messages,
            [id]: list.map((m) =>
              m.status === 'streaming' ? { ...m, status: 'complete' } : m,
            ),
          },
        };
      });
      persist();
    },

    async clear() {
      streamToken += 1;
      set({ conversations: [], messages: {}, activeId: null, streaming: false });
      await storage.remove(STORAGE_KEYS.conversations);
      await storage.remove(STORAGE_KEYS.messages);
    },
  };
});
