// -----------------------------------------------------------------------------
// Server-Sent Events parsing + resilient streaming.
//
// The run-events stream, the Creation Studio stream and the chat stream all
// speak SSE, so the wire parsing lives here (dependency-free, so it is
// unit-testable without pulling in react-native). A frame is
// `id: <n>\nevent: <name>\ndata: <json>\n\n`; the reader loop must tolerate frames
// split across network chunks and multiple frames per chunk.
//
// Beyond parsing, this module owns the RECONNECT contract: `streamWithReconnect`
// re-establishes a dropped stream with exponential backoff + jitter and resumes
// from the last seen event id (`Last-Event-ID`), so a flaky network never loses
// or duplicates timeline events. Chat uses a different recovery (resume-by-fetch,
// in the client) because its stream is a non-idempotent POST.
// -----------------------------------------------------------------------------

export interface SseEvent {
  event: string;
  data: unknown;
  /** The `id:` field, used to resume a dropped stream (`Last-Event-ID`). */
  id?: string;
  /** The server's `retry:` hint (milliseconds) for the reconnect delay. */
  retry?: number;
}

/**
 * Split a growing buffer into complete SSE frames. Returns the decoded events
 * plus the trailing partial frame to carry into the next read. Comment lines
 * (heartbeats, `: ...`) are ignored; malformed JSON payloads are dropped rather
 * than throwing, so one bad frame cannot kill a stream.
 */
export function parseSseBuffer(buffer: string): { events: SseEvent[]; rest: string } {
  const chunks = buffer.split('\n\n');
  const rest = chunks.pop() ?? '';
  const events: SseEvent[] = [];
  for (const chunk of chunks) {
    const lines = chunk.split('\n');
    let event = 'message';
    let id: string | undefined;
    let retry: number | undefined;
    const dataLines: string[] = [];
    for (const line of lines) {
      if (line.startsWith(':')) continue; // comment / heartbeat
      if (line.startsWith('event:')) event = line.slice(6).trim() || 'message';
      else if (line.startsWith('data:')) dataLines.push(line.slice(5).replace(/^ /, ''));
      else if (line.startsWith('id:')) id = line.slice(3).trim();
      else if (line.startsWith('retry:')) { const parsed = Number.parseInt(line.slice(6).trim(), 10); if (Number.isFinite(parsed) && parsed >= 0) retry = parsed; }
    }
    if (dataLines.length === 0) continue;
    try {
      const decoded: SseEvent = { event, data: JSON.parse(dataLines.join('\n')) };
      if (id !== undefined) decoded.id = id;
      if (retry !== undefined) decoded.retry = retry;
      events.push(decoded);
    } catch { /* ignore malformed frame */ }
  }
  return { events, rest };
}

/**
 * Read an SSE `Response` to completion, invoking `onEvent` for each decoded
 * frame. Throws `BACKEND_SSE_<status>` when the response is not a usable stream.
 * Returns the last event id seen, so the caller can resume from it after a drop.
 */
export async function consumeSse(response: Response, onEvent: (event: SseEvent) => void): Promise<{ lastEventId: string | null }> {
  if (!response.ok || !response.body) throw new Error(`BACKEND_SSE_${response.status}`);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let lastEventId: string | null = null;
  for (;;) {
    const next = await reader.read();
    if (next.done) break;
    buffer += decoder.decode(next.value, { stream: true });
    const parsed = parseSseBuffer(buffer);
    buffer = parsed.rest;
    for (const event of parsed.events) {
      if (event.id !== undefined) lastEventId = event.id;
      onEvent(event);
    }
  }
  return { lastEventId };
}

export function isAbortError(error: unknown): boolean {
  return Boolean(error) && typeof error === 'object' && (error as { name?: string }).name === 'AbortError';
}

