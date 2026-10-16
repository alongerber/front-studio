# Authentication between the server and Make (staged)

**Goal:** Make refuses any call to the webhook that does not carry the shared key. The key lives in two places only: the Make keychain and Vercel. It never appears in chat, code, logs or a document.

**Hook:** `gateway-webhook`, id 3873851, scenario 7867409. Every email route (summary, support, payment, recovery) goes through it, so enforcement on the hook covers every route at once, before any route runs.

## Current state (16/10)
- **Sending side, done:** `lib/notify.js` adds the `x-make-apikey` header to every call to Make when `MAKE_NOTIFY_KEY` is set.
  - Test AB7 checks that the header is sent and that the key never appears in the body.
  - Without the variable nothing changes.
- **Receiving side: not enforced.** The hook currently accepts calls without a key.
- **What does not count:** the `production` field in the request body is not proof of anything. Recipients in Preview are restricted by the server (`allowedRecipient`) and by the filter on route 35, not by that field.

## Stages (in order; no stage before the previous one has passed)
1. **Alon or Chrome:**
   - Create one random value, at least 32 characters.
   - In Make, Keys: add a new "Webhook API key" key with that value, named `front-notify`.
   - In Vercel, project `front-studio`: add `MAKE_NOTIFY_KEY` with the same value, for the **Preview** environment only.
   - Redeploy Preview.
   - Do not send the value in chat.
2. **Me (Claude):**
   - Confirm in Vercel that the variable name exists, by name only.
   - Confirm that the new deployment is READY.
   - Confirm in Make that the key exists, by its id only.
   - Chrome runs one summary from the console script. Pass if it arrives (the hook is not enforcing yet, so this only checks that nothing broke).
3. **Me, only after 2:** on hook 3873851, set `authenticationMethod` = `{apiKeyHeaderName: "x-make-apikey", apikey: [<key id>]}`.
   - The active connection is not taken down. The change is to the hook only, not to the scenario or its routes.
4. **Chrome, immediately after 3:**
   - **Positive check:** a new summary from Preview (a new test order) arrives in Gmail, and Make shows a successful run.
   - **Negative check:** a direct POST to the hook URL without the header is refused, and Make shows no run.
   - **If the positive check fails:** I remove `authenticationMethod` from the hook immediately, which restores the previous state, and I report.
5. **Before the Production launch:** `MAKE_NOTIFY_KEY` must also be set in Production with the same value. Without it, Production emails are refused by Make and wait in the retry queue.
   - Today `main` does not call this hook. Checked: there is no `MAKE_NOTIFY_URL` there. So enforcement does not affect the live site.
   - It does affect the launch, as a mandatory item in `LAUNCH_PRODUCTION.md`.

## Rollback
- **Removing the authentication from the hook:** an immediate return to the previous state.
- **Removing the variable from Vercel:** the server stops sending the header. That only matters if the hook is not enforcing.
- **Rotating the key:** a new key in Make, update Vercel and redeploy, then switch the hook to the new key id, then delete the old key.
