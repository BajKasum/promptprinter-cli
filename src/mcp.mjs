import { createInterface } from "node:readline";
import { ApiError } from "./api.mjs";
import { createConversation, MAX_USER_MESSAGE_CHARS, runTurn } from "./chat.mjs";
import { describeError } from "./errors.mjs";
import { extractPrompt } from "./extract-prompt.mjs";
import { NotLoggedInError } from "./session.mjs";
import { sanitize } from "./text.mjs";

/**
 * `promptprinter mcp`: ein MCP-Server über stdio, ohne Abhängigkeit. JSON-RPC 2.0, eine Nachricht je Zeile; stdout gehört
 * nur dem Protokoll, alles andere geht nach stderr.
 *
 * Spezifikation: https://modelcontextprotocol.io/specification/2026-07-28 (gelesen am 08.11.2026). Seit dieser Version
 * gibt es keinen Handschlag mehr: jede Anfrage nennt Version und Fähigkeiten des Clients in `params._meta`
 * (`io.modelcontextprotocol/protocolVersion`, `…/clientCapabilities`), Ergebnisse tragen `resultType`, und `server/discover`
 * nennt die unterstützten Versionen. Claude Code, Claude Desktop und andere Clients sprechen heute oft noch die älteren
 * Versionen mit `initialize` und `notifications/initialized` (bis 2025-11-25). Dieser Server kann beides ("dual-era" in der
 * Spezifikation): ein `initialize` wählt die ältere Art für diesen Prozess, eine Anfrage mit `_meta` wird nach der neuen
 * beantwortet.
 *
 * Angemeldet wird nie hier: der Server nimmt die Sitzung, die `promptprinter` im Terminal gespeichert hat, und erneuert sie
 * wie dort. Ohne Sitzung meldet jedes Werkzeug einen Fehler, der sagt, was zu tun ist.
 */
export const MODERN_VERSIONS = ["2026-07-28"];
export const LEGACY_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26"];
const META_VERSION = "io.modelcontextprotocol/protocolVersion";
const META_CAPABILITIES = "io.modelcontextprotocol/clientCapabilities";
const META_SERVER = "io.modelcontextprotocol/serverInfo";

const PARSE_ERROR = -32700;
const INVALID_REQUEST = -32600;
const METHOD_NOT_FOUND = -32601;
const INVALID_PARAMS = -32602;
const INTERNAL_ERROR = -32603;
const UNSUPPORTED_VERSION = -32022;

const MAX_LINE_CHARS = 1_000_000;
const MAX_QUERY_CHARS = 200;
const MAX_CONVERSATIONS = 50;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const INSTRUCTIONS =
  "PromptPrinter turns a rough idea into one finished, paste-ready prompt. Call create_prompt with the idea. Finn " +
  "(PromptPrinter's assistant) usually asks one short question first: show it to the user and call create_prompt again " +
  "with their answer as `idea` and the returned `conversation_id`. The result then contains the finished prompt.";

