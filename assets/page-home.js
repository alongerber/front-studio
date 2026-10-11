/* FRONT v5 · landing page behaviour. Measurement, orders, checkout and Meital live in front.js. */
(function(){"use strict";
var RM=matchMedia('(prefers-reduced-motion: reduce)').matches;

/* reveal */
var io=new IntersectionObserver(function(es){es.forEach(function(e){
  if(e.isIntersecting){e.target.classList.add('in');io.unobserve(e.target);}});},{threshold:.12,rootMargin:'0px 0px -6% 0px'});
document.querySelectorAll('.rv').forEach(function(e){ if(RM) e.classList.add('in'); else io.observe(e); });

/* top bar + mobile dock. The dock shows only once the hero buttons are off screen and the offer is not in view,
   never over the consent banner or the agent, and the page gets bottom padding so it covers nothing. */
var top=document.getElementById('top'),dock=document.getElementById('dock'),offer=document.getElementById('offer'),heroCta=document.getElementById('heroCta');
var heroVisible=true, offerVisible=false;
function paintDock(){
  var cb=!!document.querySelector('.cb'); document.body.classList.toggle('cb-on',cb);
  var on=!heroVisible&&!offerVisible&&!cb&&!document.body.classList.contains('chat-on');
  dock.classList.toggle('on',on);
  document.documentElement.style.setProperty('--dockH',on&&innerWidth<900?dock.offsetHeight+'px':'0px');
}
if('IntersectionObserver' in window){
  new IntersectionObserver(function(es){es.forEach(function(e){heroVisible=e.isIntersecting;});paintDock();},{threshold:0}).observe(heroCta);
  new IntersectionObserver(function(es){es.forEach(function(e){offerVisible=e.isIntersecting;});paintDock();},{rootMargin:'-30% 0px -30% 0px'}).observe(offer);
}
new MutationObserver(paintDock).observe(document.body,{childList:true,attributes:true,attributeFilter:['class']});
addEventListener('resize',paintDock);
addEventListener('scroll',function(){ top.classList.toggle('on',scrollY>innerHeight*.6); },{passive:true});

/* the work videos: load only when asked, one plays at a time */
var vids=[];
function wire(v,btn){
  vids.push(v);
  btn.addEventListener('click',function(){
    vids.forEach(function(o){ if(o!==v&&!o.paused) o.pause(); });
    if(!v.src){v.src=v.dataset.src;}
    v.controls=true; btn.hidden=true; v.play().catch(function(){});
  });
  new IntersectionObserver(function(es){es.forEach(function(e){ if(!e.isIntersecting&&!v.paused) v.pause(); });},{threshold:.2}).observe(v);
}
var v=document.getElementById('adv'); wire(v,document.getElementById('advPlay'));
document.querySelectorAll('[data-play]').forEach(function(b){ var x=b.parentNode.querySelector('video'); wire(x,b); });

/* FAQ */
document.querySelectorAll('.q button').forEach(function(b){
  b.addEventListener('click',function(){
    var open=b.getAttribute('aria-expanded')==='true', p=document.getElementById(b.getAttribute('aria-controls'));
    b.setAttribute('aria-expanded',!open); p.hidden=open;
  });
});
})();

