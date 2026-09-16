/* Playground user testing — the service.
 *
 * Someone who has made a WordPress theme, plugin or site fills in one form:
 * who the tester should pretend to be, five to seven things to try, and the
 * blueprint they already use to demo their thing. They get back two links: one
 * to send a tester, one to read the results.
 *
 * The tester's site is a Playground tab. It vanishes when the tab closes and
 * the tester has no site of their own, so results have to leave the sandbox as
 * they happen — which is what this Worker is for. It holds the tests, serves
 * the tester's intro page, serves the wrapped blueprint, receives the events,
 * and shows the results.
 *
 *   GET  /                      the create form
 *   POST /api/tests             create a test  -> { id, tester, results, password }
 *   GET  /t/<id>                the tester's intro page
 *   GET  /t/<id>/blueprint.json the owner's blueprint + the card
 *   GET  /t/<id>/results        the results page (asks for the password)
 *   POST /api/events            the card reports in
 *   GET  /api/results           results as JSON (x-test-password header)
 *
 * KV, one namespace:
 *   test:<id>                   the test itself (tasks, persona, blueprint, password hash)
 *   test:<id>:session:<sid>     one tester's events, newest last, capped
 *   test:<id>:index             one row per tester session, newest first
 *   ip:*                        rate counters
 *
 * Everything expires NINETY_DAYS after the last event, so an abandoned test
 * cleans itself up and the store never grows without bound.
 */

const NINETY_DAYS = 90 * 24 * 60 * 60;
const TOUCH_AFTER = 24 * 60 * 60 * 1000; // how stale a test record may get before its expiry is refreshed

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': 'content-type',
  'access-control-allow-methods': 'POST, OPTIONS',
};

function json(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: Object.assign({ 'content-type': 'application/json; charset=utf-8' }, headers),
  });
}

function html(body, headers = {}, status = 200) {
  return new Response(body, {
    status,
    headers: Object.assign(
      {
        'content-type': 'text/html; charset=utf-8',
        'x-content-type-options': 'nosniff',
        'referrer-policy': 'no-referrer',
      },
      headers
    ),
  });
}

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

/* --------------------------------------------------------------- ids, passwords */

// Test ids are read aloud and typed, so they skip the characters people confuse:
// no 0/o, no 1/l/i. Ten of these is about 51 bits — far more than guessing gets you
// through the per-address cap, and the results page still wants the password.
const ID_ALPHABET = '23456789abcdefghjkmnpqrstuvwxyz';

function makeId(len = 10) {
  const bytes = crypto.getRandomValues(new Uint8Array(len));
  let out = '';
  for (let i = 0; i < len; i++) out += ID_ALPHABET[bytes[i] % ID_ALPHABET.length];
  return out;
}

const TEST_ID_RE = new RegExp(`^[${ID_ALPHABET}]{6,16}$`);
const SESSION_RE = /^[a-z0-9]{8,32}$/;

function hex(buf) {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// PBKDF2 rather than a bare hash: the password is whatever the owner typed, and
// the results page is the only thing standing in front of a tester's notes.
async function hashPassword(password, saltHex) {
  const salt = saltHex ? Uint8Array.from(saltHex.match(/../g).map((h) => parseInt(h, 16)))
                       : crypto.getRandomValues(new Uint8Array(16));
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations: 100000, hash: 'SHA-256' },
    key,
    256
  );
  return { salt: saltHex || hex(salt), hash: hex(bits) };
}

// Compare in constant time so the results password can't be found a byte at a time.
function sameSecret(a, b) {
  const x = String(a || ''), y = String(b || '');
  if (x.length !== y.length) return false;
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x.charCodeAt(i) ^ y.charCodeAt(i);
  return diff === 0;
}

/* ------------------------------------------------------------------ counters */

// Counters are best-effort. On the free KV plan they can run out of writes, and
// when they do the Worker keeps serving rather than going down — the caps exist
// to stop one address filling the store, not to bound a bill.
async function peekCount(env, key) {
  if (!env.TESTS) return 0;
  try {
    return parseInt((await env.TESTS.get(key)) || '0', 10) || 0;
  } catch (e) {
    return 0;
  }
}

async function bumpCount(env, key, from, ttl) {
  if (!env.TESTS) return;
  try {
    await env.TESTS.put(key, String(from + 1), { expirationTtl: ttl });
  } catch (e) {
    /* out of writes: serve anyway */
  }
}

async function countAndCheck(env, key, limit, ttl) {
  const n = await peekCount(env, key);
  if (n >= limit) return { ok: false, n };
  await bumpCount(env, key, n, ttl);
  return { ok: true, n: n + 1 };
}

function ipOf(req) {
  return req.headers.get('cf-connecting-ip') || 'unknown';
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

function thisHour() {
  return new Date().toISOString().slice(0, 13);
}

/* --------------------------------------------------------------------- store */

async function readJSON(env, key, fallback) {
  if (!env.TESTS) return fallback;
  try {
    const raw = await env.TESTS.get(key);
    if (!raw) return fallback;
    const val = JSON.parse(raw);
    return val == null ? fallback : val;
  } catch (e) {
    return fallback;
  }
}

function writeJSON(env, key, value) {
  return env.TESTS.put(key, JSON.stringify(value), { expirationTtl: NINETY_DAYS });
}

async function getTest(env, id) {
  if (!TEST_ID_RE.test(id)) return null;
  return readJSON(env, `test:${id}`, null);
}

/* ---------------------------------------------------------------- validation */

function trim(v, max) {
  return String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, max);
}

