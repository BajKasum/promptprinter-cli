import { homedir } from "node:os";
import { join } from "node:path";

export const DEFAULT_SERVER = "https://promptprinter.app";

export class ConfigError extends Error {}

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * Die Adresse des Servers. Ihm schickt das Programm das Token der Sitzung, deshalb nur https, und http
 * ausschliesslich auf dem eigenen Rechner (Entwicklung und Tests). Ein Tippfehler in der Variable soll
 * scheitern und nicht ein Token im Klartext übers Netz tragen.
 */
export function serverUrl(env = process.env) {
  const raw = env.PROMPTPRINTER_URL?.trim();
  if (!raw) return DEFAULT_SERVER;
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new ConfigError(`PROMPTPRINTER_URL is not a valid address: ${raw}`);
  }
  const local = LOCAL_HOSTS.has(url.hostname) || url.hostname.endsWith(".localhost");
  if (url.protocol !== "https:" && !(url.protocol === "http:" && local)) {
    throw new ConfigError(`PROMPTPRINTER_URL must use https (http only on this computer): ${raw}`);
  }
  return url.origin;
}

/** Der Ordner für die Sitzung: %APPDATA% unter Windows, sonst XDG_CONFIG_HOME oder ~/.config. */
export function configDir(env = process.env, platform = process.platform) {
  if (env.PROMPTPRINTER_CONFIG_DIR) return env.PROMPTPRINTER_CONFIG_DIR;
  if (platform === "win32" && env.APPDATA) return join(env.APPDATA, "promptprinter");
  return join(env.XDG_CONFIG_HOME || join(homedir(), ".config"), "promptprinter");
}