/* ══ WhatsApp (survives the Facebook / Instagram in-app browser) ══ */
var WA='972559501280', WAD='055-950-1280';
function inApp(){var u=navigator.userAgent||'';return /FBAN|FBAV|FB_IAB|FBIOS|Instagram|Line\/|MicroMessenger|Snapchat|Pinterest|TikTok/i.test(u);}
function waModal(url){
  var m=document.createElement('div'); m.className='wam';
  m.innerHTML='<div class="wam__c" role="dialog" aria-modal="true"><h4>הדפדפן של פייסבוק חוסם את וואטסאפ</h4>'+
    '<p>שתי דרכים לעקוף את זה:</p><div class="wam__n">'+WAD+'</div><div class="wam__b">'+
    '<button class="btn" id="wamCopy">להעתיק את המספר</button>'+
    '<a class="btn btn--o" href="'+url+'" target="_blank" rel="noopener">לנסות שוב</a>'+
    '<button class="btn btn--o" id="wamX">סגירה</button></div>'+
    '<p style="font-size:13px;margin-top:14px">אפשר גם ללחוץ על שלוש הנקודות למעלה ולבחור ״פתח בדפדפן״.</p></div>';
  document.body.appendChild(m);
  m.querySelector('#wamX').onclick=function(){m.remove();};
  m.onclick=function(e){if(e.target===m)m.remove();};
  m.querySelector('#wamCopy').onclick=function(){
    var b=this,done=function(){b.textContent='הועתק ✓';setTimeout(function(){b.textContent='להעתיק את המספר';},2000);};
    if(navigator.clipboard&&navigator.clipboard.writeText){navigator.clipboard.writeText(WAD).then(done,done);}
    else{var t=document.createElement('textarea');t.value=WAD;document.body.appendChild(t);t.select();try{document.execCommand('copy');}catch(e){}t.remove();done();}
  };
}
document.querySelectorAll('[data-wa]').forEach(function(a){
  var url='https://wa.me/'+WA+'?text='+encodeURIComponent(a.dataset.wa);
  a.href=url; a.target='_blank'; a.rel='noopener';
  a.addEventListener('click',function(e){
    if(!inApp()) return;
    e.preventDefault();
    var t=Date.now(),hidden=false,vis=function(){if(document.hidden)hidden=true;};
    document.addEventListener('visibilitychange',vis);
    location.href='whatsapp://send?phone='+WA+'&text='+encodeURIComponent(a.dataset.wa);
    setTimeout(function(){document.removeEventListener('visibilitychange',vis);
      if(hidden||document.hidden)return; if(Date.now()-t<2400) waModal(url);},1500);
  });
});