function trimMultiline(v, max) {
  return String(v == null ? '' : v).replace(/\r\n/g, '\n').trim().slice(0, max);
}

const LIMITS = {
  subject: 80,      // what is being tested: "gogh", "my theme"
  persona: 2000,    // who the tester pretends to be
  taskTitle: 140,
  taskWhy: 300,
  taskHint: 300,
  tasksMin: 1,
  tasksMax: 12,
  blueprintBytes: 256 * 1024,
  passwordMin: 6,
  passwordMax: 200,
};

// Task ids go into the results table and into the card's localStorage key, so
// they are derived from the title rather than asked for: the owner never sees them.
function taskId(title, i) {
  const slug = String(title || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 28);
  return slug ? `${i + 1}-${slug}` : `task-${i + 1}`;
}

function cleanTasks(input) {
  const list = Array.isArray(input) ? input : [];
  const out = [];
  for (const raw of list.slice(0, LIMITS.tasksMax)) {
    const title = trim(raw && raw.title, LIMITS.taskTitle);
    if (!title) continue;
    const task = { id: taskId(title, out.length), title };
    const why = trim(raw && raw.why, LIMITS.taskWhy);
    const hint = trim(raw && raw.hint, LIMITS.taskHint);
    if (why) task.why = why;
    if (hint) task.hint = hint;
    out.push(task);
  }
  return out;
}

// The owner's blueprint is fetched from wherever they keep it, so this is the
// one place the Worker follows a URL someone gave it. Anything but a public
// https host is refused: no http, no IP literals, no localhost.
function checkBlueprintUrl(raw) {
  let u;
  try {
    u = new URL(String(raw));
  } catch (e) {
    return { error: 'That blueprint URL is not a URL.' };
  }
  if (u.protocol !== 'https:') return { error: 'The blueprint URL has to start with https://.' };
  const host = u.hostname.toLowerCase();
  if (
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host.endsWith('.internal') ||
    host.endsWith('.local') ||
    /^\d{1,3}(\.\d{1,3}){3}$/.test(host) ||
    host.includes(':')
  ) {
    return { error: 'The blueprint has to be somewhere public — that host is not.' };
  }
  return { url: u.toString() };
}

async function fetchBlueprint(url) {
  let res;
  try {
    res = await fetch(url, {
      redirect: 'follow',
      cf: { cacheTtl: 300, cacheEverything: true },
      headers: { accept: 'application/json' },
    });
  } catch (e) {
    return { error: 'Could not reach that blueprint URL.' };
  }
  if (!res.ok) return { error: `That blueprint URL answered ${res.status}.` };
  const text = await res.text();
  if (text.length > LIMITS.blueprintBytes) return { error: 'That blueprint is too big.' };
  try {
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { error: 'That blueprint is not a JSON object.' };
    }
    return { blueprint: parsed };
  } catch (e) {
    return { error: 'That blueprint URL did not give back JSON.' };
  }
}

/* ---------------------------------------------------------------- create a test */

async function createTest(env, req) {
  if (!env.TESTS) return json({ error: 'The store is not set up yet.' }, 503, CORS);

  // Only a test that actually gets made counts against the day's allowance: a
  // typo in the form, or a blueprint URL that turns out to be wrong, must not
  // cost someone one of their five.
  const cap = parseInt(env.CREATE_DAILY_LIMIT || '5', 10);
  const capKey = `ip:create:${today()}:${ipOf(req)}`;
  const made = await peekCount(env, capKey);
  if (made >= cap) return json({ error: `That is ${cap} tests today from here. Try again tomorrow.` }, 429, CORS);

  let body = {};
  try { body = JSON.parse(await req.text()) || {}; } catch (e) { body = {}; }

  const subject = trim(body.subject, LIMITS.subject);
  const persona = trimMultiline(body.persona, LIMITS.persona);
  const tasks = cleanTasks(body.tasks);
  const password = String(body.password || '');

  if (!subject) return json({ error: 'Say what is being tested — it goes in the tester’s thank-you line.' }, 400, CORS);
  if (!persona) return json({ error: 'Write a paragraph about who the tester should pretend to be.' }, 400, CORS);
  if (tasks.length < LIMITS.tasksMin) return json({ error: 'Give the tester at least one thing to try.' }, 400, CORS);
  if (password.length < LIMITS.passwordMin || password.length > LIMITS.passwordMax) {
    return json({ error: `The results password has to be at least ${LIMITS.passwordMin} characters.` }, 400, CORS);
  }

  // Either a URL to fetch each time, or JSON pasted once. Both are checked now
  // so a broken blueprint is an error on the form, not a blank tab for a tester.
  let blueprintUrl = '';
  let blueprintJson = null;
  const rawUrl = trim(body.blueprintUrl, 500);
  const rawJson = String(body.blueprintJson || '').trim();

  if (rawUrl) {
    const checked = checkBlueprintUrl(rawUrl);
    if (checked.error) return json({ error: checked.error }, 400, CORS);
    const got = await fetchBlueprint(checked.url);
    if (got.error) return json({ error: got.error }, 400, CORS);
    blueprintUrl = checked.url;
  } else if (rawJson) {
    if (rawJson.length > LIMITS.blueprintBytes) return json({ error: 'That blueprint is too big.' }, 400, CORS);
    try {
      const parsed = JSON.parse(rawJson);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return json({ error: 'The pasted blueprint is not a JSON object.' }, 400, CORS);
      }
      blueprintJson = parsed;
    } catch (e) {
      return json({ error: 'The pasted blueprint is not valid JSON.' }, 400, CORS);
    }
  } else {
    return json({ error: 'Give a blueprint — a URL, or paste the JSON.' }, 400, CORS);
  }

  const { salt, hash } = await hashPassword(password);
  const id = makeId();
  const now = Date.now();

  const record = {
    id,
    created: now,
    touched: now,
    subject,
    persona,
    tasks,
    blueprintUrl,
    blueprintJson,
    pwSalt: salt,
    pwHash: hash,
  };

  await writeJSON(env, `test:${id}`, record);
  await writeJSON(env, `test:${id}:index`, []);
  await bumpCount(env, capKey, made, 2 * 24 * 60 * 60);

  const origin = new URL(req.url).origin;
  return json({ id, tester: `${origin}/t/${id}`, results: `${origin}/t/${id}/results` }, 200, CORS);
}

