import { create } from 'zustand';
import { Attachment, Conversation, Message } from '../types/chat';
import { storage, STORAGE_KEYS } from '../services/storage';
import { uid } from '../utils/id';
import { titleFromPrompt } from '../utils/text';
import { DEFAULT_MODEL_ID } from '../data/models';
import { backendApi, ApiEvent } from '../services/api/client';
import { sweepInterruptedChats, markInterruptedMessages, planInterruptedRetry } from '../services/chat/recovery';
import { planAttachmentUploads, stripAttachmentBytes } from '../services/chat/attachments';
import { ProjectCache } from '../services/chat/project-cache';

let streamToken = 0;
let activeController: AbortController | null = null;

// Agent project/workspace resolver. Keyed by the signed-in identity so a
// session change can never reuse another tenant's project, and a failed
// creation is never cached (see `ProjectCache`).
const projectCache = new ProjectCache(backendApi);

/** Drop the cached agent project. Called on sign-out / session change. */
export function resetChatProjectCache(): void {
  projectCache.reset();
}

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
  send(text: string, opts?: { model?: string; mode?: 'chat' | 'agent'; attachments?: Attachment[] }): Promise<void>;
  recoverInterrupted(): Promise<number>;
  retryInterrupted(conversationId: string): Promise<void>;
  stop(): void;
  clear(): Promise<void>;
}

function nowIso(): string { return new Date().toISOString(); }

/**
 * Fold the attachments that could NOT be uploaded (workspace files, URLs,
 * oversized files, or failed uploads) into the outgoing prompt as name/type
 * references, so the model still gets honest context. Device files whose real
 * bytes were uploaded are sent via `attachmentIds` instead — their content
 * reaches the model directly and must not be duplicated here.
 */
function withAttachmentReferences(content: string, attachments: Attachment[]): string {
  if (attachments.length === 0) return content;
  const lines = attachments.map(
    (item) => `- ${item.name}${item.uri ? ` — ${item.uri}` : ''} (${item.mimeType}${item.sizeBytes ? `, ${item.sizeBytes} bytes` : ''})`,
  );
  const block = `[المرفقات]\n${lines.join('\n')}`;
  return content ? `${content}\n\n${block}` : block;
}

