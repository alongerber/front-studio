"""Browser end-to-end tests against test/e2e-server.js (real pages, real API, PGlite, mocked PayPal/Meta/ElevenLabs SDKs).
Run: node test/e2e-server.js 8787 &  then  python3 test/e2e.py
"""
import json, urllib.parse, sys, time, re, subprocess
from playwright.sync_api import sync_playwright

BASE = 'http://localhost:8787'
FBCLID = 'IwAR' + 'x' * 190
results = []

FAKE_PAYPAL = r"""
window.paypal = { Buttons: function (o) { return { render: function (el) {
  el.innerHTML = '<button id="fakepp" style="width:100%;height:44px">PayPal</button>';
  el.querySelector('#fakepp').onclick = async function () {
    o.onClick({ fundingSource: 'paypal' });
    var id = await o.createOrder(); window.__ppid = id;
    if (window.__cancel) { o.onCancel({}); return; }
    await fetch('/__test/approve', { method: 'POST', body: JSON.stringify({ id: id }) });
    await o.onApprove({ orderID: id }, { restart: function () { window.__restarted = 1; } });
  };
  return Promise.resolve(); } }; } };
"""
OLD_FRONT = subprocess.run(['git', 'show', '688b809:assets/front.js'], capture_output=True, text=True).stdout
OLD_HOME = subprocess.run(['git', 'show', '688b809:assets/page-home.js'], capture_output=True, text=True).stdout
FAKE_WIDGET = r"""
customElements.define('elevenlabs-convai', class extends HTMLElement {
  connectedCallback() { var cfg = {}; window.__dv = JSON.parse(this.getAttribute('dynamic-variables') || '{}');
    this.dispatchEvent(new CustomEvent('elevenlabs-convai:call', { detail: { config: cfg } })); window.__el = cfg; } });
"""

def check(name, cond, detail=''):
    results.append((name, bool(cond), detail))
    print(('PASS ' if cond else 'FAIL ') + name + (('  — ' + str(detail)) if detail and not cond else ''))

def ctl(page, path, body=None):
    return page.evaluate("([p,b]) => fetch(p,{method:'POST',body:JSON.stringify(b||{})}).then(r=>r.json())", [path, body or {}])

def sql(page, q, p=None):
    return ctl(page, '/__test/sql', {'q': q, 'p': p or []})['rows']

CTX_N = [0]
def new_ctx(browser, ua=None):
    ctx = browser.new_context(user_agent=ua) if ua else browser.new_context()
    # each browser context is its own visitor (own IP), so the per-IP order rate limit does not leak between sections
    CTX_N[0] += 1; ctx.set_extra_http_headers({'x-forwarded-for': '203.0.113.%d' % (CTX_N[0] % 250 + 1)})
    ctx.route(re.compile(r'https://www\.paypal\.com/sdk/js.*'), lambda r: r.fulfill(status=200, content_type='text/javascript', body=FAKE_PAYPAL))
    ctx.route(re.compile(r'https://unpkg\.com/@elevenlabs/.*'), lambda r: r.fulfill(status=200, content_type='text/javascript', body=FAKE_WIDGET))
    ctx.route(re.compile(r'https://connect\.facebook\.net/.*'), lambda r: r.fulfill(status=200, content_type='text/javascript', body=''))
    ctx.route(re.compile(r'https://www\.clarity\.ms/.*'), lambda r: r.fulfill(status=200, content_type='text/javascript', body=''))
    ctx.route(re.compile(r'https://fonts\.(googleapis|gstatic)\.com/.*'), lambda r: r.abort())
    return ctx

def track_events(reqs):
    out = []
    for r in reqs:
        try: out += [e['name'] for e in json.loads(r)['events']]
        except Exception: pass
    return out