/* ══ checkout sheet (PayPal via our server, Bit via WhatsApp + manual verification) ══ */
(function(){
  var F=window.FRONT, sheet=document.getElementById('pay'), where='offer', lastFocus=null;
  function open(w){ where=w||'offer'; lastFocus=document.activeElement; sheet.hidden=false; document.body.style.overflow='hidden';
    F.renderCheckout({buttons:document.getElementById('ppButtons'), msg:document.getElementById('payMsg'), delivery:document.getElementById('payDelivery'), where:function(){return where;}});
    document.getElementById('payX').focus(); }
  function close(){ sheet.hidden=true; document.body.style.overflow=''; if(lastFocus&&lastFocus.focus) lastFocus.focus(); }
  F.openCheckoutSheet=open;
  document.getElementById('payX').onclick=close;
  sheet.addEventListener('click',function(e){ if(e.target===sheet) close(); });
  addEventListener('keydown',function(e){
    if(sheet.hidden) return;
    if(e.key==='Escape'){ close(); return; }
    if(e.key!=='Tab') return;                             // keep keyboard focus inside the open order window
    var f=[].filter.call(sheet.querySelectorAll('button,a[href],input,select,textarea,iframe,[tabindex]:not([tabindex="-1"])'),function(x){ return !x.disabled&&x.getClientRects().length; });
    if(!f.length) return;
    var first=f[0], last=f[f.length-1];
    if(e.shiftKey&&document.activeElement===first){ e.preventDefault(); last.focus(); }
    else if(!e.shiftKey&&(document.activeElement===last||!sheet.contains(document.activeElement))){ e.preventDefault(); first.focus(); }
  });
  document.querySelectorAll('[data-checkout]').forEach(function(b){ b.addEventListener('click',function(){ open(b.getAttribute('data-checkout')); }); });
  document.querySelectorAll('[data-bit]').forEach(function(b){ b.addEventListener('click',function(){
    if(!F.live||!F.checkoutOpen) return;                  // test environment or checkout closed: Bit does nothing
    var t=b.textContent; b.disabled=true; b.textContent='פותחים וואטסאפ…';
    F.payWithBit(b.getAttribute('data-bit')).catch(function(e){ b.disabled=false; b.textContent=t;
      if(!F.live||(e&&e.message==='bit_disabled_in_test')) return;
      location.href='https://wa.me/'+F.CFG.wa+'?text='+encodeURIComponent('היי, אני רוצה לשלם בביט על פרסומת ב-1,290 ₪'); }); }); });

  /* ══ Meital ══ */
  function known(o){ var b=o&&o.brief||{}, k=Object.keys(b).filter(function(x){return b[x];});
    return k.length?(o.paid?'פרטי ההזמנה ששולמה: ':'נשמר בשיחה קודמת בדפדפן הזה (אותה הזמנה, עוד לא שולמה): ')+k.map(function(x){return x+': '+b[x];}).join('; '):'עדיין לא ידוע כלום.'; }
  function openWhatsapp(){
    var a=document.querySelector('.fin [data-wa]')||document.querySelector('[data-wa]');
    if(a){a.scrollIntoView({behavior:'smooth',block:'center'});a.style.transition='box-shadow .4s';
      a.style.boxShadow='0 0 0 6px rgba(227,198,140,.35)';setTimeout(function(){a.style.boxShadow='';},2600);}
    return 'whatsapp button highlighted';}
  // A paid order whose brief is still open is never paid again by accident: the server decides it is paid.
  function payTool(){
    var st=F.order?F.orderStatus().catch(function(){return null;}):Promise.resolve(null);
    return st.then(function(o){
      if(o&&o.paid&&!o.brief_done) return 'NOT OPENED: the order in this browser is already paid (server-verified). Do not open payment again; continue the brief. For a second ad, offer WhatsApp.';
      // Report what actually happened on screen, never what was intended.
      try{ open('agent'); }catch(e){}
      if(sheet.hidden||!sheet.getClientRects().length) return 'NOT OPENED: the payment window could not be shown on this screen. Do not say it opened. Say there is a display problem and offer WhatsApp.';
      return F.live
        ? 'OPENED: payment options are shown on screen (PayPal or Bit). The customer must click to pay. Opening the window is not a payment.'
        : 'OPENED: TEST ENVIRONMENT, only a PayPal sandbox test payment is shown, no real money. Do not mention Bit. The customer must click to pay. Opening the window is not a payment.';
    });
  }
  // Another business mid-chat: the agent asks first, then calls this with the customer's answer.
  function switchAd(p){
    var mode=p&&p.mode;
    if(mode!=='new_ad'&&mode!=='change_direction') return 'NOT DONE: mode must be new_ad or change_direction. Ask the customer which one they mean.';
    var st=F.order?F.orderStatus().catch(function(){return null;}):Promise.resolve(null);
    return st.then(function(o){
      // A paid order is never changed; while its brief is open it also stays the order of this browser.
      if(o&&o.paid&&(!o.brief_done||mode==='change_direction')){ F.notesBlocked='paid_order'; return 'NOT DONE: the order in this browser is already paid; its brief stays as it is. Do not save details of another business. For another ad, offer WhatsApp with Alon.'; }
      return F.switchAd(mode).then(function(){
        F.agentSales=true;
        return mode==='new_ad'
          ? 'DONE: a new ad was started; the previous ad and its details stay as they were. Treat known_context as not relevant to this ad. Save the new details with save_brief_note.'
          : 'DONE: the previous direction was archived (kept, not deleted) and this ad now starts with empty details. Treat known_context as replaced. Save the new details with save_brief_note.';
      });
    }).catch(function(){ F.notesBlocked='switch_failed'; return 'NOT DONE: could not update the order. Nothing about the new business can be saved now. Do not say it changed; tell the customer there is a technical problem and offer WhatsApp.'; });
  }
  var tools={
    switch_ad:switchAd,
    open_payment:payTool, show_payment:payTool,
    show_whatsapp:openWhatsapp,
    save_brief_note:function(p){ return F.saveNote(p&&p.field||'other', p&&p.value); }
  };
  // The agent gets the order's real state or nothing: while an existing order loads, the page says so; if it cannot
  // be loaded, the customer can retry and the order stays in this browser. Never "none" because of a slow answer.
  var opening=false;
  function openAgent(w){
    if(opening) return; opening=true;
    var st=F.order?Promise.race([F.orderStatus(), new Promise(function(_,no){ setTimeout(function(){ no(new Error('timeout')); },10000); })]):Promise.resolve(null);
    if(F.order) F.bar('טוענים את ההזמנה הקיימת…');
    st.then(function(o){
      F.bar(null);
      // A finished order is history: a new conversation here is a new sale and must not be tied to it.
      var done=!!(o&&o.paid&&o.brief_done), brief=!!(o&&o.paid&&!o.brief_done);
      F.agentSales=!brief;                                  // notes from a sales chat never land on an already paid order
      return F.openAgent({ phase:brief?'brief':'sales', known_context:done?'עדיין לא ידוע כלום.':known(o), payment_status:done||!o?'none':(o.paid?'verified':'pending'),
        opening_line:'מה העסק שלכם, ומה הייתם רוצים לקדם?' }, tools, w, { noOrder: done });
    },function(e){
      F.report('order_load',e);
      F.bar('לא הצלחנו לטעון את ההזמנה הקיימת. היא שמורה בדפדפן הזה.','לנסות שוב',function(){ F.bar(null); openAgent(w); });
    }).then(function(){ opening=false; },function(){ opening=false; });
  }
  addEventListener('pointerdown',F.loadAgent,{once:true,passive:true}); setTimeout(F.loadAgent,8000);
  document.querySelectorAll('[data-open]').forEach(function(b){ b.addEventListener('click',function(){
    if(!sheet.hidden && sheet.contains(b)) close();
    openAgent(b.getAttribute('data-cta')||'final'); }); });

  /* returning buyer with an open brief */
  if(F.order) F.orderStatus().then(function(o){ if(!o||!o.paid||o.brief_done) return;
    var d=document.createElement('div'); d.className='order';
    d.innerHTML='<span>יש לכם הזמנה פתוחה.</span><a href="'+F.esc(F.resumeUrl())+'">להמשיך באפיון</a>';
    document.body.appendChild(d); document.getElementById('top').style.top='42px'; }).catch(function(){});

  F.observeSections();
  F.observeVideo(document.getElementById('adv'),'ad');
  document.querySelectorAll('video[data-video]').forEach(function(x){ F.observeVideo(x,x.getAttribute('data-video')); });
})();

/* ── hero video: muted, starts when visible, pausable; reduced motion keeps the still image ── */
(function(){
  var v=document.getElementById('loop'),b=document.getElementById('loopBtn'); if(!v)return;
  var RM=matchMedia('(prefers-reduced-motion: reduce)').matches, user=false;
  function start(){ if(!v.src){v.src=v.dataset.src;} v.play().then(function(){b.hidden=false;}).catch(function(){}); }
  function setBtn(paused){ b.setAttribute('aria-pressed',paused?'true':'false'); b.setAttribute('aria-label',paused?'להפעיל את הסרטון':'לעצור את הסרטון'); }
  if(!RM){ new IntersectionObserver(function(es){es.forEach(function(e){
      if(e.isIntersecting){ if(!user) start(); } else if(!v.paused){ v.pause(); } });},{threshold:.2}).observe(v); }
  else{ b.hidden=false; setBtn(true); }
  b.addEventListener('click',function(){
    if(v.paused){ user=false; start(); setBtn(false); } else { user=true; v.pause(); setBtn(true); }
  });
  v.addEventListener('error',function(){ b.hidden=true; },true);
})();

