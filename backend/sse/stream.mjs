// -----------------------------------------------------------------------------
// Server-Sent Events streaming primitives.
//
// The run timeline (`GET /runs/:id/events`), the Creation Studio timeline
// (`GET /creation/jobs/:id/events`) and the chat stream (`POST /chat/stream`)
// all speak SSE. They previously shared three gaps that let a flaky network
// silently lose data:
//
//   1. NO RESUME: a reconnecting client always restarted from sequence 0, so a
//      dropped socket re-delivered (or skipped) events. We now honour the
//      standard `Last-Event-ID` request header, with a `?since=` query fallback
//      for clients/proxies that strip the header.
//   2. NO KEEP-ALIVE: an idle stream was silently reaped by proxies and load
//      balancers (Render/Vercel edge included). We now emit periodic comment
//      heartbeats, which every conformant SSE client ignores.
//   3. NO OBSERVABILITY: a dropped stream left no trace. Every lifecycle step
//      (open / resume / close / disconnect) is now a structured JSON log line.
//
// Everything here is dependency-free and injectable (the response object, the
// clock and the logger are all parameters) so it is unit-testable without a
// live socket.
// -----------------------------------------------------------------------------

export const DEFAULT_HEARTBEAT_MS = 15_000;

/** Coerce a raw cursor value to a non-negative integer, or null when invalid. */
function toCursor(value) {
  if (value === undefined || value === null) return null;
  const text = String(value).trim();
  if (!text) return null;
  const parsed = Number.parseInt(text, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

/**
 * Resolve the resume cursor for a (re)connecting SSE client.
 *
 * Precedence: the `Last-Event-ID` request header (the SSE standard, sent
 * automatically by EventSource and by our own reconnecting client) wins; then a
 * `?since=` query parameter (used by the non-streaming events endpoint and as a
 * header-less fallback). Anything missing or malformed falls back to `fallback`.
 */
export function parseResumeCursor(request, fallback = 0) {
  const header = request?.headers?.['last-event-id'];
  const raw = Array.isArray(header) ? header[0] : header;
  const fromHeader = toCursor(raw);
  if (fromHeader !== null) return fromHeader;
  const url = request?.url;
  if (typeof url === 'string' && url.includes('since=')) {
    try {
      const fromQuery = toCursor(new URL(url, 'http://localhost').searchParams.get('since'));
      if (fromQuery !== null) return fromQuery;
    } catch { /* malformed URL: fall through to the fallback */ }
  }
  return fallback;
}

/**
 * A small SSE writer that is safe against a client that has already gone away
 * (writes become no-ops instead of throwing), emits comment heartbeats, and
 * tracks frame/heartbeat counters so the lifecycle log can report them.
 */
export function createSseChannel(response, { heartbeatMs = DEFAULT_HEARTBEAT_MS, request, label = 'sse', logger } = {}) {
  let closed = Boolean(response?.writableEnded);
  let frames = 0;
  let heartbeats = 0;
  let timer = null;
  const onClose = () => { closed = true; };
  request?.on?.('close', onClose);

  const safeWrite = (chunk) => {
    if (closed || response?.writableEnded || response?.destroyed) return false;
    try { response.write(chunk); return true; } catch { closed = true; return false; }
  };

  const channel = {
    get closed() { return closed; },
    get frames() { return frames; },
    get heartbeats() { return heartbeats; },
    /** Write one `id:`/`event:`/`data:` frame. `data` may be a raw string or JSON-able. */
    write({ id, event, data } = {}) {
      let frame = '';
      if (id !== undefined && id !== null) frame += `id: ${id}\n`;
      if (event) frame += `event: ${event}\n`;
      frame += `data: ${typeof data === 'string' ? data : JSON.stringify(data ?? {})}\n\n`;
      if (safeWrite(frame)) { frames += 1; return true; }
      return false;
    },
    /** Write an SSE comment line (ignored by every conformant client). */
    comment(text = '') { return safeWrite(`: ${text}\n\n`); },
    /** Emit a single heartbeat comment. Returns false when the client is gone. */
    heartbeat() { if (channel.comment(`hb ${Date.now()}`)) { heartbeats += 1; return true; } return false; },
    /** Start the periodic heartbeat. Idempotent; a no-op when `heartbeatMs <= 0`. */
    startHeartbeat() {
      if (timer || !(heartbeatMs > 0)) return;
      timer = setInterval(() => { if (closed) { channel.stopHeartbeat(); return; } channel.heartbeat(); }, heartbeatMs);
      timer.unref?.();
    },
    stopHeartbeat() { if (timer) { clearInterval(timer); timer = null; } },
    /** Emit a terminal `close` frame (with an optional status) and end the response. */
    end(status) {
      channel.stopHeartbeat();
      if (status !== undefined) channel.write({ event: 'close', data: { status } });
      if (!response?.writableEnded) { try { response.end(); } catch { /* already gone */ } }
      closed = true;
    },
    /** Detach the close listener (call once the stream is finished). */
    dispose() { channel.stopHeartbeat(); request?.off?.('close', onClose); },
  };
  return channel;
}

/** Structured, never-throwing SSE lifecycle log (one JSON line per event). */
export function logSse(logger, level, event, fields = {}) {
  try {
    const sink = logger ?? console;
    const line = JSON.stringify({ at: new Date().toISOString(), level, event, ...fields });
    const fn = typeof sink[level] === 'function' ? sink[level] : sink.log;
    if (typeof fn === 'function') fn.call(sink, line);
  } catch { /* logging must never break a stream */ }
}