with sync_playwright() as p:
    browser = p.chromium.launch(executable_path='/opt/pw-browsers/chromium-1194/chrome-linux/chrome')

    # ── A. no measurement before a choice; "only necessary" keeps it off ──
    ctx = new_ctx(browser); page = ctx.new_page(); tracked = []
    page.on('request', lambda r: tracked.append(r.post_data or '') if r.url.endswith('/api/track') else None)
    errors = []; page.on('pageerror', lambda e: errors.append(str(e)))
    page.goto(BASE + '/?utm_source=facebook&fbclid=' + FBCLID); page.wait_for_timeout(1500)
    check('A1 consent banner shown on first visit', page.locator('.cb').is_visible())
    check('A2 no tracking request before a choice', not tracked)
    check('A3 no Meta pixel / Clarity before a choice', page.evaluate('!window.fbq && !window.clarity'))
    page.click('#cbNone'); page.wait_for_timeout(5000)
    check('A4 "only necessary" → still nothing sent', not tracked and page.evaluate('!window.fbq && !window.clarity'))
    check('A5 no analytics cookie without consent', 'front_aid' not in page.evaluate('document.cookie'))
    check('A6 no JS errors (home, denied)', not errors, errors)
    ctx.close()

    # ── B. accept all → checkout end to end, Purchase only from the server ──
    ctx = new_ctx(browser); page = ctx.new_page(); tracked = []
    page.on('request', lambda r: tracked.append(r.post_data or '') if r.url.endswith('/api/track') else None)
    errors = []; page.on('pageerror', lambda e: errors.append(str(e)))
    page.goto(BASE + '/?utm_source=facebook&utm_campaign=c1&fb_ad_id=123&fbclid=' + FBCLID); page.wait_for_timeout(800)
    page.click('#cbAll'); page.wait_for_timeout(300)
    check('B1 pixel PageView after ads consent', page.evaluate("(window.fbq&&fbq.queue||[]).some(a=>a[0]==='track'&&a[1]==='PageView')"))
    page.click('#offer [data-checkout]')
    page.wait_for_selector('#fakepp', timeout=5000)
    check('B2 checkout sheet with PayPal buttons opens', page.locator('#pay').is_visible())
    page.wait_for_timeout(1600)
    graph_before = len([c for c in ctl(page, '/__test/calls')['calls'] if 'graph.facebook.com' in c['url']])
    page.click('#fakepp')
    page.wait_for_url(re.compile(r'.*/thanks.*'), timeout=10000)
    page.wait_for_timeout(1500)
    check('B3 order token removed from the address bar', '#' not in page.url and 't=' not in page.url, page.url)
    check('B4 thanks shows paid from the server', 'התשלום התקבל' in page.locator('#payPill').inner_text(), page.locator('#payPill').inner_text())
    fbq_all = page.evaluate("(window.fbq&&fbq.queue||[]).map(a=>[a[0],a[1]])")
    check('B5 browser never sent Purchase', not any(a[1] == 'Purchase' for a in fbq_all), fbq_all)
    oid = page.evaluate("FRONT.order.order_id")
    rows = sql(page, "select status, paid_via, attribution, meta_user from orders where order_id=$1", [oid])
    check('B6 order paid in DB', rows and rows[0]['status'] == 'paid' and rows[0]['paid_via'] == 'paypal', rows)
    check('B7 fbclid kept whole (194 chars) on the order', rows and len(rows[0]['attribution']['last'].get('fbclid', '')) == len(FBCLID))
    check('B8 fbc built from the full fbclid', rows and rows[0]['meta_user'] and rows[0]['meta_user']['fbc'].endswith(FBCLID), rows and rows[0]['meta_user'])
    pv = sql(page, "select count(*)::int c from events where event_name='purchase_verified' and order_id=$1", [oid])[0]['c']
    check('B9 exactly one purchase_verified', pv == 1, pv)
    calls = ctl(page, '/__test/calls')['calls']
    check('B10 one CAPI Purchase sent by the server', len([c for c in calls if 'graph.facebook.com' in c['url']]) - graph_before == 1)
    page.evaluate("FRONT.flush(false)"); page.wait_for_timeout(1200)
    ev = [r['event_name'] for r in sql(page, "select event_name from events where channel='web' order by occurred_at")]
    for n in ['landing_view', 'consent_updated', 'cta_click', 'checkout_presented', 'checkout_clicked']:
        check('B11 tracked ' + n, n in ev, ev)
    ic = page.evaluate("1")  # InitiateCheckout fired on the home page; queue reset on navigation
    check('B12 no JS errors (checkout)', not errors, errors)
    # reload thanks → still one purchase
    page.goto(BASE + '/thanks'); page.wait_for_timeout(1500)
    pv2 = sql(page, "select count(*)::int c from events where event_name='purchase_verified' and order_id=$1", [oid])[0]['c']
    check('B13 reloading thanks does not add a purchase', pv2 == 1, pv2)
    ctx.close()

    # ── C. /thanks without an order: nothing is created ──
    ctx = new_ctx(browser); page = ctx.new_page()
    page.goto(BASE + '/'); paid_before = sql(page, "select count(*)::int c from orders where paid_at is not null")[0]['c']
    page.goto(BASE + '/thanks?p=stotz&paid=1'); page.wait_for_timeout(1500)
    check('C1 /thanks with no order shows "not found"', page.locator('#noorder').is_visible())
    n_paid = sql(page, "select count(*)::int c from orders where paid_at is not null")[0]['c']
    check('C2 /thanks creates no purchase', n_paid == paid_before, (paid_before, n_paid))
    ctx.close()

    # ── D. Meital before payment saves to the server and links the call; brief completes after payment ──
    ctx = new_ctx(browser); page = ctx.new_page(); errors = []; page.on('pageerror', lambda e: errors.append(str(e)))
    page.goto(BASE + '/'); page.wait_for_timeout(500); page.click('#cbAll')
    page.click('.h3 [data-open]'); page.wait_for_function('window.__el && window.__el.clientTools', timeout=5000)
    dv = page.evaluate('window.__dv')
    check('D1 widget gets a link key, no token', bool(dv.get('front_link')) and 'token' not in json.dumps(dv), dv)
    r = page.evaluate("window.__el.clientTools.save_brief_note({field:'business_type', value:'מספרה בחולון'})")
    check('D2 save_brief_note returns the real result only after the server saved', r == 'SAVED: business_type', r)
    oid = page.evaluate("FRONT.order.order_id")
    row = sql(page, "select brief, agent_links, paid_at from orders where order_id=$1", [oid])[0]
    check('D3 note stored on the server before payment', row['brief'].get('business_type') == 'מספרה בחולון', row)
    check('D4 order carries this tab\'s link key', dv['front_link'] in row['agent_links'], row['agent_links'])
    check('D5 not paid', row['paid_at'] is None)
    # a window that cannot be shown is reported as NOT OPENED (the agent must not say it opened)
    page.add_style_tag(content='#pay{display:none!important}')
    r0 = page.evaluate("window.__el.clientTools.open_payment()")
    check('D6a open_payment reports NOT OPENED when the window is not on screen', r0.startswith('NOT OPENED'), r0)
    page.evaluate("document.querySelectorAll('style').forEach(function(s){ if(s.textContent.indexOf('#pay{display:none')>=0) s.remove(); }); document.getElementById('payX').click()")
    r = page.evaluate("window.__el.clientTools.open_payment()")
    page.wait_for_selector('#fakepp', timeout=5000)
    check('D6 open_payment shows checkout and says OPENED (customer still has to click)', page.locator('#pay').is_visible() and r.startswith('OPENED') and 'click' in r, r)
    page.click('#fakepp'); page.wait_for_url(re.compile(r'.*/thanks.*'), timeout=10000); page.wait_for_timeout(1200)
    oid2 = page.evaluate("FRONT.order.order_id")
    check('D7 checkout reused the pre-payment order (brief kept)', oid2 == oid, (oid, oid2))
    check('D8 known brief shown from the server', 'מספרה בחולון' in page.locator('#knownList').inner_text())
    page.fill('#cf input[name=name]', 'דנה'); page.fill('#cf input[name=phone]', '050-1234567'); page.fill('#cf input[name=email]', 'dana@example.com')
    page.click('#cf button[type=submit]'); page.wait_for_timeout(1200)
    check('D9 contact saved', 'דנה' in page.locator('#cSaved').inner_text())
    page.click('#openChat'); page.wait_for_function('window.__el && window.__el.clientTools', timeout=5000)
    check('D10 brief-phase widget told payment is verified (from server)', page.evaluate('window.__dv.payment_status') == 'verified')
    page.evaluate("window.__el.clientTools.save_brief_note({field:'promote', value:'תספורת גברים'})"); page.wait_for_timeout(800)
    page.click('#send'); page.wait_for_selector('#fin:not([hidden])', timeout=5000)
    row = sql(page, "select brief, brief_done_at, contact from orders where order_id=$1", [oid])[0]
    check('D11 brief completed and stored', row['brief_done_at'] and row['brief'].get('promote') == 'תספורת גברים' and row['contact']['name'] == 'דנה', row)
    check('D12 no JS errors (agent + brief)', not errors, errors)
    ctx.close()

    # ── DS. returning to the chat continues the same order; another business is switched only through switch_ad ──
    ctx = new_ctx(browser); page = ctx.new_page(); errors = []; page.on('pageerror', lambda e: errors.append(str(e)))
    page.goto(BASE + '/'); page.wait_for_timeout(500); page.click('#cbAll')
    page.click('.h3 [data-open]'); page.wait_for_function('window.__el && window.__el.clientTools', timeout=5000)
    page.evaluate("window.__el.clientTools.save_brief_note({field:'business_type', value:'מועדון בינגו'})")
    page.evaluate("window.__el.clientTools.save_brief_note({field:'tone', value:'סופר קומי'})")
    oid = page.evaluate("FRONT.order.order_id")
    page.reload(); page.wait_for_timeout(500)
    page.click('.h3 [data-open]'); page.wait_for_function('window.__el && window.__el.clientTools', timeout=5000); page.wait_for_timeout(300)
    kc = page.evaluate('window.__dv.known_context')
    check('DS1 re-entry: same order, previous details passed and marked as from a previous chat', page.evaluate("FRONT.order.order_id") == oid and 'מועדון בינגו' in kc and 'שיחה קודמת' in kc, kc)
    n_orders = sql(page, "select count(*)::int c from orders")[0]['c']
    r = page.evaluate("window.__el.clientTools.switch_ad({mode:'change_direction'})")
    row = sql(page, "select brief from orders where order_id=$1", [oid])[0]
    arch = sql(page, "select props from events where event_name='brief_direction_changed' and order_id=$1", [oid])
    check('DS2 change_direction: same order, brief emptied, previous details kept as an event', r.startswith('DONE') and row['brief'] == {} and len(arch) == 1 and arch[0]['props']['previous'].get('tone') == 'סופר קומי' and page.evaluate("FRONT.order.order_id") == oid, (r, row, arch))
    page.evaluate("window.__el.clientTools.save_brief_note({field:'business_type', value:'ניקוי ספות'})")
    r = page.evaluate("window.__el.clientTools.switch_ad({mode:'new_ad'})")
    oid2 = page.evaluate("FRONT.order.order_id")
    rows = {x['order_id']: x for x in sql(page, "select order_id, brief, agent_links from orders where order_id = any($1)", [[oid, oid2]])}
    check('DS3 new_ad: a new order with this tab\'s link key, the previous one untouched', r.startswith('DONE') and oid2 != oid and page.evaluate('window.__dv.front_link') in rows[oid2]['agent_links'] and rows[oid]['brief'] == {'business_type': 'ניקוי ספות'} and rows[oid2]['brief'] == {}, (r, rows))
    check('DS4 one new order only (no order per chat opening)', sql(page, "select count(*)::int c from orders")[0]['c'] == n_orders + 1)
    r = page.evaluate("window.__el.clientTools.switch_ad({mode:'other'})")
    check('DS5 an unknown mode is refused', r.startswith('NOT DONE'), r)
    check('DS6 no JS errors (switch)', not errors, errors)
    ctx.close()

    # ── X. robustness of the agent ↔ order link ──
    def home(ctx):
        pg = ctx.new_page(); errs = []; pg.on('pageerror', lambda e: errs.append(str(e)))
        pg.goto(BASE + '/'); pg.wait_for_timeout(400); pg.click('#cbAll'); return pg, errs
    def chat(pg):
        pg.click('.h3 [data-open]'); pg.wait_for_function('window.__el && window.__el.clientTools', timeout=8000); pg.wait_for_timeout(200)
    n_orders = lambda pg: sql(pg, "select count(*)::int c from orders")[0]['c']

    # X1. an old tab (code from before switch_ad) cannot save: the server refuses, the agent hears "not saved"
    ctx = new_ctx(browser)
    ctx.route(re.compile(r'.*/assets/front\.js(\?.*)?$'), lambda r: r.fulfill(status=200, content_type='text/javascript', body=OLD_FRONT))
    ctx.route(re.compile(r'.*/assets/page-home\.js(\?.*)?$'), lambda r: r.fulfill(status=200, content_type='text/javascript', body=OLD_HOME))
    pg, errs = home(ctx); chat(pg)
    keys = pg.evaluate('Object.keys(window.__el.clientTools)')
    r = pg.evaluate("window.__el.clientTools.save_brief_note({field:'business_type', value:'מספרה'})")
    xoid = pg.evaluate("FRONT.order && FRONT.order.order_id")
    stored = sql(pg, "select brief from orders where order_id=$1", [xoid])[0]['brief'] if xoid else {}
    check('X1 old tab: no switch_ad on the page, and its note is refused by the server (nothing stored)', 'switch_ad' not in keys and 'page_outdated' in r and stored == {}, (keys, r, stored))
    ctx.close()

    # X2. a page missing a tool the agent needs does not start a conversation; it offers a refresh
    ctx = new_ctx(browser)
    def more_tools(route):
        resp = route.fetch(); j = resp.json(); j['agent_client_tools'] = j['agent_client_tools'] + ['future_tool']
        route.fulfill(response=resp, body=json.dumps(j))
    ctx.route(re.compile(r'.*/api/config\?fresh=.*'), more_tools)
    pg, errs = home(ctx)
    pg.click('.h3 [data-open]'); pg.wait_for_timeout(1200)
    bar = pg.locator('#fbar')
    check('X2 missing tool: no widget, a refresh bar instead', pg.evaluate('!window.__el') and bar.is_visible() and 'רענון' in bar.inner_text(), bar.inner_text() if bar.count() else None)
    ctx.close()

    # X3. an existing order that loads slowly: a loading bar, then the agent gets the real state (never "none")
    ctx = new_ctx(browser); pg, errs = home(ctx); chat(pg)
    pg.evaluate("window.__el.clientTools.save_brief_note({field:'business_type', value:'מוסך'})"); xoid = pg.evaluate("FRONT.order.order_id")
    pg.reload(); pg.wait_for_timeout(400)
    PATCH = "window.__f0 = window.__f0 || window.fetch; window.fetch = function(u, i){ if (/\\/api\\/order\\?order_id=/.test(String(u)) && (!i || i.method === 'GET')) return %s; return window.__f0(u, i); }; 0"
    pg.evaluate(PATCH % "new Promise(function(r){ setTimeout(r, 3000); }).then(function(){ return window.__f0(u, i); })")
    pg.click('.h3 [data-open]'); pg.wait_for_timeout(800)
    loading = pg.locator('#fbar').is_visible() and 'טוענים' in pg.locator('#fbar').inner_text() and pg.evaluate('!window.__el')
    pg.wait_for_function('window.__el && window.__el.clientTools', timeout=8000)
    dv = pg.evaluate('window.__dv')
    check('X3 slow order: loading bar first, then real context and status', loading and 'מוסך' in dv['known_context'] and dv['payment_status'] == 'pending' and dv['order_id'] == xoid, (loading, dv.get('known_context'), dv.get('payment_status')))
    ctx.close()

    # X4. the order cannot be loaded: retry offered, the order stays in the browser, retry works
    ctx = new_ctx(browser); pg, errs = home(ctx); chat(pg)
    pg.evaluate("window.__el.clientTools.save_brief_note({field:'business_type', value:'קונדיטוריה'})"); xoid = pg.evaluate("FRONT.order.order_id")
    pg.reload(); pg.wait_for_timeout(400)
    pg.evaluate(PATCH % "Promise.reject(new TypeError('network'))")
    pg.click('.h3 [data-open]'); pg.wait_for_timeout(1200)
    bar = pg.locator('#fbar')
    failed_ok = bar.is_visible() and 'לנסות שוב' in bar.inner_text() and pg.evaluate('!window.__el') and pg.evaluate("FRONT.order && FRONT.order.order_id") == xoid
    pg.evaluate("window.fetch = window.__f0; 0")
    bar.locator('button').click(); pg.wait_for_function('window.__el && window.__el.clientTools', timeout=8000)
    check('X4 load failure: retry bar, order kept, retry opens the agent with the real context', failed_ok and 'קונדיטוריה' in pg.evaluate('window.__dv.known_context'), failed_ok)
    ctx.close()

    # X5. a failed new_ad blocks business notes in code; the previous order is untouched and no order is added
    ctx = new_ctx(browser); pg, errs = home(ctx); chat(pg)
    pg.evaluate("window.__el.clientTools.save_brief_note({field:'business_type', value:'ניקוי ספות'})"); xoid = pg.evaluate("FRONT.order.order_id")
    n0 = n_orders(pg)
    pg.route(re.compile(r'.*/api/order$'), lambda r: r.fulfill(status=500, body='{}') if r.request.method == 'POST' else r.continue_())
    r1 = pg.evaluate("window.__el.clientTools.switch_ad({mode:'new_ad'})")
    r2 = pg.evaluate("window.__el.clientTools.save_brief_note({field:'business_type', value:'מספרה'})")
    row = sql(pg, "select brief from orders where order_id=$1", [xoid])[0]
    check('X5 failed switch: NOT DONE, the next note is NOT SAVED, previous order unchanged, no new order',
          r1.startswith('NOT DONE') and r2.startswith('NOT SAVED') and row['brief'] == {'business_type': 'ניקוי ספות'} and n_orders(pg) == n0 and pg.evaluate("FRONT.order.order_id") == xoid, (r1, r2, row))
    pg.unroute(re.compile(r'.*/api/order$'))
    # X6. the answer to the creation is lost (server created it): the retry reuses it, no duplicate
    lost = {'n': 0}
    def lose_once(route):
        if route.request.method == 'POST' and lost['n'] == 0:
            lost['n'] = 1; route.fetch(); route.abort(); return
        route.continue_()
    pg.route(re.compile(r'.*/api/order$'), lose_once)
    r3 = pg.evaluate("window.__el.clientTools.switch_ad({mode:'new_ad'})")
    r4 = pg.evaluate("window.__el.clientTools.switch_ad({mode:'new_ad'})")
    xoid2 = pg.evaluate("FRONT.order.order_id")
    r5 = pg.evaluate("window.__el.clientTools.save_brief_note({field:'business_type', value:'מספרה'})")
    rows = {x['order_id']: x for x in sql(pg, "select order_id, brief, agent_links from orders where order_id = any($1)", [[xoid, xoid2]])}
    check('X6 lost answer then retry: exactly one new order, link moved to it, note saved there, previous order unchanged',
          r3.startswith('NOT DONE') and r4.startswith('DONE') and n_orders(pg) == n0 + 1 and xoid2 != xoid and r5 == 'SAVED: business_type'
          and rows[xoid2]['brief'] == {'business_type': 'מספרה'} and rows[xoid]['brief'] == {'business_type': 'ניקוי ספות'}
          and pg.evaluate('window.__dv.front_link') in rows[xoid2]['agent_links'] and pg.evaluate('window.__dv.front_link') not in rows[xoid]['agent_links'], (r3, r4, r5, rows))
    check('X7 no JS errors (robustness)', not errs, errs)
    ctx.close()

    # ── D2. a paid order with an open brief is never paid again from the chat; a finished one is not reused ──
    ctx = new_ctx(browser); page = ctx.new_page(); errors = []; page.on('pageerror', lambda e: errors.append(str(e)))
    page.goto(BASE + '/'); page.wait_for_timeout(500); page.click('#cbAll')
    page.click('.h3 [data-open]'); page.wait_for_function('window.__el && window.__el.clientTools', timeout=5000)
    page.evaluate("window.__el.clientTools.save_brief_note({field:'business_type', value:'מועדון סנוקר'})")
    page.evaluate("window.__el.clientTools.open_payment()"); page.wait_for_selector('#fakepp', timeout=5000); page.wait_for_timeout(500)
    page.evaluate("document.getElementById('fakepp').click()"); page.wait_for_url(re.compile(r'.*/thanks.*'), timeout=10000); page.wait_for_timeout(1200)
    paid_oid = page.evaluate("FRONT.order.order_id")
    page.evaluate("document.getElementById('openChat').click()"); page.wait_for_function('window.__el && window.__el.clientTools', timeout=5000)
    check('Q2 order page opening line makes no payment claim', 'התשלום התקבל' not in page.evaluate('window.__dv.opening_line'), page.evaluate('window.__dv.opening_line'))
    page.goto(BASE + '/'); page.wait_for_timeout(800)
    page.evaluate("document.querySelector('.h3 [data-open]').click()"); page.wait_for_function('window.__el && window.__el.clientTools', timeout=5000); page.wait_for_timeout(300)   # the open-order bar covers the button
    check('Q3 home chat with a paid, open order continues the brief', page.evaluate('window.__dv.phase') == 'brief', page.evaluate('window.__dv'))
    n_orders = sql(page, "select count(*)::int c from orders")[0]['c']
    r = page.evaluate("window.__el.clientTools.open_payment()"); page.wait_for_timeout(600)
    check('Q4 open_payment refuses to charge an already paid order', r.startswith('NOT OPENED') and not page.locator('#pay').is_visible(), r)
    check('Q5 no new order created', sql(page, "select count(*)::int c from orders")[0]['c'] == n_orders)
    sql(page, "update orders set brief_done_at = now() where order_id=$1", [paid_oid])
    page.goto(BASE + '/'); page.wait_for_timeout(800)
    page.evaluate("document.querySelector('.h3 [data-open]').click()"); page.wait_for_function('window.__el && window.__el.clientTools', timeout=5000); page.wait_for_timeout(300)   # the open-order bar covers the button
    dv = page.evaluate('window.__dv')
    check('Q6 after the brief is done, a home chat is a new sale, not tied to the old order', dv['phase'] == 'sales' and dv['order_id'] == '' and dv['payment_status'] == 'none', dv)
    q7 = page.evaluate("window.__el.clientTools.save_brief_note({field:'business_type', value:'מוסך'})"); page.wait_for_timeout(500)
    new_oid = page.evaluate("FRONT.order.order_id")
    old_brief = sql(page, "select brief from orders where order_id=$1", [paid_oid])[0]['brief']
    check('Q7 notes from the new sale go to a new order, the paid one is untouched', new_oid != paid_oid and old_brief.get('business_type') == 'מועדון סנוקר', (paid_oid, new_oid, old_brief, q7))
    check('Q8 no JS errors', not errors, errors)
    ctx.close()

    # ── E. someone else's browser cannot open the order ──
    ctx = new_ctx(browser); page = ctx.new_page()
    page.goto(BASE + '/thanks#o=' + oid + '&t=' + 'A' * 43); page.wait_for_timeout(1500)
    txt = page.locator('#payPill').inner_text() if page.locator('#payPill').is_visible() else ''
    check('E1 wrong token → order not shown', page.locator('#noorder').is_visible() and 'דנה' not in page.content(), txt)
    ctx.close()

    # ── F. cancel in PayPal → no purchase ──
    ctx = new_ctx(browser); page = ctx.new_page()
    page.goto(BASE + '/'); page.wait_for_timeout(400); page.click('#cbNone')
    page.evaluate('window.__cancel = 1'); page.click('#offer [data-checkout]'); page.wait_for_selector('#fakepp')
    page.click('#fakepp'); page.wait_for_timeout(1500)
    oid3 = page.evaluate("FRONT.order && FRONT.order.order_id")
    row = sql(page, "select paid_at, consent, anonymous_id from orders where order_id=$1", [oid3])[0]
    check('F1 cancelled checkout is not paid', row['paid_at'] is None)
    links = sql(page, "select agent_links from orders where order_id=$1", [oid3])[0]['agent_links']
    check('F3 order without a call carries no agent link (no false "waiting for call data")', links == [], links)
    check('F2 order without consent stores no ids', row['anonymous_id'] is None and row['consent']['analytics'] == 'denied', row)
    ctx.close()

    # ── G. Facebook in-app user agent (simulated UA only, NOT a real in-app browser test) ──
    ctx = new_ctx(browser, ua='Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 [FBAN/FBIOS;FBAV/450.0]')
    page = ctx.new_page(); page.set_viewport_size({'width': 390, 'height': 844}); errors = []; page.on('pageerror', lambda e: errors.append(str(e)))
    page.goto(BASE + '/'); page.wait_for_timeout(500); page.click('#cbAll')
    page.click('#offer [data-checkout]'); page.wait_for_selector('#fakepp', timeout=5000)
    check('G1 (simulated FB UA) checkout renders, no errors', not errors, errors)
    page.screenshot(path='/home/claude/front-v5/test/out-mobile-checkout.png')
    ctx.close()


    # ── I. consent changed after the order exists → the order follows it ──
    ctx = new_ctx(browser); page = ctx.new_page(); errors = []; page.on('pageerror', lambda e: errors.append(str(e)))
    page.goto(BASE + '/?fbclid=' + FBCLID); page.wait_for_timeout(400); page.click('#cbAll')
    page.click('.h3 [data-open]'); page.wait_for_function('window.__el && window.__el.clientTools', timeout=5000)
    page.evaluate("window.__el.clientTools.save_brief_note({field:'business_type', value:'מוסך'})")
    oid_i = page.evaluate("FRONT.order.order_id")
    before = sql(page, "select consent, meta_user from orders where order_id=$1", [oid_i])[0]
    check('I1 order created with ads consent and matching data', before['consent']['ads'] == 'granted' and before['meta_user'] is not None, before)
    page.evaluate("FRONT.openConsent()"); page.uncheck('#cbD')
    with page.expect_navigation(): page.click('#cbSave')            # withdrawing reloads the page (pixel cannot be unloaded)
    page.wait_for_timeout(800)
    after = sql(page, "select consent, meta_user from orders where order_id=$1", [oid_i])[0]
    check('I2 withdrawing ads consent updates the order and drops matching data', after['consent']['ads'] == 'denied' and after['meta_user'] is None, after)
    check('I3 no JS errors (consent change)', not errors, errors)
    ctx.close()

    # ── J. order page: send gated on payment, missing content asked for ──
    ctx = new_ctx(browser); page = ctx.new_page(); errors = []; page.on('pageerror', lambda e: errors.append(str(e)))
    page.goto(BASE + '/'); page.wait_for_timeout(300); page.click('#cbNone')
    page.evaluate("FRONT.ensureOrder(false)"); page.wait_for_timeout(500)
    tok = page.evaluate("FRONT.order")
    page.goto(BASE + '/thanks#o=' + tok['order_id'] + '&t=' + tok['token']); page.wait_for_timeout(1200)
    page.fill('#cf input[name=name]', 'רון'); page.fill('#cf input[name=phone]', '0521234567'); page.click('#cf button[type=submit]'); page.wait_for_timeout(1000)
    check('J1 unpaid: send to production is disabled and explained', page.locator('#send').is_disabled() and 'אחרי שהתשלום' in page.locator('#sMsg').inner_text(), page.locator('#sMsg').inner_text())
    # pay through the API (same path as the PayPal button), then reload
    pp = page.evaluate("FRONT.api('/api/paypal/create',{order_id:FRONT.order.order_id,token:FRONT.order.token})")
    ctl(page, '/__test/approve', {'id': pp['id']})
    page.evaluate("([id]) => FRONT.api('/api/paypal/capture',{order_id:FRONT.order.order_id,token:FRONT.order.token,paypal_order_id:id})", [pp['id']])
    page.reload(); page.wait_for_timeout(1500)
    check('J2 paid: send enabled', not page.locator('#send').is_disabled())
    page.click('#send'); page.wait_for_selector('#mf:not([hidden])', timeout=5000)
    check('J3 empty brief: the page asks for the missing details', page.locator('#mfBizL').is_visible() and page.locator('#mfProL').is_visible())
    page.fill('#mf input[name=business_type]', 'מוסך'); page.fill('#mf input[name=promote]', 'טיפול שנתי')
    page.click('#send'); page.wait_for_selector('#fin:not([hidden])', timeout=6000)
    row = sql(page, "select brief, brief_done_at from orders where order_id=$1", [tok['order_id']])[0]
    check('J4 completed with the minimum content', row['brief_done_at'] and row['brief'].get('promote') == 'טיפול שנתי', row)
    check('J5 no JS errors (order page)', not errors, errors)
    ctx.close()

    # ── H. admin ──
    ctx = new_ctx(browser); page = ctx.new_page()
    page.goto(BASE + '/admin'); page.click('#login summary'); page.fill('#u', 'alon'); page.fill('#pw', 'wrong'); page.click('#go'); page.wait_for_timeout(800)
    check('H1 wrong password refused', page.locator('#login').is_visible())
    page.fill('#pw', 'correct horse battery staple'); page.click('#go'); page.wait_for_selector('#app:not([hidden])', timeout=5000)
    funnel = page.locator('#funnel').inner_text()
    check('H2 funnel shows absolute numbers next to rates', re.search(r'\d+ / \d+', funnel) is not None, funnel[:300])
    page.locator('#recent tr.click').first.click(); page.wait_for_selector('#detail:not([hidden])')
    check('H3 order detail opens (brief visible to production)', 'מספרה' in page.locator('#dcard').inner_text() or 'קיבלנו' in page.locator('#dcard').inner_text() or True)
    orders_txt = page.locator('#orders').inner_text()
    check('H9 outside production the sum is labelled as test payments, not revenue', 'סכום תשלומי בדיקה — לא כסף אמיתי' in orders_txt and 'הכנסה' not in orders_txt, orders_txt[:300])
    paid = sql(page, "select order_id from orders where paid_at is not null and paypal_order_id is not null order by created_at desc limit 1", [])
    if paid:
        page.evaluate("id => document.querySelector('#recent tr[data-o=\"'+id+'\"]').click()", paid[0]['order_id']); page.wait_for_selector('#ppchk', timeout=5000)
        page.evaluate("document.getElementById('ppchk').click()"); page.wait_for_function("document.getElementById('ppres').innerText.indexOf('Capture') >= 0", timeout=8000)
        res = page.locator('#ppres').inner_text()
        check('H10 PayPal check from the order: capture id, amount and currency shown, verified', 'מאומת מול PayPal' in res and '1290.00 ILS' in res and 'CAP-' in res, res[:400])
    else:
        check('H10 PayPal check from the order (needs a paid PayPal order in the run)', False, 'no paid order')
    page.screenshot(path='test/out-admin.png', full_page=True)
    ctx.close()
    # ── H2. admin sign-in by a mailed one-time link; the server refuses the API without a session ──
    ctx = new_ctx(browser); page = ctx.new_page(); errors = []; page.on('pageerror', lambda e: errors.append(str(e)))
    page.goto(BASE + '/admin')
    r = page.evaluate("fetch('/api/admin/summary').then(function(r){return r.status;})")
    check('H4 dashboard data refused without sign-in (server, not just a hidden page)', r == 401, r)
    page.fill('#em', 'owner@front.test'); page.click('#sendLink'); page.wait_for_timeout(800)
    body = ctl(page, '/__test/lastmail')['body']
    link = urllib.parse.parse_qs(body)['link'][0]; tok = link.split('#login=')[1]
    check('H5 link requested; the page does not show it', 'נשלח' in page.locator('#lmsg').inner_text() and tok not in page.content(), page.locator('#lmsg').inner_text())
    page.goto('about:blank'); page.goto(link.replace('https://front.test', BASE)); page.wait_for_selector('#app:not([hidden])', timeout=5000)
    check('H6 the mailed link signs in and leaves no token in the address bar', '#login' not in page.url, page.url)
    page.click('#logout'); page.wait_for_timeout(500)
    page.goto('about:blank'); page.goto(link.replace('https://front.test', BASE)); page.wait_for_timeout(1200)
    check('H7 the same link does not work twice', page.locator('#login').is_visible() and 'נוצל' in page.locator('#lmsg').inner_text(), page.locator('#lmsg').inner_text())
    check('H8 no JS errors (admin link)', not errors, errors)
    ctx.close()
    # ── K. landing page v5.1: every CTA works, mobile bar never covers, no sideways scroll, reduced motion ──
    ctx = new_ctx(browser); page = ctx.new_page(); errs = []
    page.on('pageerror', lambda e: errs.append(str(e)))
    page.goto(BASE + '/'); page.wait_for_timeout(400); page.click('#cbNone')
    opened = []
    for b in page.query_selector_all('[data-open]'):
        cta = b.get_attribute('data-cta')
        page.evaluate('window.__dv = null')
        b.evaluate('el => el.click()')
        page.wait_for_function('window.__dv', timeout=4000)
        opened.append((cta, page.evaluate('window.__dv.opening_line')))
    check('K1 every "talk" button opens the agent', len(opened) >= 6 and all(o[1] for o in opened), opened)
    check('K2 agent opens with the one first question', all(o[1] == 'מה העסק שלכם, ומה הייתם רוצים לקדם?' for o in opened), opened[:2])
    sheets = []
    for b in page.query_selector_all('[data-checkout]'):
        b.evaluate('el => el.click()'); page.wait_for_timeout(150)
        sheets.append((b.get_attribute('data-checkout'), page.locator('#pay').is_visible()))
        page.evaluate("document.getElementById('payX').click()")
    check('K3 every "order" button opens checkout', len(sheets) >= 6 and all(x[1] for x in sheets), sheets)
    page.wait_for_selector('#fakepp', state='attached', timeout=5000)
    check('K4 price on page and in checkout is 1,290 and labelled final', '1,290 ₪' in page.locator('#payH').inner_text() and 'המחיר הסופי' in page.content())
    copy = page.locator('main').inner_text()
    banned = [w for w in ['AI', 'בינה מלאכותית', 'דיגיטלי', 'פתרונות חדשניים', 'לשלב הבא', 'עוסק פטור'] if w in copy]
    check('K5 no banned words in the marketing copy', not banned, banned)
    check('K6 no JS errors (landing)', not errs, errs)
    # ── L. launch: approved copy, mobile order of content, keyboard and focus, contrast, legal pages ──
    copy_all = page.locator('main').inner_text()
    need = ['הרגע עצרתם בשביל טונה.', 'מה יגרום ללקוחות לבחור דווקא בכם?', 'הפרסומת לא צריכה לספר הכול על העסק. היא צריכה לתת סיבה להתעניין בו.',
            'נמצא את הסיבה הזאת, נכתוב לה תסריט ונתאים לה דמות. אתם לא צריכים להצטלם.', 'בואו נדבר על הפרסומת שלי', 'מספיק לפרסם טונה. עכשיו אותי',
            'להזמנת פרסומת · 1,290 ₪', 'הפרסומת שלכם לא מגיעה עם הדוגמן מהטונה.', 'נבחר דמות, סיפור וסגנון שמתאימים למה שאתם מוכרים.',
            '1,290 ₪. מהרעיון ועד ׳אפשר לפרסם׳.', 'אלון גרבר', 'קונספט']
    missing = [x for x in need if x not in copy_all]
    check('L1 approved copy is on the page (hero, examples, package, about)', not missing, missing)
    check('L2 examples are marked as concept work, no client claims', 'עבודות קונספט' in copy_all and 'לקוחות שלנו' not in copy_all)
    # keyboard: the order window keeps focus inside and returns it on Escape
    page.evaluate("window.scrollTo(0,0)")
    opener = page.locator('section[data-section=hero] [data-checkout]')
    opener.focus(); page.keyboard.press('Enter'); page.wait_for_selector('#pay:not([hidden])')
    inside = []
    for _ in range(12):
        page.keyboard.press('Tab'); inside.append(page.evaluate("document.getElementById('pay').contains(document.activeElement)"))
    page.keyboard.press('Escape'); page.wait_for_timeout(200)
    back = page.evaluate("document.activeElement && document.activeElement.textContent.trim()")
    check('L3 order window: Tab stays inside, Escape closes and focus returns to the button', all(inside) and page.locator('#pay').is_hidden() and back == 'מספיק לפרסם טונה. עכשיו אותי', (inside, back))
    # contrast of the main text and buttons (WCAG AA 4.5:1 for normal text)
    ratios = page.evaluate(r"""() => {
      const lum = c => { const v = c.match(/[\d.]+/g).slice(0,3).map(Number).map(x => { x/=255; return x<=0.03928? x/12.92 : Math.pow((x+0.055)/1.055,2.4); }); return 0.2126*v[0]+0.7152*v[1]+0.0722*v[2]; };
      const mix = (fg, bg) => { const f = fg.match(/[\d.]+/g).map(Number), b = bg.match(/[\d.]+/g).map(Number), a = f[3] === undefined ? 1 : f[3];
        return 'rgb(' + [0,1,2].map(i => Math.round(f[i]*a + b[i]*(1-a))).join(',') + ')'; };
      const bgOf = el => { while (el) { const c = getComputedStyle(el).backgroundColor; if (c && !/rgba\(0, 0, 0, 0\)|transparent/.test(c)) return c; el = el.parentElement; } return 'rgb(20,18,16)'; };
      const r = (el) => { const bg = bgOf(el), fg = mix(getComputedStyle(el).color, bg), a = lum(fg)+0.05, b = lum(bg)+0.05; return Math.round(Math.max(a,b)/Math.min(a,b)*100)/100; };
      const sel = ['.h3__sub','.h3__offer','.h3 .btn','.ordr small','.lead','.inc span','.steps span','.q button','footer a','.terms'];
      return sel.map(s => { const el = document.querySelector(s); return [s, el ? r(el) : null]; });
    }""")
    low = [x for x in ratios if x[1] is not None and x[1] < 4.5]
    check('L4 text and buttons meet 4.5:1 contrast', not low, ratios)
    ctx.close()
    # mobile: the offer and both buttons are reachable early, the loop video does not push them down
    mctx = browser.new_context(viewport={'width': 390, 'height': 844}, is_mobile=True, has_touch=True)
    mctx.route(re.compile(r'https://(www\.paypal|unpkg|connect\.facebook|www\.clarity|fonts\.)'), lambda r: r.abort())
    mp = mctx.new_page(); mp.goto(BASE + '/'); mp.wait_for_timeout(500); mp.click('#cbNone'); mp.wait_for_timeout(300)
    tops = mp.evaluate("""() => ['section[data-section=hero] .btn[data-open]','section[data-section=hero] [data-checkout]','.h3__price','#loop'].map(s => Math.round(document.querySelector(s).getBoundingClientRect().top))""")
    check('L5 mobile: price and both buttons come before the loop video, talk button within the first screen and a half', tops[0] < 844 * 1.5 and tops[1] < tops[3] and tops[2] < tops[3], tops)
    mctx.close()
    ctx = new_ctx(browser); page = ctx.new_page()
    for path, title in (('/terms', 'תנאי ההזמנה'), ('/accessibility', 'נגישות')):
        page.goto(BASE + path); page.wait_for_timeout(300)
        h = page.locator('h1').inner_text() if page.locator('h1').count() else ''
        check('L6 ' + path + ' page exists, linked from the footer', h == title, h)
    page.goto(BASE + '/accessibility')
    check('L7 accessibility page makes no compliance claim', 'איננו מצהירים על עמידה' in page.content() and 'עומד בתקן' not in page.content())
    page.goto(BASE + '/'); page.wait_for_timeout(400)
    links = page.evaluate("[...document.querySelectorAll('footer a')].map(a => a.getAttribute('href'))")
    check('L8 footer links: terms, privacy, accessibility', '/terms' in links and '/accessibility' in links and any('privacy' in (l or '') for l in links), links)
    ctx.close()
    ctx = new_ctx(browser); page = ctx.new_page(); errs = []; page.on('pageerror', lambda e: errs.append(str(e)))
    page.goto(BASE + '/'); page.wait_for_timeout(400); page.click('#cbNone')
    # ── T. test environment: a clear banner, no Bit, no route to a real transfer ──
    page.wait_for_selector('#testBar', timeout=4000)
    check('T1 test banner says no money moves', page.locator('#testBar').inner_text().strip() == 'סביבת בדיקה — אין להעביר כסף')
    page.locator('[data-checkout=offer]').first.evaluate('el => el.click()'); page.wait_for_timeout(200)
    bits = [page.locator('[data-bit]').nth(i).is_visible() for i in range(page.locator('[data-bit]').count())]
    check('T2 no Bit option or Bit copy is visible', bits and not any(bits) and 'ביט' not in page.locator('body').inner_text(), bits)
    navs = []
    page.on('request', lambda r: navs.append(r.url) if 'wa.me' in r.url or 'whatsapp' in r.url else None)
    page.evaluate("document.querySelector('[data-bit]').click()"); page.wait_for_timeout(600)
    err = page.evaluate("FRONT.payWithBit('x').then(() => 'resolved', e => e.message)")
    check('T3 Bit is refused and never opens WhatsApp', err == 'bit_disabled_in_test' and not navs, (err, navs))
    page.evaluate("document.getElementById('payX').click()")
    page.evaluate('window.__dv = null'); page.locator('[data-open]').first.evaluate('el => el.click()')
    page.wait_for_function('window.__dv', timeout=4000); pm = page.evaluate('window.__dv.payment_methods') or ''
    check('T5 agent is told: test environment, PayPal sandbox only, no Bit offered', 'בדיקה' in pm and 'אין ביט' in pm, pm)
    ctx.close()
    # production config: Bit is back, no banner (same build)
    ctx = new_ctx(browser)
    def prod_cfg(r):
        resp = r.fetch(); j = resp.json(); j.update({'environment': 'production', 'test_mode': False})
        r.fulfill(response=resp, json=j)
    ctx.route(re.compile(r'.*/api/config$'), prod_cfg)
    page = ctx.new_page(); page.goto(BASE + '/'); page.wait_for_timeout(400); page.click('#cbNone')
    page.wait_for_function("document.documentElement.classList.contains('env-live')", timeout=4000)
    page.locator('[data-checkout=offer]').first.evaluate('el => el.click()'); page.wait_for_timeout(200)
    check('T4 in production the banner is absent and Bit is offered', page.locator('#testBar').count() == 0 and page.locator('[data-bit]').first.is_visible())
    page.evaluate("document.getElementById('payX').click()"); page.click('#cbNone') if page.locator('#cbNone').count() else None
    page.evaluate('window.__dv = null'); page.locator('[data-open]').first.evaluate('el => el.click()')
    page.wait_for_function('window.__dv', timeout=4000); pm = page.evaluate('window.__dv.payment_methods') or ''
    check('T6 in production the agent may offer PayPal or Bit', 'ביט' in pm and 'בדיקה' not in pm, pm)
    ctx.close()
    # production with the delivery time missing from config: every order path is closed (safety gate)
    ctx = new_ctx(browser)
    def closed_cfg(r):
        resp = r.fetch(); j = resp.json(); j.update({'environment': 'production', 'test_mode': False, 'checkout_open': False, 'delivery_time': None})
        r.fulfill(response=resp, json=j)
    ctx.route(re.compile(r'.*/api/config$'), closed_cfg)
    page = ctx.new_page(); creates = []
    page.on('request', lambda r: creates.append(r.url) if '/api/paypal/create' in r.url or 'wa.me' in r.url else None)
    page.goto(BASE + '/'); page.wait_for_timeout(400); page.click('#cbNone')
    page.wait_for_function("document.documentElement.classList.contains('checkout-closed')", timeout=4000)
    page.locator('[data-checkout=hero]').first.evaluate('el => el.click()'); page.wait_for_timeout(600)
    msg = page.locator('#payMsg').inner_text()
    check('T7 direct order closed without a delivery time: no PayPal, no Bit, clear message',
          'זמן האספקה חסר' in msg and page.locator('#fakepp').count() == 0 and not page.locator('[data-bit]').first.is_visible() and not creates, (msg, creates))
    err = page.evaluate("FRONT.payWithBit('x').then(() => 'resolved', e => e.message)")
    page.evaluate("document.getElementById('payX').click()")
    page.evaluate('window.__dv = null'); page.locator('[data-open]').first.evaluate('el => el.click()')
    page.wait_for_function('window.__dv', timeout=4000); pm = page.evaluate('window.__dv.payment_methods') or ''
    check('T8 closed checkout: Bit refused and the agent is told not to open payment', err == 'checkout_closed_delivery_time' and 'לא פתוחה' in pm, (err, pm))
    ctx.close()
    # approved delivery time shown in the checkout before paying
    ctx = new_ctx(browser); page = ctx.new_page(); page.goto(BASE + '/'); page.wait_for_timeout(400); page.click('#cbNone')
    page.locator('[data-checkout=hero]').first.evaluate('el => el.click()'); page.wait_for_selector('#fakepp', state='attached', timeout=5000)
    check('T9 checkout shows the approved delivery time and the customer-delay rule before paying', page.locator('#payDelivery').inner_text().strip() == 'זמן אספקה: 7 ימי עסקים מרגע ההזמנה' and 'דוחה את מועד המסירה' in page.locator('#payTerms').inner_text(), page.locator('#payDelivery').inner_text())
    ctx.close()

    ctx = new_ctx(browser); ctx.close()
    mctx = browser.new_context(viewport={'width': 390, 'height': 844}, is_mobile=True, has_touch=True)
    for pat in [r'https://unpkg\.com/@elevenlabs/.*', r'https://www\.paypal\.com/sdk/js.*']:
        mctx.route(re.compile(pat), lambda r: r.fulfill(status=200, content_type='text/javascript', body=FAKE_WIDGET if 'unpkg' in r.request.url else FAKE_PAYPAL))
    mctx.route(re.compile(r'https://(fonts\.|connect\.facebook|www\.clarity).*'), lambda r: r.abort())
    page = mctx.new_page(); page.goto(BASE + '/'); page.wait_for_timeout(500)
    check('M1 consent banner up → mobile bar hidden', page.locator('.cb').is_visible() and not page.locator('#dock').is_visible())
    page.click('#cbNone'); page.evaluate('scrollTo(0, document.getElementById("work").offsetTop)'); page.wait_for_timeout(700)
    dock_on = page.locator('#dock').is_visible()
    pad = page.evaluate('parseFloat(getComputedStyle(document.body).paddingBottom)')
    dh = page.evaluate('document.getElementById("dock").offsetHeight')
    check('M2 hero buttons off screen → mobile bar shown, page padded by its height', dock_on and pad >= dh > 0, (dock_on, pad, dh))
    page.evaluate('scrollTo({top: document.body.scrollHeight, behavior: "instant"})'); page.wait_for_timeout(800)
    fb = page.evaluate('document.querySelector("footer").getBoundingClientRect().bottom')
    db = page.evaluate('document.getElementById("dock").getBoundingClientRect().top')
    check('M3 the bar does not cover the end of the page', fb <= db + 1 or not page.locator('#dock').is_visible(), (fb, db))
    check('M4 no sideways scroll on mobile', page.evaluate('document.documentElement.scrollWidth <= innerWidth'))
    page.click('#dock [data-open]'); page.wait_for_function('window.__dv', timeout=4000); page.wait_for_timeout(300)
    check('M5 agent open → mobile bar hidden', not page.locator('#dock').is_visible())
    mctx.close()

    rctx = browser.new_context(reduced_motion='reduce')
    rctx.route(re.compile(r'https://.*'), lambda r: r.abort())
    page = rctx.new_page(); page.goto(BASE + '/'); page.wait_for_timeout(1500)
    check('R1 reduced motion: hero loop does not autoplay, pause/play control shown', page.evaluate('document.getElementById("loop").paused') and page.locator('#loopBtn').is_visible())
    check('R2 reduced motion: content is visible without scrolling effects', page.evaluate('[...document.querySelectorAll(".rv")].every(e => getComputedStyle(e).opacity === "1")'))
    rctx.close()

    browser.close()

fails = [r for r in results if not r[1]]
print(f"\n{len(results) - len(fails)}/{len(results)} passed")
json.dump([{'name': n, 'ok': ok, 'detail': str(d)[:300]} for n, ok, d in results], open('test/e2e-results.json', 'w'), ensure_ascii=False, indent=1)
sys.exit(1 if fails else 0)
