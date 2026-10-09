# One-off Sandbox checks against a v5 Preview deployment. Prints no secrets.
import json, os, sys, urllib.request, urllib.error
B = os.environ['BASE']
def call(method, path, body=None, headers=None):
    h = {'content-type': 'application/json', 'user-agent': 'front-v5-sandbox-check'}
    h.update(headers or {})
    req = urllib.request.Request(B + path, data=json.dumps(body).encode() if body is not None else None, headers=h, method=method)
    try:
        with urllib.request.urlopen(req, timeout=30) as r: return r.status, json.loads(r.read() or b'{}')
    except urllib.error.HTTPError as e:
        try: return e.code, json.loads(e.read() or b'{}')
        except Exception: return e.code, {}
res = []
def check(name, ok, detail=''):
    res.append(ok); print(('PASS ' if ok else 'FAIL ') + name + (('  — ' + str(detail)) if detail and not ok else ''))
s, c = call('GET', '/api/config')
check('S1 config: preview, sandbox, test mode, PayPal client present, checkout open',
      s == 200 and c.get('environment') == 'preview' and c.get('paypal_env') == 'sandbox' and c.get('test_mode') is True and bool(c.get('paypal_client_id')) and c.get('checkout_open') is True,
      {k: c.get(k) for k in ('environment', 'paypal_env', 'test_mode', 'checkout_open')})
s, o = call('POST', '/api/order', {'consent': {'analytics': 'denied', 'ads': 'denied'}})
oid, tok = o.get('order_id'), o.get('token')
check('S2 order created on the Preview database', s == 200 and bool(oid), (s, o.get('error')))
print('order_id=' + str(oid))
s, n = call('POST', '/api/brief/note', {'order_id': oid, 'token': tok, 'field': 'business_type', 'value': 'מספרה (בדיקת sandbox)'})
check('S3 brief note saved before payment', s == 200, (s, n))
s, p1 = call('POST', '/api/paypal/create', {'order_id': oid, 'token': tok})
check('S4 server created a PayPal Sandbox order (server credentials work)', s == 200 and bool(p1.get('id')), (s, p1.get('error')))
s, p2 = call('POST', '/api/paypal/create', {'order_id': oid, 'token': tok})
check('S5 second create reuses the same PayPal order (no duplicate)', s == 200 and p2.get('id') == p1.get('id') and p2.get('reused') is True, (s, p2))
s, cap = call('POST', '/api/paypal/capture', {'order_id': oid, 'token': tok, 'paypal_order_id': p1.get('id')})
check('S6 capture before buyer approval does not mark paid', not cap.get('paid'), (s, cap))
s, w = call('POST', '/api/paypal/webhook', {'id': 'WH-FAKE-1', 'event_type': 'PAYMENT.CAPTURE.COMPLETED', 'resource': {'id': 'FAKE', 'custom_id': oid}},
            {'paypal-transmission-id': 'x', 'paypal-transmission-time': '2026-10-09T00:00:00Z', 'paypal-transmission-sig': 'bad',
             'paypal-cert-url': 'https://api.sandbox.paypal.com/v1/notifications/certs/CERT-x', 'paypal-auth-algo': 'SHA256withRSA'})
check('S7 unsigned/forged webhook rejected', s >= 400, (s, w))
s, g = call('GET', '/api/order?order_id=' + str(oid), None, {'x-order-token': tok})
od = g.get('order') or {}
check('S8 order still unpaid, brief note kept on the same order', s == 200 and not od.get('paid') and (od.get('brief') or {}).get('business_type'), (s, {k: od.get(k) for k in ('status', 'paid')}))
print('paypal_order_created=' + ('yes' if p1.get('id') else 'no'))
print(f'{sum(res)}/{len(res)} passed')
sys.exit(0 if all(res) else 1)
