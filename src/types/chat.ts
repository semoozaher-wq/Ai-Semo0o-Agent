import { ChatRole, TokenUsage } from './model';
import { ToolInvocation } from './tool';

export type MessageStatus = 'pending' | 'streaming' | 'complete' | 'error' | 'interrupted';

export type AttachmentKind = 'image' | 'document' | 'audio' | 'code' | 'other';

export interface Attachment {
  id: string;
  name: string;
  mimeType: string;
  sizeBytes: number;
  uri?: string;
  kind: AttachmentKind;
}

export interface Message {
  id: string;
  conversationId: string;
  role: ChatRole;
  content: string;
  createdAt: string;
  status: MessageStatus;
  model?: string | undefined;
  attachments?: Attachment[] | undefined;
  toolInvocations?: ToolInvocation[] | undefined;
  agentTaskId?: string | undefined;
  usage?: TokenUsage | undefined;
  error?: string | undefined;
}

export interface Conversation {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  model: string;
  pinned?: boolean;
  messageCount: number;
  lastMessagePreview?: string;
  agentId?: string;
  /** Server-side conversation id, captured from the stream `start` frame so the
   *  thread can be resumed and recovered after a reload. */
  backendId?: string | undefined;
}

export interface ChatQuickAction {
  id: string;
  label: string;
  labelAr: string;
  icon: string;
  prompt: string;
}
