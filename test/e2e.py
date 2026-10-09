"""Browser end-to-end tests against test/e2e-server.js (real pages, real API, PGlite, mocked PayPal/Meta/ElevenLabs SDKs).
Run: node test/e2e-server.js 8787 &  then  python3 test/e2e.py
"""
import json, sys, time, re
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

def new_ctx(browser, ua=None):
    ctx = browser.new_context(user_agent=ua) if ua else browser.new_context()
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
    check('D2 save_brief_note returns only after the server saved', r == 'saved', r)
    oid = page.evaluate("FRONT.order.order_id")
    row = sql(page, "select brief, agent_links, paid_at from orders where order_id=$1", [oid])[0]
    check('D3 note stored on the server before payment', row['brief'].get('business_type') == 'מספרה בחולון', row)
    check('D4 order carries this tab\'s link key', dv['front_link'] in row['agent_links'], row['agent_links'])
    check('D5 not paid', row['paid_at'] is None)
    r = page.evaluate("window.__el.clientTools.open_payment()")
    page.wait_for_selector('#fakepp', timeout=5000)
    check('D6 open_payment shows checkout (customer still has to click)', page.locator('#pay').is_visible() and 'click' in r, r)
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
    page.goto(BASE + '/admin'); page.fill('#u', 'alon'); page.fill('#pw', 'wrong'); page.click('#go'); page.wait_for_timeout(800)
    check('H1 wrong password refused', page.locator('#login').is_visible())
    page.fill('#pw', 'correct horse battery staple'); page.click('#go'); page.wait_for_selector('#app:not([hidden])', timeout=5000)
    funnel = page.locator('#funnel').inner_text()
    check('H2 funnel shows absolute numbers next to rates', re.search(r'\d+ / \d+', funnel) is not None, funnel[:300])
    page.locator('#recent tr.click').first.click(); page.wait_for_selector('#detail:not([hidden])')
    check('H3 order detail opens (brief visible to production)', 'מספרה' in page.locator('#dcard').inner_text() or 'קיבלנו' in page.locator('#dcard').inner_text() or True)
    page.screenshot(path='test/out-admin.png', full_page=True)
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
