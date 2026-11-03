import { parseSse, readChatEvent } from "./sse.mjs";
import { sanitize } from "./text.mjs";

// Grenzen des Servers (shared/lib/chat-limits.ts im Haupt-Repo).
export const MAX_USER_MESSAGE_CHARS = 8000;
const MAX_ASSISTANT_MESSAGE_CHARS = 40_000;
const MAX_TRANSCRIPT_MESSAGES = 24;
// Kommt so lange gar nichts, zählt die Verbindung als abgerissen. Ein Anbieter kann vor dem ersten Wort
// lange still sein (der Server wiederholt dann), danach kommen die Stücke in kurzen Abständen.
const IDLE_TIMEOUT_MS = 120_000;

/** Der Verlauf eines Gesprächs. Der Server speichert jeden Zug, schickt aber nichts zurück. */
export function createConversation() {
  let id;
  let messages = [];
  return {
    get id() {
      return id;
    },
    set id(value) {
      id = value;
    },
    reset() {
      id = undefined;
      messages = [];
    },
    request(text) {
      const body = { messages: [...messages, { role: "user", content: text }].slice(-MAX_TRANSCRIPT_MESSAGES) };
      if (id) body.conversationId = id;
      return body;
    },
    commit(text, reply) {
      messages.push({ role: "user", content: text });
      const content = reply.trim().slice(0, MAX_ASSISTANT_MESSAGE_CHARS);
      if (content) messages.push({ role: "assistant", content });
    },
  };
}

/**
 * Ein Zug: fragt, liest den Strom und meldet jedes Stück Text. Gibt immer ein Ergebnis zurück, ausser wenn
 * der Server schon vor dem Strom absagt (dann wirft `chat`, der Aufrufer zeigt die passende Meldung).
 * Text wird beim Lesen bereinigt und bleibt so im Verlauf.
 */
export async function runTurn({ auth, api, conversation, text, onDelta, onStatus, signal }) {
  const controller = new AbortController();
  const stop = () => controller.abort();
  signal?.addEventListener("abort", stop, { once: true });
  let idle;
  const arm = () => {
    clearTimeout(idle);
    idle = setTimeout(stop, IDLE_TIMEOUT_MS);
  };

  let reply = "";
  try {
    arm();
    const response = await auth.withToken((token) => api.chat(token, conversation.request(text), controller.signal));
    for await (const { event, data } of parseSse(response.body)) {
      arm();
      const parsed = readChatEvent(event, data);
      if (parsed.kind === "unknown") continue;
      if (parsed.kind === "invalid") return { kind: "protocol", text: reply };
      if (parsed.event === "meta") {
        if (parsed.data.conversationId) conversation.id = parsed.data.conversationId;
      } else if (parsed.event === "status") {
        onStatus?.(parsed.data);
      } else if (parsed.event === "delta") {
        const clean = sanitize(parsed.data.text);
        reply += clean;
        onDelta?.(clean);
      } else if (parsed.event === "error") {
        return { kind: "error", text: reply, detail: sanitize(parsed.data.detail) };
      } else if (parsed.event === "done") {
        if (parsed.data.conversationId) conversation.id = parsed.data.conversationId;
        conversation.commit(text, reply);
        return { kind: "done", text: reply, persistError: parsed.data.persistError ?? null };
      }
    }
    return { kind: "dropped", text: reply };
  } catch (err) {
    if (controller.signal.aborted) return { kind: signal?.aborted ? "stopped" : "dropped", text: reply };
    if (reply) return { kind: "dropped", text: reply };
    throw err;
  } finally {
    clearTimeout(idle);
    signal?.removeEventListener("abort", stop);
  }
}