export const useChatStore = create<ChatState>((set, get) => {
  const persist = () => {
    const { conversations, messages } = get();
    void storage.set(STORAGE_KEYS.conversations, conversations);
    void storage.set(STORAGE_KEYS.messages, messages);
  };
  const patchMessage = (conversationId: string, messageId: string, patch: Partial<Message>) => set((state) => ({ messages: { ...state.messages, [conversationId]: (state.messages[conversationId] ?? []).map((message) => message.id === messageId ? { ...message, ...patch } : message) } }));
  // Resolve the agent project for the current session (cached per identity).
  const ensureProject = () => projectCache.resolve();
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
  const streamChat = async (conversationId: string, assistantId: string, content: string, model: string, backendId: string | undefined, token: number, attachmentIds: string[] = []): Promise<boolean> => {
    let streamed = '';
    let terminal = false;
    try {
      await backendApi.chatStream(
        { message: content, model, ...(backendId ? { conversationId: backendId } : {}), ...(attachmentIds.length ? { attachmentIds } : {}) },
        (frame) => {
          if (token !== streamToken) return;
          if (frame.type === 'start' && typeof frame.conversationId === 'string') {
            const backendConversationId = frame.conversationId;
            set((state) => ({ conversations: state.conversations.map((item) => item.id === conversationId ? { ...item, backendId: backendConversationId } : item) }));
          } else if (frame.type === 'resume' && typeof frame.text === 'string') {
            // Resume-by-fetch after a dropped socket: the backend persisted the
            // FULL reply, so REPLACE our buffer (never append) to avoid dupes.
            streamed = frame.text;
            patchMessage(conversationId, assistantId, { content: streamed, status: 'streaming' });
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
  // Produce the assistant reply for an already-appended user turn. Shared by
  // `send` and `retryInterrupted` so a retry reuses the exact same streaming,
  // agent-run, fallback and error handling as a first attempt.
  const generateReply = async (conversationId: string, assistantId: string, content: string, model: string, mode: 'chat' | 'agent', token: number, attachmentIds: string[] = []) => {
    const conversation = get().conversations.find((item) => item.id === conversationId);
    try {
      if (mode === 'chat') {
        const streamed = await streamChat(conversationId, assistantId, content, model, conversation?.backendId, token, attachmentIds);
        // Streaming unavailable (older backend, proxy that buffers SSE, or an
        // empty stream): fall back to a single-shot completion so the user
        // still gets an answer.
        if (!streamed && token === streamToken) {
          const result = await backendApi.chat({ message: content, model, ...(attachmentIds.length ? { attachmentIds } : {}) });
          if (token === streamToken) patchMessage(conversationId, assistantId, { content: result.text, status: 'complete', model });
        }
      } else {
        const project = await ensureProject();
        const run = await backendApi.createRun({ kind: 'agent.run', projectId: project.projectId, workspaceId: project.workspaceId, goal: content, model, ...(attachmentIds.length ? { attachmentIds } : {}) });
        await backendApi.streamEvents(run.runId, (event) => { if (token === streamToken) handleEvent(conversationId, assistantId, event); }, activeController?.signal);
        const snapshot = await backendApi.getRun(run.runId);
        const finalText = snapshot.result?.final ?? (snapshot.status === 'completed' ? 'اكتملت المهمة دون نص نهائي.' : `انتهت المهمة بالحالة: ${snapshot.status}`);
        if (token === streamToken) patchMessage(conversationId, assistantId, { content: finalText, status: snapshot.status === 'completed' ? 'complete' : 'error', error: snapshot.status === 'completed' ? undefined : snapshot.status });
      }
    } catch (error) {
      if (token === streamToken) patchMessage(conversationId, assistantId, { content: 'تعذّر تشغيل الوكيل عبر الـBackend.', status: 'error', error: error instanceof Error ? error.message : 'BACKEND_AGENT_FAILED' });
    } finally { if (token === streamToken) set({ streaming: false }); persist(); }
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
      const content = text.trim();
      const attachments = opts?.attachments ?? [];
      if (!content && attachments.length === 0) return;
      let conversationId = get().activeId; if (!conversationId) conversationId = get().newConversation(opts?.model);
      const conversation = get().conversations.find((item) => item.id === conversationId);
      const model = opts?.model ?? conversation?.model ?? DEFAULT_MODEL_ID;
      // Persist only attachment metadata — never the base64 bytes (they can be
      // multi-megabyte and would bloat local storage).
      const storedAttachments = stripAttachmentBytes(attachments);
      const userMessage: Message = { id: uid('msg'), conversationId, role: 'user', content, createdAt: nowIso(), status: 'complete', ...(storedAttachments.length ? { attachments: storedAttachments } : {}) };
      const assistantId = uid('msg');
      const mode = opts?.mode ?? 'chat';
      const assistantMessage: Message = { id: assistantId, conversationId, role: 'assistant', content: mode === 'agent' ? 'جارٍ الاتصال بالـBackend وتشغيل الوكيل…' : 'جارٍ إعداد الرد…', createdAt: nowIso(), status: 'streaming', model };
      const preview = content || attachments[0]?.name || '';
      set((state) => { const existing = state.messages[conversationId] ?? []; return { messages: { ...state.messages, [conversationId]: [...existing, userMessage, assistantMessage] }, conversations: state.conversations.map((item) => item.id === conversationId ? { ...item, title: existing.length === 0 ? titleFromPrompt(preview) : item.title, updatedAt: nowIso(), messageCount: item.messageCount + 2, lastMessagePreview: preview.slice(0, 80) } : item), streaming: true }; });
      const token = ++streamToken; activeController?.abort(); activeController = new AbortController();
      // Upload the real file bytes first so the model receives their content;
      // only name-only references (workspace/URL/oversized/failed) are folded
      // into the prompt text.
      const { attachmentIds, referenceOnly } = await planAttachmentUploads(backendApi, attachments, conversation?.backendId);
      // The uploader stamps server ids onto the queued attachments; mirror them
      // onto the optimistic user turn so a retry reuses the upload and the UI can
      // fetch the stored bytes (e.g. an image thumbnail) without re-uploading.
      if (attachments.some((item) => item.backendId)) {
        patchMessage(conversationId, userMessage.id, { attachments: stripAttachmentBytes(attachments) });
      }
      await generateReply(conversationId, assistantId, withAttachmentReferences(content, referenceOnly), model, mode, token, attachmentIds);
    },
    async recoverInterrupted() {
      // Ask the backend which threads hold a reply that was left mid-stream by a
      // crash/restart, sweep them to `interrupted`, and mirror that locally so
      // the UI can offer a retry instead of spinning forever. Best-effort: any
      // failure leaves the local state untouched.
      try {
        const { recoveredCount, recoveredBackendIds } = await sweepInterruptedChats(backendApi);
        if (!recoveredBackendIds.length) return 0;
        set((state) => ({ messages: markInterruptedMessages(state.messages, state.conversations, recoveredBackendIds) }));
        persist();
        return recoveredCount;
      } catch { return 0; }
    },
    async retryInterrupted(conversationId) {
      // Replay the user turn that produced the most recent interrupted reply,
      // dropping the dead assistant message first so the thread stays coherent.
      const plan = planInterruptedRetry(get().messages[conversationId]);
      if (!plan) return;
      const conversation = get().conversations.find((item) => item.id === conversationId);
      const model = conversation?.model ?? DEFAULT_MODEL_ID;
      const assistantId = uid('msg');
      const assistantMessage: Message = { id: assistantId, conversationId, role: 'assistant', content: 'جارٍ إعادة المحاولة…', createdAt: nowIso(), status: 'streaming', model };
      set((state) => {
        const existing = state.messages[conversationId] ?? [];
        return {
          messages: { ...state.messages, [conversationId]: [...existing.slice(0, plan.keepCount), assistantMessage] },
          conversations: state.conversations.map((item) => item.id === conversationId ? { ...item, updatedAt: nowIso() } : item),
          streaming: true,
        };
      });
      const token = ++streamToken; activeController?.abort(); activeController = new AbortController();
      await generateReply(conversationId, assistantId, plan.content, model, 'chat', token);
    },
    stop() { streamToken += 1; activeController?.abort(); activeController = null; set({ streaming: false }); persist(); },
    async clear() { streamToken += 1; activeController?.abort(); set({ conversations: [], messages: {}, activeId: null, streaming: false }); await storage.remove(STORAGE_KEYS.conversations); await storage.remove(STORAGE_KEYS.messages); },
  };
});
