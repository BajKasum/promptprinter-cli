# PromptPrinter in your terminal

Tell Finn what you want, answer one short question, get one finished prompt that works in any AI. This is the terminal client of [PromptPrinter](https://promptprinter.app): the same account, the same Finn, your conversations also show up in the browser.

> **Status: in development, not on npm yet.** Sign-in and chat work. `/pp --kontext` (sending local project context) comes next.

```text
> /pp landing page for a hairdresser
Finn: Two quick things: who reads it, and what tone do you want?
> people from the neighbourhood, casual
Finn: Here is your prompt.
┌─ Prompt ─────────────────────────────────────────────
│ ...
└──────────────────────────────────────────────────────
/copy copy   /save save   /pp new prompt
```

## Run it from source

Needs Node 22 or newer. No dependencies.

```bash
git clone https://github.com/BajKasum/promptprinter-cli.git
cd promptprinter-cli
node bin/promptprinter.mjs
```

On first start the program shows a code. Open the address it shows, sign in if needed, type the code and confirm. There is no password in the terminal.

A Free account chats with its own AI key, which you add once [in the browser](https://promptprinter.app/settings). The terminal never sees that key.

## Commands

| In the program | |
|---|---|
| `/pp <idea>` | new prompt: Finn asks briefly, then prints it |
| `/new` | new conversation |
| `/copy` | copy the latest prompt |
| `/save [file]` | save the latest prompt as Markdown, never overwrites |
| `/whoami` | show account, plan and key |
| `/login`, `/logout` | sign in, sign this device out |
| `/help`, `/exit` | |

Anything else you type goes to Finn. `Ctrl+C` stops a running reply; at the empty prompt it quits.

From the shell: `promptprinter login`, `logout`, `whoami`, `--version`, `--help`.

## What it stores and sends

- **On your computer:** one file, `session.json`, in `%APPDATA%\promptprinter` (Windows) or `~/.config/promptprinter`. It holds your sign-in and is readable only by you on Linux and macOS (`0600`); on Windows it relies on the permissions of your user folder. Anyone who can read this file can act as you until the session is revoked. It holds no AI provider key.
- **To PromptPrinter:** your computer's name when signing in (shown on the confirmation page), then what you type. The server stores each conversation like any chat in the browser and sends it to the AI provider of your account. No telemetry.
- `promptprinter logout` ends this one session. Signing out in the browser ends all of them.

## Settings

| Variable | |
|---|---|
| `NO_COLOR` | no colours |
| `PROMPTPRINTER_LANG` | `de` or `en`, otherwise taken from your system |
| `PROMPTPRINTER_NO_BROWSER` | do not open the browser when signing in |
| `PROMPTPRINTER_CONFIG_DIR` | another folder for the sign-in file |
| `PROMPTPRINTER_URL` | another server, `https` only (`http` only on this computer); a sign-in is never sent to another server |

## Development

```bash
npm test          # tests against a local stub server
npm run check     # syntax
npm run mutation  # breaks each safeguard, the tests must notice
npm run contract  # compares the server's interface with the pinned version
```

MIT, see [LICENSE](LICENSE). Security reports: [SECURITY.md](SECURITY.md).