/* ------------------------------------------------------- the wrapped blueprint */

// The owner's blueprint plus the two steps that make it a test: install the card
// plugin, and hand it the test id, the tasks and where to report. Their own steps
// run first so the card lands on a site that is already set up.
function wrapBlueprint(base, test, origin, pluginZipUrl) {
  const out = Object.assign({}, base);
  const steps = Array.isArray(base.steps) ? base.steps.slice() : [];

  // Networking is what lets the card reach this Worker from inside the sandbox.
  out.features = Object.assign({}, base.features, { networking: true });

  steps.push({
    step: 'installPlugin',
    pluginData: { resource: 'url', url: pluginZipUrl },
    options: { activate: true },
  });

  steps.push({
    step: 'setSiteOptions',
    options: {
      playground_user_test: JSON.stringify({
        test: test.id,
        report: `${origin}/api/events`,
        subject: test.subject,
        tasks: test.tasks,
      }),
    },
  });

  out.steps = steps;
  return out;
}

async function zipIsThere(url) {
  try {
    const res = await fetch(url, {
      method: 'HEAD',
      redirect: 'follow',
      cf: { cacheTtl: 3600, cacheEverything: true },
    });
    return res.ok;
  } catch (e) {
    return false;
  }
}

async function serveBlueprint(env, req, id) {
  const test = await getTest(env, id);
  if (!test) return json({ error: 'No such test.' }, 404, CORS);

  let base = test.blueprintJson;
  if (!base) {
    const got = await fetchBlueprint(test.blueprintUrl);
    if (got.error) return json({ error: got.error }, 502, CORS);
    base = got.blueprint;
  }

  const origin = new URL(req.url).origin;
  const zip = env.PLUGIN_ZIP_URL || '';
  if (!zip) return json({ error: 'The card plugin is not configured.' }, 503, CORS);

  // Serving a blueprint that installs a zip which is not there is the worst
  // thing this service can do: Playground shrugs off the failed step, the
  // tester gets a perfectly good site with no card on it, does the whole test,
  // and nothing is recorded. One HEAD — cached for an hour, so it costs almost
  // nothing — turns that into a refusal the owner can see.
  if (!(await zipIsThere(zip))) {
    return json({ error: 'The card plugin zip is not where the service expects it. Nothing can be recorded until it is, so no blueprint is served.' }, 503, CORS);
  }

  const wrapped = wrapBlueprint(base, test, origin, zip);
  return json(wrapped, 200, Object.assign({ 'cache-control': 'public, max-age=60' }, CORS));
}

/* -------------------------------------------------------------------- events */

const EVENT_TYPES = ['start', 'task_start', 'task_done', 'task_skip', 'hint', 'error', 'wrap', 'note'];
const MAX_EVENTS_PER_SESSION = 600;
const MAX_SESSIONS_PER_TEST = 500;

// Nothing from the card is trusted: the type has to be one of ours, and every
// string is cut to a fixed length before it goes anywhere near the store.
function cleanEvent(e) {
  const out = {
    t: Number(e && e.t) || Date.now(),
    type: e && EVENT_TYPES.includes(e.type) ? e.type : 'note',
    task: trim(e && e.task, 40),
    path: trim(e && e.path, 200),
    note: trimMultiline(e && e.note, 2000),
  };
  if (e && e.data && typeof e.data === 'object' && !Array.isArray(e.data)) {
    const d = {};
    for (const k of Object.keys(e.data).slice(0, 12)) {
      const v = e.data[k];
      if (typeof v === 'number' || typeof v === 'boolean') d[k.slice(0, 32)] = v;
      else if (typeof v === 'string') d[k.slice(0, 32)] = v.slice(0, 500);
    }
    out.data = d;
  }
  return out;
}