export const TOOLS = [
  {
    name: "create_prompt",
    title: "Create a prompt with PromptPrinter",
    description:
      "Send an idea to Finn, PromptPrinter's prompt assistant. Returns either Finn's follow-up question (status " +
      "\"question\") or the finished prompt (status \"prompt\"), always with a conversation_id. To answer a question, call " +
      "again with the user's answer as `idea` and that conversation_id. The conversation is stored in the user's " +
      "PromptPrinter account like any chat.",
    inputSchema: {
      type: "object",
      properties: {
        idea: {
          type: "string",
          minLength: 1,
          maxLength: MAX_USER_MESSAGE_CHARS,
          description: "The idea for the prompt, or the answer to Finn's question when conversation_id is set.",
        },
        conversation_id: {
          type: "string",
          description: "From an earlier create_prompt result, to answer Finn's question in the same conversation.",
        },
      },
      required: ["idea"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  },
  {
    name: "list_saved_prompts",
    title: "List saved prompts",
    description: "List the prompts the user saved in PromptPrinter, newest first. Optional search in title and text.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", maxLength: MAX_QUERY_CHARS, description: "Search words for title and prompt text." },
        limit: { type: "integer", minimum: 1, maximum: 50, description: "How many to return (default 20)." },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  {
    name: "get_saved_prompt",
    title: "Get a saved prompt",
    description: "Get the full text of one saved prompt by its id (from list_saved_prompts).",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string", description: "The id of the saved prompt." } },
      required: ["id"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
];

/** Ein Fehler, der als JSON-RPC-Fehler zurückgeht (nicht als Werkzeugfehler). */
class RpcError extends Error {
  constructor(code, message, data) {
    super(message);
    this.code = code;
    this.data = data;
  }
}

/** Ein Werkzeugfehler: das Modell bekommt den Text und kann damit weitermachen oder dem Nutzer sagen, was fehlt. */
class ToolError extends Error {}

/**
 * Der Server ohne Ein- und Ausgabe: `handle(message)` gibt die Antwort zurück oder `null` (Benachrichtigung, Antwort eines
 * Clients). So lässt er sich im Test Nachricht für Nachricht prüfen.
 */
export function createMcpServer({ api, auth, t, version, log = () => {} }) {
  const serverInfo = { name: "promptprinter", title: "PromptPrinter", version };
  const conversations = new Map();
  const running = new Map();
  let legacyVersion = null;

  function errorText(err) {
    if (err instanceof ToolError) return err.message;
    if (err instanceof NotLoggedInError || (err instanceof ApiError && err.status === 401)) return t("mcpLogin");
    return describeError(err, { t, server: api.server });
  }

  async function createPrompt(args, signal) {
    const idea = typeof args.idea === "string" ? args.idea.trim() : "";
    if (!idea) throw new ToolError(t("mcpIdeaMissing"));
    if (idea.length > MAX_USER_MESSAGE_CHARS) {
      throw new ToolError(t("tooLong", { length: idea.length, max: MAX_USER_MESSAGE_CHARS }));
    }
    let conversation;
    if (args.conversation_id !== undefined) {
      conversation = typeof args.conversation_id === "string" ? conversations.get(args.conversation_id) : undefined;
      if (!conversation) throw new ToolError(t("mcpUnknownConversation"));
    } else {
      conversation = createConversation();
    }
    const result = await runTurn({ auth, api, conversation, text: idea, signal });
    if (result.kind === "error") throw new ToolError(t("generic", { detail: result.detail }));
    if (result.kind !== "done") throw new ToolError(t(result.kind === "protocol" ? "protocol" : "dropped"));
    if (conversation.id) {
      conversations.delete(conversation.id);
      conversations.set(conversation.id, conversation);
      while (conversations.size > MAX_CONVERSATIONS) conversations.delete(conversations.keys().next().value);
    }
    const reply = result.text.trim();
    const prompt = extractPrompt(reply);
    const id = conversation.id ?? null;
    if (prompt) {
      return {
        content: [{ type: "text", text: `${prompt}\n\n---\n${t("mcpPromptNote", { id: id ?? "-" })}` }],
        structuredContent: { status: "prompt", prompt, reply, conversation_id: id },
      };
    }
    return {
      content: [{ type: "text", text: `${reply}\n\n---\n${t("mcpQuestionNote", { id: id ?? "-" })}` }],
      structuredContent: { status: "question", question: reply, conversation_id: id },
    };
  }

  async function listSaved(args) {
    const query = args.query === undefined ? "" : args.query;
    if (typeof query !== "string" || query.length > MAX_QUERY_CHARS) throw new ToolError(t("mcpBadQuery", { max: MAX_QUERY_CHARS }));
    const limit = args.limit === undefined ? 20 : args.limit;
    if (!Number.isInteger(limit) || limit < 1 || limit > 50) throw new ToolError(t("mcpBadLimit"));
    const body = await auth.withToken((token) => api.savedPrompts(token, { query: query.trim(), limit }));
    const prompts = (Array.isArray(body?.prompts) ? body.prompts : [])
      .filter((p) => typeof p?.id === "string")
      .map((p) => ({
        id: sanitize(p.id),
        title: sanitize(String(p.title ?? "")),
        createdAt: sanitize(String(p.createdAt ?? "")),
        preview: sanitize(String(p.preview ?? "")),
      }));
    const text =
      prompts.length === 0
        ? t("mcpNoSaved")
        : prompts.map((p, i) => `${i + 1}. ${p.title} (${p.createdAt.slice(0, 10)})\n   id: ${p.id}\n   ${p.preview}`).join("\n");
    return { content: [{ type: "text", text }], structuredContent: { prompts } };
  }

  async function getSaved(args) {
    if (typeof args.id !== "string" || !UUID.test(args.id)) throw new ToolError(t("mcpBadId"));
    let body;
    try {
      body = await auth.withToken((token) => api.savedPrompt(token, args.id));
    } catch (err) {
      if (err instanceof ApiError && (err.status === 404 || err.status === 400)) throw new ToolError(t("mcpNotFound"));
      throw err;
    }
    const saved = {
      id: sanitize(String(body?.id ?? args.id)),
      title: sanitize(String(body?.title ?? "")),
      content: sanitize(String(body?.content ?? "")),
      createdAt: sanitize(String(body?.createdAt ?? "")),
    };
    return { content: [{ type: "text", text: saved.content }], structuredContent: saved };
  }

  const handlers = { create_prompt: createPrompt, list_saved_prompts: listSaved, get_saved_prompt: getSaved };

  async function callTool(params, signal) {
    const name = params?.name;
    const handler = typeof name === "string" && Object.hasOwn(handlers, name) ? handlers[name] : null;
    if (!handler) throw new RpcError(INVALID_PARAMS, `Unknown tool: ${String(name)}`);
    const args = params.arguments ?? {};
    if (typeof args !== "object" || Array.isArray(args)) throw new RpcError(INVALID_PARAMS, "arguments must be an object");
    try {
      return { ...(await handler(args, signal)), isError: false };
    } catch (err) {
      if (err instanceof RpcError) throw err;
      if (!(err instanceof ToolError)) log(`${name}: ${err?.message ?? err}`);
      return { content: [{ type: "text", text: errorText(err) }], isError: true };
    }
  }

  // Welche Art der Anfrage: mit `_meta`-Version die neue, nach `initialize` die ältere, sonst ein Fehler.
  function eraOf(method, params) {
    const meta = params?._meta;
    const requested = meta && typeof meta === "object" ? meta[META_VERSION] : undefined;
    if (requested !== undefined) {
      if (!MODERN_VERSIONS.includes(requested)) {
        throw new RpcError(UNSUPPORTED_VERSION, "Unsupported protocol version", {
          supported: [...MODERN_VERSIONS, ...LEGACY_VERSIONS],
          requested,
        });
      }
      if (!meta[META_CAPABILITIES] || typeof meta[META_CAPABILITIES] !== "object") {
        throw new RpcError(INVALID_PARAMS, `Missing _meta["${META_CAPABILITIES}"]`);
      }
      return "modern";
    }
    if (legacyVersion || method === "ping") return "legacy";
    throw new RpcError(INVALID_PARAMS, `Missing _meta["${META_VERSION}"]; send initialize first or use ${MODERN_VERSIONS[0]}`);
  }

  async function dispatch(method, params, signal) {
    if (method === "initialize") {
      const requested = params?.protocolVersion;
      legacyVersion = LEGACY_VERSIONS.includes(requested) ? requested : LEGACY_VERSIONS[0];
      return {
        era: "legacy",
        result: { protocolVersion: legacyVersion, capabilities: { tools: {} }, serverInfo, instructions: INSTRUCTIONS },
      };
    }
    const era = method === "server/discover" ? "modern" : eraOf(method, params);
    if (method === "server/discover") {
      if (params?._meta?.[META_VERSION] !== undefined) eraOf(method, params);
      return {
        era,
        result: {
          supportedVersions: [...MODERN_VERSIONS, ...LEGACY_VERSIONS],
          capabilities: { tools: {} },
          instructions: INSTRUCTIONS,
        },
      };
    }
    if (method === "ping") return { era, result: {} };
    if (method === "tools/list") return { era, result: { tools: TOOLS } };
    if (method === "tools/call") return { era, result: await callTool(params, signal) };
    throw new RpcError(METHOD_NOT_FOUND, `Method not found: ${method}`);
  }

  async function handle(message) {
    if (Array.isArray(message)) return reply(null, null, new RpcError(INVALID_REQUEST, "Batches are not supported"));
    if (!message || typeof message !== "object" || message.jsonrpc !== "2.0") {
      return reply(message?.id ?? null, null, new RpcError(INVALID_REQUEST, "Invalid request"));
    }
    const { id, method, params } = message;
    if (typeof method !== "string") return null; // eine Antwort des Clients: dieser Server fragt nie etwas
    if (id === undefined) {
      if (method === "notifications/cancelled") running.get(params?.requestId)?.abort();
      return null;
    }
    if ((typeof id !== "string" && typeof id !== "number") || (params !== undefined && (typeof params !== "object" || params === null))) {
      return reply(typeof id === "string" || typeof id === "number" ? id : null, null, new RpcError(INVALID_REQUEST, "Invalid request"));
    }
    const controller = new AbortController();
    running.set(id, controller);
    try {
      const { era, result } = await dispatch(method, params, controller.signal);
      if (controller.signal.aborted) return null; // abgebrochen: keine Nachricht mehr dazu
      return reply(id, era === "modern" ? { resultType: "complete", ...result, _meta: { [META_SERVER]: serverInfo } } : result);
    } catch (err) {
      if (controller.signal.aborted) return null;
      if (err instanceof RpcError) return reply(id, null, err);
      log(`${method}: ${err?.message ?? err}`);
      return reply(id, null, new RpcError(INTERNAL_ERROR, "Internal error"));
    } finally {
      running.delete(id);
    }
  }

  return { handle };
}

function reply(id, result, error) {
  if (error) {
    const body = { code: error.code, message: error.message };
    if (error.data !== undefined) body.data = error.data;
    return { jsonrpc: "2.0", id, error: body };
  }
  return { jsonrpc: "2.0", id, result };
}

/**
 * Liest Zeilen von `input`, schreibt Antworten nach `output`. Anfragen laufen nebeneinander (ein langer create_prompt hält
 * kein ping auf). Endet, wenn die Eingabe endet und alle Antworten geschrieben sind.
 */
export function serveStdio({ input, output, server, log }) {
  const rl = createInterface({ input, crlfDelay: Infinity, terminal: false });
  const pending = new Set();
  const send = (message) => {
    if (message) output.write(`${JSON.stringify(message)}\n`);
  };
  rl.on("line", (line) => {
    if (!line.trim()) return;
    if (line.length > MAX_LINE_CHARS) {
      send(reply(null, null, new RpcError(INVALID_REQUEST, "Message too large")));
      return;
    }
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      send(reply(null, null, new RpcError(PARSE_ERROR, "Parse error")));
      return;
    }
    const work = server
      .handle(message)
      .then(send)
      .catch((err) => log(`unexpected: ${err?.message ?? err}`))
      .finally(() => pending.delete(work));
    pending.add(work);
  });
  return new Promise((resolve) => {
    rl.on("close", async () => {
      await Promise.allSettled([...pending]);
      resolve();
    });
  });
}
