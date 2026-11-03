// Die Texte des Programms, deutsch und englisch. Antworten des Modells kommen in der Sprache des Nutzers.
const MESSAGES = {
  de: {
    help: `Befehle im Programm:
  /pp <Idee>       neuer Prompt: Finn fragt kurz nach und druckt ihn
  /new             neues Gespräch
  /copy            letzten Prompt in die Zwischenablage
  /save [Datei]    letzten Prompt als Markdown speichern
  /whoami          Konto, Plan und Key anzeigen
  /login, /logout  anmelden, dieses Gerät abmelden
  /help            diese Liste
  /exit            beenden`,
    usage: `Aufruf: promptprinter [Befehl]

  (ohne Befehl)  Programm starten
  login          dieses Gerät anmelden
  logout         dieses Gerät abmelden
  whoami         Konto, Plan und Key anzeigen
  --version      Version anzeigen
  --help         diese Hilfe`,
    disclosure: "Finn ist eine KI und kann Fehler machen. Prüf wichtige Angaben selbst.",
    tips: "/pp <Idee>  Prompt drucken   /help  Befehle   /exit  Ende",
    actions: "/copy kopieren   /save speichern   /pp neuer Prompt",
    prompt: "Prompt",
    finn: "Finn",
    thinking: "Finn denkt nach ...",
    retrying: "Finn braucht etwas länger, neuer Versuch ({attempt} von {max}) ...",
    ppAsk: "Neues Gespräch. Was soll der Prompt leisten?",
    newChat: "Neues Gespräch.",
    unknownCommand: "Unbekannter Befehl: {command}. /help zeigt alle.",
    tooLong: "Das sind {length} Zeichen, höchstens {max} gehen in einer Nachricht.",
    stopped: "Abgebrochen.",
    dropped: "Die Verbindung ist abgerissen, bevor die Antwort fertig war. Schick die Nachricht noch einmal.",
    protocol: "Der Server hat etwas geschickt, das dieses Programm nicht versteht. Aktualisiere PromptPrinter.",
    persistFailed: "Die Antwort steht hier, wurde aber nicht in deinen Chats im Browser gespeichert.",
    noPromptYet: "Noch kein Prompt da. /pp <Idee> startet einen.",
    copied: "Prompt kopiert.",
    copyFailed: "Die Zwischenablage ist hier nicht erreichbar. /save speichert den Prompt als Datei.",
    saved: "Gespeichert: {path}",
    saveExists: "{path} gibt es schon, sie wird nicht überschrieben. Nenn einen anderen Namen.",
    saveFailed: "Speichern ging nicht: {reason}",
    loginStart: "Melde dieses Terminal im Browser an:",
    loginOpen: "  1. Öffne {url}",
    loginCode: "  2. Tippe diesen Code ab: {code}",
    loginWarning: "Bestätige nur, wenn du diesen Befehl gerade selbst gestartet hast.",
    loginWaiting: "Warte auf die Bestätigung im Browser ... (Strg+C bricht ab)",
    loginDone: "Angemeldet.",
    loginDenied: "Die Anmeldung wurde im Browser abgelehnt.",
    loginExpired: "Der Code ist abgelaufen. Starte die Anmeldung noch einmal.",
    loginInvalid: "Der Code gilt nicht mehr. Starte die Anmeldung noch einmal.",
    loginFailed: "Die Anmeldung ist am Server gescheitert. Starte sie noch einmal.",
    loginCancelled: "Anmeldung abgebrochen.",
    loginRequired: "Du bist nicht angemeldet. Starte `promptprinter login`.",
    loginAgain: "Deine Anmeldung gilt nicht mehr. /login meldet dich neu an.",
    alreadyIn: "Du bist schon angemeldet. /logout meldet dieses Gerät ab.",
    loggedOut: "Dieses Gerät ist abgemeldet.",
    logoutLocalOnly: "Die Anmeldung auf diesem Gerät ist gelöscht, der Server war aber nicht erreichbar. Abmelden im Browser beendet alle Sitzungen.",
    notLoggedIn: "Dieses Gerät ist nicht angemeldet.",
    account: "Angemeldet als {email}, {plan}, {key}",
    planFree: "Free",
    planPro: "Pro",
    keyOwn: "eigener Key",
    keyServer: "Server-Key",
    keyNone: "kein Key",
    needKey: "Zum Chatten brauchst du einen eigenen KI-Key. Trag ihn hier ein, das Terminal sieht ihn nie: {url}",
    needConsent: "Bevor Finn über den Server-Key läuft, stimme bitte im Browser zu: {url}",
    quota: "Dein Kontingent für diesen Monat ist aufgebraucht ({limit} Antworten). Ein eigener Key hebt die Grenze auf: {url}",
    keyUnreadable: "Dein gespeicherter Key lässt sich nicht lesen. Trag ihn neu ein: {url}",
    rateLimited: "Zu viele Anfragen. Versuch es in {seconds} Sekunden wieder.",
    network: "Der Server ist nicht erreichbar. Prüf deine Verbindung und versuch es noch einmal.",
    busy: "Ein anderes PromptPrinter-Fenster aktualisiert gerade die Anmeldung. Versuch es gleich noch einmal.",
    generic: "Das ging nicht: {detail}",
  },
  en: {
    help: `Commands:
  /pp <idea>       new prompt: Finn asks briefly, then prints it
  /new             new conversation
  /copy            copy the latest prompt
  /save [file]     save the latest prompt as Markdown
  /whoami          show account, plan and key
  /login, /logout  sign in, sign this device out
  /help            this list
  /exit            quit`,
    usage: `Usage: promptprinter [command]

  (no command)   start the program
  login          sign this device in
  logout         sign this device out
  whoami         show account, plan and key
  --version      show the version
  --help         this help`,
    disclosure: "Finn is an AI and can make mistakes. Double-check important details.",
    tips: "/pp <idea>  print a prompt   /help  commands   /exit  quit",
    actions: "/copy copy   /save save   /pp new prompt",
    prompt: "Prompt",
    finn: "Finn",
    thinking: "Finn is thinking ...",
    retrying: "Finn needs a bit longer, trying again ({attempt} of {max}) ...",
    ppAsk: "New conversation. What should the prompt do?",
    newChat: "New conversation.",
    unknownCommand: "Unknown command: {command}. /help shows all of them.",
    tooLong: "That is {length} characters, a message can have at most {max}.",
    stopped: "Stopped.",
    dropped: "The connection dropped before the reply was finished. Send your message again.",
    protocol: "The server sent something this program does not understand. Update PromptPrinter.",
    persistFailed: "The reply is here, but it was not saved to your chats in the browser.",
    noPromptYet: "No prompt yet. /pp <idea> starts one.",
    copied: "Prompt copied.",
    copyFailed: "The clipboard is not reachable here. /save stores the prompt as a file.",
    saved: "Saved: {path}",
    saveExists: "{path} already exists and will not be overwritten. Choose another name.",
    saveFailed: "Could not save: {reason}",
    loginStart: "Sign this terminal in using your browser:",
    loginOpen: "  1. Open {url}",
    loginCode: "  2. Type this code: {code}",
    loginWarning: "Only confirm if you started this command yourself just now.",
    loginWaiting: "Waiting for confirmation in the browser ... (Ctrl+C cancels)",
    loginDone: "Signed in.",
    loginDenied: "The sign-in was denied in the browser.",
    loginExpired: "The code expired. Start the sign-in again.",
    loginInvalid: "The code is no longer valid. Start the sign-in again.",
    loginFailed: "The sign-in failed on the server. Start it again.",
    loginCancelled: "Sign-in cancelled.",
    loginRequired: "You are not signed in. Run `promptprinter login`.",
    loginAgain: "Your sign-in is no longer valid. /login signs you in again.",
    alreadyIn: "You are already signed in. /logout signs this device out.",
    loggedOut: "This device is signed out.",
    logoutLocalOnly: "The sign-in on this device is deleted, but the server was not reachable. Signing out in the browser ends all sessions.",
    notLoggedIn: "This device is not signed in.",
    account: "Signed in as {email}, {plan}, {key}",
    planFree: "Free",
    planPro: "Pro",
    keyOwn: "own key",
    keyServer: "server key",
    keyNone: "no key",
    needKey: "To chat you need your own AI key. Add it here, the terminal never sees it: {url}",
    needConsent: "Before Finn can use the server key, please agree in your browser: {url}",
    quota: "Your quota for this month is used up ({limit} replies). Your own key removes the limit: {url}",
    keyUnreadable: "Your saved key cannot be read. Add it again: {url}",
    rateLimited: "Too many requests. Try again in {seconds} seconds.",
    network: "The server is not reachable. Check your connection and try again.",
    busy: "Another PromptPrinter window is updating the sign-in. Try again in a moment.",
    generic: "That did not work: {detail}",
  },
};

export function detectLang(env = process.env) {
  const explicit = env.PROMPTPRINTER_LANG || env.LC_ALL || env.LC_MESSAGES || env.LANG;
  const locale = explicit || Intl.DateTimeFormat().resolvedOptions().locale;
  return /^de\b|^de[_-]/i.test(locale) ? "de" : "en";
}

export function translator(lang) {
  const table = MESSAGES[lang] ?? MESSAGES.en;
  return (key, vars = {}) =>
    table[key].replace(/\{(\w+)\}/g, (whole, name) => (name in vars ? String(vars[name]) : whole));
}