// One row per tester, kept beside the events so the results table is a single read.
function summarise(row, all, now) {
  const start = all.find((e) => e.type === 'start');
  const wrap = all.filter((e) => e.type === 'wrap').slice(-1)[0];
  const startData = (start && start.data) || {};
  const wrapData = (wrap && wrap.data) || {};
  return {
    id: row.id,
    first: row.first || now,
    last: now,
    n: all.length,
    viewport: startData.viewport || '',
    done: all.filter((e) => e.type === 'task_done').length,
    skipped: all.filter((e) => e.type === 'task_skip').length,
    wrapped: !!wrap,
    name: wrapData.name || '',
  };
}

async function appendEvents(env, req) {
  if (!env.TESTS) return json({ error: 'The store is not set up yet.' }, 503, CORS);

  let body = {};
  try { body = JSON.parse(await req.text()) || {}; } catch (e) { body = {}; }

  const id = String(body.test || '');
  const session = String(body.session || '');
  if (!TEST_ID_RE.test(id)) return json({ error: 'test' }, 400, CORS);
  if (!SESSION_RE.test(session)) return json({ error: 'session' }, 400, CORS);

  const test = await getTest(env, id);
  if (!test) return json({ error: 'No such test.' }, 404, CORS);

  const cap = parseInt(env.EVENTS_HOURLY_LIMIT || '300', 10);
  const gate = await countAndCheck(env, `ip:events:${thisHour()}:${ipOf(req)}`, cap, 2 * 60 * 60);
  if (!gate.ok) return json({ error: 'too many' }, 429, CORS);

  const events = (Array.isArray(body.events) ? body.events : []).slice(0, 50).map(cleanEvent);
  if (!events.length) return json({ ok: true, n: 0 }, 200, CORS);

  const key = `test:${id}:session:${session}`;
  const had = await readJSON(env, key, []);
  const all = (Array.isArray(had) ? had : []).concat(events).slice(-MAX_EVENTS_PER_SESSION);
  await writeJSON(env, key, all);

  const now = Date.now();
  const index = await readJSON(env, `test:${id}:index`, []);
  const rows = Array.isArray(index) ? index : [];
  const at = rows.findIndex((r) => r && r.id === session);
  const row = summarise({ id: session, first: at < 0 ? now : rows[at].first }, all, now);
  if (at < 0) rows.unshift(row); else rows[at] = row;
  await writeJSON(env, `test:${id}:index`, rows.slice(0, MAX_SESSIONS_PER_TEST));

  // Ninety days from the last event, not from the day it was made — but only
  // re-put the test when its expiry has had a day to drift, so a busy test does
  // not spend a KV write per batch keeping itself alive.
  if (now - (test.touched || test.created || 0) > TOUCH_AFTER) {
    test.touched = now;
    await writeJSON(env, `test:${id}`, test);
  }

  return json({ ok: true, n: all.length }, 200, CORS);
}

/* ------------------------------------------------------------------- results */

async function readResults(env, req, url) {
  const id = url.searchParams.get('test') || '';
  const test = await getTest(env, id);
  const given = req.headers.get('x-test-password') || '';

  // Hash even when there is no such test, so a wrong id and a wrong password
  // take the same time and tell the asker the same thing.
  const salt = test ? test.pwSalt : '00000000000000000000000000000000';
  const { hash } = await hashPassword(given, salt);
  if (!test || !sameSecret(hash, test.pwHash)) {
    return json({ error: 'That password is not right.' }, 401, { 'cache-control': 'no-store' });
  }

  const session = url.searchParams.get('session') || '';
  if (session) {
    if (!SESSION_RE.test(session)) return json({ error: 'session' }, 400, { 'cache-control': 'no-store' });
    const events = await readJSON(env, `test:${id}:session:${session}`, []);
    return json({ session, events }, 200, { 'cache-control': 'no-store' });
  }

  const index = await readJSON(env, `test:${id}:index`, []);
  return json(
    {
      subject: test.subject,
      created: test.created,
      tasks: test.tasks,
      sessions: Array.isArray(index) ? index : [],
    },
    200,
    { 'cache-control': 'no-store' }
  );
}

/* --------------------------------------------------------------------- pages */

const PAGE_CSS = `
  :root { --paper:#faf9f6; --ink:#1a1916; --soft:#6d6a63; --line:#e6e2da; --accent:#16181c; --ok:#2f8f5b; --bad:#c2452d; }
  * { box-sizing:border-box; }
  body { margin:0; background:var(--paper); color:var(--ink); font:17px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",Inter,sans-serif; }
  .wrap { max-width:640px; margin:0 auto; padding:56px 20px 120px; }
  h1 { font:700 34px/1.15 Georgia,"Iowan Old Style",serif; margin:0 0 14px; letter-spacing:-.01em; }
  p { margin:0 0 16px; }
  .soft { color:var(--soft); }
  .card { margin:26px 0; padding:20px 22px; border:1px solid var(--line); border-radius:16px; background:#fff; }
  .card h2 { font-size:14px; letter-spacing:.08em; text-transform:uppercase; color:var(--soft); margin:0 0 8px; }
  ol { margin:0; padding-left:20px; } li { margin:0 0 6px; }
  .go { display:inline-block; margin:8px 0 0; padding:14px 24px; border-radius:999px; background:var(--accent); color:#fff; font-weight:600; text-decoration:none; border:0; cursor:pointer; font-size:17px; }
  .go[disabled] { opacity:.5; cursor:default; }
  .fine { font-size:14px; color:var(--soft); margin-top:28px; }
`;

