# Authentication between the server and Make (staged)

**Goal:** Make refuses any call to the webhook that does not carry the shared key. The key lives in two places only: the Make keychain and Vercel. It never appears in chat, code, logs or a document.

**Hook:** `gateway-webhook`, id 3873851, scenario 7867409. Every email route (summary, support, payment, recovery) goes through it, so enforcement on the hook covers every route at once, before any route runs.

## Current state (16/10)
- **Sending side, done:** `lib/notify.js` adds the `x-make-apikey` header to every call to Make when `MAKE_NOTIFY_KEY` is set.
  - Test AB7 checks that the header is sent and that the key never appears in the body.
  - Without the variable nothing changes.
- **Receiving side: not enforced.** The hook currently accepts calls without a key.
- **What does not count:** the `production` field in the request body is not proof of anything. Recipients in Preview are restricted by the server (`allowedRecipient`) and by the filter on route 35, not by that field.

## Email budget for the test (so a limit block is not read as an authentication failure)
- **The summary limit:** two summaries per address in a **rolling 24-hour window**. It counts summaries in the `pending`, `sent` and `failed` states.
  - **Trap:** a summary that Make refuses for lack of a key stays `pending` and counts toward the limit. So a summary is not a good tool for checking authentication.
  - **The limits stay as they are.** Nothing is raised or bypassed for the test.
- **How to check authentication without using the limit:** the Make checks run on the **support** route (`/api/support`, `a=support`), not on the summary.
  - Checked in the scenario: route 31 sends only to the owner's fixed address (`ActionSendMeEmail` to alongerber@gmail.com), whatever the address in the request.
  - That route has no summary limit, only 5 requests per minute per IP.
  - Authentication is checked on the hook, before any route runs, so a pass on the support route proves it for every route.
- **Summary emails to alongerber@gmail.com during the test:** two at most in 24 hours.
  1. `allowed` in the live check (`repeat` is a duplicate and does not count).
  2. One live check of Meital after stage 2, Chrome in a text chat on Preview.
  - The ten simulations mock `send_summary`, so they do not send.
  - Forbidden addresses are stored as `not_allowed` and do not count toward the limit.
  - **A third summary only 24 hours after the first:** I give the exact time from the database row, without sending.

## How to read a result
| What came back | Meaning | What it does not mean |
|---|---|---|
| `state: limited` | The server's limit (address, order or daily). **Did not reach Make** | Not an authentication failure |
| `state: not_allowed` | An address that is forbidden in Preview. Did not reach Make | Not a failure |
| `state: sent` | Make answered `{"ok":true}` | It does not mean the email arrived. That is checked in Gmail |
| `state: queued` or `failed` | Make did not answer ok (refusal, error or timeout). The request waits for a retry | Not by itself an authentication failure. Read the error in the dashboard or the Make log |
| Support: `saved: true`, email arrives | Make received the call and ran it | — |
| Support: `saved: true`, no email | Make refused or failed. The request stays `pending` in the dashboard with its error | — |

## Stages (in order; no stage before the previous one has passed)
1. **Alon or Chrome:**
   - Create one random value, at least 32 characters.
   - In Make, Keys: add a new "Webhook API key" key with that value, named `front-notify`.
   - In Vercel, project `front-studio`: add `MAKE_NOTIFY_KEY` with the same value, for the **Preview** environment only.
   - Redeploy Preview.
   - Do not send the value in chat.
2. **Me (Claude):** confirm in Vercel that the variable name exists, by name only; that the new deployment is READY; and in Make that the key exists, by its id only.
   - **Chrome, check A:** one support request from the console (below). Expected: `saved: true`, and one email to the owner, "[<environment>] פנייה P-… · עזרה בהזמנה". This checks that the header does not break anything.
3. **Me, only after 2:** on hook 3873851, set `authenticationMethod` = `{apiKeyHeaderName: "x-make-apikey", apikey: [<key id>]}`.
   - The active connection is not taken down. The change is to the hook only, not to the scenario or its routes.
4. **Chrome, immediately after 3:**
   - **Positive check B:** another support request. Expected: an email arrives and Make shows a successful run.
   - **Negative check C:** a direct POST to the hook URL without the header, with the body `{"a":"auth-check"}`.
     - **Why this body:** no route matches it, so **no email is sent in any case**.
     - **Expected:** Make refuses (a 401/403-class answer) and no run is recorded.
     - **Failure:** an "Accepted" answer means the hook is not enforcing.
     - **The URL:** Chrome takes it from Make, and it is not pasted into chat.
   - **If B fails:** I remove `authenticationMethod` from the hook immediately and report. Support requests that did not get through stay in the queue and are retried; nothing is lost.
5. **Before the Production launch:** `MAKE_NOTIFY_KEY` must also be set in Production with the same value. Without it, Production emails are refused by Make and wait in the retry queue.
   - Today `main` does not call this hook. Checked: there is no `MAKE_NOTIFY_URL` there. So enforcement does not affect the live site.
   - It does affect the launch, as a mandatory item in `LAUNCH_PRODUCTION.md`.

**Console for checks A/B (Preview, "essential only" in the cookie banner):**
```js
fetch('/api/support',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({client_ref:crypto.randomUUID(),email:'alongerber@gmail.com',message:'TEST MAKE-AUTH '+new Date().toISOString(),source:'home'})}).then(r=>r.json()).then(j=>console.log(JSON.stringify(j)))
```

## Rollback
- **Removing the authentication from the hook:** an immediate return to the previous state.
- **Removing the variable from Vercel:** the server stops sending the header. That only matters if the hook is not enforcing.
- **Rotating the key:** a new key in Make, update Vercel and redeploy, then switch the hook to the new key id, then delete the old key.
