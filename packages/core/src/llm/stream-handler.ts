/**
 * Reusable NDJSON stream parser for LLM streaming responses.
 */
export async function* parseNdjsonStream<T = unknown>(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  options: { loggerName?: string } = {},
): AsyncGenerator<T> {
  const { loggerName = "stream-handler" } = options;
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) {
        continue;
      }
      try {
        yield JSON.parse(trimmed) as T;
      } catch {
        console.warn(`[${loggerName}] Skipping malformed NDJSON line:`, trimmed.slice(0, 120));
      }
    }
  }

  if (buffer.trim()) {
    try {
      yield JSON.parse(buffer.trim()) as T;
    } catch {
      console.warn(
        `[${loggerName}] Skipping malformed trailing data:`,
        buffer.trim().slice(0, 120),
      );
    }
  }
}
