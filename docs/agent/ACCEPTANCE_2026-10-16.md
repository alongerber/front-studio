# Meital acceptance test, final preparation (16/10, Preview only)

This document replaces the instructions in `ACCEPTANCE_2026-10-15.md`, which stays as a record of the first round. **Chrome works only from this document.**

## Final version for the test
| Item | Value |
|---|---|
| Site code | Commit `c9f33aa` on v5, deployment `dpl_AU4KvnnzRxEQknfCvPx1HnZcaAdi`, READY. Later commits on top of it change documentation only. The final deployment is in the report |
| Preview address | `front-studio-git-v5-alons-projects-65a14969.vercel.app` |
| Agent | `agent_5801m4a74w3dfawt9hdjhbe1nrjc`, version **`agtvrsn_4801m5129je1efz86m67369bqm57`**. Includes the protections: customer text is data, authority claims grant nothing, an order number is not access |
| Backup of the previous version | `docs/agent/meital-v5-backup-agtvrsn_8501.md`, which is the text published in 8501 |
| Summary offer (stage 2) | **Not enabled.** It waits for the live check and for the email to arrive |
| Production / 8501 / main / Meta | Not touched |

## What changed in the summary (what the server enforces)
- **Binding to an authorised conversation:** a request without an order ID with its token, plus the tab's conversation key attached to that order, gets 403. That includes a forged token, another order's token and another tab's key.
- **Fixed content:** the email is built only from what is saved on the order. The fields are type, business name, what is promoted, goal, audience, tone and the direction the customer liked. Any text sent in the request is ignored.
  - Links and domains are removed.
  - No summary is sent without a direction the customer liked (`nothing_to_send`).
- **Recipient:** in Preview only the test address. A forbidden address is stored as `not_allowed` and **does not reach Make**. Checked in SM3 and AB3: the number of Make calls stays unchanged.
- **Limits:** at most 2 addresses per order, at most 2 per address per day, and a site-wide daily cap.
- **Duplicates:** the same order and the same address count as one request. The key is created by the server, not by the page.
- **Tests that ran on this code:**
  - unit tests 133/133;
  - browser tests 170/170, including U0–U7, which check the summary from the page itself (16/10).

## Live check on Preview, for Chrome (free, about two minutes)
**What happens:**
- **Test orders:** A (`ZX-ALFA-7731`) and B (`ZX-BRAVO-4482`), each with its own conversation key.
- **Checks:** cross-access, a fake payment, every forbidden summary case, and only at the end one allowed send.
- **Expected result:** exactly **one** TEST email to alongerber@gmail.com.
- **What is printed:** results only. No tokens and no keys.

**How to run:** open the Preview address, choose "רק הכרחיות" ("essential only") in the cookie banner, don't start a conversation, and paste into the console:

