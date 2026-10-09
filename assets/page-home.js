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
    F.renderCheckout({buttons:document.getElementById('ppButtons'), msg:document.getElementById('payMsg'), where:function(){return where;}});
    document.getElementById('payX').focus(); }
  function close(){ sheet.hidden=true; document.body.style.overflow=''; if(lastFocus&&lastFocus.focus) lastFocus.focus(); }
  F.openCheckoutSheet=open;
  document.getElementById('payX').onclick=close;
  sheet.addEventListener('click',function(e){ if(e.target===sheet) close(); });
  addEventListener('keydown',function(e){ if(e.key==='Escape'&&!sheet.hidden) close(); });
  document.querySelectorAll('[data-checkout]').forEach(function(b){ b.addEventListener('click',function(){ open(b.getAttribute('data-checkout')); }); });
  document.querySelectorAll('[data-bit]').forEach(function(b){ b.addEventListener('click',function(){
    var t=b.textContent; b.disabled=true; b.textContent='פותחים וואטסאפ…';
    F.payWithBit(b.getAttribute('data-bit')).catch(function(){ b.disabled=false; b.textContent=t;
      location.href='https://wa.me/'+F.CFG.wa+'?text='+encodeURIComponent('היי, אני רוצה לשלם בביט על פרסומת ב-1,290 ₪'); }); }); });

  /* ══ Meital ══ */
  function known(o){ var b=o&&o.brief||{}, k=Object.keys(b).filter(function(x){return b[x];});
    return k.length?k.map(function(x){return x+': '+b[x];}).join('; '):'עדיין לא ידוע כלום.'; }
  function openWhatsapp(){
    var a=document.querySelector('.fin [data-wa]')||document.querySelector('[data-wa]');
    if(a){a.scrollIntoView({behavior:'smooth',block:'center'});a.style.transition='box-shadow .4s';
      a.style.boxShadow='0 0 0 6px rgba(227,198,140,.35)';setTimeout(function(){a.style.boxShadow='';},2600);}
    return 'whatsapp button highlighted';}
  var tools={
    open_payment:function(){ open('agent'); return 'payment options are shown on screen (PayPal or Bit). The customer must click to pay.'; },
    show_payment:function(){ open('agent'); return 'payment options are shown on screen (PayPal or Bit). The customer must click to pay.'; },
    show_whatsapp:openWhatsapp,
    save_brief_note:function(p){ return F.saveNote(p&&p.field||'other', p&&p.value); }
  };
  function openAgent(w){
    // Payment status and known context come from the server, never from this browser.
    var st=F.order?F.orderStatus().catch(function(){return null;}):Promise.resolve(null);
    var timer=new Promise(function(r){ setTimeout(r,1500); });
    Promise.race([st,timer]).then(function(o){
      F.openAgent({ phase:o&&o.paid?'brief':'sales', known_context:known(o), payment_status:o?(o.paid?'verified':'pending'):'none',
        opening_line:'מה העסק שלכם, ומה הייתם רוצים לקדם?' }, tools, w);
    });
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

/* ── hero video: muted, starts when visible, pausable; caption follows what he is holding ── */
(function(){
  var v=document.getElementById('loop'),b=document.getElementById('loopBtn'); if(!v)return;
  var W=document.getElementById('loopW'),N=document.getElementById('loopN'),bar=document.getElementById('loopBar');
  var SEG=[[0,'פרחים'],[2.45,'אינסטלציה'],[5.2,'נדל״ן'],[6.62,'קונדיטוריה'],[8.12,'מוסכים']], END=10;
  var fills=SEG.map(function(sg,i){ var len=(SEG[i+1]?SEG[i+1][0]:END)-sg[0], el=document.createElement('i'), f=document.createElement('b');
    el.style.flex=len; el.appendChild(f); bar.appendChild(el); return f; });
  var cur=-1, RM=matchMedia('(prefers-reduced-motion: reduce)').matches, user=false, raf=0;
  function idx(t){ for(var i=SEG.length-1;i>=0;i--) if(t>=SEG[i][0]) return i; return 0; }
  function paint(){
    var t=v.currentTime||0, d=v.duration||END, i=idx(t);
    if(i!==cur){ cur=i; W.classList.add('out');
      setTimeout(function(){ W.textContent=SEG[cur][1]; N.textContent='0'+(cur+1)+' / 0'+SEG.length; W.classList.remove('out'); },180); }
    for(var k=0;k<fills.length;k++){ var s0=SEG[k][0], s1=SEG[k+1]?SEG[k+1][0]:d;
      fills[k].style.transform='scaleX('+Math.max(0,Math.min(1,(t-s0)/(s1-s0)))+')'; }
    if(!v.paused) raf=requestAnimationFrame(paint);
  }
  v.addEventListener('play',function(){ cancelAnimationFrame(raf); raf=requestAnimationFrame(paint); });
  v.addEventListener('seeked',paint);
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

