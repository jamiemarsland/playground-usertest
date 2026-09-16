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
 */
(function () {
  'use strict';
  var cfg = window.PGUT;
  if (!cfg || !cfg.test || !cfg.session || !cfg.report || !cfg.tasks || !cfg.tasks.length) return;

  var KEY = 'pgut:' + cfg.test + ':' + cfg.session;
  var state = load() || { i: 0, started: 0, taskStart: 0, results: {}, wrapped: false, hidden: false, pos: null, queue: [] };
  var tasks = cfg.tasks;

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
    '.pgut[hidden],.pgut-pill[hidden],.pgut [hidden]{display:none}' +
    '@media (max-width:700px){.pgut,.pgut-pill{top:auto!important;bottom:12px!important;left:12px!important;right:12px!important;width:auto}}';
  var style = document.createElement('style');
  style.textContent = css;
  document.head.appendChild(style);

  var card = document.createElement('div');
  card.className = 'pgut';
  card.setAttribute('role', 'complementary');
  card.setAttribute('aria-label', 'Testing tasks');
  var pill = document.createElement('button');
  pill.className = 'pgut-pill';
  pill.type = 'button';
  pill.hidden = true;
  pill.addEventListener('click', function () { state.hidden = false; save(); render(); });
  document.body.appendChild(card);
  document.body.appendChild(pill);

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

  function place() {
    var el = state.hidden ? pill : card;
    var other = state.hidden ? card : pill;
    other.style.left = other.style.top = other.style.right = '';
    if (state.pos) {
      el.style.left = state.pos.x + 'px';
      el.style.top = state.pos.y + 'px';
      el.style.right = 'auto';
    } else {
      el.style.left = 'auto';
      el.style.right = '16px';
      el.style.top = headerBottom() + 'px';
    }
  }
  window.addEventListener('resize', function () { if (!state.pos) place(); });

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
        el.style.right = 'auto';
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
      pill.textContent = state.wrapped
        ? 'Thanks for testing'
        : (state.i < tasks.length ? 'Task ' + (state.i + 1) + ' of ' + tasks.length : 'Last few questions');
      place();
      return;
    }
    card.hidden = false;
    pill.hidden = true;
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

  function finish(type) {
    var t = tasks[state.i];
    var note = (card.querySelector('.pgut-note') || {}).value || '';
    state.results[t.id] = { type: type, secs: secs(), note: note };
    send(type, t.id, note, { secs: secs() });
    state.i += 1;
    state.taskStart = 0;
    save();
    render();
  }

  function renderWrap() {
    card.innerHTML =
      head('Last few questions') +
      '<div class="pgut-body">' +
        '<p class="pgut-title">Thank you. Four quick questions.</p>' +
        '<div class="pgut-q">Are you happy with the site you made?</div>' +
        '<div class="pgut-scale" data-q="happy"><button type="button" data-v="1">1</button><button type="button" data-v="2">2</button><button type="button" data-v="3">3</button><button type="button" data-v="4">4</button><button type="button" data-v="5">5</button></div>' +
        '<div class="pgut-q">Could you finish it with a bit more time?</div>' +
        '<div class="pgut-scale" data-q="confident"><button type="button" data-v="yes">Yes</button><button type="button" data-v="maybe">Maybe</button><button type="button" data-v="no">No</button></div>' +
        '<div class="pgut-q">How did editing make you feel?</div>' +
        '<textarea data-q="feel"></textarea>' +
        '<div class="pgut-q">What confused you, if anything?</div>' +
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

  /* ---- go -------------------------------------------------------------- */
  if (!state.started) {
    state.started = Date.now();
    save();
    send('start', '', '', {
      subject: cfg.subject || '',
      viewport: window.innerWidth + 'x' + window.innerHeight,
      ua: String(navigator.userAgent || '').slice(0, 160),
      tasks: tasks.length,
    });
  } else {
    flush();
  }
  render();
})();