/** Exponential backoff with symmetric jitter, clamped to `maxDelayMs`. */
export function computeBackoff(attempt: number, { baseDelayMs = 500, maxDelayMs = 15_000, jitterRatio = 0.2, random = Math.random }: { baseDelayMs?: number; maxDelayMs?: number; jitterRatio?: number; random?: () => number } = {}): number {
  const exponential = Math.min(maxDelayMs, baseDelayMs * 2 ** Math.max(0, attempt - 1));
  const jitter = exponential * jitterRatio * (random() * 2 - 1);
  return Math.max(0, Math.round(exponential + jitter));
}

/** Abortable sleep used between reconnect attempts (resolves early on abort). */
export function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) { resolve(); return; }
    const onAbort = () => { clearTimeout(timer); resolve(); };
    const timer = setTimeout(() => { signal?.removeEventListener?.('abort', onAbort); resolve(); }, ms);
    signal?.addEventListener?.('abort', onAbort, { once: true });
  });
}

export interface ReconnectInfo { attempt: number; delayMs: number; lastEventId: string | null }
export interface StreamWithReconnectOptions {
  /** Open the stream, resuming from `lastEventId` (null on the first attempt). */
  connect: (lastEventId: string | null, attempt: number) => Promise<Response>;
  onEvent: (event: SseEvent) => void;
  signal?: AbortSignal | undefined;
  /** A frame that ends the stream for good (e.g. `close`/`done`/`error`). */
  isTerminal?: (event: SseEvent) => boolean;
  onReconnect?: (info: ReconnectInfo) => void;
  onError?: (error: unknown) => void;
  maxAttempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  jitterRatio?: number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  random?: () => number;
}
export interface StreamResult { lastEventId: string | null; attempts: number; reconnects: number; terminal: boolean }

/**
 * Consume an SSE stream, transparently reconnecting on a network drop. Each
 * attempt resumes from the last seen event id, so no event is lost or
 * re-delivered. Returns once a terminal frame is seen, the stream ends cleanly
 * after a terminal frame, the signal aborts, or the attempt budget is exhausted.
 */
export async function streamWithReconnect({
  connect, onEvent, signal, isTerminal, onReconnect, onError,
  maxAttempts = 8, baseDelayMs = 500, maxDelayMs = 15_000, jitterRatio = 0.2,
  sleep = defaultSleep, random = Math.random,
}: StreamWithReconnectOptions): Promise<StreamResult> {
  let lastEventId: string | null = null;
  let attempt = 0;
  let reconnects = 0;
  let serverRetry: number | null = null;
  for (;;) {
    if (signal?.aborted) return { lastEventId, attempts: attempt, reconnects, terminal: false };
    let terminal = false;
    try {
      const response = await connect(lastEventId, attempt);
      const result = await consumeSse(response, (event) => {
        if (event.id !== undefined) lastEventId = event.id;
        if (typeof event.retry === 'number') serverRetry = event.retry;
        if (isTerminal?.(event)) terminal = true;
        onEvent(event);
      });
      if (result.lastEventId !== null) lastEventId = result.lastEventId;
      // A clean end after a terminal frame is success. A clean end WITHOUT one
      // means the server or an intermediary proxy closed early -> reconnect.
      if (terminal || signal?.aborted) return { lastEventId, attempts: attempt, reconnects, terminal };
      attempt += 1;
      if (attempt > maxAttempts) return { lastEventId, attempts: attempt, reconnects, terminal: false };
    } catch (error) {
      if (signal?.aborted || isAbortError(error)) return { lastEventId, attempts: attempt, reconnects, terminal: false };
      onError?.(error);
      attempt += 1;
      if (attempt > maxAttempts) throw error;
    }
    reconnects += 1;
    const delay = serverRetry !== null ? Math.min(serverRetry, maxDelayMs) : computeBackoff(attempt, { baseDelayMs, maxDelayMs, jitterRatio, random });
    onReconnect?.({ attempt, delayMs: delay, lastEventId });
    await sleep(delay, signal);
  }
}
