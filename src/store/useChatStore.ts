import { create } from 'zustand';
import { Conversation, Message, MessageStatus } from '../types/chat';
import { storage, STORAGE_KEYS } from '../services/storage';
import { uid } from '../utils/id';
import { titleFromPrompt } from '../utils/text';
import { DEFAULT_MODEL_ID } from '../data/models';
import { backendApi, ApiEvent } from '../services/api/client';

let streamToken = 0;
let activeController: AbortController | null = null;

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
  send(text: string, opts?: { model?: string; mode?: 'chat' | 'agent' }): Promise<void>;
  recoverInterrupted(): Promise<number>;
  stop(): void;
  clear(): Promise<void>;
}

function nowIso(): string { return new Date().toISOString(); }

export const useChatStore = create<ChatState>((set, get) => {
  const persist = () => {
    const { conversations, messages } = get();
    void storage.set(STORAGE_KEYS.conversations, conversations);
    void storage.set(STORAGE_KEYS.messages, messages);
  };
  const patchMessage = (conversationId: string, messageId: string, patch: Partial<Message>) => set((state) => ({ messages: { ...state.messages, [conversationId]: (state.messages[conversationId] ?? []).map((message) => message.id === messageId ? { ...message, ...patch } : message) } }));
  const projectPromise = { value: null as { projectId: string; workspaceId: string } | null, pending: null as Promise<{ projectId: string; workspaceId: string }> | null };
  const ensureProject = async () => {
    await backendApi.ensureSession();
    if (projectPromise.value) return projectPromise.value;
    projectPromise.pending ??= backendApi.createProject({ name: 'Semo0o Agent Workspace' }).then((project) => { projectPromise.value = project; return project; });
    return projectPromise.pending;
  };
  const handleEvent = (conversationId: string, assistantId: string, event: ApiEvent) => {
    if (event.type === 'planning_started') patchMessage(conversationId, assistantId, { content: 'بدأ التخطيط الآمن للمهمة…', status: 'streaming' });
    else if (event.type === 'planning_completed') patchMessage(conversationId, assistantId, { content: `تم إنشاء خطة من ${String(event.steps ?? 0)} خطوات…`, status: 'streaming' });
    else if (event.type === 'permission_requested') patchMessage(conversationId, assistantId, { content: `بانتظار موافقة المستخدم على الأداة: ${String(event.toolId ?? '')}`, status: 'streaming' });
    else if (event.type === 'tool_completed') patchMessage(conversationId, assistantId, { content: `تم تنفيذ ${String(event.toolId ?? 'الأداة')} والتحقق من النتيجة…`, status: 'streaming' });
    else if (event.type === 'step_completed') patchMessage(conversationId, assistantId, { content: `تم التحقق من الخطوة ${String(event.stepId ?? '')}…`, status: 'streaming' });
    else if (event.type === 'run_finished' && typeof event.final === 'string') patchMessage(conversationId, assistantId, { content: event.final, status: 'complete' });
  };
  // Stream a chat reply token-by-token. Returns true when the stream reached a
  // terminal frame (`done`/`error`); false when streaming is unavailable so the
  // caller can degrade to a single-shot completion. The `start` frame's
  // conversationId is persisted on the local thread so it can be resumed.
  const streamChat = async (conversationId: string, assistantId: string, content: string, model: string, backendId: string | undefined, token: number): Promise<boolean> => {
    let streamed = '';
    let terminal = false;
    try {
      await backendApi.chatStream(
        { message: content, model, ...(backendId ? { conversationId: backendId } : {}) },
        (frame) => {
          if (token !== streamToken) return;
          if (frame.type === 'start' && typeof frame.conversationId === 'string') {
            const backendConversationId = frame.conversationId;
            set((state) => ({ conversations: state.conversations.map((item) => item.id === conversationId ? { ...item, backendId: backendConversationId } : item) }));
          } else if (frame.type === 'token' && typeof frame.text === 'string') {
            streamed += frame.text;
            patchMessage(conversationId, assistantId, { content: streamed, status: 'streaming' });
          } else if (frame.type === 'done') {
            terminal = true;
            patchMessage(conversationId, assistantId, { content: streamed, status: 'complete', model });
          } else if (frame.type === 'error') {
            terminal = true;
            patchMessage(conversationId, assistantId, { content: streamed, status: 'error', error: typeof frame.error === 'string' ? frame.error : 'CHAT_STREAM_FAILED' });
          }
        },
        activeController?.signal,
      );
      return terminal;
    } catch {
      return false;
    }
  };

  return {
    conversations: [], messages: {}, activeId: null, streaming: false, hydrated: false,
    async hydrate() {
      const conversations = (await storage.get<Conversation[]>(STORAGE_KEYS.conversations)) ?? [];
      const messages = (await storage.get<Record<string, Message[]>>(STORAGE_KEYS.messages)) ?? {};
      set({ conversations, messages, activeId: conversations[0]?.id ?? null, hydrated: true });
    },
    newConversation(model) {
      const id = uid('conv');
      const conversation: Conversation = { id, title: 'محادثة جديدة', createdAt: nowIso(), updatedAt: nowIso(), model: model ?? get().conversations[0]?.model ?? DEFAULT_MODEL_ID, messageCount: 0 };
      set((state) => ({ conversations: [conversation, ...state.conversations], messages: { ...state.messages, [id]: [] }, activeId: id }));
      persist();
      return id;
    },
    setActive(id) { set({ activeId: id }); },
    async deleteConversation(id) { set((state) => { const conversations = state.conversations.filter((item) => item.id !== id); const messages = { ...state.messages }; delete messages[id]; return { conversations, messages, activeId: state.activeId === id ? conversations[0]?.id ?? null : state.activeId }; }); persist(); },
    renameConversation(id, title) { set((state) => ({ conversations: state.conversations.map((item) => item.id === id ? { ...item, title, updatedAt: nowIso() } : item) })); persist(); },
    async send(text, opts) {
      const content = text.trim(); if (!content) return;
      let conversationId = get().activeId; if (!conversationId) conversationId = get().newConversation(opts?.model);
      const conversation = get().conversations.find((item) => item.id === conversationId);
      const model = opts?.model ?? conversation?.model ?? DEFAULT_MODEL_ID;
      const userMessage: Message = { id: uid('msg'), conversationId, role: 'user', content, createdAt: nowIso(), status: 'complete' };
      const assistantId = uid('msg');
      const mode = opts?.mode ?? 'chat';
      const assistantMessage: Message = { id: assistantId, conversationId, role: 'assistant', content: mode === 'agent' ? 'جارٍ الاتصال بالـBackend وتشغيل الوكيل…' : 'جارٍ إعداد الرد…', createdAt: nowIso(), status: 'streaming', model };
      set((state) => { const existing = state.messages[conversationId] ?? []; return { messages: { ...state.messages, [conversationId]: [...existing, userMessage, assistantMessage] }, conversations: state.conversations.map((item) => item.id === conversationId ? { ...item, title: existing.length === 0 ? titleFromPrompt(content) : item.title, updatedAt: nowIso(), messageCount: item.messageCount + 2, lastMessagePreview: content.slice(0, 80) } : item), streaming: true }; });
      const token = ++streamToken; activeController?.abort(); activeController = new AbortController();
      try {
        if (mode === 'chat') {
          const streamed = await streamChat(conversationId, assistantId, content, model, conversation?.backendId, token);
          // Streaming unavailable (older backend, proxy that buffers SSE, or an
          // empty stream): fall back to a single-shot completion so the user
          // still gets an answer.
          if (!streamed && token === streamToken) {
            const result = await backendApi.chat({ message: content, model });
            if (token === streamToken) patchMessage(conversationId, assistantId, { content: result.text, status: 'complete', model });
          }
        } else {
          const project = await ensureProject();
          const run = await backendApi.createRun({ kind: 'agent.run', projectId: project.projectId, workspaceId: project.workspaceId, goal: content, model });
          await backendApi.streamEvents(run.runId, (event) => { if (token === streamToken) handleEvent(conversationId!, assistantId, event); }, activeController.signal);
          const snapshot = await backendApi.getRun(run.runId);
          const finalText = snapshot.result?.final ?? (snapshot.status === 'completed' ? 'اكتملت المهمة دون نص نهائي.' : `انتهت المهمة بالحالة: ${snapshot.status}`);
          if (token === streamToken) patchMessage(conversationId, assistantId, { content: finalText, status: snapshot.status === 'completed' ? 'complete' : 'error', error: snapshot.status === 'completed' ? undefined : snapshot.status });
        }
      } catch (error) {
        if (token === streamToken) patchMessage(conversationId, assistantId, { content: 'تعذّر تشغيل الوكيل عبر الـBackend.', status: 'error', error: error instanceof Error ? error.message : 'BACKEND_AGENT_FAILED' });
      } finally { if (token === streamToken) set({ streaming: false }); persist(); }
    },
    async recoverInterrupted() {
      // Ask the backend which threads hold a reply that was left mid-stream by a
      // crash/restart, sweep them to `interrupted`, and mirror that locally so
      // the UI can offer a retry instead of spinning forever.
      try {
        const { conversations } = await backendApi.getRecoverableChats();
        if (!conversations.length) return 0;
        const recoveredBackendIds = new Set<string>();
        let count = 0;
        for (const item of conversations) {
          try { const result = await backendApi.recoverChat(item.conversationId); count += result.recovered.length; recoveredBackendIds.add(item.conversationId); } catch { /* keep sweeping the rest */ }
        }
        set((state) => {
          const messages = { ...state.messages };
          for (const conversation of state.conversations) {
            if (!conversation.backendId || !recoveredBackendIds.has(conversation.backendId)) continue;
            const list = messages[conversation.id];
            if (!list) continue;
            messages[conversation.id] = list.map((message) => message.role === 'assistant' && (message.status === 'streaming' || message.status === 'pending') ? { ...message, status: 'interrupted' as MessageStatus } : message);
          }
          return { messages };
        });
        persist();
        return count;
      } catch { return 0; }
    },
    stop() { streamToken += 1; activeController?.abort(); activeController = null; set({ streaming: false }); persist(); },
    async clear() { streamToken += 1; activeController?.abort(); set({ conversations: [], messages: {}, activeId: null, streaming: false }); await storage.remove(STORAGE_KEYS.conversations); await storage.remove(STORAGE_KEYS.messages); },
  };
});
