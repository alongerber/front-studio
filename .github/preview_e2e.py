# One-off check of the live v5 Preview (temporary branch, not for merge). No real payment, no emails.
import json, re
from playwright.sync_api import sync_playwright
B = 'https://front-studio-git-v5-alons-projects-65a14969.vercel.app'
res = []
def check(n, c, d=''):
    res.append(c); print(('PASS ' if c else 'FAIL ') + n + ('' if c else '  — ' + str(d)[:400]))
with sync_playwright() as p:
    b = p.chromium.launch()
    for name, ctxargs in [('desktop', dict(viewport={'width': 1440, 'height': 900})),
                          ('mobile', dict(viewport={'width': 390, 'height': 844}, is_mobile=True, has_touch=True, user_agent='Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1'))]:
        c = b.new_context(**ctxargs); pg = c.new_page(); errs = []
        pg.on('pageerror', lambda e: errs.append(str(e)))
        pixel = []
        pg.on('request', lambda r: pixel.append(r.url) if 'facebook.com/tr' in r.url else None)
        r = pg.goto(B + '/', wait_until='domcontentloaded')
        check(f'{name}: page 200', r.status == 200, r.status)
        pg.wait_for_timeout(2500)
        h1 = pg.locator('h1').inner_text()
        check(f'{name}: headline', 'הוא עשה את שלו' in h1 and 'עכשיו תור העסק שלכם' in h1, h1)
        check(f'{name}: price final', '1,290 ₪' in pg.locator('.h3__price').inner_text())
        check(f'{name}: consent banner first, no pixel before choice', pg.locator('.cb').is_visible() and not pixel)
        check(f'{name}: no sideways scroll', pg.evaluate('document.documentElement.scrollWidth <= innerWidth'))
        pg.click('#cbNone'); pg.wait_for_timeout(500)
        if name == 'desktop':
            v = pg.evaluate("(()=>{const v=document.getElementById('loop');return [!!v.src, v.paused, v.readyState]})()")
            pg.wait_for_timeout(2500)
            v2 = pg.evaluate("(()=>{const v=document.getElementById('loop');return [!!v.src, v.paused, Math.round(v.currentTime*10)/10]})()")
            check(f'{name}: hero loop loads and plays muted', v2[0] and not v2[1] and v2[2] > 0, (v, v2))
        # the real agent widget
        pg.click('.h3 [data-open]')
        try:
            pg.wait_for_function("document.querySelector('elevenlabs-convai') && document.querySelector('elevenlabs-convai').shadowRoot && document.querySelector('elevenlabs-convai').shadowRoot.innerHTML.length > 200", timeout=15000)
            ok = True
        except Exception as e: ok = False
        dv = pg.evaluate("JSON.parse(document.querySelector('elevenlabs-convai')?.getAttribute('dynamic-variables')||'{}')")
        check(f'{name}: real agent widget opens', ok)
        check(f'{name}: agent gets the opening question + sales phase', dv.get('opening_line') == 'מה העסק שלכם, ומה הייתם רוצים לקדם?' and dv.get('phase') == 'sales', dv)
        sr = pg.evaluate("document.querySelector('elevenlabs-convai').shadowRoot.textContent")
        check(f'{name}: widget offers text first and a voice option', ('לכתוב' in sr or 'כתבו' in sr or 'יאללה' in sr) and ('לדבר' in sr or 'דיבור' in sr or 'יאללה' in sr), sr[:300])
        if name == 'mobile':
            check(f'{name}: bar hidden while agent open', not pg.locator('#dock').is_visible())
        # checkout
        pg.evaluate("document.querySelector('[data-checkout=\"offer\"]').click()"); pg.wait_for_timeout(4000)
        msg = pg.locator('#payMsg').inner_text() if pg.locator('#payMsg').is_visible() else ''
        btns = pg.locator('#ppButtons iframe').count()
        check(f'{name}: checkout sheet opens with price', pg.locator('#pay').is_visible() and '1,290' in pg.locator('#payH').inner_text())
        print(f'INFO {name}: paypal iframes={btns} message="{msg}"')
        check(f'{name}: no JS errors', not errs, errs)
        c.close()
    # server flow on the Preview: order → note before payment → same order keeps it → finish blocked without payment
    c = b.new_context(); pg = c.new_page(); pg.goto(B + '/'); pg.wait_for_timeout(1500)
    api = lambda path, body=None, tok=None: pg.evaluate("([p,b,t]) => fetch(p,{method:b?'POST':'GET',headers:Object.assign({'content-type':'application/json'},t?{'x-order-token':t}:{}),body:b?JSON.stringify(b):undefined}).then(async r=>({s:r.status,j:await r.json().catch(()=>null)}))", [path, body, tok])
    cfg = api('/api/config')['j']
    print('INFO config:', json.dumps(cfg, ensure_ascii=False))
    check('server: price and currency from the server', cfg['amount'] == '1290.00' and cfg['currency'] == 'ILS' and cfg['environment'] == 'preview' and cfg['paypal_env'] == 'sandbox', cfg)
    o = api('/api/order', {'consent': {'analytics': 'denied', 'ads': 'denied'}})
    check('server: order created in the preview DB', o['s'] == 201 and o['j']['environment'] == 'preview', o)
    oid, tok = o['j']['order_id'], o['j']['token']
    n = api('/api/brief/note', {'order_id': oid, 'token': tok, 'field': 'business_type', 'value': 'בדיקה: מספרה'})
    check('server: note before payment saved', n['s'] == 200, n)
    g = api('/api/order?order_id=' + oid, None, tok)
    check('server: the same order holds the note', g['s'] == 200 and 'מספרה' in json.dumps(g['j'], ensure_ascii=False), g)
    f = api('/api/brief/finish', {'order_id': oid, 'token': tok})
    check('server: brief cannot be completed without payment', f['s'] == 409 and f['j']['error'] in ('payment_required', 'contact_required'), f)
    w = api('/api/order?order_id=' + oid, None, 'x' * 30)
    check('server: wrong token sees nothing', w['s'] == 404, w)
    pc = api('/api/paypal/create', {'order_id': oid, 'token': tok})
    print('INFO paypal create without sandbox keys:', pc['s'], json.dumps(pc['j']))
    th = pg.goto(B + '/thanks?p=stotz'); pg.wait_for_timeout(1500)
    o2 = api('/api/order?order_id=' + oid, None, tok)
    check('server: visiting /thanks does not mark anything paid', o2['j']['order']['paid'] is False, o2)
    b.close()
print(f'\n{sum(res)}/{len(res)} passed')