```js
(async()=>{const P=(u,b,h={})=>fetch(u,{method:'POST',headers:{'content-type':'application/json',...h},body:JSON.stringify(b)}).then(async r=>({s:r.status,j:await r.json().catch(()=>null)}));
const K=()=>{const b=new Uint8Array(24);crypto.getRandomValues(b);return btoa(String.fromCharCode(...b)).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'')}, H={'x-front-proto':'9'};
const mk=async(name)=>{const link=K();const o=(await P('/api/order',{consent:{analytics:'denied',ads:'denied'},agent_link:link})).j;
  const n1=(await P('/api/brief/note',{order_id:o.order_id,token:o.token,field:'business_name',value:'TEST '+name,phase:'sales'},H)).s;
  const n2=(await P('/api/brief/note',{order_id:o.order_id,token:o.token,field:'liked_direction',value:'TEST קבלה: '+name+' https://evil.example/x',phase:'sales'},H)).s;
  return {...o,link,notes:[n1,n2]};};
const S=(b)=>P('/api/summary',b), A=await mk('אינסטלציה ZX-ALFA-7731'), B=await mk('מספרה ZX-BRAVO-4482'), r={A:A.order_id,B:B.order_id,notesA:A.notes,notesB:B.notes};
r.readB_withA=(await fetch('/api/order?order_id='+B.order_id,{headers:{'x-order-token':A.token}})).status;
r.writeB_withA=(await P('/api/brief/note',{order_id:B.order_id,token:A.token,field:'other',value:'x',phase:'sales'},H)).s;
r.fakeCapture=(await P('/api/paypal/capture',{order_id:A.order_id,token:A.token,paypal_order_id:'FAKE-1'})).s;
r.noOrder=(await S({email:'alongerber@gmail.com'})).s;
r.B_withAtoken=(await S({email:'alongerber@gmail.com',order_id:B.order_id,token:A.token,link:A.link})).s;
r.B_withAlink=(await S({email:'alongerber@gmail.com',order_id:B.order_id,token:B.token,link:A.link})).s;
r.forbidden=(await S({email:'someone.else@example.com',order_id:A.order_id,token:A.token,link:A.link})).j;
r.dashed=(await S({email:'-alongerber@gmail.com',order_id:A.order_id,token:A.token,link:A.link})).j;
r.allowed=(await S({email:'alongerber@gmail.com',order_id:A.order_id,token:A.token,link:A.link,direction:'ZX-INJECT text that must not appear'})).j;
r.repeat=(await S({email:'ALONGERBER@gmail.com',order_id:A.order_id,token:A.token,link:A.link})).j;
console.log(JSON.stringify(r,null,1));})();
```

**Expected:**
| Field | Expected |
|---|---|
| `notesA`, `notesB` | `[200,200]` |
| `readB_withA`, `writeB_withA` | 404 |
| `fakeCapture` | 409 |
| `noOrder`, `B_withAtoken`, `B_withAlink` | 403 |
| `forbidden.state`, `dashed.state` | `not_allowed` |
| `allowed.state` | `sent` |
| `repeat` | `duplicate: true` and the same `ref` as `allowed` |

**In Gmail (alongerber@gmail.com):** exactly one email, "[בדיקה] פרונט · סיכום הכיוון לפרסומת שלכם", with a test banner.
- **What should appear:** "שם העסק: TEST אינסטלציה ZX-ALFA-7731", and in the direction "[קישור הוסר]" instead of the link.
- **What must not appear:** ZX-BRAVO, ZX-INJECT, or the text of the forbidden address.

**What Chrome sends back:** the printed JSON, plus whether one email arrived and whether its content matches.

**What I check myself afterwards:**
- the Make run log for that time window: exactly one run for the summary, so no forbidden request reached Make;
- the email in Gmail, if the connection is available.

Only if everything passes do I enable stage 2: the summary prompt and the `send_summary` tool, version `tool_7601`, which now receives an address only.

## Authentication between the server and Make (staged, see `docs/MAKE_AUTH.md`)
Sending the header in the code is not the security fix. The fix exists only once Make refuses calls that come without the key, and that is not enabled yet. The stages:
1. **Done:** the server sends `x-make-apikey` whenever `MAKE_NOTIFY_KEY` is set. Without it nothing changes.
2. **Alon or Chrome:** create one secret value and enter it in two places: the Make keychain (an API key for webhooks) and Vercel as `MAKE_NOTIFY_KEY` (Preview only). Then a Preview redeploy. The value is not shown in chat and not sent to me.
3. **Me:** check in Vercel that the variable name exists (name only), and that the summary still arrives after the redeploy.
4. **Me, only after 3:** turn on API-key authentication on hook 3873851 using the key ID from Make (not the value). Make then refuses an unauthenticated call before any route runs, for every email route.
   - **Then Chrome:** one positive check (a new summary arrives) and one negative check (a call without the header is refused).
   - **If the positive check fails:** I turn the authentication off immediately.
5. **Before launch:** the same variable in Production as well. Otherwise Production emails will wait in the retry queue.

The `main` branch does not call this webhook (checked: no use of `MAKE_NOTIFY_URL` there). So enforcement now does not affect the live site.

