/* FRONT v5 · shared client: consent, ids, tracking, orders, checkout, Meital.
   Rules (see docs/ANALYTICS_CONTRACT.md):
   - Nothing is measured before a consent choice. Analytics and ads are separate choices.
   - The browser never sends Purchase and never decides an order id or a payment status.
   - Every failure here is swallowed: measurement must never break the page or the purchase. */
(function () {
  'use strict';
  var F = window.FRONT = window.FRONT || {};
  var meta = document.querySelector('meta[name="front-build"]');
  var CFG = F.CFG = {
    pixel: '871649018702910', clarity: 'xdrn5fa9p1', agent: 'agent_5801m4a74w3dfawt9hdjhbe1nrjc',
    version: meta ? meta.content : 'v5', wa: '972559501280', price: 1290, product: 'ad_1290'
  };

  /* ── small utils ── */
  function rd(store, k) { try { var v = store.getItem(k); return v ? JSON.parse(v) : null; } catch (e) { return null; } }
  function wr(store, k, v) { try { if (v == null) store.removeItem(k); else store.setItem(k, JSON.stringify(v)); } catch (e) {} }
  var LS = (function () { try { return window.localStorage; } catch (e) { return null; } })();
  var SS = (function () { try { return window.sessionStorage; } catch (e) { return null; } })();
  var mem = {};
  var memStore = { getItem: function (k) { return mem[k] || null; }, setItem: function (k, v) { mem[k] = v; }, removeItem: function (k) { delete mem[k]; } };
  var L = LS || memStore, S = SS || memStore;
  function uuid() {
    if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
    var b = new Uint8Array(16); crypto.getRandomValues(b); b[6] = (b[6] & 15) | 64; b[8] = (b[8] & 63) | 128;
    var h = Array.prototype.map.call(b, function (x) { return (x + 256).toString(16).slice(1); }).join('');
    return h.slice(0, 8) + '-' + h.slice(8, 12) + '-' + h.slice(12, 16) + '-' + h.slice(16, 20) + '-' + h.slice(20);
  }
  function randKey() { var b = new Uint8Array(24); crypto.getRandomValues(b); return btoa(String.fromCharCode.apply(null, b)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); }
  function cookie(name) { var m = document.cookie.match(new RegExp('(?:^|; )' + name + '=([^;]*)')); return m ? decodeURIComponent(m[1]) : null; }
  function setCookie(name, val, maxAge) { document.cookie = name + '=' + encodeURIComponent(val) + '; Max-Age=' + maxAge + '; Path=/; SameSite=Lax' + (location.protocol === 'https:' ? '; Secure' : ''); }
  function esc(s) { var t = document.createElement('span'); t.textContent = s == null ? '' : String(s); return t.innerHTML; }
  F.esc = esc;
  function safe(fn) { return function () { try { return fn.apply(this, arguments); } catch (e) { report('safe', e); } }; }

  /* ── consent ── */
  var CK = 'front_consent_v1';
  var consent = rd(L, CK) || { analytics: 'unset', ads: 'unset' };
  F.consent = function () { return { analytics: consent.analytics, ads: consent.ads }; };
  F.consentForServer = function () { return { analytics: consent.analytics === 'granted' ? 'granted' : 'denied', ads: consent.ads === 'granted' ? 'granted' : 'denied' }; };
  var A = function () { return consent.analytics === 'granted'; };
  var AD = function () { return consent.ads === 'granted'; };

  function setConsent(analytics, ads) {
    var wasA = A(), wasAD = AD();
    consent = { analytics: analytics ? 'granted' : 'denied', ads: ads ? 'granted' : 'denied', ts: Date.now() };
    wr(L, CK, consent);
    syncConsent();                                     // an existing order follows the latest choice (before any reload)
    if (!A()) { buffer.length = 0; queue.length = 0; setCookie('front_aid', '', 0); wr(L, 'front_ft', null); wr(L, 'front_sess', null); }
    if ((wasA && !A()) || (wasAD && !AD())) {        // tools that already loaded cannot be unloaded: revoke and reload
      try { if (window.fbq && !AD()) fbq('consent', 'revoke'); } catch (e) {}
      location.reload(); return;
    }
    applyConsent();
    if (A()) { track('consent_updated', { analytics: consent.analytics, ads: consent.ads }); for (var i = 0; i < buffer.length; i++) queue.push(buffer[i]); buffer.length = 0; flushSoon(); }
    else buffer.length = 0;
    hideBanner();
  }
  F.setConsent = setConsent;
  function syncConsent() {
    var o = F.order; if (!o || consent.analytics === 'unset') return;
    var ids = F.ids ? F.ids() : {};
    try {
      fetch('/api/consent', { method: 'POST', keepalive: true, headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ order_id: o.order_id, token: o.token, consent: F.consentForServer(), fbc: fbc(), fbp: AD() ? cookie('_fbp') : null,
          anonymous_id: ids.anonymous_id || null, session_id: ids.session_id || null }) }).catch(function () {});
    } catch (e) {}
  }
  F.syncConsent = syncConsent;

  var clarityOn = false, pixelOn = false;
  function applyConsent() {
    if (A() && !clarityOn && CFG.clarity) {
      clarityOn = true;
      (function (c, l, a, r, i, t, y) { c[a] = c[a] || function () { (c[a].q = c[a].q || []).push(arguments); };
        t = l.createElement(r); t.async = 1; t.src = 'https://www.clarity.ms/tag/' + i;
        y = l.getElementsByTagName(r)[0]; y.parentNode.insertBefore(t, y); })(window, document, 'clarity', 'script', CFG.clarity);
    }
    if (AD() && !pixelOn && CFG.pixel) {
      pixelOn = true;
      !function (f, b, e, v, n, t, s) { if (f.fbq) return; n = f.fbq = function () { n.callMethod ? n.callMethod.apply(n, arguments) : n.queue.push(arguments); };
        if (!f._fbq) f._fbq = n; n.push = n; n.loaded = !0; n.version = '2.0'; n.queue = []; t = b.createElement(e); t.async = !0;
        t.src = v; s = b.getElementsByTagName(e)[0]; s.parentNode.insertBefore(t, s); }(window, document, 'script', 'https://connect.facebook.net/en_US/fbevents.js');
      fbq('init', CFG.pixel); fbq('track', 'PageView');
    }
  }
  // Meta standard events: only with ads consent. Purchase is NOT here on purpose (server CAPI only).
  F.pixel = function (name, params, eventId) {
    if (!AD() || !window.fbq || name === 'Purchase') return;
    try { fbq('track', name, params || {}, eventId ? { eventID: eventId } : undefined); } catch (e) {}
  };

  /* ── consent banner (wording is a placeholder until the privacy policy text is decided) ── */
  var banner = null;
  function showBanner(withChoices) {
    if (banner) banner.remove();
    banner = document.createElement('div'); banner.className = 'cb'; banner.setAttribute('role', 'dialog'); banner.setAttribute('aria-label', 'הגדרות פרטיות');
    banner.setAttribute('data-clarity-mask', 'true');
    banner.innerHTML =
      '<p class="cb__t">האתר משתמש בכלים לשיפור האתר ולמדידת פרסום. אפשר לבחור.</p>' +
      '<div class="cb__o"' + (withChoices ? '' : ' hidden') + '>' +
      '<label><input type="checkbox" id="cbA"' + (A() ? ' checked' : '') + '> מדידת שימוש באתר (כדי לשפר אותו)</label>' +
      '<label><input type="checkbox" id="cbD"' + (AD() ? ' checked' : '') + '> מדידת פרסום (Meta)</label></div>' +
      '<div class="cb__b">' +
      (withChoices ? '<button type="button" class="cb__p" id="cbSave">שמירה</button>' :
        '<button type="button" class="cb__p" id="cbAll">לאשר הכול</button><button type="button" id="cbNone">רק מה שהכרחי</button><button type="button" id="cbMore">לבחור</button>') +
      '</div>';
    document.body.appendChild(banner);
    var $ = function (id) { return banner.querySelector('#' + id); };
    if ($('cbAll')) $('cbAll').onclick = function () { setConsent(true, true); };
    if ($('cbNone')) $('cbNone').onclick = function () { setConsent(false, false); };
    if ($('cbMore')) $('cbMore').onclick = function () { showBanner(true); };
    if ($('cbSave')) $('cbSave').onclick = function () { setConsent($('cbA').checked, $('cbD').checked); };
  }
  function hideBanner() { if (banner) { banner.remove(); banner = null; } }
  F.openConsent = function () { showBanner(true); };

  /* ── ids & attribution ── */
  var qs = new URLSearchParams(location.search);
  var touchNow = (function () {
    var t = {}, got = false;
    ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term'].forEach(function (k) { var v = qs.get(k); if (v) { t[k] = v.slice(0, 500); got = true; } });
    [['fb_campaign_id', 'campaign_id'], ['fb_adset_id', 'adset_id'], ['fb_ad_id', 'ad_id']].forEach(function (p) { var v = qs.get(p[0]); if (v) { t[p[1]] = v.slice(0, 64); got = true; } });
    var fbclid = qs.get('fbclid'); if (fbclid) { t.fbclid = fbclid.slice(0, 1000); got = true; }          // never cut short
    try { var r = document.referrer && new URL(document.referrer); if (r && r.host !== location.host) { t.referrer_host = r.host; got = true; } } catch (e) {}
    if (!got) return null;
    t.landing_path = location.pathname; t.ts = Date.now(); return t;
  })();
  function anonId() {
    if (!A()) return null;
    var v = cookie('front_aid');
    if (!v || !/^[0-9a-f-]{36}$/i.test(v)) { v = uuid(); }
    setCookie('front_aid', v, 34186669);                                   // ~13 months, refreshed on use
    return v;
  }
  function sessionId() {
    if (!A()) return null;
    var s = rd(L, 'front_sess'), now = Date.now(), src = touchNow ? [touchNow.utm_source, touchNow.utm_campaign, touchNow.ad_id, touchNow.fbclid].join('|') : null;
    if (!s || now - s.last > 30 * 60 * 1000 || (src && src !== s.src)) s = { id: uuid(), src: src || (s && s.src) || '' };
    s.last = now; wr(L, 'front_sess', s); return s.id;
  }
  function touches() {
    if (!A()) return { first: null, last: null };
    var ft = rd(L, 'front_ft');
    if (!ft && touchNow) { ft = touchNow; wr(L, 'front_ft', ft); }
    var lt = touchNow || rd(L, 'front_lt');
    if (touchNow) wr(L, 'front_lt', touchNow);
    return { first: ft || { landing_path: location.pathname, ts: Date.now() }, last: lt };
  }
  F.ids = function () { return { anonymous_id: anonId(), session_id: sessionId() }; };
  function fbc() {
    if (!AD()) return null;
    var c = cookie('_fbc'); if (c) return c;
    var t = touchNow && touchNow.fbclid ? touchNow : rd(L, 'front_lt');
    return t && t.fbclid ? 'fb.1.' + (t.ts || Date.now()) + '.' + t.fbclid : null;
  }
  // One random key per tab session: links Meital's conversation to the order (see migration 002).
  var LINK = (rd(S, 'front_link') || randKey()); wr(S, 'front_link', LINK);
  F.agentLink = LINK;

  /* ── events ── */
  var queue = [], buffer = [], flushT = 0;
  // Sent at once: these often happen right before the page is left (PayPal, WhatsApp).
  var URGENT = { checkout_clicked: 1, payment_cancelled: 1, whatsapp_click: 1, agent_start_requested: 1, consent_updated: 1 };
  function track(name, props, opts) {
    var e = { id: uuid(), name: name, at: new Date().toISOString(), path: location.pathname, props: props || {}, cta: opts && opts.cta || null };
    try { if (A() && window.clarity && name !== 'time_summary') clarity('event', name); } catch (x) {}
    if (A()) { queue.push(e); if (URGENT[name]) flush(false); else flushSoon(); }
    else if (consent.analytics === 'unset' && buffer.length < 100) buffer.push(e);    // decided later
    return e.id;
  }
  F.track = track;
  function flushSoon() { if (!flushT) flushT = setTimeout(function () { flushT = 0; flush(false); }, 4000); }
  function flush(beacon) {
    if (!queue.length || !A()) return;
    var ids = F.ids(), t = touches(), o = F.order;
    var body = JSON.stringify({ consent: F.consentForServer(), anonymous_id: ids.anonymous_id, session_id: ids.session_id, first_touch: t.first, last_touch: t.last,
      order_id: o && o.order_id || null, order_token: o && o.token || null, site_version: CFG.version, events: queue.splice(0, 50) });
    try {
      if (beacon && navigator.sendBeacon && navigator.sendBeacon('/api/track', new Blob([body], { type: 'text/plain' }))) return;
      fetch('/api/track', { method: 'POST', body: body, headers: { 'content-type': 'text/plain' }, keepalive: true }).catch(function () {});
    } catch (e) {}
    if (queue.length) flushSoon();
  }
  F.flush = flush;
  var errCount = 0;
  function report(where, e) { if (errCount++ < 5) track('client_error', { where: where, message: String(e && e.message || e).slice(0, 180) }); }
  F.report = report;
  window.addEventListener('error', function (e) { if (e && e.message) report('window', e.message); });

  /* ── active time (estimate: visible tab + interaction in the last 30s) ── */
  var tm = { open: 0, visible: 0, active: 0 }, lastInput = Date.now(), lastTick = Date.now();
  ['pointerdown', 'keydown', 'scroll', 'touchstart', 'wheel', 'mousemove'].forEach(function (n) { addEventListener(n, function () { lastInput = Date.now(); }, { passive: true, capture: true }); });
  function tick() {
    var now = Date.now(), d = Math.min(now - lastTick, 5000); lastTick = now;
    tm.open += d; if (!document.hidden) { tm.visible += d; if (now - lastInput < 30000) tm.active += d; }
  }
  function emitTime(final) {
    tick();
    if (tm.open < 1000) return;
    track('time_summary', { open_ms: tm.open, visible_ms: tm.visible, active_ms: tm.active, final: !!final });
    tm = { open: 0, visible: 0, active: 0 };
  }
  setInterval(tick, 1000);
  setInterval(function () { emitTime(false); }, 30000);
  document.addEventListener('visibilitychange', function () { if (document.hidden) { emitTime(true); flush(true); } else { lastTick = Date.now(); } });
  addEventListener('pagehide', function () { emitTime(true); flush(true); });

  /* ── API ── */
  function api(path, body, opts) {
    opts = opts || {};
    var init = { method: body ? 'POST' : 'GET', headers: {}, cache: 'no-store', credentials: 'same-origin' };
    if (body) { init.body = JSON.stringify(body); init.headers['content-type'] = 'application/json'; }
    if (opts.token) init.headers['x-order-token'] = opts.token;
    return fetch(path, init).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (j) {
        if (!r.ok) { var e = new Error(j.error || ('http_' + r.status)); e.status = r.status; throw e; }
        return j;
      });
    });
  }
  F.api = api;

  /* ── orders (created by the server; we only keep id + token) ── */
  var OK = 'front_order_v5';
  F.order = rd(L, OK);
  F.saveOrder = function (o) { F.order = o; wr(L, OK, o); };
  F.orderStatus = function () {
    var o = F.order; if (!o) return Promise.resolve(null);
    return api('/api/order?order_id=' + encodeURIComponent(o.order_id), null, { token: o.token }).then(function (j) {
      var sc = j.order && j.order.consent, mine = F.consentForServer();
      if (sc && consent.analytics !== 'unset' && (sc.analytics !== mine.analytics || sc.ads !== mine.ads)) syncConsent();   // changed on another page
      return j.order; })
      .catch(function (e) { if (e.status === 404) { F.saveOrder(null); return null; } throw e; });
  };
  var creating = null;
  // fresh: for a new checkout, an order that is already paid is not reused.
  F.ensureOrder = function (fresh) {
    if (creating) return creating;
    creating = (function () {
      var check = F.order ? (fresh ? F.orderStatus() : Promise.resolve({ paid: false })) : Promise.resolve(null);
      return check.then(function (st) {
        if (F.order && st && !st.paid) return F.order;
        var ids = F.ids(), t = touches();
        return api('/api/order', { consent: F.consentForServer(), anonymous_id: ids.anonymous_id, session_id: ids.session_id, first_touch: t.first, last_touch: t.last,
          fbc: fbc(), fbp: AD() ? cookie('_fbp') : null, agent_link: callStarted ? LINK : null }).then(function (j) {
          F.saveOrder({ order_id: j.order_id, token: j.token }); return F.order;
        });
      });
    })();
    creating.then(function () { creating = null; }, function () { creating = null; });
    return creating;
  };
  F.resumeUrl = function (o) { o = o || F.order; return location.origin + '/thanks#o=' + encodeURIComponent(o.order_id) + '&t=' + encodeURIComponent(o.token); };

  /* ── WhatsApp clicks (Contact = click only, never an optimisation goal) ── */
  document.addEventListener('click', safe(function (e) {
    var a = e.target.closest && e.target.closest('[data-wa]'); if (!a) return;
    var id = track('whatsapp_click', {}, { cta: a.getAttribute('data-cta') || null });
    F.pixel('Contact', {}, id);
  }), true);
  /* CTA clicks */
  document.addEventListener('click', safe(function (e) {
    var a = e.target.closest && e.target.closest('[data-cta]'); if (!a) return;
    track('cta_click', { cta_target: a.getAttribute('data-cta-target') || null }, { cta: a.getAttribute('data-cta') });
  }), true);

  /* ── section views: ≥50% visible for 1s, once per load ── */
  F.observeSections = function () {
    if (!('IntersectionObserver' in window)) return;
    var timers = {}, done = {};
    var io = new IntersectionObserver(function (es) {
      es.forEach(function (en) {
        var k = en.target.getAttribute('data-section');
        if (done[k]) return;
        if (en.isIntersecting) timers[k] = setTimeout(function () { done[k] = 1; io.unobserve(en.target); track('section_view', { section: k }); }, 1000);
        else clearTimeout(timers[k]);
      });
    }, { threshold: 0.5 });
    document.querySelectorAll('[data-section]').forEach(function (el) { io.observe(el); });
  };
  /* ── ad video (#adv only; the hero loop is not a view) ── */
  F.observeVideo = function (v, name) {
    if (!v) return;
    var seen = {};
    v.addEventListener('play', function () { if (!seen.s) { seen.s = 1; track('video_start', { video: name }); } });
    v.addEventListener('timeupdate', function () {
      if (!v.duration) return; var p = v.currentTime / v.duration * 100;
      [25, 50, 75].forEach(function (m) { if (p >= m && !seen[m]) { seen[m] = 1; track('video_progress', { video: name, pct: m }); } });
    });
    v.addEventListener('ended', function () { if (!seen.e) { seen.e = 1; track('video_complete', { video: name }); } });
  };

  /* ── Meital (ElevenLabs widget). Only `elevenlabs-convai:call` is exposed by the widget:
        we record it as agent_start_requested, never as "connected". ── */
  var widget = null, widgetLoaded = false, callStarted = false;
  // The link key is attached to an order only once a call was requested, so "waiting for call data" means a real call.
  function attachLink() { if (F.order) api('/api/agent-link', { order_id: F.order.order_id, token: F.order.token, agent_link: LINK }).catch(function () {}); }
  F.loadAgent = function () {
    if (widgetLoaded) return; widgetLoaded = true;
    var t = document.createElement('script'); t.src = 'https://unpkg.com/@elevenlabs/convai-widget-embed@0.19.0'; t.async = true; document.head.appendChild(t);
  };
  function expand(w) {
    var sr = w.shadowRoot; if (!sr) return false;
    var b = sr.querySelector('button[aria-label="פתיחה"],button[aria-label="Expand widget"],button[aria-expanded="false"]');
    if (b) { b.click(); return true; } return false;
  }
  function wrapTools(tools) {
    var out = {};
    Object.keys(tools).forEach(function (name) {
      out[name] = function (params) {
        var res;
        try { res = tools[name](params); } catch (e) { track('agent_tool_result', { tool: name, ok: false, error: String(e.message || e).slice(0, 120) }); return 'error'; }
        return Promise.resolve(res).then(function (r) { track('agent_tool_result', { tool: name, ok: true }); return r; },
          function (e) { track('agent_tool_result', { tool: name, ok: false, error: String(e && e.message || e).slice(0, 120) }); return 'not saved: ' + (e && e.message || 'error'); });
      };
    });
    return out;
  }
  // vars: {phase, known_context, payment_status, opening_line}. Ids are added here.
  F.openAgent = function (vars, tools, where) {
    F.loadAgent();
    track('agent_opened', {}, { cta: where || null });
    if (widget && expand(widget)) return widget;
    if (widget) widget.remove();
    var ids = F.ids();
    var dv = Object.assign({}, vars, {
      front_link: LINK, anonymous_id: ids.anonymous_id || '', session_id: ids.session_id || '', order_id: F.order ? F.order.order_id : '', site_version: CFG.version,
      // What the agent may offer. Until the server confirms production: PayPal sandbox only, never Bit.
      payment_methods: F.live ? 'פייפאל (גם בכרטיס אשראי בלי חשבון) או ביט'
        : 'סביבת בדיקה: רק תשלום בדיקה בפייפאל, בלי כסף אמיתי. אין ביט.'
    });
    var w = document.createElement('elevenlabs-convai');
    w.setAttribute('agent-id', CFG.agent); w.setAttribute('default-expanded', 'true');
    w.setAttribute('dynamic-variables', JSON.stringify(dv));
    w.setAttribute('data-clarity-mask', 'true');                         // chat text and contact details never reach Clarity
    w.addEventListener('elevenlabs-convai:call', function (e) {
      try { e.detail.config.clientTools = Object.assign(e.detail.config.clientTools || {}, wrapTools(tools || {})); } catch (x) { report('agent_tools', x); }
      track('agent_start_requested', {});
      if (!callStarted) { callStarted = true; attachLink(); }
    });
    document.body.appendChild(w); document.body.classList.add('chat-on');
    widget = w;
    return w;
  };
  // save_brief_note → server, before the call ends. Returns only after the server stored it.
  F.saveNote = function (field, value) {
    callStarted = true;                                   // a tool call proves the conversation is running
    return F.ensureOrder(false).then(function (o) {
      return api('/api/brief/note', { order_id: o.order_id, token: o.token, field: String(field || 'other'), value: String(value || '') });
    }).then(function () { return 'saved'; });
  };

  /* ── environment: outside production no real money moves ── */
  // Until the server confirms production we behave as a test environment: Bit stays hidden and refused.
  var cfgReady = null;
  F.config = function () {
    if (!cfgReady) { cfgReady = api('/api/config'); cfgReady.catch(function () { cfgReady = null; }); }
    return cfgReady;
  };
  F.live = false;
  function markEnv() {
    F.config().then(function (c) {
      F.live = c.test_mode === false && c.environment === 'production';
      document.documentElement.classList.toggle('env-live', F.live);
      if (F.live || document.getElementById('testBar')) return;
      var bar = document.createElement('div');
      bar.id = 'testBar'; bar.setAttribute('role', 'status');
      bar.textContent = 'סביבת בדיקה — אין להעביר כסף';
      bar.style.cssText = 'position:sticky;top:0;z-index:9999;background:#ffd400;color:#111;font:800 15px/1.3 Heebo,system-ui,sans-serif;text-align:center;padding:8px 12px';
      document.body.insertBefore(bar, document.body.firstChild);
    }, function () {});
  }
  if (document.body) markEnv(); else document.addEventListener('DOMContentLoaded', markEnv);

  /* ── checkout (PayPal Orders API via our server; Bit = manual, verified by admin, production only) ── */
  var ppReady = null, ppConfig = null;
  function loadPaypal() {
    if (ppReady) return ppReady;
    ppReady = F.config().then(function (c) {
      ppConfig = c;
      if (!c.paypal_client_id) throw new Error('paypal_not_configured');
      return new Promise(function (res, rej) {
        var s = document.createElement('script');
        s.src = 'https://www.paypal.com/sdk/js?client-id=' + encodeURIComponent(c.paypal_client_id) + '&currency=ILS&intent=capture&components=buttons&locale=he_IL';
        s.onload = function () { window.paypal ? res(window.paypal) : rej(new Error('paypal_sdk_missing')); };
        s.onerror = function () { rej(new Error('paypal_sdk_failed')); };
        document.head.appendChild(s);
      });
    });
    ppReady.catch(function () { ppReady = null; });
    return ppReady;
  }
  var rendered = false;
  // ui: {box, buttons, msg, where}
  F.renderCheckout = function (ui) {
    var say = function (t, cls) { ui.msg.hidden = !t; ui.msg.className = 'paymsg' + (cls ? ' ' + cls : ''); ui.msg.textContent = t || ''; };
    if (rendered) return;
    say('טוענים את אפשרויות התשלום…');
    loadPaypal().then(function (paypal) {
      say('');
      rendered = true;
      return paypal.Buttons({
        style: { layout: 'vertical', shape: 'rect', height: 48, label: 'pay' },
        onClick: function (data) {
          var id = track('checkout_clicked', { method: data && data.fundingSource || 'paypal' }, { cta: ui.where() });
          F.pixel('InitiateCheckout', { value: CFG.price, currency: 'ILS', content_ids: [CFG.product], content_type: 'product' }, id);
        },
        createOrder: function () {
          return F.ensureOrder(true).then(function (o) { return api('/api/paypal/create', { order_id: o.order_id, token: o.token }); }).then(function (j) { return j.id; });
        },
        onApprove: function (data, actions) {
          say('מאמתים את התשלום מול פייפאל…');
          var o = F.order;
          return api('/api/paypal/capture', { order_id: o.order_id, token: o.token, paypal_order_id: data.orderID }).then(function (r) {
            if (r.paid || r.pending) { flush(true); location.href = F.resumeUrl(o); return; }
            if (r.status === 'APPROVED' && actions && actions.restart) return actions.restart();   // e.g. card declined → choose another
            say('התשלום לא הושלם. לא חויבתם. אפשר לנסות שוב' + (F.live ? ' או לשלם בביט.' : '.'), 'err');
          }, function (e) {
            report('capture', e);
            // The webhook still captures an approved payment even if this call failed.
            say('לא הצלחנו לאמת כרגע. אם אישרתם בפייפאל, התשלום ייקלט אצלנו גם בלי לעשות דבר. אפשר לבדוק בקישור ההזמנה.', 'err');
            setTimeout(function () { location.href = F.resumeUrl(o); }, 2500);
          });
        },
        onCancel: function () { track('payment_cancelled', { method: 'paypal' }); say('החלון נסגר בלי תשלום. אפשר לנסות שוב.'); },
        onError: function (err) { report('paypal', err); say('משהו השתבש בתשלום בפייפאל. לא חויבתם. אפשר לנסות שוב' + (F.live ? ' או לשלם בביט.' : '.'), 'err'); }
      }).render(ui.buttons).then(function () {
        if (!('IntersectionObserver' in window)) return track('checkout_presented', { method: 'paypal' });
        var t = 0, io = new IntersectionObserver(function (es) {
          es.forEach(function (en) {
            if (en.isIntersecting) t = setTimeout(function () { io.disconnect(); track('checkout_presented', { method: 'paypal' }); }, 1000);
            else clearTimeout(t);
          });
        }, { threshold: 0.5 });
        io.observe(ui.buttons);
      });
    }).catch(function (e) {
      report('paypal_load', e);
      if (!F.live) return say(e && e.message === 'paypal_not_configured' ? 'סביבת בדיקה — אין להעביר כסף. תשלום הבדיקה (PayPal Sandbox) עדיין לא מחובר.' : 'סביבת בדיקה — אין להעביר כסף. לא הצלחנו לטעון את PayPal Sandbox.', 'err');
      say(e && e.message === 'paypal_not_configured' ? 'תשלום בפייפאל לא זמין כרגע. אפשר לשלם בביט.' : 'לא הצלחנו לטעון את פייפאל בדפדפן הזה. אפשר לפתוח את האתר בדפדפן רגיל, או לשלם בביט.', 'err');
    });
  };
  // Bit: we create the order first so the WhatsApp message carries its number for manual verification.
  F.payWithBit = function (where) {
    if (!F.live) return Promise.reject(new Error('bit_disabled_in_test'));   // never route a test visitor to a real transfer
    return F.ensureOrder(true).then(function (o) {
      var text = 'היי, אני רוצה לשלם בביט על פרסומת ב-1,290 ₪. מספר הזמנה ' + o.order_id;
      var id = track('whatsapp_click', {}, { cta: where || 'bit' }); F.pixel('Contact', {}, id);
      flush(true);
      var inApp = /FBAN|FBAV|FB_IAB|FBIOS|Instagram/i.test(navigator.userAgent || '');
      location.href = (inApp ? 'whatsapp://send?phone=' + CFG.wa + '&text=' : 'https://wa.me/' + CFG.wa + '?text=') + encodeURIComponent(text);
      return o;
    }, function (e) { report('bit', e); throw e; });
  };

  /* ── boot ── */
  applyConsent();
  if (consent.analytics === 'unset' || consent.ads === 'unset') {
    if (document.body) showBanner(false); else document.addEventListener('DOMContentLoaded', function () { showBanner(false); });
  }
  document.addEventListener('click', function (e) { var b = e.target.closest && e.target.closest('[data-consent-open]'); if (b) { e.preventDefault(); F.openConsent(); } });
  var landing = { };
  if (touchNow) ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'campaign_id', 'adset_id', 'ad_id', 'referrer_host'].forEach(function (k) { if (touchNow[k]) landing[k] = touchNow[k]; });
  landing.has_fbclid = !!(touchNow && touchNow.fbclid);
  landing.viewport = innerWidth + 'x' + innerHeight;
  track('landing_view', landing);
})();
