/* The card a tester sees: what to try, a note box on each, and a wrap-up.
 *
 * Two ways in. Inside a WordPress test the plugin loads it on a site booted by
 * that test. On any other website the owner adds one line that loads it from
 * the app, and it wakes only for someone who came through a tester link.
 *
 * Everything the tester does
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

  // Two homes. Inside a WordPress test the plugin hands the card its settings
  // as window.PGUT. On any other website the app serves this same file with
  // window.PGUT_APP set, and the card finds its test from the tester's link.
  if (window.PGUT) return run(window.PGUT);
  if (window.PGUT_APP) return fromWebsite(String(window.PGUT_APP));

  /* ---- on any website ----------------------------------------------------- */
  // The owner put one line on their site, so this file loads for every visitor.
  // It does nothing unless the visitor arrived by a tester link
  // (?usertest=<id>), and from then on it follows them around that site.
  function fromWebsite(app) {
    var ACTIVE = 'pgut:web';
    var read = function () { try { return JSON.parse(localStorage.getItem(ACTIVE) || 'null'); } catch (e) { return null; } };
    var write = function (v) { try { localStorage.setItem(ACTIVE, JSON.stringify(v)); } catch (e) {} };
    var forget = function () { try { localStorage.removeItem(ACTIVE); } catch (e) {} };
    var params = new URLSearchParams(location.search);
    var id = params.get('usertest') || '';
    if (!/^[a-z0-9]{6,16}$/.test(id)) id = '';
    var v = params.get('usertest_v') || '';
    if (!/^[abc]$/.test(v)) v = '';

    // the owner's "is it on my site?" link: say so, report in, start nothing
    if (id && params.get('usertest_check') === '1') return installed(app, id);

    var active = read();
    if (id && (!active || active.test !== id)) {
      active = { test: id, v: v, session: newSession() };
      write(active);
    }
    if (!active || !active.test || !active.session) return;

    // keep the test out of the address bar, so a link shared on from here
    // does not turn a friend into a tester
    if (id && window.history && history.replaceState) {
      params.delete('usertest');
      params.delete('usertest_v');
      var q = params.toString();
      history.replaceState(history.state, '', location.pathname + (q ? '?' + q : '') + location.hash);
    }

    if (!window.fetch) return;
    fetch(app + '/api/card?test=' + encodeURIComponent(active.test))
      .then(function (r) {
        if (r.status === 404) { forget(); return null; }
        return r.ok ? r.json() : null;
      })
      .then(function (c) {
        if (!c || !c.tasks || !c.tasks.length) return;
        run({
          test: c.test, session: active.session, subject: c.subject, tasks: c.tasks, questions: c.questions,
          report: app + '/api/events' + (active.v ? '?v=' + active.v : ''),
          web: true, forget: forget,
        });
      })
      .then(null, function () {});
  }

  function newSession() {
    var abc = 'abcdefghijklmnopqrstuvwxyz0123456789', out = '';
    var bytes = new Uint8Array(14);
    if (window.crypto && crypto.getRandomValues) crypto.getRandomValues(bytes);
    else for (var i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
    for (var j = 0; j < bytes.length; j++) out += abc[bytes[j] % abc.length];
    return out;
  }

  function installed(app, id) {
    var note = document.createElement('div');
    note.setAttribute('role', 'status');
    note.style.cssText = 'position:fixed;right:16px;bottom:16px;z-index:2147483000;max-width:320px;padding:14px 16px;border-radius:14px;' +
      'background:#16181c;color:#fff;font:14px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",Inter,sans-serif;box-shadow:0 12px 40px rgba(22,24,28,.25)';
    note.textContent = 'The test card is on this site. Testers who come through your link will see their tasks here.';
    (document.body || document.documentElement).appendChild(note);
    setTimeout(function () { note.remove(); }, 8000);
    if (window.fetch) {
      fetch(app + '/api/seen', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ test: id, origin: location.origin }) })
        .then(null, function () {});
    }
  }

  /* ---- the card ----------------------------------------------------------- */
  function run(cfg) {
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
      // numbered, so the app can tell a resend from something new
      state.n = (state.n || 0) + 1;
      state.queue.push({ n: state.n, t: Date.now(), type: type, task: task || '', path: where(), note: note || '', data: data || null });
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
        .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); state.queue = state.queue.slice(batch.length); save(); return true; })
        .catch(function () { return false; })
        // more waiting goes straight after a batch that landed; the long wait
        // is only for trying again after one that did not
        .then(function (ok) { sending = false; if (state.queue.length) setTimeout(flush, ok ? 200 : 4000); });
    }

    // A tester who presses Send and closes the tab straight away should not
    // take their answers with them: anything still waiting goes as they leave.
    document.addEventListener('visibilitychange', function () { if (document.visibilityState === 'hidden') flush(); });

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

    // The block editor and the Site Editor keep Save, Publish and the settings
    // sidebar along the top and down the right, which is exactly where the card
    // would land. There it starts at the bottom left instead, a little above the
    // editor's breadcrumb bar.
    function inEditor() {
      var b = document.body.classList;
      return b.contains('block-editor-page') || b.contains('site-editor-php') ||
        !!document.querySelector('.interface-interface-skeleton, .edit-site');
    }

    function place() {
      var el = state.hidden ? pill : card;
      var other = state.hidden ? card : pill;
      other.style.left = other.style.top = other.style.right = other.style.bottom = '';
      if (state.pos) {
        el.style.left = state.pos.x + 'px';
        el.style.top = state.pos.y + 'px';
        el.style.right = el.style.bottom = 'auto';
      } else if (inEditor()) {
        el.style.left = '16px';
        el.style.bottom = '60px';
        el.style.right = el.style.top = 'auto';
      } else {
        el.style.left = el.style.bottom = 'auto';
        el.style.right = '16px';
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
      if (!state.taskStart) { state.taskStart = Date.now(); save(); send('task_start', t.id); watchPage(); }
    }

    /* ---- did the site change? ------------------------------------------- */
    // A task can carry a check: something the site itself can show (the name
    // changed, a page was published, the colours moved). The plugin answers from
    // the test's own copy of the check, so nothing here can steer it. For words
    // on the home page the card reads the page as a visitor would.
    function checkSite(t) {
      if (t.check && cfg.web) return Promise.resolve(sawIt(t));
      if (!t.check || !cfg.rest || !window.fetch) return Promise.resolve('');
      var ask = fetch(cfg.rest + (cfg.rest.indexOf('?') === -1 ? '?' : '&') + 'task=' + encodeURIComponent(t.id), {
        credentials: 'same-origin', cache: 'no-store', headers: { 'X-WP-Nonce': cfg.nonce || '' },
      })
        .then(function (r) { return r.ok ? r.json() : { result: 'unknown' }; })
        .then(function (d) {
          if (!d || d.result !== 'client') return (d && d.result) || 'unknown';
          return fetch(cfg.home || '/', { credentials: 'same-origin', cache: 'no-store' })
            .then(function (r) { return r.text(); })
            .then(function (html) {
              var words = String(t.check.text || '').toLowerCase().replace(/\s+/g, ' ').trim();
              var doc = new DOMParser().parseFromString(html, 'text/html');
              var bar = doc.getElementById('wpadminbar');
              if (bar) bar.remove();
              [].slice.call(doc.querySelectorAll('script,style,.pgut')).forEach(function (n) { n.remove(); });
              var text = (doc.body ? doc.body.textContent : '').toLowerCase().replace(/\s+/g, ' ');
              return words && text.indexOf(words) !== -1 ? 'yes' : 'no';
            });
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
    var own = cfg.questions || {};
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
        (cfg.web
          ? '<p class="pgut-p">Your answers have gone to whoever asked you to try this.</p>' +
            '<div class="pgut-row"><button type="button" class="pgut-btn is-primary pgut-close">Close this card</button></div></div>'
          : '<p class="pgut-p">Your answers have gone to whoever asked you to try this. Carry on playing with the site for as long as you like; it is yours until you close the tab.</p></div>');
      afterRender();
      var close = card.querySelector('.pgut-close');
      if (close) {
        // on a real website the card has to go away for good once it is done,
        // or it would greet the tester on every page from then on
        close.addEventListener('click', function () {
          if (cfg.forget) cfg.forget();
          card.remove();
          pill.remove();
        });
      }
    }

    /* ---- on a website: what the card saw ----------------------------------- */
    // There is no WordPress to ask on an ordinary website, so a check is
    // answered from what the tester did while the task was open: the pages they
    // reached, the words those pages showed, and what they clicked. Only that
    // yes or no leaves the page, never the words themselves.
    function seenFor(id) {
      state.seen = state.seen || {};
      state.seen[id] = state.seen[id] || { paths: [], text: false, clicked: false };
      return state.seen[id];
    }
    function pageText() {
      var copy = document.body ? document.body.cloneNode(true) : null;
      if (!copy) return '';
      [].slice.call(copy.querySelectorAll('script,style,noscript,.pgut,.pgut-pill')).forEach(function (n) { n.remove(); });
      return (copy.textContent || '').toLowerCase().replace(/\s+/g, ' ');
    }
    function words(s) { return String(s || '').toLowerCase().replace(/\s+/g, ' ').trim(); }
    function samePage(path, want) {
      var a = String(path || '').replace(/\/+(\?|$)/, '$1') || '/';
      var b = String(want || '').replace(/\/+(\?|$)/, '$1') || '/';
      if (b.indexOf('?') === -1) a = a.split('?')[0];
      return a === b || (b !== '/' && a.indexOf(b + '/') === 0);
    }
    function watchPage() {
      if (!cfg.web || state.wrapped || state.i >= tasks.length) return;
      var t = tasks[state.i];
      var seen = seenFor(t.id);
      var here = location.pathname + location.search;
      if (seen.paths.indexOf(here) === -1 && seen.paths.length < 40) seen.paths.push(here);
      if (t.check && t.check.type === 'text' && !seen.text && words(t.check.text) && pageText().indexOf(words(t.check.text)) !== -1) seen.text = true;
      save();
    }
    function sawIt(t) {
      var seen = seenFor(t.id);
      var c = t.check;
      if (c.type === 'page') {
        var all = seen.paths.concat([location.pathname + location.search]);
        return all.some(function (p) { return samePage(p, c.path); }) ? 'yes' : 'no';
      }
      if (c.type === 'text') return seen.text || pageText().indexOf(words(c.text)) !== -1 ? 'yes' : 'no';
      if (c.type === 'click') return seen.clicked ? 'yes' : 'no';
      return 'unknown';
    }
    if (cfg.web) {
      document.addEventListener('click', function (ev) {
        if (state.wrapped || state.i >= tasks.length) return;
        var t = tasks[state.i];
        if (!t.check || t.check.type !== 'click' || !ev.target || !ev.target.closest) return;
        if (ev.target.closest('.pgut,.pgut-pill')) return;
        var el = ev.target.closest('a,button,[role=button],input[type=submit],input[type=button],summary,label');
        if (!el) return;
        var label = words(el.innerText || el.value || el.getAttribute('aria-label') || el.title || '');
        if (label && label.indexOf(words(t.check.text)) !== -1) { seenFor(t.id).clicked = true; save(); }
      }, true);
    }

    /* ---- go -------------------------------------------------------------- */
    watchPage();
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
  }
})();
