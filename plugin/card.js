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
 * A tour (mode "tour") uses the same card the other way round: each step shows
 * what to do straight away, a ring points at the thing to click, the step moves
 * on by itself when the site shows it done, and it ends with a button instead
 * of questions.
 */
(function () {
  'use strict';
  var cfg = window.PGUT;
  if (!cfg || !cfg.test || !cfg.session || !cfg.report || !cfg.tasks || !cfg.tasks.length) return;

  var KEY = 'pgut:' + cfg.test + ':' + cfg.session;
  var state = load() || { i: 0, started: 0, taskStart: 0, results: {}, wrapped: false, hidden: false, pos: null, queue: [] };
  var tasks = cfg.tasks;
  var tour = cfg.mode === 'tour';
  // a tour's own memory: which steps the site was marked for, what the card
  // saw when a step began (words on the home page, blocks in the editor), and
  // whether the card stepped aside for the ring
  state.marked = state.marked || {};
  state.base = state.base || {};

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
    '.pgut-wait i{width:8px;height:8px;border-radius:50%;background:#7cf2b0;animation:pgutWait 1.8s infinite}' +
    '@keyframes pgutWait{0%{box-shadow:0 0 0 0 rgba(47,143,91,.45)}70%{box-shadow:0 0 0 7px rgba(47,143,91,0)}100%{box-shadow:0 0 0 0 rgba(47,143,91,0)}}' +
    '.pgut-nice{margin:0;padding:9px 11px;border-radius:8px;background:#e8f6ee;color:#145a37;font-weight:600}' +
    '.pgut-dots{display:flex;gap:5px;align-items:center}.pgut-dots i{width:7px;height:7px;border-radius:50%;background:rgba(22,24,28,.16)}' +
    '.pgut-dots i.is-done{background:#2f8f5b}.pgut-dots i.is-skip{background:#e8a33d}.pgut-dots i.is-now{background:#16181c;width:18px;border-radius:99px}' +
    'a.pgut-cta{display:block;box-sizing:border-box;text-decoration:none}' +
    '.pgut-ring{position:fixed;z-index:2147482999;pointer-events:none;border:2px solid #1f7a4d;border-radius:8px;box-shadow:0 0 0 4px rgba(124,242,176,.55);animation:pgutRing 1.6s ease-out infinite;transition:left .3s,top .3s,width .3s,height .3s}' +
    '.pgut-ring span{position:absolute;left:50%;bottom:calc(100% + 8px);transform:translateX(-50%);white-space:nowrap;font:600 12px/1 -apple-system,BlinkMacSystemFont,"Segoe UI",Inter,sans-serif;color:#fff;background:#145a37;padding:6px 9px;border-radius:6px}' +
    '.pgut-ring.is-below span{bottom:auto;top:calc(100% + 8px)}' +
    '@keyframes pgutRing{0%{box-shadow:0 0 0 2px rgba(124,242,176,.7)}70%{box-shadow:0 0 0 12px rgba(124,242,176,0)}100%{box-shadow:0 0 0 2px rgba(124,242,176,0)}}' +
    '@media (prefers-reduced-motion:reduce){.pgut-ring,.pgut-wait i{animation:none;transition:none}}' +
    '@media (max-width:700px){.pgut,.pgut-pill{top:auto!important;bottom:12px!important;left:12px!important;right:12px!important;width:auto}}';
  var style = document.createElement('style');
  style.textContent = css;
  document.head.appendChild(style);

  var card = document.createElement('div');
  card.className = 'pgut';
  card.setAttribute('role', 'complementary');
  card.setAttribute('aria-label', tour ? 'Tour' : 'Testing tasks');
  var pill = document.createElement('button');
  pill.className = 'pgut-pill';
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
    return '<div class="pgut-head"><span class="pgut-lab">' + esc(label) + '</span>' +
      '<button type="button" class="pgut-hide" title="Put this card away for a moment">Hide</button></div>';
  }

  function afterRender() {
    var h = card.querySelector('.pgut-head');
    h.querySelector('.pgut-hide').addEventListener('click', function () { state.hidden = true; save(); render(); });
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
  // The same tasks, shown rather than tested. What to do is on the card from
  // the start, the step moves on by itself once the site shows it, and Skip
  // is always there. A step with nothing the card can watch has Next instead.

  function dots() {
    return '<span class="pgut-dots" aria-hidden="true">' + tasks.map(function (t, i) {
      var r = state.results[t.id];
      var c = i === state.i ? 'is-now' : (r ? (r.type === 'task_skip' ? 'is-skip' : 'is-done') : '');
      return '<i class="' + c + '"></i>';
    }).join('') + '</span>';
  }

  // Whether the card can see this step happen. Words that were already on the
  // home page when the step began say nothing, and nor does a step the site
  // could not be marked for; those get Next.
  function watchable(t) {
    return !!(t.check && state.base[t.id] !== 'unusable' && state.marked[t.id] !== 'failed');
  }

  var niceTimer = null;
  function renderStep() {
    var t = tasks[state.i];
    var watch = watchable(t);
    card.innerHTML =
      head('Step ' + (state.i + 1) + ' of ' + tasks.length) +
      '<div class="pgut-body">' +
        '<p class="pgut-title">' + esc(t.title) + '</p>' +
        (t.why ? '<p class="pgut-p">' + esc(t.why) + '</p>' : '') +
        (t.hint ? '<div class="pgut-tell">' + esc(t.hint) + '</div>' : '') +
        (state.nice
          ? '<p class="pgut-nice" role="status">\u2713 Nice, that worked</p>'
          : (watch ? '<p class="pgut-wait"><i></i>Moves on by itself once it\u2019s done</p>' : '') +
            '<div class="pgut-row"><button type="button" class="pgut-btn pgut-skip">Skip</button>' +
            (watch ? '' : '<button type="button" class="pgut-btn is-primary pgut-next">Next</button>') + '</div>') +
      '</div>' +
      '<div class="pgut-foot">' + dots() + '</div>';
    afterRender();
    var sk = card.querySelector('.pgut-skip');
    if (sk) sk.addEventListener('click', function () { moveOn('task_skip', 'skip'); });
    var nx = card.querySelector('.pgut-next');
    if (nx) nx.addEventListener('click', function () { moveOn('task_done', 'next'); });
    if (!state.taskStart) { state.taskStart = Date.now(); state.aside = false; save(); send('task_start', t.id); }
    beginStep(t);
    // "Nice, that worked" stays a moment so it can be read, then the next step
    if (state.nice && !niceTimer) {
      niceTimer = setTimeout(function () { niceTimer = null; moveOn('task_done', 'auto', 'yes'); }, 1500);
    }
    aim();
  }

  function moveOn(type, how, seen) {
    var t = tasks[state.i];
    if (!t) return;
    var took = secs();
    var data = { secs: took, how: how };
    if (seen) data.check = seen;
    state.results[t.id] = { type: type, secs: took, how: how };
    send(type, t.id, '', data);
    state.i += 1;
    state.taskStart = 0;
    state.nice = false;
    if (state.i >= tasks.length && !state.wrapped) {
      state.wrapped = true;
      send('wrap', 'wrap', '', { tour: true, minutes: state.started ? Math.round((Date.now() - state.started) / 60000) : 0 });
    }
    save();
    render();
  }

  function renderEnd() {
    var b = cfg.button && cfg.button.url && cfg.button.label ? cfg.button : null;
    card.innerHTML =
      head('All done') +
      '<div class="pgut-body"><p class="pgut-title">That\u2019s the tour.</p>' +
      '<p class="pgut-p">The site is yours until you close the tab, so carry on for as long as you like.</p>' +
      (b ? '<a class="pgut-btn is-primary pgut-cta" href="' + esc(b.url) + '" target="_blank" rel="noopener">' + esc(b.label) + '</a>' : '') +
      '</div>' +
      '<div class="pgut-foot">' + dots() + '</div>';
    afterRender();
    var cta = card.querySelector('.pgut-cta');
    if (cta) cta.addEventListener('click', function () { send('cta', 'done', '', { url: b.url }); });
    aim();
  }

  // As a step begins: mark the site, so the step's check is measured from
  // here rather than from the boot, and note what the card itself can see.
  function beginStep(t) {
    if (!t.check || state.marked[t.id]) return;
    state.marked[t.id] = 'pending';
    save();
    var mark = !cfg.mark ? Promise.resolve() : fetch(cfg.mark + (cfg.mark.indexOf('?') === -1 ? '?' : '&') + 'task=' + encodeURIComponent(t.id), {
      method: 'POST', credentials: 'same-origin', cache: 'no-store', headers: { 'X-WP-Nonce': cfg.nonce || '' },
    }).then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); });
    mark
      .then(function () {
        if (t.check.type !== 'text') return;
        return homeHas(t.check.text).then(function (yes) { state.base[t.id] = yes ? 'unusable' : 'absent'; });
      })
      .then(function () { state.marked[t.id] = 'yes'; }, function () { state.marked[t.id] = 'failed'; })
      .then(function () { save(); if (tasks[state.i] === t && !state.hidden) render(); });
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
    return !!path && String(location.pathname + location.search).indexOf(path) !== -1;
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

  // Every couple of seconds while a step is open and the tab is in front. The
  // words check reads the whole home page, so it looks half as often.
  var looking = false, ticks = 0;
  function watch() {
    ticks++;
    if (!tour || looking || document.hidden || state.nice || state.i >= tasks.length) return;
    var t = tasks[state.i];
    if (!watchable(t) || state.marked[t.id] !== 'yes') return;
    if (t.check.type === 'text' && ticks % 2) return;
    looking = true;
    look(t)
      .then(function (seen) {
        if (seen === 'yes' && tasks[state.i] === t && !state.nice) {
          state.nice = true;
          save();
          render();
        }
      }, function () {})
      .then(function () { looking = false; });
  }

  // The ring: the step's selector, looked for on the page and inside the
  // editor's canvas frame, which is the same origin. A selector that finds
  // nothing, or something with no size, shows no ring rather than a wrong one.
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
        return { left: r.left + dx, top: r.top + dy, width: r.width, height: r.height };
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

  function aim() {
    var t = tour && !state.nice && state.i < tasks.length ? tasks[state.i] : null;
    var r = t && t.point ? findPoint(t.point) : null;
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
    // the card steps aside once per step if it is sitting on the thing to click
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
    setInterval(watch, 2500);
    setInterval(aim, 400);
    window.addEventListener('scroll', aim, true);
    window.addEventListener('resize', aim);
  }

  /* ---- go -------------------------------------------------------------- */
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
