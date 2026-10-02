/**
 * Minimal, dependency-free HTTP + Server-Sent-Events client used by the real
 * model providers. Works on web, Node and React Native (with a graceful
 * non-streaming fallback when `response.body` is unavailable).
 */

export interface HttpInit {
  method?: 'GET' | 'POST';
  headers?: Record<string, string>;
  body?: unknown;
  signal?: AbortSignal;
  timeoutMs?: number;
}

export class HttpError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly payload?: unknown,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

function mergeSignals(signal: AbortSignal | undefined, timeoutMs: number | undefined) {
  if (!timeoutMs) return { signal, cleanup: () => {} };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const onAbort = () => controller.abort();
  if (signal) {
    if (signal.aborted) controller.abort();
    else signal.addEventListener('abort', onAbort);
  }
  return {
    signal: controller.signal,
    cleanup: () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    },
  };
}

async function parseError(response: Response): Promise<HttpError> {
  let payload: unknown;
  let message = `HTTP ${response.status} ${response.statusText}`;
  try {
    const text = await response.text();
    try {
      payload = JSON.parse(text);
      const err = (payload as { error?: { message?: string } | string }).error;
      if (typeof err === 'string') message = err;
      else if (err && typeof err === 'object' && err.message) message = err.message;
    } catch {
      if (text) message = text.slice(0, 400);
    }
  } catch {
    /* ignore */
  }
  return new HttpError(response.status, message, payload);
}

/** POST JSON and parse a JSON response, throwing {@link HttpError} on failure. */
export async function postJson<T>(url: string, init: HttpInit = {}): Promise<T> {
  const { signal, cleanup } = mergeSignals(init.signal, init.timeoutMs);
  try {
    const response = await fetch(url, {
      method: init.method ?? 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(init.headers ?? {}),
      },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      signal,
    });
    if (!response.ok) throw await parseError(response);
    return (await response.json()) as T;
  } finally {
    cleanup();
  }
}

/** GET JSON. */
export async function getJson<T>(
  url: string,
  init: HttpInit = {},
): Promise<T> {
  const { signal, cleanup } = mergeSignals(init.signal, init.timeoutMs);
  try {
    const response = await fetch(url, {
      method: 'GET',
      headers: { ...(init.headers ?? {}) },
      signal,
    });
    if (!response.ok) throw await parseError(response);
    return (await response.json()) as T;
  } finally {
    cleanup();
  }
}

/** GET raw bytes (used to download GitHub ZIP archives). */
export async function getBytes(
  url: string,
  init: HttpInit = {},
): Promise<Uint8Array> {
  const { signal, cleanup } = mergeSignals(init.signal, init.timeoutMs);
  try {
    const response = await fetch(url, {
      method: 'GET',
      headers: { ...(init.headers ?? {}) },
      signal,
    });
    if (!response.ok) throw await parseError(response);
    const buffer = await response.arrayBuffer();
    return new Uint8Array(buffer);
  } finally {
    cleanup();
  }
}

export interface SseEvent {
  event?: string;
  data: string;
}

/**
 * Stream Server-Sent Events from a POST endpoint.
 *
 * Throws {@link StreamingUnsupportedError} when the runtime cannot stream
 * (`response.body` missing), letting providers fall back to a single-shot
 * completion.
 */
export class StreamingUnsupportedError extends Error {
  constructor() {
    super('Streaming is not supported in this runtime');
    this.name = 'StreamingUnsupportedError';
  }
}

export async function* streamSse(
  url: string,
  init: HttpInit = {},
): AsyncGenerator<SseEvent> {
  const { signal, cleanup } = mergeSignals(init.signal, init.timeoutMs);
  try {
    const response = await fetch(url, {
      method: init.method ?? 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'text/event-stream',
        ...(init.headers ?? {}),
      },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      signal,
    });
    if (!response.ok) throw await parseError(response);

    const body = response.body as ReadableStream<Uint8Array> | null | undefined;
    if (!body || typeof body.getReader !== 'function') {
      throw new StreamingUnsupportedError();
    }

    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let boundary = buffer.indexOf('\n\n');
      while (boundary !== -1) {
        const rawEvent = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const parsed = parseSseBlock(rawEvent);
        if (parsed) yield parsed;
        boundary = buffer.indexOf('\n\n');
      }
    }
    // Flush any trailing event.
    const trailing = parseSseBlock(buffer);
    if (trailing) yield trailing;
  } finally {
    cleanup();
  }
}

function parseSseBlock(block: string): SseEvent | null {
  const lines = block.split('\n');
  let event: string | undefined;
  const dataLines: string[] = [];
  for (const line of lines) {
    if (line.startsWith('event:')) event = line.slice(6).trim();
    else if (line.startsWith('data:')) dataLines.push(line.slice(5).replace(/^ /, ''));
  }
  if (dataLines.length === 0) return null;
  return { event, data: dataLines.join('\n') };
}
