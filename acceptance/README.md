# Acceptance run

The real program against a local PromptPrinter server, confirmed in the real `/cli` page. Not part of `npm test` and not in the npm package: it needs the main repository (not public), its local Supabase stack and Playwright.

```bash
node acceptance/run.mjs ../PromptPrinter e2e/cli-login.spec.ts e2e/cli-me.spec.ts e2e/mfa.spec.ts
```

The first argument is the main repository (default `../PromptPrinter`), everything after it goes to `playwright test`, here the server's own terminal and second-factor tests. Before the run: Docker, `npx --yes supabase@2.119.0 start` in the main repository, and `E2E_SUPABASE_CLI="npx --yes supabase@2.119.0"` if the Supabase CLI is not installed globally. Afterwards `supabase stop`.

`program.spec.ts` covers: sign in by code, account and plan, a Free account without key is refused, a prompt with a follow-up question, `/save`, `/copy`, sign out; and an account with a second factor, where `/cli` asks for the authenticator code before the terminal can be approved. The model is the server's stub, not a real provider.
