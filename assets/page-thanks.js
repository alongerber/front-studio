/* FRONT v5 · order page. Everything shown here comes from the server.
   Arriving here proves nothing: no Purchase is sent from this page, ever. */
(function () {
  'use strict';
  var F = window.FRONT;
  function $(id) { return document.getElementById(id); }
  var esc = F.esc;

  /* The personal link carries the order token in the fragment (#o=…&t=…): it never reaches any server log or Referer. */
  var h = new URLSearchParams(location.hash.replace(/^#/, ''));
  if (h.get('o') && h.get('t')) {
    F.saveOrder({ order_id: h.get('o').toUpperCase().slice(0, 12), token: h.get('t').slice(0, 64) });
    try { history.replaceState(null, '', location.pathname); } catch (e) {}          // keep the token out of the address bar
  }
  var order = null;                 // server view of the order
  var LABEL = { business_type: 'סוג העסק', business_name: 'שם העסק', promote: 'מה מקדמים', audience: 'למי זה מיועד', past_experience: 'ניסיון קודם',
    concern: 'חשש שעלה', avoid: 'מה לא להגיד', call_to_action: 'מה הצופה צריך לעשות', tone: 'טון', contact_details: 'פרטים בסרטון', customer_questions: 'מה לקוחות שואלים', other: 'עוד' };

  if (!F.order) { $('noorder').hidden = false; ['c1', 'c2', 'c3'].forEach(function (id) { $(id).hidden = true; }); $('ordId').textContent = '—'; $('payPill').hidden = true; return; }
  $('ordId').textContent = F.order.order_id;

  /* ── status ── */
  function render(o) {
    order = o;
    F.supportOrder = { order_id: F.order.order_id, token: F.order.token };   // the server just confirmed this order for this link
    var pill = $('payPill');
    pill.classList.remove('ok', 'warn');
    if (o.paid) { pill.textContent = o.paid_via === 'bit_manual' ? 'התשלום בביט אושר' : 'התשלום התקבל'; pill.classList.add('ok'); $('h1').textContent = 'התשלום התקבל.'; $('nopay').hidden = true; }
    else if (o.status === 'pending') { pill.textContent = 'התשלום בבדיקה אצל פייפאל'; pill.classList.add('warn'); $('nopay').hidden = false;
      $('nopayTxt').textContent = 'פייפאל עדיין בודקים את התשלום. ברגע שיאשרו, זה יופיע כאן. בינתיים אפשר להתחיל באפיון.'; }
    else if (o.status === 'refunded') { pill.textContent = 'התשלום הוחזר'; pill.classList.add('warn'); $('nopay').hidden = true; $('h1').textContent = 'התשלום הוחזר.'; }
    else { pill.textContent = 'עדיין לא התקבל תשלום'; pill.classList.add('warn'); $('nopay').hidden = false; $('h1').textContent = 'ההזמנה נפתחה.'; }
    renderKnown(); showContact(); if (o.brief_done) showFinished(); sendState();
  }
  function refresh() {
    return F.orderStatus().then(function (o) {
      if (!o) { $('noorder').hidden = false; return null; }
      render(o); return o;
    }).catch(function (e) { F.report('status', e); return null; });
  }
  // Webhooks may land a little after the customer: poll fast at first, then slowly, and stop once paid.
  var started = Date.now();
  function poll() {
    refresh().then(function (o) {
      if (o && o.paid) return;
      var age = Date.now() - started; if (age > 15 * 60 * 1000) return;
      setTimeout(poll, age < 2 * 60 * 1000 ? 5000 : 20000);
    });
  }
  poll();

  /* ── known brief ── */
  function keys() { var b = order && order.brief || {}; return Object.keys(b).filter(function (k) { return b[k]; }); }
  function renderKnown() {
    var k = keys(), b = order && order.brief || {}; $('known').hidden = !k.length;
    $('knownList').innerHTML = k.map(function (x) { return '<li>' + esc(LABEL[x] || x) + ': <b>' + esc(b[x]) + '</b></li>'; }).join('');
  }

  /* ── 01 contact ── */
  var cf = $('cf');
  function unlock() { $('c2').classList.remove('off'); $('c3').classList.remove('off'); $('resume').hidden = false; }
  function showContact() {
    var c = order && order.contact; if (!c || !c.name || !c.phone) return;
    if (!cf.hidden && document.activeElement && cf.contains(document.activeElement)) return;
    cf.hidden = true; var s = $('cSaved'); s.hidden = false;
    s.innerHTML = 'נשמר: <b>' + esc(c.name) + '</b> · <b dir="ltr">' + esc(c.phone) + '</b>' + (c.email ? ' · <b dir="ltr">' + esc(c.email) + '</b>' : '') + ' · <button type="button" class="lnk" id="cEdit">עריכה</button>';
    $('cEdit').onclick = function () { cf.name.value = c.name; cf.phone.value = c.phone; cf.email.value = c.email || ''; cf.hidden = false; s.hidden = true; };
    unlock();
  }
  cf.addEventListener('submit', function (e) {
    e.preventDefault();
    var n = cf.name.value.trim(), p = cf.phone.value.trim(), m = cf.email.value.trim(), msg = $('cMsg');
    var bad = function (t) { msg.hidden = false; msg.className = 'msg err'; msg.textContent = t; };
    if (!n || p.replace(/\D/g, '').length < 9) return bad('צריך שם וטלפון, כדי שנוכל לשלוח את התסריט.');
    if (m && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(m)) return bad('כתובת האימייל לא נראית תקינה.');
    var btn = cf.querySelector('button[type=submit]'); btn.disabled = true; msg.hidden = true;
    F.api('/api/brief/contact', { order_id: F.order.order_id, token: F.order.token, name: n, phone: p, email: m })
      .then(function () { cf.hidden = true; return refresh(); })
      .catch(function (err) { bad('לא הצלחנו לשמור כרגע. נסו שוב בעוד רגע.'); F.report('contact', err); })
      .then(function () { btn.disabled = false; });
  });

  /* ── 02 Meital, in brief mode. What she saves goes to the server immediately. ── */
  function known() { var b = order && order.brief || {}, k = keys(); return k.length ? k.map(function (x) { return (LABEL[x] || x) + ': ' + b[x]; }).join('; ') : 'עדיין לא ידוע כלום.'; }
  function opening() {
    // The page shows the payment state from the server; Meital confirms payment only after her own server check.
    var b = order && order.brief || {}, biz = b.business_name || b.business_type;
    var head = 'תודה על ההזמנה. ';
    if (biz) return head + 'את ' + biz + ' כבר הכרנו, עכשיו נדייק מה הפרסומת צריכה להגיד. ' + (b.promote ? 'מי הלקוח שהכי חשוב לכם להביא?' : 'איזה שירות או מוצר הכי חשוב לכם לקדם?');
    return head + 'בואו נתחיל: איזה עסק יש לכם, ומה הכי הייתם רוצים שיזמינו אצלכם?';
  }
  function supportTool() {
    try { F.openSupport('agent'); } catch (e) {}
    return document.getElementById('support') ? 'OPENED: the help form is on screen with this order attached. Nothing was sent yet: the customer writes and sends it. Do not say a request was opened or passed on.'
      : 'NOT OPENED: the help form could not be shown. Tell the customer the link is at the bottom of the page, under "עזרה בהזמנה".';
  }
  var tools = {
    save_brief_note: function (p) { return F.saveNote(p && p.field || 'other', p && p.value).then(function (r) { refresh(); return r; }); },
    open_support: supportTool, show_whatsapp: supportTool,   // show_whatsapp: older agent versions; it opens the same help form
    open_payment: function () { return 'NOT OPENED: payment is not opened from the order page. To know whether the payment arrived, call check_payment.'; },
    switch_ad: function () { return 'NOT DONE: this is the brief of a paid order; it stays as it is. Do not save details of another business here. For another ad, the customer can order it from the home page.'; }
  };
  $('openChat').addEventListener('click', function () {
    F.agentSales = false;
    F.openAgent({ phase: 'brief', known_context: known(), payment_status: order && order.paid ? 'verified' : 'pending', opening_line: opening() }, tools, 'thanks');
  });
  $('copyLink').addEventListener('click', function () {
    var u = F.resumeUrl(), b = this;
    (navigator.clipboard ? navigator.clipboard.writeText(u) : Promise.reject()).then(function () { b.textContent = 'הקישור הועתק'; }, function () { prompt('הקישור האישי להמשך:', u); });
  });

  /* ── 03 send: "received" is shown only after the server confirms it saved ── */
  function showFinished() {
    $('fin').hidden = false; $('c3').hidden = true; $('sfSend').disabled = true; $('sfMsg').hidden = true;
    var c = order && order.contact || {};
    $('finTxt').textContent = 'הזמנה ' + F.order.order_id + '. הכול אצלנו. הצעד הבא: תסריט לאישור, ' + (c.email ? 'במייל או בוואטסאפ.' : 'בוואטסאפ.');
  }
  // Completing the brief needs a payment that stands and minimum content (the server enforces both).
  function sendState() {
    var b = $('send'), msg = $('sMsg'); if (!order) return;
    if (!order.paid && !order.brief_done) {
      b.disabled = true; $('sfSend').disabled = true; msg.hidden = false; msg.className = 'msg';
      msg.textContent = order.refunded ? 'התשלום להזמנה הזו הוחזר, ולכן אי אפשר להעביר אותה להפקה.' : 'אפשר לשמור פרטים כבר עכשיו. שליחה להפקה נפתחת אחרי שהתשלום מאושר.';
    } else if (b.disabled && !sending) { b.disabled = false; $('sfSend').disabled = false; msg.hidden = true; }
  }
  /* ── 02b self-fill: the same fields, the same note API and the same server rules as Meital's notes ── */
  var sf = $('sf'), SF = ['business_type', 'business_name', 'promote', 'audience', 'call_to_action', 'avoid', 'tone', 'contact_details', 'customer_questions', 'other'];
  var DRAFT = 'front_brief_draft_' + F.order.order_id;
  function draft(v) { try { if (v === undefined) return JSON.parse(sessionStorage.getItem(DRAFT) || 'null'); if (v) sessionStorage.setItem(DRAFT, JSON.stringify(v)); else sessionStorage.removeItem(DRAFT); } catch (e) { return null; } }
  function formValues() { var o = {}; SF.forEach(function (k) { o[k] = sf[k].value.trim(); }); return o; }
  var filled = false;                 // fields are filled once from the server (and an unsent draft); never overwritten while typing
  function fillForm() {
    if (filled || !order) return; filled = true;
    var b = order.brief || {}, d = draft() || {};
    SF.forEach(function (k) { sf[k].value = d[k] || b[k] || ''; });
  }
  sf.addEventListener('input', function (e) { draft(formValues()); var l = e.target.closest('label'); if (l) fieldError(l.dataset.f, ''); });
  function setMode(self) {
    $('mMeital').setAttribute('aria-pressed', String(!self)); $('mSelf').setAttribute('aria-pressed', String(self));
    $('meitalPane').hidden = self; sf.hidden = !self; if (self) fillForm();
  }
  $('mMeital').onclick = function () { setMode(false); };
  $('mSelf').onclick = function () { setMode(true); };
  function fieldError(k, text) {
    var l = sf.querySelector('[data-f="' + k + '"]'); if (!l) return;
    var e = l.querySelector('.ferr'); e.hidden = !text; e.textContent = text || '';
    l.querySelector('input').setAttribute('aria-invalid', text ? 'true' : 'false');
  }
  var MISSING_TEXT = { business_type: 'חסר: איזה עסק (או שם העסק).', promote: 'חסר: מה הפרסומת צריכה לקדם.' };
  function showMissing(missing) {
    setMode(true);
    missing.forEach(function (k) { fieldError(k, MISSING_TEXT[k] || 'חסר.'); });
    var first = missing[0] && sf[missing[0]]; if (first) { first.focus(); first.scrollIntoView({ behavior: 'smooth', block: 'center' }); }
  }
  // What the server will see after saving: stored brief + the non-empty form values (an empty field never deletes).
  function missingAfter(vals) {
    var b = order && order.brief || {}, has = function (k) { return String(vals[k] || b[k] || '').trim().length >= 2; };
    var m = []; if (!has('business_type') && !has('business_name')) m.push('business_type'); if (!has('promote')) m.push('promote'); return m;
  }
  // Save only what changed and is not empty, one field at a time; any refusal stops and is reported (nothing is lost).
  function saveForm() {
    if (sf.hidden && !filled) return Promise.resolve();
    var vals = formValues(), b = order && order.brief || {};
    var todo = SF.filter(function (k) { return vals[k] && vals[k] !== String(b[k] || ''); });
    return todo.reduce(function (p, k) {
      return p.then(function () { return F.api('/api/brief/note', { order_id: F.order.order_id, token: F.order.token, field: k, value: vals[k], phase: 'brief' }); });
    }, Promise.resolve());
  }

  /* ── 03 send (Meital or self-fill): "received" is shown only after the server confirms the brief is completed ── */
  var sending = false;
  function sendBrief() {
    var b = $('send'), sb = $('sfSend'), msg = sf.hidden ? $('sMsg') : $('sfMsg');
    $('sMsg').hidden = true; $('sfMsg').hidden = true;
    if (sending) return;
    var fail = function (t, html) { msg.hidden = false; msg.className = 'msg err'; if (html) msg.innerHTML = html; else msg.textContent = t; };
    if (!(order && order.has_contact)) { fail('צריך קודם שם וטלפון בשלב 01.'); $('c1').scrollIntoView({ behavior: 'smooth', block: 'center' }); return; }
    if (!sf.hidden) { var m = missingAfter(formValues()); if (m.length) { showMissing(m); fail('חסרים פרטים, מסומן ליד השדות.'); return; } }
    sending = true; b.disabled = true; sb.disabled = true; b.textContent = 'שולחים…'; sb.textContent = 'שולחים…';
    var done = function () { sending = false; b.disabled = false; sb.disabled = false; b.textContent = 'שליחת האפיון'; sb.textContent = 'שמירה ושליחת האפיון'; sendState(); };
    saveForm()
      .then(function () { return F.api('/api/brief/finish', { order_id: F.order.order_id, token: F.order.token }); })
      .then(function (r) { if (!(r && r.ok && r.saved)) throw new Error('not_saved'); draft(null); return refresh(); })
      .then(function () { done(); showFinished(); })
      .catch(function (err) {
        done();
        var code = err && err.message;
        if (code === 'brief_incomplete') {
          return F.orderStatus().then(function (o) { if (o) order = o; filled = false; fillForm(); showMissing(order.brief_missing || ['business_type', 'promote']);
            msg = $('sfMsg'); fail('כדי להתחיל לעבוד חסרים עוד פרטים, מסומנים ליד השדות. אפשר להשלים כאן או לספר למיטל.'); });
        }
        if (code === 'payment_required') return fail('התשלום עוד לא מאושר אצלנו, ולכן אי אפשר עדיין להעביר להפקה. כל מה שכתבתם נשמר.');
        if (code === 'contact_required') { $('c1').scrollIntoView({ behavior: 'smooth', block: 'center' }); return fail('צריך קודם שם וטלפון בשלב 01.'); }
        if (code === 'rate_limited') return fail('היו הרבה ניסיונות ברצף. מה שמילאתם נשאר כאן; נסו שוב בעוד דקה.');
        if (code === 'page_outdated') return fail('העמוד הזה לא מעודכן. רעננו אותו; מה שמילאתם נשמר בדפדפן ויחזור לשדות.');
        F.report('finish', err);
        b.textContent = 'לנסות שוב';
        fail(null, 'לא הצלחנו לשמור כרגע (' + esc(code || 'שגיאה') + '). מה שמילאתם נשאר כאן. נסו שוב בעוד רגע, או <a class="lnk" href="#" data-support="thanks">פנו בטופס העזרה</a>; ההזמנה תצורף אליו.');
      });
  }
  $('send').addEventListener('click', sendBrief);
  sf.addEventListener('submit', function (e) { e.preventDefault(); sendBrief(); });

  addEventListener('pointerdown', F.loadAgent, { once: true, passive: true });
})();