// The page a tester is sent. Their name for the next half hour, what happens,
// and Start. It never says how long it takes: that is what puts people off.
function introPage(test, origin) {
  const playground = 'https://playground.wordpress.net/?blueprint-url=' +
    encodeURIComponent(`${origin}/t/${test.id}/blueprint.json`) + '&storage=temp';
  const paras = test.persona
    .split(/\n{2,}/)
    .map((p) => `<p>${esc(p)}</p>`)
    .join('');
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Thank you for helping make ${esc(test.subject)} better</title>
<style>${PAGE_CSS}</style></head><body><div class="wrap">
<h1>Thank you for helping make ${esc(test.subject)} better</h1>
<p>You are about to get a real WordPress website in your browser, already set up, with a small card of things to try. Nobody is watching. There are no wrong answers.</p>
<div class="card"><h2>Who you are while you try it</h2>
${paras}
<p class="soft" style="margin:0">The site you get is a start someone made for you. Make it yours.</p></div>
<div class="card"><h2>How it goes</h2>
<ol><li>Press Start. Give it a minute to build.</li>
<li>A card on the right lists ${test.tasks.length} thing${test.tasks.length === 1 ? '' : 's'} to try. Do each one your own way, then press Done. If you can’t, press Couldn’t do it. Both are useful.</li>
<li>At the end there are four quick questions.</li></ol></div>
<a class="go" href="${esc(playground)}" target="_blank" rel="noopener">Start</a>
<p class="fine">Use a computer, not a phone, and Chrome, Edge or Firefox. The site is throwaway: close the tab and it is gone. The only thing kept is what the card learns — which tasks you did, how long they took, which page you were on, and anything you type into it. Nothing else: not what you write on the site, and not your name unless you choose to type it.</p>
</div></body></html>`;
}

// The owner's whole flow: one form, two links back. No account, nothing to host.
const HOME = `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>User-test a WordPress thing with anyone</title>
<style>${PAGE_CSS}
  .wrap { max-width: 720px; }
  label { display:block; font-weight:600; margin:0 0 6px; }
  .hint { font-size:14px; color:var(--soft); margin:0 0 8px; font-weight:400; }
  input[type=text], input[type=password], input[type=url], textarea {
    width:100%; font:inherit; padding:10px 12px; border:1px solid var(--line);
    border-radius:10px; background:#fff; color:inherit; resize:vertical; }
  textarea { min-height:90px; }
  fieldset { border:0; padding:0; margin:0 0 26px; }
  .task { display:grid; gap:8px; padding:14px 16px; border:1px solid var(--line); border-radius:12px; background:#fff; margin:0 0 10px; }
  .task .top { display:flex; gap:10px; align-items:center; }
  .task .top input { flex:1; }
  .drop { all:unset; cursor:pointer; color:var(--soft); font-size:20px; line-height:1; padding:2px 8px; border-radius:8px; }
  .drop:hover { background:rgba(22,24,28,.06); }
  .add { all:unset; cursor:pointer; font-weight:600; text-decoration:underline; text-underline-offset:3px; }
  .tabs { display:flex; gap:8px; margin:0 0 10px; }
  .tabs button { all:unset; cursor:pointer; padding:7px 14px; border-radius:999px; border:1px solid var(--line); background:#fff; font-size:15px; }
  .tabs button.on { background:var(--accent); color:#fff; border-color:var(--accent); }
  .err { color:var(--bad); font-weight:600; }
  .out { margin:26px 0 0; padding:20px 22px; border:1px solid var(--line); border-radius:16px; background:#fff; }
  .out code { display:block; font:14px/1.6 ui-monospace,SFMono-Regular,Menlo,monospace; word-break:break-all; padding:8px 10px; background:var(--paper); border-radius:8px; margin:4px 0 14px; }
</style></head><body><div class="wrap">
<h1>User-test it with anyone</h1>
<p>Someone opens a link, gets a throwaway WordPress site in their browser, and a small card lists a few things to try. You read what happened. Nothing to install, at either end.</p>

<form id="f">
<fieldset>
  <label for="subject">What are you testing?</label>
  <p class="hint">Goes in the tester’s first line: “Thank you for helping make <em>this</em> better.”</p>
  <input type="text" id="subject" maxlength="80" placeholder="my theme" required>
</fieldset>

<fieldset>
  <label for="persona">Who should they pretend to be?</label>
  <p class="hint">A paragraph. Give them a reason to want the site, not just instructions. Don’t use the demo site’s own name, or “rename the site” has nothing to change.</p>
  <textarea id="persona" maxlength="2000" required placeholder="You are a photographer a few months into running your own business. Customers keep asking whether you have a website…"></textarea>
</fieldset>

<fieldset>
  <label>What should they try?</label>
  <p class="hint">Five to seven works well. Say what they want, not which button to press — the hint is there for when they are stuck.</p>
  <div id="tasks"></div>
  <button type="button" class="add" id="add">Add another</button>
</fieldset>

<fieldset>
  <label>The blueprint that sets up your site</label>
  <p class="hint">The one you already use to demo your thing. A URL is re-read each time, so you can keep editing it.</p>
  <div class="tabs"><button type="button" class="on" data-bp="url">A URL</button><button type="button" data-bp="json">Paste JSON</button></div>
  <input type="url" id="bpurl" placeholder="https://example.com/blueprint.json">
  <textarea id="bpjson" hidden placeholder='{ "steps": [ … ] }'></textarea>
</fieldset>

<fieldset>
  <label for="password">A password for the results page</label>
  <p class="hint">There are no accounts here. This password is the only thing in front of your testers’ notes, and it cannot be recovered — keep it somewhere.</p>
  <input type="password" id="password" minlength="6" maxlength="200" required>
</fieldset>

<p id="msg" class="err" role="alert"></p>
<button type="submit" class="go" id="submit">Make the test</button>
</form>

<div id="out"></div>
</div>
<script>
(function () {
  var tasksEl = document.getElementById('tasks');
  var mode = 'url';

  function addTask(title, hint) {
    var d = document.createElement('div');
    d.className = 'task';
    d.innerHTML =
      '<div class="top"><input type="text" class="t-title" maxlength="140" placeholder="Give the site your own name"></div>' +
      '<input type="text" class="t-hint" maxlength="300" placeholder="Hint, shown only if they ask (optional)">';
    var drop = document.createElement('button');
    drop.type = 'button';
    drop.className = 'drop';
    drop.title = 'Remove';
    drop.textContent = '\\u00d7';
    drop.addEventListener('click', function () { d.remove(); });
    d.querySelector('.top').appendChild(drop);
    if (title) d.querySelector('.t-title').value = title;
    if (hint) d.querySelector('.t-hint').value = hint;
    tasksEl.appendChild(d);
  }
  for (var i = 0; i < 5; i++) addTask();
  document.getElementById('add').addEventListener('click', function () { addTask(); });

  [].slice.call(document.querySelectorAll('[data-bp]')).forEach(function (b) {
    b.addEventListener('click', function () {
      mode = b.dataset.bp;
      [].slice.call(document.querySelectorAll('[data-bp]')).forEach(function (o) { o.classList.toggle('on', o === b); });
      document.getElementById('bpurl').hidden = mode !== 'url';
      document.getElementById('bpjson').hidden = mode !== 'json';
    });
  });

  var msg = document.getElementById('msg'), submit = document.getElementById('submit');
  document.getElementById('f').addEventListener('submit', function (ev) {
    ev.preventDefault();
    msg.textContent = '';
    var tasks = [].slice.call(tasksEl.querySelectorAll('.task')).map(function (d) {
      return { title: d.querySelector('.t-title').value, hint: d.querySelector('.t-hint').value };
    }).filter(function (t) { return t.title.trim(); });
    if (!tasks.length) { msg.textContent = 'Give the tester at least one thing to try.'; return; }

    submit.disabled = true;
    submit.textContent = 'Checking the blueprint…';
    fetch('/api/tests', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        subject: document.getElementById('subject').value,
        persona: document.getElementById('persona').value,
        tasks: tasks,
        blueprintUrl: mode === 'url' ? document.getElementById('bpurl').value : '',
        blueprintJson: mode === 'json' ? document.getElementById('bpjson').value : '',
        password: document.getElementById('password').value,
      }),
    }).then(function (r) { return r.json().then(function (d) { return { ok: r.ok, d: d }; }); })
      .then(function (res) {
        submit.disabled = false;
        submit.textContent = 'Make the test';
        if (!res.ok) { msg.textContent = res.d.error || 'That did not work.'; return; }
        document.getElementById('f').hidden = true;
        document.getElementById('out').innerHTML =
          '<div class="out"><h2 style="margin-top:0">Two links</h2>' +
          '<p style="margin-bottom:4px"><strong>Send this to a tester</strong></p><code>' + res.d.tester + '</code>' +
          '<p style="margin-bottom:4px"><strong>Read the results here</strong>, with the password you chose</p><code>' + res.d.results + '</code>' +
          '<p class="soft" style="margin:0">Keep both. Neither can be looked up again, and the test keeps itself for ninety days after the last tester.</p></div>';
        window.scrollTo(0, document.body.scrollHeight);
      })
      .catch(function () {
        submit.disabled = false;
        submit.textContent = 'Make the test';
        msg.textContent = 'Could not reach the service. Try again.';
      });
  });
})();
</script>
</body></html>`;

// What the owner reads. One row per tester; click a row for the tasks and notes.
// The password is asked for once and kept for the tab, never put in the URL.
const RESULTS = `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Results</title>
<style>${PAGE_CSS}
  body { font-size:15px; }
  .wrap { max-width:1000px; padding:32px 20px 120px; }
  h1 { font-size:26px; margin:0 0 4px; }
  input { font:inherit; padding:8px 10px; border:1px solid var(--line); border-radius:8px; width:320px; max-width:100%; }
  button { font:inherit; padding:8px 14px; border-radius:999px; border:1px solid var(--line); background:#fff; cursor:pointer; }
  table { width:100%; border-collapse:collapse; margin:18px 0; background:#fff; border:1px solid var(--line); border-radius:12px; overflow:hidden; }
  th, td { text-align:left; padding:9px 12px; border-bottom:1px solid var(--line); vertical-align:top; }
  th { font-size:12px; letter-spacing:.06em; text-transform:uppercase; color:var(--soft); }
  tr.s { cursor:pointer; } tr.s:hover td { background:#f6f3ee; }
  .ok { color:var(--ok); font-weight:600; } .bad { color:var(--bad); font-weight:600; }
  .bar { display:inline-block; height:8px; background:var(--ok); border-radius:4px; vertical-align:middle; }
  .bar.b { background:var(--bad); }
  .detail { margin:0 0 24px; padding:16px 18px; border:1px solid var(--line); border-radius:12px; background:#fff; }
  .detail h2 { font-size:16px; margin:0 0 8px; } .note { white-space:pre-wrap; }
  .wrapq { display:grid; grid-template-columns:170px 1fr; gap:6px 14px; margin:10px 0 0; }
  .err { color:var(--bad); }
</style></head><body><div class="wrap">
<h1 id="title">Results</h1>
<p class="soft">Each row is one tester. Click a row for the tasks and notes. <span id="sum"></span></p>
<div id="auth"><input id="pw" type="password" placeholder="password" autocomplete="current-password"> <button id="go">Show</button> <span id="msg" class="err"></span></div>
<div id="out"></div>
<script>
(function () {
  var id = location.pathname.split('/')[2] || '';
  var key = 'pgut:pw:' + id;
  var pw = sessionStorage.getItem(key) || '';
  var out = document.getElementById('out'), auth = document.getElementById('auth');
  var sum = document.getElementById('sum'), msg = document.getElementById('msg');
  var titles = {};

  var esc = function (s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); };
  var when = function (t) { return t ? new Date(t).toLocaleString() : ''; };
  var mins = function (s) { return s == null ? '' : Math.floor(s / 60) + 'm ' + (s % 60) + 's'; };

  function get(q) {
    return fetch('/api/results?test=' + encodeURIComponent(id) + (q || ''), { headers: { 'x-test-password': pw } })
      .then(function (r) {
        if (r.status === 401) throw new Error('That password is not right.');
        if (!r.ok) throw new Error('Could not read the results.');
        return r.json();
      });
  }

  // Events are a stream; this folds them back into one row per task, in the
  // order the tester met them, so "where did they get stuck" reads off the page.
  function tasksOf(events) {
    var order = [], by = {};
    events.forEach(function (e) {
      if (!e.task || e.task === 'wrap') return;
      if (!by[e.task]) { by[e.task] = { id: e.task, status: '', secs: null, note: '', hint: false, errors: 0, path: '' }; order.push(e.task); }
      var t = by[e.task];
      if (e.type === 'task_done' || e.type === 'task_skip') {
        t.status = e.type === 'task_done' ? 'done' : 'couldn\\u2019t';
        t.secs = e.data && e.data.secs;
        if (e.note) t.note = e.note;
        if (e.path) t.path = e.path;
      }
      if (e.type === 'hint') t.hint = true;
      if (e.type === 'error') t.errors++;
    });
    return order.map(function (k) { return by[k]; });
  }

  function showSession(row, events) {
    var start = events.filter(function (e) { return e.type === 'start'; })[0] || {};
    var wrap = events.filter(function (e) { return e.type === 'wrap'; }).slice(-1)[0];
    var tasks = tasksOf(events);
    var errs = events.filter(function (e) { return e.type === 'error'; });
    var h = '<div class="detail"><h2>' + esc(row.name || row.id) + ' <span class="soft">\\u00b7 ' +
      esc(when(row.first)) + ' \\u00b7 ' + esc((start.data || {}).viewport || '') + '</span></h2>';
    h += '<table><tr><th>Task</th><th>Result</th><th>Time</th><th>Hint</th><th>Ended on</th><th>Note</th></tr>' +
      tasks.map(function (t) {
        return '<tr><td>' + esc(titles[t.id] || t.id) + '</td>' +
          '<td class="' + (t.status === 'done' ? 'ok' : (t.status ? 'bad' : 'soft')) + '">' + esc(t.status || 'not reached') + '</td>' +
          '<td>' + mins(t.secs) + '</td><td>' + (t.hint ? 'yes' : '') + '</td>' +
          '<td class="soft">' + esc(t.path) + '</td><td class="note">' + esc(t.note) + '</td></tr>';
      }).join('') + '</table>';
    if (wrap && wrap.data) {
      var w = wrap.data;
      h += '<div class="wrapq">' +
        '<span class="soft">Happy with the site</span><span>' + esc(w.happy) + ' / 5</span>' +
        '<span class="soft">Could finish it</span><span>' + esc(w.confident) + '</span>' +
        '<span class="soft">How editing felt</span><span class="note">' + esc(w.feel) + '</span>' +
        '<span class="soft">What confused them</span><span class="note">' + esc(w.confused) + '</span>' +
        '<span class="soft">Minutes</span><span>' + esc(w.minutes) + '</span></div>';
    } else h += '<p class="soft">No wrap-up yet.</p>';
    if (errs.length) h += '<p class="err">' + errs.length + ' script error(s): ' +
      esc(errs.map(function (e) { return e.note; }).join(' \\u00b7 ').slice(0, 400)) + '</p>';
    document.getElementById('d-' + row.id).innerHTML = h + '</div>';
  }

  function load() {
    get('').then(function (d) {
      auth.hidden = true;
      msg.textContent = '';
      sessionStorage.setItem(key, pw);
      document.getElementById('title').textContent = d.subject ? d.subject + ' \\u2014 results' : 'Results';
      (d.tasks || []).forEach(function (t) { titles[t.id] = t.title; });
      var rows = d.sessions || [], done = 0, skipped = 0;
      rows.forEach(function (r) { done += r.done || 0; skipped += r.skipped || 0; });
      sum.textContent = rows.length + ' tester(s), ' + done + ' tasks done, ' + skipped + ' not managed.';
      if (!rows.length) { out.innerHTML = '<p class="soft">Nobody has started yet.</p>'; return; }
      out.innerHTML = '<table><tr><th>When</th><th>Who</th><th>Done</th><th>Couldn\\u2019t</th><th>Wrap-up</th></tr>' +
        rows.map(function (r) {
          return '<tr class="s" data-id="' + esc(r.id) + '"><td>' + esc(when(r.first)) + '</td>' +
            '<td>' + esc(r.name || r.id) + '</td>' +
            '<td><span class="bar" style="width:' + (r.done * 14) + 'px"></span> ' + r.done + '</td>' +
            '<td><span class="bar b" style="width:' + (r.skipped * 14) + 'px"></span> ' + r.skipped + '</td>' +
            '<td>' + (r.wrapped ? 'yes' : '') + '</td></tr>' +
            '<tr><td colspan="5" id="d-' + esc(r.id) + '"></td></tr>';
        }).join('') + '</table>';
      [].slice.call(out.querySelectorAll('tr.s')).forEach(function (tr) {
        tr.addEventListener('click', function () {
          var rid = tr.dataset.id;
          var holder = document.getElementById('d-' + rid);
          if (holder.dataset.busy) return;
          if (holder.innerHTML) { holder.innerHTML = ''; return; }
          var row = rows.filter(function (r) { return r.id === rid; })[0];
          holder.dataset.busy = '1';
          get('&session=' + encodeURIComponent(rid))
            .then(function (d2) { showSession(row, d2.events || []); })
            .then(null, function () { holder.innerHTML = '<p class="err">Could not read that one.</p>'; })
            .then(function () { delete holder.dataset.busy; });
        });
      });
    }).catch(function (e) {
      auth.hidden = false;
      pw = '';
      sessionStorage.removeItem(key);
      msg.textContent = e.message;
    });
  }

  document.getElementById('go').addEventListener('click', function () {
    pw = document.getElementById('pw').value;
    load();
  });
  document.getElementById('pw').addEventListener('keydown', function (ev) {
    if (ev.key === 'Enter') { pw = this.value; load(); }
  });
  if (pw) load();
})();
</script>
</body></html>`;

/* -------------------------------------------------------------------- router */

const TEST_PATH = new RegExp(`^/t/([${ID_ALPHABET}]{6,16})(/blueprint\\.json|/results)?/?$`);

export default {
  async fetch(req, env) {
    const url = new URL(req.url);

    if (url.pathname === '/' || url.pathname === '') {
      return html(HOME, { 'cache-control': 'public, max-age=300' });
    }

    if (url.pathname === '/api/tests') {
      if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
      if (req.method !== 'POST') return json({ error: 'POST only' }, 405, CORS);
      return createTest(env, req);
    }

    if (url.pathname === '/api/events') {
      if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
      if (req.method !== 'POST') return json({ error: 'POST only' }, 405, CORS);
      return appendEvents(env, req);
    }

    if (url.pathname === '/api/results') {
      if (req.method !== 'GET') return json({ error: 'GET only' }, 405);
      return readResults(env, req, url);
    }

    const hit = TEST_PATH.exec(url.pathname);
    if (hit) {
      const [, id, tail] = hit;
      if (tail === '/blueprint.json') return serveBlueprint(env, req, id);
      // The results page is the same HTML for every test; it reads the id out of
      // its own path and asks for the password before anything is fetched.
      if (tail === '/results') return html(RESULTS, { 'cache-control': 'no-store' });
      const test = await getTest(env, id);
      if (!test) return html(NOT_FOUND, { 'cache-control': 'no-store' }, 404);
      return html(introPage(test, url.origin), { 'cache-control': 'public, max-age=300' });
    }

    return html(NOT_FOUND, { 'cache-control': 'no-store' }, 404);
  },
};

const NOT_FOUND = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Nothing here</title><style>${PAGE_CSS}</style></head><body><div class="wrap">
<h1>Nothing here</h1>
<p>That link is wrong, or the test it pointed at has expired. Tests keep themselves for ninety days after the last tester.</p>
<p><a href="/">Make a new one</a></p>
</div></body></html>`;

// exported for the tests
export { cleanEvent, cleanTasks, wrapBlueprint, checkBlueprintUrl, hashPassword, sameSecret, summarise, taskId, makeId, TEST_PATH };
