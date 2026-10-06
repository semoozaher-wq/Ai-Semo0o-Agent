// -----------------------------------------------------------------------------
// Server-Sent Events parsing.
//
// Both the run-events stream and the chat stream speak SSE, so the wire parsing
// lives here (dependency-free, so it is unit-testable without pulling in
// react-native). A frame is `event: <name>\ndata: <json>\n\n`; the reader loop
// must tolerate frames split across network chunks and multiple frames per chunk.
// -----------------------------------------------------------------------------

export interface SseEvent { event: string; data: unknown }

/**
 * Split a growing buffer into complete SSE frames. Returns the decoded events
 * plus the trailing partial frame to carry into the next read. Malformed JSON
 * payloads are dropped rather than throwing, so one bad frame cannot kill a
 * stream.
 */
export function parseSseBuffer(buffer: string): { events: SseEvent[]; rest: string } {
  const chunks = buffer.split('\n\n');
  const rest = chunks.pop() ?? '';
  const events: SseEvent[] = [];
  for (const chunk of chunks) {
    const lines = chunk.split('\n');
    const event = lines.find((line) => line.startsWith('event:'))?.slice(6).trim() || 'message';
    const data = lines.find((line) => line.startsWith('data:'))?.slice(5).trim();
    if (!data) continue;
    try { events.push({ event, data: JSON.parse(data) }); } catch { /* ignore malformed frame */ }
  }
  return { events, rest };
}

/**
 * Read an SSE `Response` to completion, invoking `onEvent` for each decoded
 * frame. Throws `BACKEND_SSE_<status>` when the response is not a usable stream.
 */
export async function consumeSse(response: Response, onEvent: (event: SseEvent) => void): Promise<void> {
  if (!response.ok || !response.body) throw new Error(`BACKEND_SSE_${response.status}`);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const next = await reader.read();
    if (next.done) break;
    buffer += decoder.decode(next.value, { stream: true });
    const parsed = parseSseBuffer(buffer);
    buffer = parsed.rest;
    for (const event of parsed.events) onEvent(event);
  }
}
