/* The card a tester sees: what to try, a note box on each, and a wrap-up.
 *
 * Loads only when the site was booted by a test. Everything the tester does
 * with the card — done, couldn't, a note, opening the hint, the wrap-up — goes
 * to the test that sent them, under a session id the site made once. Nothing
 * else is collected: not what they write on the site, and not their name unless
 * they type one into the last box.
 *
 * Its place in the list survives reloads and the walk between the editor and
 * the published site, because the id comes from the site and the place is kept
 * in localStorage against it.
 *
 * A tour (mode "tour") uses the same card the other way round: it plays
 * itself, pressing through each step while a ring shows where, checks the site
 * shows it happened, and ends with a button instead of questions.
 */
(function () {
  'use strict';
  var cfg = window.PGUT;
  if (!cfg || !cfg.test || !cfg.session || !cfg.report || !cfg.tasks || !cfg.tasks.length) return;

  var KEY = 'pgut:' + cfg.test + ':' + cfg.session;
  var state = load() || { i: 0, started: 0, taskStart: 0, results: {}, wrapped: false, hidden: false, pos: null, queue: [] };
  var tasks = cfg.tasks;
  var tour = cfg.mode === 'tour';
  // a tour reads each step out loud, with the browser's own voice
  var voiceOk = tour && 'speechSynthesis' in window && typeof SpeechSynthesisUtterance !== 'undefined';
  var voiceBlocked = false;
  // one tab plays a tour; another tab on the same site shows where it is
  // playing rather than pressing buttons in the same editor at the same time
  var tabId = (function () {
    try {
      var id = sessionStorage.getItem('pgut:tab');
      if (!id) { id = Math.random().toString(36).slice(2, 10); sessionStorage.setItem('pgut:tab', id); }
      return id;
    } catch (e) { return 'tab'; }
  })();
  var spectator = false;
  // a tour's own memory: which steps the site was marked for, what the card
  // saw when a step began (words on the home page, blocks in the editor), and
  // whether the card stepped aside for the ring
  state.marked = state.marked || {};
  state.base = state.base || {};
  // sound is off until someone turns it on: a page that starts talking is
  // not what anyone expects from a website
  if (state.voice === undefined) state.voice = false;

  function load() { try { return JSON.parse(localStorage.getItem(KEY) || 'null'); } catch (e) { return null; } }
  function save() { try { localStorage.setItem(KEY, JSON.stringify(state)); } catch (e) {} }

  /* ---- sending --------------------------------------------------------- */
  // Events queue up and go in small batches. A failed send stays in the queue
  // for the next try, so a flaky minute loses nothing.
  var sending = false;

  function where() {
    return String(location.pathname + location.search).slice(0, 200);
  }

  function send(type, task, note, data) {
    state.queue.push({ t: Date.now(), type: type, task: task || '', path: where(), note: note || '', data: data || null });
    save();
    flush();
  }

  function flush() {
    if (sending || !state.queue.length || !window.fetch) return;
    // a result whose site check is still out waits a moment, so the answer
    // travels with it; past seven seconds it goes as it is
    var waiting = state.queue.some(function (e) { return e.data && e.data.check === 'pending' && Date.now() - e.t < 7000; });
    if (waiting) { setTimeout(flush, 800); return; }
    var batch = state.queue.slice(0, 40);
    sending = true;
    fetch(cfg.report, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ test: cfg.test, session: cfg.session, events: batch }),
      keepalive: true,
    })
      .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); state.queue = state.queue.slice(batch.length); save(); })
      .catch(function () {})
      .then(function () { sending = false; if (state.queue.length) setTimeout(flush, 4000); });
  }

  window.addEventListener('error', function (ev) {
    var msg = ev && ev.message ? String(ev.message).slice(0, 300) : 'error';
    send('error', currentId(), msg);
  });

  /* ---- the card -------------------------------------------------------- */
  // [hidden] is spelled out, and for everything inside the card as well as the
  // card itself, because the controls here use `all: unset` — which throws away
  // the browser's own rule for the hidden attribute. Without it the bring-back
  // pill shows as an empty black lozenge from the first paint, and "Show a hint"
  // stays on screen after the hint it opened.
  // A tour's colours: one accent for the card's buttons, its edges, the ring
  // and the pointer's halo, and a dark or light card. The service checks the
  // accent can be read and works out what goes on it (ink) and the shade used
  // for words on the card (text); these are only defaults if it did not.
  function hexOk(v, fallback) { return /^#[0-9a-f]{6}$/i.test(String(v || '')) ? v : fallback; }
  function alpha(hex, a) {
    var n = parseInt(hex.slice(1), 16);
    return 'rgba(' + ((n >> 16) & 255) + ',' + ((n >> 8) & 255) + ',' + (n & 255) + ',' + a + ')';
  }
  var theme = (function (t) {
    t = t && typeof t === 'object' ? t : {};
    var light = t.card === 'light';
    var acc = hexOk(t.accent, '#7cf2b0');
    return { acc: acc, ink: hexOk(t.ink, '#0e0f12'), text: hexOk(t.text, acc), light: light };
  })(cfg.theme);

  function tourCss(th) {
    var A = th.acc;
    var bg = th.light ? '#ffffff' : '#16181c';
    var fg = th.light ? '#16181c' : '#f2f2f0';
    var dim = function (a) { return th.light ? 'rgba(22,24,28,' + a + ')' : 'rgba(242,242,240,' + a + ')'; };
    var soft = th.light ? 'rgba(22,24,28,.05)' : 'rgba(255,255,255,.07)';
    return '' +
      // the card: never part of the site underneath, light or dark
      '.pgut.is-tour{background:' + bg + ';color:' + fg + ';border:1px solid ' + alpha(A, 0.6) + ';box-shadow:0 0 0 4px ' + alpha(A, 0.18) + ',0 18px 50px rgba(0,0,0,.35)}' +
      '.pgut.is-tour .pgut-head{border-bottom-color:' + dim(0.1) + '}' +
      '.pgut.is-tour .pgut-lab{color:' + th.text + '}' +
      '.pgut.is-tour .pgut-hide,.pgut.is-tour .pgut-again{color:' + dim(0.65) + '}.pgut.is-tour .pgut-hide:hover{background:' + soft + ';color:' + fg + '}' +
      '.pgut.is-tour .pgut-hide+.pgut-hide{margin-left:4px}' +
      '.pgut.is-tour .pgut-p,.pgut.is-tour .pgut-wait{color:' + dim(0.7) + '}' +
      '.pgut.is-tour .pgut-wait i{background:' + A + '}' +
      '.pgut.is-tour .pgut-tell{background:' + soft + ';color:' + fg + '}' +
      '.pgut.is-tour .pgut-btn{border-color:' + dim(0.25) + ';color:' + fg + '}' +
      '.pgut.is-tour .pgut-btn.is-primary{background:' + A + ';color:' + th.ink + ';border-color:' + A + '}' +
      '.pgut.is-tour .pgut-btn:focus-visible,.pgut.is-tour .pgut-hide:focus-visible,.pgut.is-tour .pgut-again:focus-visible{outline-color:' + th.text + '}' +
      '.pgut.is-tour .pgut-nice{background:' + alpha(A, 0.15) + ';color:' + th.text + '}' +
      '.pgut.is-tour .pgut-foot{color:' + dim(0.5) + '}' +
      '.pgut.is-tour .pgut-dots i{background:' + dim(0.2) + '}.pgut.is-tour .pgut-dots i.is-done{background:' + alpha(A, 0.55) + '}.pgut.is-tour .pgut-dots i.is-now{background:' + A + '}' +
      '.pgut-pill.is-tour{background:' + bg + ';color:' + th.text + ';box-shadow:0 0 0 1px ' + alpha(A, 0.6) + ',0 8px 24px rgba(0,0,0,.35)}' +
      // the ring round the thing to press: a white line inside the accent, so
      // it shows on any site
      '.pgut-ring{position:fixed;z-index:2147482999;pointer-events:none;border:3px solid ' + A + ';border-radius:10px;box-shadow:0 0 0 2px #fff,0 0 0 6px ' + alpha(A, 0.45) + ';animation:pgutRing 1.6s ease-out infinite;transition:left .3s,top .3s,width .3s,height .3s}' +
      '.pgut-ring span{position:absolute;left:50%;bottom:calc(100% + 10px);transform:translateX(-50%);white-space:nowrap;font:600 12px/1 -apple-system,BlinkMacSystemFont,"Segoe UI",Inter,sans-serif;color:' + th.ink + ';background:' + A + ';padding:6px 9px;border-radius:6px;box-shadow:0 0 0 2px #fff}' +
      '.pgut-ring.is-below span{bottom:auto;top:calc(100% + 10px)}' +
      '@keyframes pgutRing{0%{box-shadow:0 0 0 2px #fff,0 0 0 2px ' + alpha(A, 0.7) + '}70%{box-shadow:0 0 0 2px #fff,0 0 0 16px ' + alpha(A, 0) + '}100%{box-shadow:0 0 0 2px #fff,0 0 0 2px ' + alpha(A, 0) + '}}' +
      // the pointer: large, white with a dark edge so it shows on anything,
      // with a soft halo of the accent round its tip
      '.pgut-cursor{position:fixed;left:0;top:0;z-index:2147483001;pointer-events:none;filter:drop-shadow(0 3px 4px rgba(0,0,0,.4));transition:transform .75s cubic-bezier(.3,.7,.2,1)}' +
      '.pgut-cursor svg{position:relative;display:block;transition:transform .12s;transform-origin:3px 3px}.pgut-cursor.is-down svg{transform:scale(.86)}' +
      '.pgut-halo{position:absolute;left:-25px;top:-25px;width:56px;height:56px;border-radius:50%;background:radial-gradient(circle,' + alpha(A, 0.85) + ' 0,' + alpha(A, 0.45) + ' 40%,' + alpha(A, 0) + ' 70%);animation:pgutHalo 1.4s ease-in-out infinite}' +
      '@keyframes pgutHalo{0%,100%{transform:scale(.8)}50%{transform:scale(1.15)}}' +
      '.pgut-tap{position:fixed;z-index:2147483000;width:52px;height:52px;margin:-26px 0 0 -26px;border-radius:50%;border:3px solid ' + A + ';background:' + alpha(A, 0.3) + ';box-shadow:0 0 0 2px #fff;pointer-events:none;animation:pgutTap .6s ease-out forwards}' +
      '@keyframes pgutTap{from{transform:scale(.3);opacity:1}to{transform:scale(1.5);opacity:0}}' +
      '.pgut-cursor[hidden]{display:none}' +
      '@media (prefers-reduced-motion:reduce){.pgut-ring,.pgut-halo,.pgut-wait i{animation:none;transition:none}.pgut-cursor{transition:none}.pgut-tap{animation:none;opacity:0}}';
  }

  var css = '' +
    '.pgut{position:fixed;width:320px;max-width:calc(100vw - 32px);z-index:2147483000;font:14px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",Inter,sans-serif;color:#16181c;background:rgba(255,255,255,.98);border:1px solid rgba(22,24,28,.12);border-radius:14px;box-shadow:0 12px 40px rgba(22,24,28,.18);box-sizing:border-box}' +
    '.pgut *{box-sizing:border-box}' +
    '.pgut-head{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:10px 12px 8px;border-bottom:1px solid rgba(22,24,28,.08);cursor:grab;touch-action:none;user-select:none}' +
    '.pgut-head.is-held{cursor:grabbing}' +
    '.pgut-lab{font-size:11px;font-weight:600;letter-spacing:.08em;text-transform:uppercase;color:rgba(22,24,28,.55)}' +
    '.pgut-hide{all:unset;cursor:pointer;font-size:12px;color:rgba(22,24,28,.55);padding:2px 6px;border-radius:6px}.pgut-hide:hover{background:rgba(22,24,28,.06)}' +
    '.pgut-body{padding:12px}' +
    '.pgut-title{margin:0 0 6px;font-size:16px;font-weight:600;line-height:1.3}' +
    '.pgut-p{margin:0 0 10px;color:rgba(22,24,28,.7)}' +
    '.pgut-hintbtn{all:unset;cursor:pointer;font-size:13px;color:rgba(22,24,28,.6);text-decoration:underline;text-underline-offset:3px;margin:0 0 10px;display:inline-block}' +
    '.pgut-hint{margin:0 0 10px;padding:8px 10px;border-radius:8px;background:rgba(22,24,28,.05);font-size:13px}' +
    '.pgut textarea,.pgut input[type=text]{width:100%;font:inherit;padding:8px 10px;border:1px solid rgba(22,24,28,.16);border-radius:8px;resize:vertical;min-height:38px;background:#fff;color:inherit}' +
    '.pgut textarea{min-height:56px}' +
    '.pgut-row{display:flex;gap:8px;margin-top:10px}' +
    '.pgut-btn{all:unset;cursor:pointer;flex:1;text-align:center;padding:9px 12px;border-radius:999px;font-weight:600;border:1px solid rgba(22,24,28,.16)}' +
    '.pgut-btn.is-primary{background:#16181c;color:#fff;border-color:#16181c}' +
    '.pgut-btn:hover{filter:brightness(.96)}' +
    '.pgut-q{margin:12px 0 4px;font-weight:600}' +
    '.pgut-scale{display:flex;gap:6px}.pgut-scale button{all:unset;cursor:pointer;flex:1;text-align:center;padding:8px 0;border-radius:8px;border:1px solid rgba(22,24,28,.16)}.pgut-scale button.is-on{background:#16181c;color:#fff;border-color:#16181c}' +
    '.pgut-pill{all:unset;position:fixed;z-index:2147483000;cursor:pointer;font:600 13px -apple-system,BlinkMacSystemFont,"Segoe UI",Inter,sans-serif;color:#fff;background:#16181c;padding:8px 14px;border-radius:999px;box-shadow:0 8px 24px rgba(22,24,28,.25)}' +
    '.pgut-foot{padding:0 12px 10px;font-size:12px;color:rgba(22,24,28,.5)}' +
    '.pgut[hidden],.pgut-pill[hidden],.pgut [hidden],.pgut-ring[hidden]{display:none}' +
    // a tour's step: what to do, shown straight away, and how it will move on
    '.pgut-tell{margin:0 0 10px;padding:9px 11px;border-radius:8px;background:rgba(22,24,28,.05);font-size:14px}' +
    '.pgut-wait{display:flex;align-items:center;gap:8px;margin:0;font-size:12px;color:rgba(22,24,28,.55)}' +
    '.pgut-wait i{width:8px;height:8px;border-radius:50%;animation:pgutWait 1.8s infinite}' +
    '@keyframes pgutWait{0%{box-shadow:0 0 0 0 rgba(47,143,91,.45)}70%{box-shadow:0 0 0 7px rgba(47,143,91,0)}100%{box-shadow:0 0 0 0 rgba(47,143,91,0)}}' +
    '.pgut-nice{margin:0;padding:9px 11px;border-radius:8px;background:#e8f6ee;color:#145a37;font-weight:600}' +
    '.pgut-dots{display:flex;gap:5px;align-items:center}.pgut-dots i{width:7px;height:7px;border-radius:50%;background:rgba(22,24,28,.16)}' +
    '.pgut-dots i.is-done{background:#2f8f5b}.pgut-dots i.is-skip{background:#e8a33d}.pgut-dots i.is-now{background:#16181c;width:18px;border-radius:99px}' +
    'a.pgut-cta{display:block;box-sizing:border-box;text-decoration:none}' +
    '@media (max-width:700px){.pgut,.pgut-pill{top:auto!important;bottom:12px!important;left:12px!important;right:12px!important;width:auto}}';
  var style = document.createElement('style');
  style.textContent = css + (tour ? tourCss(theme) : '');
  document.head.appendChild(style);

  var card = document.createElement('div');
  card.className = tour ? 'pgut is-tour' : 'pgut';
  card.setAttribute('role', 'complementary');
  card.setAttribute('aria-label', tour ? 'Tour' : 'Testing tasks');
  var pill = document.createElement('button');
  pill.className = tour ? 'pgut-pill is-tour' : 'pgut-pill';
  pill.type = 'button';
  pill.hidden = true;
  pill.addEventListener('click', function () { state.hidden = false; save(); render(); });
  document.body.appendChild(card);
  document.body.appendChild(pill);
  var ring = document.createElement('div');
  ring.className = 'pgut-ring';
  ring.hidden = true;
  ring.setAttribute('aria-hidden', 'true');
  ring.innerHTML = '<span>Here</span>';
  document.body.appendChild(ring);
  var pointer = document.createElement('div');
  pointer.className = 'pgut-cursor';
  pointer.hidden = true;
  pointer.setAttribute('aria-hidden', 'true');
  pointer.innerHTML = '<span class="pgut-halo"></span><svg width="34" height="40" viewBox="0 0 22 26"><path d="M2 2 L2 20 L7 15.5 L10.5 23 L13.6 21.6 L10.1 14.3 L17 14.3 Z" fill="#fff" stroke="#16181c" stroke-width="1.5" stroke-linejoin="round"/></svg>';
  if (tour) document.body.appendChild(pointer);

  /* ---- where it sits --------------------------------------------------- */
  // The one thing a card like this gets wrong is landing on top of the site's
  // own menu. Rather than guess a number that suits one theme, measure whatever
  // is sitting at the top of the page and start below it — and let the tester
  // drag it anywhere if the measurement is still wrong for their site.
  function headerBottom() {
    var lowest = 0;
    var seen = document.querySelectorAll(
      '#wpadminbar, header, .wp-site-blocks > header, .wp-block-template-part, ' +
      '.interface-interface-skeleton__header, .edit-site-header, .editor-header'
    );
    for (var i = 0; i < seen.length && i < 40; i++) {
      var r = seen[i].getBoundingClientRect();
      // Anything wide that begins in the first couple of hundred pixels of the
      // document counts — an admin bar and a site header stack, so it is the
      // lowest edge of the pile that matters, not the topmost element's.
      if (r.height && r.width > window.innerWidth / 2 && r.top + window.scrollY <= 200 && r.bottom > lowest) {
        lowest = r.bottom;
      }
    }
    return Math.min(Math.round(lowest) + 16, 320);
  }

  // The block editor and the Site Editor keep Save, Publish and the settings
  // sidebar along the top and down the right, which is exactly where the card
  // would land. There it starts at the bottom left instead, a little above the
  // editor's breadcrumb bar.
  function inEditor() {
    var b = document.body.classList;
    return b.contains('block-editor-page') || b.contains('site-editor-php') ||
      !!document.querySelector('.interface-interface-skeleton, .edit-site');
  }

  // state.aside: a tour's ring landed under the card, so the card sits on the
  // other side of the screen until the next step
  function place() {
    var el = state.hidden ? pill : card;
    var other = state.hidden ? card : pill;
    other.style.left = other.style.top = other.style.right = other.style.bottom = '';
    var left = inEditor() ? !state.aside : !!state.aside;
    if (state.pos) {
      el.style.left = state.pos.x + 'px';
      el.style.top = state.pos.y + 'px';
      el.style.right = el.style.bottom = 'auto';
    } else if (inEditor()) {
      el.style.left = left ? '16px' : 'auto';
      el.style.right = left ? 'auto' : '16px';
      el.style.bottom = '60px';
      el.style.top = 'auto';
    } else {
      el.style.left = left ? '16px' : 'auto';
      el.style.right = left ? 'auto' : '16px';
      el.style.bottom = 'auto';
      el.style.top = headerBottom() + 'px';
    }
  }
  window.addEventListener('resize', function () { if (!state.pos) place(); });
  // The editors draw themselves a moment after the page loads, so a card placed
  // on first paint has not seen them yet. Look again while they arrive.
  [400, 1200, 3000, 6000].forEach(function (t) {
    setTimeout(function () { if (!state.pos) place(); }, t);
  });

  function draggable(handle, el) {
    handle.addEventListener('pointerdown', function (ev) {
      if (ev.target.closest('button') !== handle && ev.target.closest('button')) return;
      var r = el.getBoundingClientRect();
      var dx = ev.clientX - r.left;
      var dy = ev.clientY - r.top;
      var moved = false;
      handle.classList.add('is-held');
      handle.setPointerCapture(ev.pointerId);

      function move(e) {
        moved = true;
        var x = Math.max(8, Math.min(e.clientX - dx, window.innerWidth - r.width - 8));
        var y = Math.max(8, Math.min(e.clientY - dy, window.innerHeight - 60));
        el.style.left = x + 'px';
        el.style.top = y + 'px';
        el.style.right = el.style.bottom = 'auto';
        state.pos = { x: x, y: y };
      }
      function up() {
        handle.classList.remove('is-held');
        handle.removeEventListener('pointermove', move);
        handle.removeEventListener('pointerup', up);
        if (moved) save();
      }
      handle.addEventListener('pointermove', move);
      handle.addEventListener('pointerup', up);
    });
  }

  /* ---- what it says ---------------------------------------------------- */
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }
  function currentId() { var t = tasks[state.i]; return t ? t.id : (state.wrapped ? 'done' : 'wrap'); }
  function secs() { return state.taskStart ? Math.round((Date.now() - state.taskStart) / 1000) : 0; }

  function head(label) {
    var sound = voiceOk
      ? '<button type="button" class="pgut-hide pgut-sound" aria-pressed="' + (state.voice ? 'true' : 'false') + '" title="Read each step out loud">' +
        (!state.voice ? 'Turn on sound' : voiceBlocked ? 'Tap for sound' : 'Sound on') + '</button>'
      : '';
    // once a tour is under way, starting it again is always one press away
    var again = tour && state.begun && !spectator
      ? '<button type="button" class="pgut-hide pgut-restart" title="Start the tour again from the beginning">Restart</button>'
      : '';
    return '<div class="pgut-head"><span class="pgut-lab">' + esc(label) + '</span>' +
      '<span>' + sound + again + '<button type="button" class="pgut-hide pgut-away" title="Put this card away for a moment">Hide</button></span></div>';
  }

  function afterRender() {
    var h = card.querySelector('.pgut-head');
    h.querySelector('.pgut-away').addEventListener('click', function () { state.hidden = true; save(); render(); });
    var again = h.querySelector('.pgut-restart');
    if (again) again.addEventListener('click', restart);
    var snd = h.querySelector('.pgut-sound');
    if (snd) snd.addEventListener('click', function () {
      // a browser that would not speak without a tap gets its tap here
      if (state.voice && voiceBlocked) { voiceBlocked = false; sayStep(); render(); return; }
      state.voice = !state.voice;
      save();
      if (state.voice) sayStep(); else hush();
      render();
    });
    draggable(h, card);
    place();
  }

  function render() {
    if (state.hidden) {
      card.hidden = true;
      pill.hidden = false;
      pill.textContent = tour
        ? (state.i < tasks.length ? 'Step ' + (state.i + 1) + ' of ' + tasks.length : 'Tour finished')
        : state.wrapped
        ? 'Thanks for testing'
        : (state.i < tasks.length ? 'Task ' + (state.i + 1) + ' of ' + tasks.length : 'Last few questions');
      place();
      return;
    }
    card.hidden = false;
    pill.hidden = true;
    if (tour && spectator) return renderElsewhere();
    if (tour) return state.i >= tasks.length ? renderEnd() : renderStep();
    if (state.wrapped) return renderThanks();
    if (state.i >= tasks.length) return renderWrap();

    var t = tasks[state.i];
    card.innerHTML =
      head('Task ' + (state.i + 1) + ' of ' + tasks.length) +
      '<div class="pgut-body">' +
        '<p class="pgut-title">' + esc(t.title) + '</p>' +
        (t.why ? '<p class="pgut-p">' + esc(t.why) + '</p>' : '') +
        (t.hint ? '<button type="button" class="pgut-hintbtn">Stuck? Show a hint</button><div class="pgut-hint" hidden>' + esc(t.hint) + '</div>' : '') +
        '<textarea class="pgut-note" placeholder="Anything to say about this one? (optional)"></textarea>' +
        '<div class="pgut-row"><button type="button" class="pgut-btn pgut-skip">Couldn’t do it</button>' +
        '<button type="button" class="pgut-btn is-primary pgut-done">Done</button></div>' +
      '</div>' +
      '<div class="pgut-foot">Take your time. Say what you think out loud if someone is with you.</div>';
    afterRender();

    var hb = card.querySelector('.pgut-hintbtn');
    if (hb) {
      hb.addEventListener('click', function () {
        card.querySelector('.pgut-hint').hidden = false;
        hb.hidden = true;
        send('hint', t.id);
      });
    }
    card.querySelector('.pgut-done').addEventListener('click', function () { finish('task_done'); });
    card.querySelector('.pgut-skip').addEventListener('click', function () { finish('task_skip'); });
    if (!state.taskStart) { state.taskStart = Date.now(); save(); send('task_start', t.id); }
  }

  /* ---- did the site change? ------------------------------------------- */
  // A task can carry a check: something the site itself can show (the name
  // changed, a page was published, the colours moved). The plugin answers from
  // the test's own copy of the check, so nothing here can steer it. For words
  // on the home page the card reads the page as a visitor would.
  function askSite(t) {
    return fetch(cfg.rest + (cfg.rest.indexOf('?') === -1 ? '?' : '&') + 'task=' + encodeURIComponent(t.id), {
      credentials: 'same-origin', cache: 'no-store', headers: { 'X-WP-Nonce': cfg.nonce || '' },
    })
      .then(function (r) { return r.ok ? r.json() : { result: 'unknown' }; })
      .then(function (d) { return (d && d.result) || 'unknown'; });
  }

  // Are these words on the home page, as a visitor would read it?
  function homeHas(words) {
    words = String(words || '').toLowerCase().replace(/\s+/g, ' ').trim();
    return fetch(cfg.home || '/', { credentials: 'same-origin', cache: 'no-store' })
      .then(function (r) { return r.text(); })
      .then(function (html) {
        var doc = new DOMParser().parseFromString(html, 'text/html');
        var bar = doc.getElementById('wpadminbar');
        if (bar) bar.remove();
        [].slice.call(doc.querySelectorAll('script,style,.pgut')).forEach(function (n) { n.remove(); });
        var text = (doc.body ? doc.body.textContent : '').toLowerCase().replace(/\s+/g, ' ');
        return !!words && text.indexOf(words) !== -1;
      });
  }

  function checkSite(t) {
    if (!t.check || !cfg.rest || !window.fetch) return Promise.resolve('');
    var ask = askSite(t)
      .then(function (result) {
        if (result !== 'client') return result;
        if (t.check.type === 'page') return onScreen(t.check.path) ? 'yes' : 'no';
        if (t.check.type !== 'text') return 'unknown';
        return homeHas(t.check.text).then(function (yes) { return yes ? 'yes' : 'no'; });
      })
      .then(null, function () { return 'unknown'; });
    var late = new Promise(function (resolve) { setTimeout(function () { resolve('unknown'); }, 6000); });
    return Promise.race([ask, late]);
  }

  function finish(type) {
    var t = tasks[state.i];
    var note = (card.querySelector('.pgut-note') || {}).value || '';
    var took = secs();
    state.results[t.id] = { type: type, secs: took, note: note };
    // queued at once (a tester who walks away loses nothing), sent once the
    // site has said whether it changed
    var data = { secs: took };
    if (t.check) data.check = 'pending';
    send(type, t.id, note, data);
    var queued = state.queue[state.queue.length - 1];
    if (t.check) {
      checkSite(t).then(function (seen) {
        state.queue.forEach(function (e) { if (e === queued || (e.t === queued.t && e.task === queued.task && e.type === queued.type)) e.data.check = seen || 'unknown'; });
        save();
        flush();
      });
    }
    state.i += 1;
    state.taskStart = 0;
    save();
    render();
  }

  // The closing questions suit any test, not only one about building a site;
  // a test that wants its own words for any of them sends those instead.
  var QUESTIONS = {
    happy: 'How happy are you with how it went?',
    finish: 'If you had kept going, could you have finished?',
    feel: 'How did it feel to use?',
    confused: 'What confused you, if anything?'
  };
  var own = (window.PGUT && PGUT.questions) || {};
  Object.keys(QUESTIONS).forEach(function (k) { if (typeof own[k] === 'string' && own[k]) QUESTIONS[k] = own[k]; });

  function renderWrap() {
    card.innerHTML =
      head('Last few questions') +
      '<div class="pgut-body">' +
        '<p class="pgut-title">Thank you. Four quick questions.</p>' +
        '<div class="pgut-q">' + esc(QUESTIONS.happy) + '</div>' +
        '<div class="pgut-scale" data-q="happy"><button type="button" data-v="1">1</button><button type="button" data-v="2">2</button><button type="button" data-v="3">3</button><button type="button" data-v="4">4</button><button type="button" data-v="5">5</button></div>' +
        '<div class="pgut-q">' + esc(QUESTIONS.finish) + '</div>' +
        '<div class="pgut-scale" data-q="confident"><button type="button" data-v="yes">Yes</button><button type="button" data-v="maybe">Maybe</button><button type="button" data-v="no">No</button></div>' +
        '<div class="pgut-q">' + esc(QUESTIONS.feel) + '</div>' +
        '<textarea data-q="feel"></textarea>' +
        '<div class="pgut-q">' + esc(QUESTIONS.confused) + '</div>' +
        '<textarea data-q="confused"></textarea>' +
        '<div class="pgut-q">Your name, if you like</div>' +
        '<input type="text" data-q="name" placeholder="optional">' +
        '<div class="pgut-row"><button type="button" class="pgut-btn is-primary pgut-send">Send</button></div>' +
      '</div>';
    afterRender();

    var picks = {};
    [].slice.call(card.querySelectorAll('.pgut-scale')).forEach(function (row) {
      [].slice.call(row.querySelectorAll('button')).forEach(function (b) {
        b.addEventListener('click', function () {
          picks[row.dataset.q] = b.dataset.v;
          [].slice.call(row.querySelectorAll('button')).forEach(function (o) { o.classList.toggle('is-on', o === b); });
        });
      });
    });
    card.querySelector('.pgut-send').addEventListener('click', function () {
      send('wrap', 'wrap', '', {
        happy: picks.happy || '',
        confident: picks.confident || '',
        feel: card.querySelector('[data-q=feel]').value.slice(0, 500),
        confused: card.querySelector('[data-q=confused]').value.slice(0, 500),
        name: card.querySelector('[data-q=name]').value.slice(0, 80),
        minutes: state.started ? Math.round((Date.now() - state.started) / 60000) : 0,
      });
      state.wrapped = true;
      save();
      render();
    });
  }

  function renderThanks() {
    card.innerHTML =
      head('All done') +
      '<div class="pgut-body"><p class="pgut-title">Thank you. That really helps.</p>' +
      '<p class="pgut-p">Your answers have gone to whoever asked you to try this. Carry on playing with the site for as long as you like; it is yours until you close the tab.</p></div>';
    afterRender();
  }

  /* ---- a tour ---------------------------------------------------------- */
  // The same tasks, shown rather than tested. A tour plays itself: each step
  // says what it shows, the ring goes to each thing in turn and the card
  // presses it, and the site's check confirms it happened before the next
  // step. Nobody has to do anything. Pause stops it, and while it is paused
  // someone can do the step themselves and it still moves on. Skip is always
  // there.

  function dots() {
    return '<span class="pgut-dots" aria-hidden="true">' + tasks.map(function (t, i) {
      var r = state.results[t.id];
      var c = i === state.i ? 'is-now' : (r ? (r.type === 'task_skip' ? 'is-skip' : 'is-done') : '');
      return '<i class="' + c + '"></i>';
    }).join('') + '</span>';
  }

  function acts(t) { return (t && t['do']) || []; }

  /* ---- the voice -------------------------------------------------------- */
  // Each step is read out as it starts playing: its title, then what it says.
  // The browser's own voice, so nothing to fetch and nothing to pay for; it
  // sounds like the computer it runs on. A browser that will not speak until
  // the page has been tapped says so on the switch, and one tap starts it.
  function pickVoice() {
    var all = window.speechSynthesis.getVoices() || [];
    var lang = String(document.documentElement.lang || navigator.language || 'en').slice(0, 2).toLowerCase();
    var mine = all.filter(function (v) { return String(v.lang || '').slice(0, 2).toLowerCase() === lang; });
    var good = mine.filter(function (v) { return /natural|premium|enhanced|google|samantha|daniel/i.test(v.name); });
    return good[0] || mine[0] || null;
  }

  function say(text) {
    if (!voiceOk || !state.voice || !text) return;
    try {
      window.speechSynthesis.cancel();
      var u = new SpeechSynthesisUtterance(text);
      var v = pickVoice();
      if (v) { u.voice = v; u.lang = v.lang; }
      u.onstart = function () { if (voiceBlocked) { voiceBlocked = false; render(); } };
      u.onerror = function (e) { if (e && e.error === 'not-allowed' && !voiceBlocked) { voiceBlocked = true; render(); } };
      window.speechSynthesis.speak(u);
    } catch (e) { /* no voice here: the words are on the card */ }
  }

  // What the voice says: the step's own script, written to be heard, or else
  // the card's line (the heading on its own sounds clipped when read out).
  function sayStep() {
    var t = tasks[state.i];
    if (t) speak(t.audio, t.say || t.hint || t.title);
    else if (state.wrapped) speak(cfg.endAudio, endWords());
  }

  // A step can carry a recording of its words, in a real voice. It plays
  // instead of the browser's voice; a recording that will not load falls back
  // to the browser reading the same words.
  var player = null;
  function speak(url, words) {
    if (!voiceOk || !state.voice) return;
    if (!url) return say(words);
    hush();
    try {
      player = new Audio(url);
      player.onplaying = function () { if (voiceBlocked) { voiceBlocked = false; render(); } };
      var started = player.play();
      if (started && started.catch) {
        started.catch(function (e) {
          if (e && e.name === 'NotAllowedError') { if (!voiceBlocked) { voiceBlocked = true; render(); } return; }
          player = null;
          say(words);
        });
      }
    } catch (e) {
      player = null;
      say(words);
    }
  }

  function endWords() {
    return 'That\u2019s the tour. The site is yours to keep exploring until you close this tab.' +
      (cfg.button && cfg.button.label ? ' There\u2019s a link on the card if you want to go further.' : '');
  }

  function hush() {
    if (player) { try { player.pause(); } catch (e) {} player = null; }
    if (voiceOk) { try { window.speechSynthesis.cancel(); } catch (e) {} }
  }

  function speaking() {
    if (!voiceOk || !state.voice || voiceBlocked) return false;
    if (player && !player.paused && !player.ended) return true;
    return window.speechSynthesis.speaking || window.speechSynthesis.pending;
  }

  // Carry on once the voice has finished, so a step's words are never cut
  // off by the next one; a voice that never says it is done is waited on for
  // twenty seconds at most.
  function whenQuiet(tok, next) {
    var since = Date.now();
    (function wait() {
      if (tok !== runTok) return;
      if (speaking() && Date.now() - since < 20000) { timer = setTimeout(wait, 300); return; }
      next();
    })();
  }

  // Whether the card can see this step happen. Words that were already on the
  // home page when the step began say nothing, and nor does a step the site
  // could not be marked for.
  function watchable(t) {
    return !!(t.check && state.base[t.id] !== 'unusable' && state.marked[t.id] !== 'failed');
  }

  var niceTimer = null;
  function renderStep() {
    var t = tasks[state.i];
    var first = !state.begun;
    var status = '';
    if (state.nice) status = '<p class="pgut-nice" role="status">✓ Nice, that worked</p>';
    else if (state.problem) status = '<p class="pgut-wait" role="status">' + esc(state.problem) + '</p>';
    else if (state.playing) status = '<p class="pgut-wait"><i></i>Playing</p>';
    else if (!first) status = '<p class="pgut-wait">Paused. Try it yourself if you like, or press Play.</p>';
    card.innerHTML =
      head('Step ' + (state.i + 1) + ' of ' + tasks.length) +
      '<div class="pgut-body">' +
        '<p class="pgut-title">' + esc(t.title) + '</p>' +
        (t.why ? '<p class="pgut-p">' + esc(t.why) + '</p>' : '') +
        (t.hint ? '<div class="pgut-tell">' + esc(t.hint) + '</div>' : '') +
        status +
        (state.nice ? '' : first
          ? '<div class="pgut-row"><button type="button" class="pgut-btn is-primary pgut-play">Start the tour</button></div>'
          : '<div class="pgut-row"><button type="button" class="pgut-btn pgut-skip">Skip</button>' +
            '<button type="button" class="pgut-btn is-primary pgut-play">' + (state.playing ? 'Pause' : 'Play') + '</button></div>') +
      '</div>' +
      '<div class="pgut-foot">' + dots() + '</div>';
    afterRender();
    var pl = card.querySelector('.pgut-play');
    if (pl) pl.addEventListener('click', function () { if (state.playing) pause(); else play(); });
    var sk = card.querySelector('.pgut-skip');
    if (sk) sk.addEventListener('click', function () { moveOn('task_skip', 'skip'); });
    if (!state.taskStart && state.begun) { state.taskStart = Date.now(); state.aside = false; save(); send('task_start', t.id); }
    if (state.begun) beginStep(t);
    // "Nice, that worked" (they did it themselves) stays a moment, then on
    if (state.nice && !niceTimer) {
      niceTimer = setTimeout(function () { niceTimer = null; moveOn('task_done', 'auto', 'yes'); }, 1500);
    }
    if (state.playing && !state.nice) run();
    aim();
  }

  // Back to the beginning: the first step on the page the tour began on. The
  // site keeps whatever the tour changed; the steps work from wherever it is.
  function restart() {
    stop();
    hush();
    pointer.hidden = true;
    state.i = 0;
    state.results = {};
    state.marked = {};
    state.base = {};
    state.act = null;
    state.spoken = null;
    state.nice = false;
    state.problem = '';
    state.wrapped = false;
    state.taskStart = 0;
    state.cur = null;
    state.aside = false;
    state.begun = true;
    state.playing = true;
    state.hidden = false;
    save();
    send('note', '', 'Started the tour again');
    var start = cfg.home || '/';
    if (location.href.split('#')[0] !== start) location.assign(start);
    else render();
  }

  function play() {
    state.tab = tabId;
    state.beat = Date.now();
    state.begun = true;
    state.playing = true;
    state.problem = '';
    save();
    render();
  }

  function pause() {
    state.playing = false;
    stop();
    hush();
    pointer.hidden = true;
    save();
    render();
  }

  function moveOn(type, how, seen) {
    var t = tasks[state.i];
    if (!t) return;
    stop();
    var took = secs();
    var data = { secs: took, how: how };
    if (seen) data.check = seen;
    state.results[t.id] = { type: type, secs: took, how: how };
    send(type, t.id, '', data);
    state.i += 1;
    state.taskStart = 0;
    state.nice = false;
    state.problem = '';
    state.act = null;
    if (type === 'task_skip') hush();
    if (state.i >= tasks.length && !state.wrapped) {
      if (state.playing) speak(cfg.endAudio, endWords());
      state.wrapped = true;
      state.playing = false;
      send('wrap', 'wrap', '', { tour: true, minutes: state.started ? Math.round((Date.now() - state.started) / 60000) : 0 });
    }
    save();
    render();
  }

  function renderEnd() {
    pointer.hidden = true;
    var b = cfg.button && cfg.button.url && cfg.button.label ? cfg.button : null;
    card.innerHTML =
      head('All done') +
      '<div class="pgut-body"><p class="pgut-title">That’s the tour.</p>' +
      '<p class="pgut-p">The site is yours until you close the tab, so carry on for as long as you like.</p>' +
      (b ? '<a class="pgut-btn is-primary pgut-cta" href="' + esc(b.url) + '" target="_blank" rel="noopener">' + esc(b.label) + '</a>' : '') +
      '<button type="button" class="pgut-again pgut-over">Watch it again</button>' +
      '</div>' +
      '<div class="pgut-foot">' + dots() + '</div>';
    afterRender();
    card.querySelector('.pgut-over').addEventListener('click', restart);
    var cta = card.querySelector('.pgut-cta');
    if (cta) cta.addEventListener('click', function () { send('cta', 'done', '', { url: b.url }); });
    aim();
  }

  function playingElsewhere(s) {
    return !!(s && s.playing && s.tab && s.tab !== tabId && Date.now() - (s.beat || 0) < 6000);
  }

  function renderElsewhere() {
    pointer.hidden = true;
    ring.hidden = true;
    card.innerHTML =
      head('Tour') +
      '<div class="pgut-body"><p class="pgut-title">Playing in another tab</p>' +
      '<p class="pgut-p">This tour is playing in another tab of this site.</p>' +
      '<div class="pgut-row"><button type="button" class="pgut-btn is-primary pgut-here">Play it here</button></div></div>';
    afterRender();
    card.querySelector('.pgut-here').addEventListener('click', function () {
      state = load() || state;
      state.tab = tabId;
      state.beat = Date.now();
      spectator = false;
      save();
      render();
    });
  }

  /* ---- playing a step --------------------------------------------------- */
  // state.act remembers which of the step's actions comes next, and is moved
  // on BEFORE an action happens: a click that loads another page carries on
  // from the next action there, and never presses the same thing twice.
  var timer = null, runTok = 0;
  function stop() { runTok++; clearTimeout(timer); }

  function run() {
    stop();
    var tok = runTok;
    if (!state.playing || state.i >= tasks.length) return;
    var t = tasks[state.i];
    if (!state.act || state.act.i !== state.i) { state.act = { i: state.i, n: 0 }; save(); }
    var list = acts(t);
    var a = list[state.act.n];
    // a step that begins by jumping to another screen (no way to show) jumps
    // first and speaks when it is there, so the words never talk about a
    // screen not yet shown; one that can show the way speaks as it goes
    var opening = !!(a && a.go && state.act.n === 0 && !(state.act.hops) && !nextPress(new URL(a.go, cfg.home || location.origin)) && !arrivedAt(new URL(a.go, cfg.home || location.origin)));
    // read once per step, not again when a click loads another page
    if (state.spoken !== state.i && !opening) { state.spoken = state.i; save(); sayStep(); }
    if (state.act.n >= list.length) return settle(t, tok);
    // the first action waits long enough for the words to be read
    timer = setTimeout(function () { if (tok === runTok) perform(t, a, tok, Date.now()); }, opening ? 500 : (state.act.n || state.act.hops) ? 900 : 2200);
  }

  function advance(t, tok) {
    state.act.n++;
    save();
    timer = setTimeout(function () { if (tok === runTok) run(); }, 50);
  }

  function trouble(words) {
    pointer.hidden = true;
    state.playing = false;
    state.problem = words;
    stop();
    save();
    render();
  }

  function perform(t, a, tok, since) {
    if (a.wait) { state.act.n++; save(); timer = setTimeout(function () { if (tok === runTok) run(); }, a.wait * 1000); return; }
    if (a.go) return travel(t, a, tok, since);
    if (a.key) {
      var into = document.activeElement || document.body;
      var opts = { key: a.key, code: a.key, bubbles: true, cancelable: true };
      into.dispatchEvent(new KeyboardEvent('keydown', opts));
      into.dispatchEvent(new KeyboardEvent('keyup', opts));
      return advance(t, tok);
    }
    var sel = a.click || a.into;
    var got = findPoint(sel);
    if (!got) {
      // pages and panels take a moment to arrive, so look again for a while;
      // an action marked "maybe" is let go sooner and passed over
      var wait = a.maybe ? 2500 : 12000;
      if (Date.now() - since < wait) { timer = setTimeout(function () { if (tok === runTok) perform(t, a, tok, since); }, 250); return; }
      if (a.maybe) return advance(t, tok);
      return trouble('This step could not find what to press on this site. Skip it, or try it yourself.');
    }
    // the ring goes there, and the pointer glides over to it and presses, so
    // people see how you get around rather than things just happening
    aim();
    glide(got.left + got.width / 2, got.top + got.height / 2, function () {
      if (tok !== runTok) return;
      var el = findPoint(sel);
      if (!el) return perform(t, a, tok, since);
      // a link to another page would cut the voice off mid-sentence, so the
      // pointer waits on it until the voice has finished
      var away = a.click && leaves(el.el);
      if (away) whenQuiet(tok, function () { press(findPoint(sel) || el, true); });
      else press(el, false);
    });

    function press(el, away) {
      tap(el.left + el.width / 2, el.top + el.height / 2);
      timer = setTimeout(function () {
        if (tok !== runTok) return;
        if (!a.click) { typeInto(el.el, a.type, function () { if (tok === runTok) advance(t, tok); }); return; }
        state.act.n++;
        save();
        el.el.click();
        // a link to another page: the next page carries on from here, so
        // nothing more happens on this one, the next step's words included
        if (!away) timer = setTimeout(function () { if (tok === runTok) run(); }, 50);
      }, 260);
    }
  }

  /* ---- finding the way ------------------------------------------------ */
  // A step that needs another screen is not jumped to: the tour presses its
  // way there through WordPress's own navigation, the way a person would, so
  // people see how to get around. The admin menu, the admin bar's Edit Site
  // and the Site Editor's own sidebar between them reach most screens. Only
  // when it can find no way does it go straight there.
  var SITE_EDITOR_SECTIONS = { '/page': 'Pages', '/styles': 'Styles', '/navigation': 'Navigation', '/pattern': 'Patterns', '/wp_template': 'Templates', '/template': 'Templates' };

  function params(u) {
    var out = {};
    u.searchParams.forEach(function (v, k) { out[k] = v; });
    return out;
  }

  // Is this address the screen we were sent to? Same file, and every setting
  // the target names is set the same way here.
  function arrivedAt(target) {
    var here = new URL(location.href);
    if (here.pathname.replace(/\/$/, '') !== target.pathname.replace(/\/$/, '')) return false;
    var want = params(target), have = params(here);
    return Object.keys(want).every(function (k) { return have[k] === want[k]; });
  }

  function visible(el) {
    var r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0 && r.bottom > 0 && r.right > 0 && r.top < window.innerHeight && r.left < window.innerWidth;
  }

  // A link on screen to the target: exactly, or at least to the same file
  // (the Site Editor before its Pages, say), which is a step closer.
  function linkTo(target, sameFileOk) {
    var links = document.querySelectorAll('#adminmenu a[href], #wpadminbar a[href], .edit-site-layout a[href], a[href]');
    var close = null;
    for (var i = 0; i < links.length && i < 600; i++) {
      var el = links[i];
      if (!visible(el) || (el.closest && el.closest('.pgut'))) continue;
      var u;
      try { u = new URL(el.getAttribute('href'), location.href); } catch (e) { continue; }
      if (u.origin !== target.origin || u.pathname !== target.pathname) continue;
      var want = params(target), have = params(u);
      if (Object.keys(want).every(function (k) { return have[k] === want[k]; })) return el;
      if (sameFileOk && !close) close = el;
    }
    return close;
  }

  // An admin bar menu with the target folded inside it (+ New, then Page):
  // the menu opens on hover, so the pointer goes to it and it opens.
  function folded(target) {
    var menus = document.querySelectorAll('#wpadminbar li.menupop');
    for (var i = 0; i < menus.length; i++) {
      var head = menus[i].querySelector('a.ab-item, .ab-item');
      if (!head || !visible(head) || menus[i].classList.contains('hover')) continue;
      var links = menus[i].querySelectorAll('.ab-sub-wrapper a[href]');
      for (var j = 0; j < links.length; j++) {
        var u;
        try { u = new URL(links[j].getAttribute('href'), location.href); } catch (e) { continue; }
        if (u.pathname !== target.pathname) continue;
        var want = params(target), have = params(u);
        if (Object.keys(want).every(function (k) { return have[k] === want[k]; })) return { open: menus[i], el: head };
      }
    }
    return null;
  }

  // The one press that gets nearer the target from here, or nothing.
  function nextPress(target) {
    var here = new URL(location.href);
    var exact = linkTo(target, false);
    if (exact) return exact;
    var menu = folded(target);
    if (menu) return menu;
    var file = target.pathname.split('/').pop();
    var section = file === 'site-editor.php' ? SITE_EDITOR_SECTIONS[target.searchParams.get('p') || ''] : '';
    if (section && here.pathname.split('/').pop() === 'site-editor.php') {
      // inside the Site Editor: its sidebar, after stepping out of editing
      var item = findPoint('button "' + section + '" || a "' + section + '"');
      if (item) return item.el;
      // a sidebar showing one of its own lists (Templates, say): back up a level
      var up = findPoint('.edit-site-sidebar-button[aria-label="Back"] || .edit-site-sidebar-navigation-screen__back');
      if (up) return up.el;
      var out = findPoint('[aria-label="Open Navigation"]');
      if (out) return out.el;
      return null;
    }
    if (here.pathname.split('/').pop() !== file) {
      var near = linkTo(target, true);
      if (near) return near;
      // a screen in the admin menu whose section is folded away: open the section
      var hidden = document.querySelector('#adminmenu a[href$="' + file + '"], #adminmenu a[href*="' + file + '?"]');
      var top = hidden && hidden.closest('li.menu-top');
      var head = top && top.querySelector('a.menu-top');
      if (head && visible(head)) return head;
      // from the site itself, the admin bar: Edit Site for the Site Editor,
      // the site's name for the dashboard
      if (file === 'site-editor.php') { var edit = document.querySelector('#wp-admin-bar-site-editor > a'); if (edit && visible(edit)) return edit; }
      if (here.pathname.indexOf('/wp-admin') === -1) { var dash = document.querySelector('#wp-admin-bar-site-name > a'); if (dash && visible(dash)) return dash; }
    }
    return null;
  }

  // Press the way there one press at a time, across page loads, at most six
  // presses; past that, or with no way to see, go straight there.
  function travel(t, a, tok, since) {
    since = since || Date.now();
    var target = new URL(a.go, cfg.home || location.origin);
    if (arrivedAt(target)) { state.act.hops = 0; return advance(t, tok); }
    var hops = state.act.hops || 0;
    var el = hops < 6 ? nextPress(target) : null;
    // a screen that has only just loaded draws its menus a moment later, so
    // look for a while before deciding there is no way to show
    if (!el && hops < 6 && Date.now() - since < 8000) {
      timer = setTimeout(function () { if (tok === runTok) travel(t, a, tok, since); }, 300);
      return;
    }
    if (!el) {
      whenQuiet(tok, function () {
        state.act.n++;
        state.act.hops = 0;
        save();
        // the tour maker learns which step could not show the way
        send('note', t.id, 'Went straight to ' + target.pathname + target.search + ': no way there to show from ' + where());
        location.assign(target.toString());
      });
      return;
    }
    if (el.open) {
      // hover over the menu so it opens, then look again for the way on
      var hr = el.el.getBoundingClientRect();
      glide(hr.left + hr.width / 2, hr.top + hr.height / 2, function () {
        if (tok !== runTok) return;
        el.open.classList.add('hover');
        state.act.hops = hops + 1;
        save();
        timer = setTimeout(function () { if (tok === runTok) travel(t, a, tok, Date.now()); }, 500);
      });
      return;
    }
    var r = el.getBoundingClientRect();
    glide(r.left + r.width / 2, r.top + r.height / 2, function () {
      if (tok !== runTok) return;
      var away = leaves(el);
      var go = function () {
        var r2 = el.getBoundingClientRect();
        tap(r2.left + r2.width / 2, r2.top + r2.height / 2);
        timer = setTimeout(function () {
          if (tok !== runTok) return;
          state.act.hops = hops + 1;
          save();
          el.click();
          // a press that stays on this page (the Site Editor moves between
          // its screens without loading one): look again once it settles
          if (!away) timer = setTimeout(function () { if (tok === runTok) travel(t, a, tok, Date.now()); }, 1200);
        }, 260);
      };
      if (away) whenQuiet(tok, go); else go();
    });
  }

  // The pointer: starts where it last was (kept across page loads), slides to
  // the thing to press, and shows the press.
  var reduced = window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches;
  function glide(x, y, done) {
    var from = state.cur || { x: Math.round(window.innerWidth / 2), y: Math.round(window.innerHeight / 2) };
    if (pointer.hidden) {
      pointer.style.transition = 'none';
      pointer.style.transform = 'translate(' + (from.x - 3) + 'px,' + (from.y - 3) + 'px)';
      pointer.hidden = false;
      void pointer.offsetWidth;
      pointer.style.transition = '';
    }
    pointer.style.transform = 'translate(' + (x - 3) + 'px,' + (y - 3) + 'px)';
    state.cur = { x: Math.round(x), y: Math.round(y) };
    save();
    timer = setTimeout(done, reduced ? 150 : 800);
  }

  // The sounds of a mouse button and of keys, made on the spot rather than
  // fetched: short bursts of filtered noise. Only with sound on, like the
  // voice; without sound the ripple and the letters still show it.
  var clicker = null;
  function tick(pitch, loud, after, length) {
    if (!voiceOk || !state.voice) return;
    try {
      var Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) return;
      clicker = clicker || new Ctx();
      if (clicker.state === 'suspended') clicker.resume();
      var len = Math.floor(clicker.sampleRate * length);
      var buf = clicker.createBuffer(1, len, clicker.sampleRate);
      var data = buf.getChannelData(0);
      for (var i = 0; i < len; i++) data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 4);
      var src = clicker.createBufferSource();
      src.buffer = buf;
      var tone = clicker.createBiquadFilter();
      tone.type = 'bandpass';
      tone.frequency.value = pitch;
      tone.Q.value = 1.1;
      var level = clicker.createGain();
      level.gain.value = loud;
      src.connect(tone);
      tone.connect(level);
      level.connect(clicker.destination);
      src.start(clicker.currentTime + after);
    } catch (e) { /* no sound here */ }
  }

  // a mouse button: down, then a softer up
  function clickSound() {
    tick(2600, 0.55, 0, 0.025);
    tick(2600, 0.3, 0.07, 0.025);
  }

  // a key: a typewriter's clack, never quite the same twice
  function keySound() {
    tick(1400 + Math.random() * 900, 0.45, 0, 0.03);
    tick(3800 + Math.random() * 800, 0.18, 0.012, 0.012);
  }

  function tap(x, y) {
    clickSound();
    var ripple = document.createElement('div');
    ripple.className = 'pgut-tap';
    ripple.style.left = x + 'px';
    ripple.style.top = y + 'px';
    document.body.appendChild(ripple);
    setTimeout(function () { ripple.remove(); }, 650);
    pointer.classList.add('is-down');
    setTimeout(function () { pointer.classList.remove('is-down'); }, 200);
  }

  // Does pressing this load another page? A link somewhere else does.
  function leaves(el) {
    var link = el.closest ? el.closest('a[href]') : null;
    if (!link || link.target === '_blank') return false;
    var href = link.getAttribute('href') || '';
    return !!href && href.charAt(0) !== '#' && href.indexOf('javascript:') !== 0;
  }

  // Types into a field the way the editor hears a person type, a character
  // at a time, through the native setter so its own listeners see it.
  function typeInto(el, text, done) {
    el.focus();
    var proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    var desc = Object.getOwnPropertyDescriptor(proto, 'value');
    var i = 0;
    (function next() {
      if (i > text.length) return done();
      if (i > 0) keySound();
      var v = text.slice(0, i++);
      if (desc && desc.set) desc.set.call(el, v); else el.value = v;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      // a person's typing is uneven, and so is this
      setTimeout(next, 70 + Math.round(Math.random() * 60));
    })();
  }

  // Once a step's actions are done: let the site confirm it, then hold so the
  // words can be read, then the next step. A step whose check never comes is
  // paused with a word, rather than carried past as if it had worked.
  function settle(t, tok) {
    var hold = 2600;
    if (!t.check || !watchable(t)) {
      timer = setTimeout(function () { whenQuiet(tok, function () { moveOn('task_done', 'played'); }); }, hold);
      return;
    }
    var since = Date.now();
    (function poll() {
      if (tok !== runTok) return;
      if (state.marked[t.id] !== 'yes' && state.marked[t.id] !== 'failed') { timer = setTimeout(poll, 400); return; }
      look(t).then(function (seen) {
        if (tok !== runTok) return;
        if (seen === 'yes') { timer = setTimeout(function () { whenQuiet(tok, function () { moveOn('task_done', 'played', 'yes'); }); }, hold); return; }
        if (Date.now() - since > 15000) return trouble('That did not work on this site. Skip it, or try it yourself.');
        timer = setTimeout(poll, 900);
      }, function () { if (tok === runTok) timer = setTimeout(poll, 900); });
    })();
  }

  // As a step begins: mark the site, so the step's check is measured from
  // here rather than from the boot, and note what the card itself can see
  // before anything is pressed.
  function beginStep(t) {
    if (!t.check || state.marked[t.id]) return;
    // reaching a screen is read from the address alone; the site has nothing
    // to remember for it
    if (t.check.type === 'page') { state.marked[t.id] = 'yes'; save(); return; }
    state.marked[t.id] = 'pending';
    save();
    var mark = !cfg.mark ? Promise.resolve() : fetch(cfg.mark + (cfg.mark.indexOf('?') === -1 ? '?' : '&') + 'task=' + encodeURIComponent(t.id), {
      method: 'POST', credentials: 'same-origin', cache: 'no-store', headers: { 'X-WP-Nonce': cfg.nonce || '' },
    }).then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); });
    mark
      .then(function () {
        if (t.check.type === 'block' || t.check.type === 'block_changed') return look(t);
        if (t.check.type !== 'text') return;
        return homeHas(t.check.text).then(function (yes) { state.base[t.id] = yes ? 'unusable' : 'absent'; });
      })
      .then(function () { state.marked[t.id] = 'yes'; }, function () { state.marked[t.id] = 'failed'; })
      .then(function () { save(); });
  }

  // The blocks of one kind in the editor, each as its settings and its inner
  // blocks' settings, or null when there is no editor on this page. Read from
  // the editor itself, so a step can be done before anything is saved.
  function blocksNamed(name) {
    try {
      if (!inEditor()) return null;
      var d = window.wp && wp.data && wp.data.select && wp.data.select('core/block-editor');
      if (!d || !d.getClientIdsWithDescendants) return null;
      // before the editor has loaded what it is editing, an empty list means
      // "not yet", not "no blocks"
      var ed = wp.data.select('core/editor');
      if (ed && ed.__unstableIsEditorReady && !ed.__unstableIsEditorReady()) return null;
      return d.getClientIdsWithDescendants().filter(function (id) { return d.getBlockName(id) === name; }).map(function (id) {
        var inner = d.getClientIdsOfDescendants ? d.getClientIdsOfDescendants([id]) : [];
        return JSON.stringify([d.getBlockAttributes(id), inner.map(function (c) { return [d.getBlockName(c), d.getBlockAttributes(c)]; })]);
      }).sort();
    } catch (e) {
      return null;
    }
  }

  // Is this the screen they were sent to? Part of its address is enough.
  function onScreen(path) {
    if (!path) return false;
    var here = String(location.pathname + location.search);
    var plain = function (x) { try { return decodeURIComponent(x); } catch (e) { return x; } };
    return here.indexOf(path) !== -1 || plain(here).indexOf(plain(path)) !== -1;
  }

  // Is the step done? yes, no, or wait (nothing to go on yet).
  function look(t) {
    var c = t.check;
    if (c.type === 'page') return Promise.resolve(onScreen(c.path) ? 'yes' : 'no');
    if (c.type === 'block' || c.type === 'block_changed') {
      var now = blocksNamed(c.block);
      if (!now) return Promise.resolve('wait');
      var base = state.base[t.id];
      var rebase = function () { state.base[t.id] = now; save(); return Promise.resolve('no'); };
      // the first look with an editor on the page is the line it is measured from
      if (!Array.isArray(base)) return rebase();
      if (c.type === 'block') return Promise.resolve(now.length > base.length ? 'yes' : 'no');
      // a block of the kind arriving or leaving moves the line; only a change
      // to one that was already there counts
      if (now.length !== base.length) return rebase();
      return Promise.resolve(now.join('\n') !== base.join('\n') ? 'yes' : 'no');
    }
    if (c.type === 'text') return homeHas(c.text).then(function (yes) { return yes ? 'yes' : 'no'; });
    return askSite(t);
  }

  // While a tour is paused, someone may do the step themselves; every couple
  // of seconds the card looks. The words check reads the whole home page, so
  // it looks half as often.
  var looking = false, ticks = 0;
  function watch() {
    ticks++;
    if (!tour || !state.begun || state.playing || looking || document.hidden || state.nice || state.i >= tasks.length) return;
    var t = tasks[state.i];
    if (!watchable(t) || state.marked[t.id] !== 'yes') return;
    if (t.check.type === 'text' && ticks % 2) return;
    looking = true;
    look(t)
      .then(function (seen) {
        if (seen === 'yes' && tasks[state.i] === t && !state.nice && !state.playing) {
          state.nice = true;
          save();
          render();
        }
      }, function () {})
      .then(function () { looking = false; });
  }

  // The ring: a selector, looked for on the page and inside the editor's
  // canvas frame, which is the same origin. A selector that finds nothing, or
  // something with no size, shows no ring rather than a wrong one.
  //
  // Two additions to plain CSS, because the editor's own buttons often carry
  // no class or label worth relying on, and a step can cross two panels:
  //   button "Styles"       an element whose words (or label) are exactly that
  //   a || b || c           the first of these on screen wins
  function findPoint(point) {
    var parts = String(point).split('||');
    for (var p = 0; p < parts.length; p++) {
      var got = findOne(parts[p].trim());
      if (got) return got;
    }
    return null;
  }

  function findOne(sel) {
    if (!sel) return null;
    var words = null;
    var quoted = sel.match(/^(.*?)\s*"([^"]+)"$/);
    if (quoted) {
      words = quoted[2].replace(/\s+/g, ' ').trim();
      sel = quoted[1].trim() || 'button, a, [role="button"], [role="menuitem"], [role="tab"]';
    }
    var hit = function (doc, dx, dy) {
      var els;
      try { els = doc.querySelectorAll(sel); } catch (e) { return null; }
      for (var i = 0; i < els.length && i < 400; i++) {
        var el = els[i];
        if (words !== null && el.textContent.replace(/\s+/g, ' ').trim() !== words && el.getAttribute('aria-label') !== words) continue;
        var r = el.getBoundingClientRect();
        if (!r.width || !r.height) continue;
        return { el: el, left: r.left + dx, top: r.top + dy, width: r.width, height: r.height };
      }
      return null;
    };
    var got = hit(document, 0, 0);
    if (got) return got;
    var frames = document.querySelectorAll('iframe');
    for (var i = 0; i < frames.length && i < 8; i++) {
      try {
        var fr = frames[i].getBoundingClientRect();
        var inFrame = frames[i].contentDocument && hit(frames[i].contentDocument, fr.left, fr.top);
        if (inFrame) return inFrame;
      } catch (e) { /* another origin: not ours to look in */ }
    }
    return null;
  }

  function overlaps(a, b) {
    return a.left < b.left + b.width && a.left + a.width > b.left && a.top < b.top + b.height && a.top + a.height > b.top;
  }

  // While playing, the ring is on whatever is about to be pressed; otherwise
  // on the step's own pointer, if it has one.
  function target() {
    if (!tour || state.nice || state.i >= tasks.length) return null;
    var t = tasks[state.i];
    var list = acts(t);
    if (state.playing && state.act && state.act.i === state.i && state.act.n < list.length) {
      var a = list[state.act.n];
      if (a.click || a.into) return a.click || a.into;
    }
    return t.point || null;
  }

  function aim() {
    var sel = target();
    var r = sel ? findPoint(sel) : null;
    if (!r) { ring.hidden = true; return; }
    // a ring that was not showing appears where it belongs; only a ring that
    // is already on screen slides to the next thing
    var fresh = ring.hidden;
    if (fresh) ring.style.transition = 'none';
    ring.hidden = false;
    ring.style.left = (r.left - 5) + 'px';
    ring.style.top = (r.top - 5) + 'px';
    ring.style.width = (r.width + 10) + 'px';
    ring.style.height = (r.height + 10) + 'px';
    if (fresh) { void ring.offsetWidth; ring.style.transition = ''; }
    ring.classList.toggle('is-below', r.top < 44);
    // the card steps aside once per step if it is sitting on the thing to press
    if (!state.pos && !state.hidden && !state.aside) {
      var c = card.getBoundingClientRect();
      if (overlaps({ left: c.left, top: c.top, width: c.width, height: c.height }, r)) {
        state.aside = true;
        save();
        place();
      }
    }
  }

  if (tour) {
    // the playing tab says it is still there; a watching tab takes over once
    // the playing one has gone quiet
    setInterval(function () {
      if (spectator) {
        var s = load();
        if (!playingElsewhere(s)) { state = s || state; spectator = false; render(); }
        return;
      }
      if (state.playing) {
        var now = load();
        if (playingElsewhere(now)) { state = now; spectator = true; stop(); hush(); render(); return; }
        state.tab = tabId;
        state.beat = Date.now();
        save();
      }
    }, 2000);
    setInterval(watch, 2500);
    setInterval(aim, 400);
    window.addEventListener('scroll', aim, true);
    window.addEventListener('resize', aim);
    // a click usually slides a panel in; look again as it settles, so the
    // ring keeps up rather than trailing it
    document.addEventListener('click', function () {
      [60, 250, 500].forEach(function (t) { setTimeout(aim, t); });
    }, true);
  }

  /* ---- go -------------------------------------------------------------- */
  if (tour && playingElsewhere(state)) spectator = true;
  else if (tour && state.playing) { state.tab = tabId; state.beat = Date.now(); save(); }
  if (!state.started) {
    state.started = Date.now();
    save();
    send('start', '', '', {
      subject: cfg.subject || '',
      viewport: window.innerWidth + 'x' + window.innerHeight,
      ua: String(navigator.userAgent || '').slice(0, 160),
      tasks: tasks.length,
      mode: tour ? 'tour' : 'test',
    });
  } else {
    flush();
  }
  render();
})();
