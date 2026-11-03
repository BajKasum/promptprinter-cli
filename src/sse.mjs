// Liest den Antwort-Strom von POST /api/chat: `event: <name>\ndata: <JSON>\n\n`. Bytes kommen in
// beliebigen Stücken, auch mitten in einem Zeichen oder einer Zeile, deshalb der eine Decoder im
// Stream-Modus und der Puffer. Ein am Ende unvollständiges Ereignis fällt weg: ohne Leerzeile ist
// es nicht fertig, und der Aufrufer merkt am fehlenden `done`, dass die Verbindung abriss.
export async function* parseSse(stream) {
  const decoder = new TextDecoder();
  let buffer = "";
  for await (const chunk of stream) {
    buffer += decoder.decode(chunk, { stream: true });
    let boundary;
    while ((boundary = nextBoundary(buffer)) !== null) {
      const block = buffer.slice(0, boundary.start);
      buffer = buffer.slice(boundary.end);
      const parsed = parseBlock(block);
      if (parsed) yield parsed;
    }
  }
}

function nextBoundary(buffer) {
  const match = /\r?\n\r?\n/.exec(buffer);
  return match ? { start: match.index, end: match.index + match[0].length } : null;
}

function parseBlock(block) {
  let event = "message";
  const data = [];
  for (const line of block.split(/\r?\n/)) {
    if (line.startsWith(":")) continue;
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    const value = colon === -1 ? "" : line.slice(colon + 1).replace(/^ /, "");
    if (field === "event") event = value;
    else if (field === "data") data.push(value);
  }
  return data.length > 0 ? { event, data: data.join("\n") } : null;
}

// Der Vertrag steht im Haupt-Repo (shared/lib/chat-stream.ts), scripts/check-contract.mjs merkt, wenn
// er sich ändert. Wie dort: Unbekanntes ist `unknown` und wird übergangen, damit der Server Ereignisse
// ergänzen kann, ohne alte Programme zu brechen; Kaputtes ist `invalid`, ein Protokollfehler.
const READERS = {
  meta: (d) => optionalStrings(d, ["conversationId", "userMessageId"]),
  status: (d) => typeof d.phase === "string",
  delta: (d) => typeof d.text === "string",
  done: (d) => optionalStrings(d, ["conversationId", "assistantMessageId", "persistError"]),
  error: (d) => typeof d.detail === "string",
};

function optionalStrings(data, fields) {
  return fields.every((field) => data[field] === undefined || typeof data[field] === "string");
}

export function readChatEvent(event, data) {
  if (!Object.hasOwn(READERS, event)) return { kind: "unknown", event };
  let json;
  try {
    json = JSON.parse(data);
  } catch {
    return { kind: "invalid", event };
  }
  if (json === null || typeof json !== "object" || !READERS[event](json)) return { kind: "invalid", event };
  return { kind: "event", event, data: json };
}
