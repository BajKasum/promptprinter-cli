// Wie `extractPrompt` im Haupt-Repo (shared/lib/saved-prompts.ts), damit /copy und /save im Terminal
// denselben Text liefern wie "Prompt speichern" im Browser: bevorzugt der letzte Block vom Typ `text`,
// sonst der längste. Der Abschluss darf mitten in der Zeile stehen, glm-4.5-air schreibt ihn oft so.
const FENCE = /```([^\n`]*)\n([\s\S]*?)```/g;

export function extractPrompt(markdown) {
  const blocks = [];
  for (const match of markdown.matchAll(FENCE)) {
    const body = match[2].replace(/\n$/, "").trim();
    if (body) blocks.push({ lang: match[1].trim().toLowerCase(), body });
  }
  if (blocks.length === 0) return null;
  const text = blocks.filter((block) => block.lang === "text");
  if (text.length > 0) return text[text.length - 1].body;
  return blocks.reduce((longest, block) => (block.body.length > longest.body.length ? block : longest)).body;
}