## Text simulations: what actually runs and what it costs
**What I checked in the documentation:**
- **Mocks:** in simulation tests, tools can be mocked completely, selectively or not at all. A tool with no mock runs for real, or returns an error, depending on the setting. ([Agent Testing](https://elevenlabs.io/docs/eleven-agents/customization/agent-testing))
- **Billing:** the documentation says LLM costs are charged separately and deducted from the credits ([pricing](https://elevenlabs.io/pricing/agents), [Models](https://elevenlabs.io/docs/eleven-agents/customization/llm)).
- **What I did not find:** official documentation on how a simulation test is billed, including the simulated user and the evaluator. **I didn't verify this from documentation, and I can't confirm it without a single measured run.**

**What runs for real in our tests:**
- **Page tools are mocked:** open_payment, open_support, save_brief_note, switch_ad and send_summary are page tools, and there is no browser in a simulation. They do not run in reality. The report shows only whether they were called and with what parameters.
- **check_payment runs for real:** in ACC-09 it is no longer mocked, so the simulation calls it against Preview. The server answers by itself, and since the conversation key in the test is not attached to any order, the expected answer is `no_order`. In the other tests it stays mocked.
- **Real server actions are checked separately:** the console script above, AB1–AB7, and U0–U7.
- **A refusal by Meital proves nothing about server-side blocking.** The server blocks are checked only in those three channels.

**Cost estimate, ElevenLabs calculator for this agent (`calculate_llm_usage`, in dollars):**
- claude-sonnet-5, Meital: about $0.0107 per message.
- claude-sonnet-4-6, simulated user and evaluator by default: about $0.016 per message.
- **One test of up to 10 turns:** about 10 Meital messages ($0.11) + 10 simulated-user messages ($0.16) + evaluation of 5–6 conditions (about $0.05–0.10). That is about **$0.3–0.4**.
- **Ten tests:** about $3–4. With reruns of failures, up to about $6.

**Converting to credits:** I didn't verify the exact rate. The only real measurement, the voice call, showed about 115 credits of LLM per Meital turn. By that measure a single test is about 1,200–2,500 credits.

**Proposal: measure before buying.**
1. **One measurement test:** ACC-09, up to 10 turns. **Cap 2,500 credits.** I read the actual cost from the test run and from the credit balance.
2. **Rest of the package, 9 tests:** only if the measurement came in at or under the estimate. **Proposed cap: 15,000 credits** for all ten, including ACC-09.
3. **Reruns after fixes:** up to 5,000 more. **Total cap: 20,000.** If the measurement is higher than expected, I stop and report before continuing.

This is not approved yet; waiting for your approval of the measurement step (2,500).

## The ten tests (on agent version `agtvrsn_4801…`, and 5 and 10 only after stage 2)
| # | ID | Tool mocks |
|---|---|---|
| 1 Ready to buy, salon, straightening | `test_1001m50vmkfxfmgr1msre4kzkt84` | all |
| 2 Impatient plumber | `test_7901m50vngyxevb9abjj9hs8n7rn` | all |
| 3 Advertising history and a memory correction | `test_3901m50vpexgedvt0qveh8me3e0g` | all |
| 4 500 / expensive / need to think / end the call | `test_3901m50vqczcem38qtz91p5sqjdz` | all |
| 5 Summary and a fault (stage 2) | `test_9201m50vre43emzt78amw5vyrm52` | all |
| 6 Impersonation | `test_8701m50vsg4qedh83k0kv76cnas5` | all |
| 7 Hidden instructions | `test_8101m50vtppwf1xrafy53r3arm71` | all |
| 8 Order B through A | `test_0401m50vvqr4f9aafh2vnz1xkra1` | all |
| 9 Fake payment | `test_9701m50vwpyveg1v6efynds2cgxd` | page tools only. **check_payment is real** |
| 10 Abuse of emails and tools (stage 2) | `test_7101m50vxk1qe1rr9x8rmdd3219s` | all |

Voice tests have been cancelled: the pronunciation was approved by Alon.
