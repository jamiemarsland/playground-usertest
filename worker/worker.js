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

// Where the tester's card comes from. Every test's blueprint installs whatever
// is at this URL, so the card is updated for everybody by replacing the release
// asset — no redeploy of the service.
const DEFAULT_CARD_ZIP = 'https://github.com/jamiemarsland/playground-usertest/releases/latest/download/playground-usertest-card.zip';
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

// The address the outside world uses, which is not always the one the request
// arrived on. Behind a host that runs the worker on its own internal origin —
// Spacefast's Functions runner does — req.url carries that internal name, and
// every link the service hands out would quietly point at it: tester links,
// the results page, and the report URL baked into each tester's card.
function publicOrigin(req) {
  const url = new URL(req.url);
  const host = req.headers.get('x-forwarded-host') || req.headers.get('host') || '';
  if (!host || /[^a-zA-Z0-9.:-]/.test(host)) return url.origin;
  const proto = (req.headers.get('x-forwarded-proto') || url.protocol.replace(':', '') || 'https').split(',')[0].trim();
  return `${proto === 'http' && host !== 'localhost' && !host.startsWith('localhost:') ? 'https' : proto}://${host}`;
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

/* --------------------------------------------------------------------- store */
// One SQL database behind a D1-shaped binding. That shape is what Spacefast's
// Functions runtime hands a worker when it declares `"database": true`, and it
// is also what Cloudflare D1 gives you — so the same code runs on either, and
// moving hosts is a config change rather than a rewrite.
//
// The SQL is deliberately plain: VARCHAR with lengths (MySQL will not index a
// bare TEXT key), no AUTOINCREMENT, no ON CONFLICT, no CREATE INDEX. Every
// lookup rides a primary key that already covers it.

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS tests (
     id             VARCHAR(16)  NOT NULL PRIMARY KEY,
     created        BIGINT       NOT NULL,
     touched        BIGINT       NOT NULL,
     expires        BIGINT       NOT NULL,
     subject        VARCHAR(120) NOT NULL,
     persona        TEXT         NOT NULL,
     tasks          TEXT         NOT NULL,
     blueprint_url  VARCHAR(600),
     blueprint_json TEXT,
     blueprint_boot TEXT,
     pw_salt        VARCHAR(64)  NOT NULL,
     pw_hash        VARCHAR(64)  NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS sessions (
     test_id  VARCHAR(16) NOT NULL,
     id       VARCHAR(40) NOT NULL,
     first_at BIGINT      NOT NULL,
     last_at  BIGINT      NOT NULL,
     viewport VARCHAR(40),
     name     VARCHAR(120),
     PRIMARY KEY (test_id, id)
   )`,
  // The primary key starts with test_id, so "everything for this test" and
  // "everything for this tester" both read straight off it.
  `CREATE TABLE IF NOT EXISTS events (
     test_id    VARCHAR(16) NOT NULL,
     session_id VARCHAR(40) NOT NULL,
     seq        BIGINT      NOT NULL,
     t          BIGINT      NOT NULL,
     type       VARCHAR(20) NOT NULL,
     task       VARCHAR(48),
     path       VARCHAR(220),
     note       TEXT,
     data       TEXT,
     PRIMARY KEY (test_id, session_id, seq)
   )`,
  `CREATE TABLE IF NOT EXISTS counters (
     k       VARCHAR(160) NOT NULL PRIMARY KEY,
     n       INT          NOT NULL,
     expires BIGINT       NOT NULL
   )`,
];

// Once per database, not once per request — and keyed on the binding rather
// than kept in one module-level variable, so a second database in the same
// isolate gets its own tables instead of inheriting someone else's "done".
const schemaReady = new WeakMap();
function ensureSchema(env) {
  let pending = schemaReady.get(env.DB);
  if (!pending) {
    pending = (async () => {
      for (const sql of SCHEMA) await env.DB.prepare(sql).run();
    })().catch((e) => {
      schemaReady.delete(env.DB); // a failed migration must not be remembered as done
      throw e;
    });
    schemaReady.set(env.DB, pending);
  }
  return pending;
}

// D1 and node:sqlite report a write's row count in different places.
function changed(res) {
  if (!res) return 0;
  if (res.meta && typeof res.meta.changes === 'number') return res.meta.changes;
  if (typeof res.changes === 'number') return res.changes;
  return 0;
}

const q = (env, sql, ...args) => env.DB.prepare(sql).bind(...args);
const all = async (env, sql, ...args) => ((await q(env, sql, ...args).all()).results) || [];
const one = async (env, sql, ...args) => (await q(env, sql, ...args).first()) || null;
const run = (env, sql, ...args) => q(env, sql, ...args).run();

// No ON CONFLICT: update first, insert only if nothing was there. Two round
// trips on the first write of a row, one thereafter, and portable everywhere.
async function upsert(env, updateSql, updateArgs, insertSql, insertArgs) {
  const res = await run(env, updateSql, ...updateArgs);
  if (changed(res) > 0) return;
  try {
    await run(env, insertSql, ...insertArgs);
  } catch (e) {
    // Someone else inserted it between the two statements; the update is now
    // the right thing to have done, so do it.
    await run(env, updateSql, ...updateArgs);
  }
}

/* ------------------------------------------------------------------ counters */
// Best-effort. If the store is unhappy the Worker keeps serving rather than
// going down: the caps exist to stop one address filling the database, not to
// bound a bill.

async function peekCount(env, key) {
  if (!env.DB) return 0;
  try {
    const row = await one(env, 'SELECT n, expires FROM counters WHERE k = ?', key);
    if (!row) return 0;
    if (Number(row.expires) < Date.now()) return 0;
    return Number(row.n) || 0;
  } catch (e) {
    return 0;
  }
}

async function bumpCount(env, key, from, ttl) {
  if (!env.DB) return;
  const expires = Date.now() + ttl * 1000;
  try {
    await upsert(
      env,
      'UPDATE counters SET n = ?, expires = ? WHERE k = ?', [from + 1, expires, key],
      'INSERT INTO counters (k, n, expires) VALUES (?, ?, ?)', [key, from + 1, expires]
    );
  } catch (e) {
    /* out of room, or racing: serve anyway */
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

/* ------------------------------------------------------------------- reading */

function parse(raw, fallback) {
  if (raw == null || raw === '') return fallback;
  try {
    const v = JSON.parse(raw);
    return v == null ? fallback : v;
  } catch (e) {
    return fallback;
  }
}

// A test past its expiry is gone whether or not the sweep has caught up with
// it, so expiry is enforced on read rather than trusted to a cron.
async function getTest(env, id) {
  if (!TEST_ID_RE.test(id) || !env.DB) return null;
  const row = await one(env, 'SELECT * FROM tests WHERE id = ?', id);
  if (!row) return null;
  if (Number(row.expires) < Date.now()) return null;
  return {
    id: row.id,
    created: Number(row.created),
    touched: Number(row.touched),
    subject: row.subject,
    persona: row.persona,
    tasks: parse(row.tasks, []),
    blueprintUrl: row.blueprint_url || '',
    blueprintJson: parse(row.blueprint_json, null),
    blueprintBoot: parse(row.blueprint_boot, null),
    pwSalt: row.pw_salt,
    pwHash: row.pw_hash,
  };
}

function eventRow(r) {
  return {
    t: Number(r.t),
    type: r.type,
    task: r.task || '',
    path: r.path || '',
    note: r.note || '',
    data: parse(r.data, null),
  };
}

async function sessionEvents(env, id, session) {
  const rows = await all(
    env,
    'SELECT * FROM events WHERE test_id = ? AND session_id = ? ORDER BY seq',
    id, session
  );
  return rows.map(eventRow);
}

// One row per tester for the results table: the stored row plus the counts,
// which are an aggregate now rather than a summary written on every event.
async function sessionIndex(env, id, limit) {
  const rows = await all(
    env,
    `SELECT s.test_id, s.id, s.first_at, s.last_at, s.viewport, s.name,
            (SELECT COUNT(*) FROM events e WHERE e.test_id = s.test_id AND e.session_id = s.id) AS n,
            (SELECT COUNT(*) FROM events e WHERE e.test_id = s.test_id AND e.session_id = s.id AND e.type = 'task_done') AS done,
            (SELECT COUNT(*) FROM events e WHERE e.test_id = s.test_id AND e.session_id = s.id AND e.type = 'task_skip') AS skipped,
            (SELECT COUNT(*) FROM events e WHERE e.test_id = s.test_id AND e.session_id = s.id AND e.type = 'wrap') AS wraps
       FROM sessions s
      WHERE s.test_id = ?
      ORDER BY s.first_at DESC`,
    id
  );
  return rows.slice(0, limit || MAX_SESSIONS_PER_TEST).map((r) => ({
    id: r.id,
    first: Number(r.first_at),
    last: Number(r.last_at),
    n: Number(r.n) || 0,
    viewport: r.viewport || '',
    done: Number(r.done) || 0,
    skipped: Number(r.skipped) || 0,
    wrapped: Number(r.wraps) > 0,
    name: r.name || '',
  }));
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

// URLs someone hands us — a blueprint to fetch, a plugin zip to install, a
// photograph to import — all get the same treatment: public https only, no IP
// literals, no localhost, nothing that could point back inside.
function checkPublicUrl(raw, what) {
  let u;
  try {
    u = new URL(String(raw));
  } catch (e) {
    return { error: `That ${what} is not a URL.` };
  }
  if (u.protocol !== 'https:') return { error: `The ${what} has to start with https://.` };
  const host = u.hostname.toLowerCase();
  if (
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host.endsWith('.internal') ||
    host.endsWith('.local') ||
    /^\d{1,3}(\.\d{1,3}){3}$/.test(host) ||
    host.includes(':')
  ) {
    return { error: `The ${what} has to be somewhere public — that host is not.` };
  }
  return { url: u.toString() };
}

function checkBlueprintUrl(raw) {
  return checkPublicUrl(raw, 'blueprint URL');
}

// Unlike the card, this one the service really does have to read: the owner's
// blueprint is wrapped with two more steps before a tester ever sees it, and
// you cannot wrap what you cannot fetch.
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
  const text = await res.text();
  // A host that refuses its own workers outbound fetch answers for the URL
  // rather than letting it answer, so the status says 403 about a file that is
  // sitting there, readable, for anyone else. Saying that plainly matters: the
  // owner would otherwise go and check permissions on a URL that is fine.
  if (!res.ok && (res.status === 403 || res.status === 502) && /egress_denied|outbound fetch/i.test(text)) {
    return { error: 'This service is not allowed to fetch URLs where it is hosted, so it cannot read that blueprint — nothing is wrong with the URL itself. Paste the blueprint JSON instead, or describe the site and let the service build one.' };
  }
  if (!res.ok) return { error: `That blueprint URL answered ${res.status}.` };
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

/* ---------------------------------------------------------------- the check */
// An agent drafting tasks gets two things wrong by default, and both of them
// quietly ruin the test rather than breaking it. This says so before the test
// goes out rather than after five people have sat through it.
//
// Advisory on purpose: it never blocks a create. Someone who means it can
// ignore every word.

const BUTTON_WORDS = /\b(click|press|tap|hit|select|choose|drag|navigate to|go to the|open the)\b/i;

function lintTest(input) {
  const problems = [];
  const notes = [];

  const subject = trim(input && input.subject, LIMITS.subject);
  const persona = trimMultiline(input && input.persona, LIMITS.persona);
  const tasks = cleanTasks(input && input.tasks);
  const boot = input && input.boot && typeof input.boot === 'object' ? input.boot : null;
  const siteName = boot ? trim(boot.title, 60) : '';

  if (!subject) problems.push('Say what is being tested — it is the tester’s first line: “Thank you for helping make X better”.');
  if (!persona) problems.push('There is no persona. The tester needs to know who they are meant to be.');
  if (!tasks.length) problems.push('There is nothing for them to try.');

  // The one that cost a whole round of testing: an Elliot Grey site and an
  // Elliot Smith persona, so "give the site your own name" had nothing to change.
  if (siteName && persona && persona.toLowerCase().includes(siteName.toLowerCase())) {
    problems.push(`The persona is already called ${siteName}, which is the name the demo site carries. Anything about making the site theirs has nothing to change. Give them a different name.`);
  }

  tasks.forEach((task, i) => {
    const hit = task.title.match(BUTTON_WORDS);
    if (hit) {
      problems.push(`Task ${i + 1} says “${hit[0]}” — it is telling them which control to use. Say what they want to end up with; put the control in the hint, where you find out who needed it.`);
    }
    if (/\?\s*$/.test(task.title)) {
      notes.push(`Task ${i + 1} is phrased as a question. Tasks are things to do; the questions come at the end.`);
    }
  });

  const titles = tasks.map((t) => t.title.toLowerCase());
  titles.forEach((t, i) => {
    if (titles.indexOf(t) !== i) problems.push(`Task ${i + 1} repeats an earlier one.`);
  });

  if (tasks.length && tasks.length < 3) notes.push('Two or three tasks rarely tells you much. Five is a good number.');
  if (tasks.length > 7) notes.push(`${tasks.length} tasks is past what most people will sit through. Seven is about the ceiling.`);

  const noHint = tasks.filter((t) => !t.hint).length;
  if (noHint) notes.push(`${noHint} task(s) have no hint. Whether someone opened the hint is the clearest signal in the results — without one you only learn that they failed, not where.`);

  if (persona && persona.length < 120) notes.push('The persona is short. Give them a reason to want the site, not just a job title — people put more care into a site they believe in.');
  if (persona && !/\byou\b/i.test(persona)) notes.push('The persona does not address them as “you”. It reads better in the second person.');

  const summary = tasks.length
    ? `${tasks.length} task(s) for someone testing ${subject || 'something'}:\n` + tasks.map((t, i) => `  ${i + 1}. ${t.title}${t.hint ? '' : '  (no hint)'}`).join('\n')
    : '';

  return { ok: problems.length === 0, problems, notes, summary };
}

/* ------------------------------------------------- a blueprint, without one */
// Most people who want to test something do not have a Playground blueprint,
// and writing one is fiddly in ways that bite quietly — a failed step does not
// stop the boot, it just leaves a hole in the site. So a test can instead
// describe what it wants booted, and the service assembles the blueprint:
//
//   { title, tagline, theme, plugins: [], images: [], pages: [], content }
//
// theme and each plugin are either a wordpress.org slug or an https zip.

const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,60}$/;

function cleanBoot(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return { error: 'boot has to be an object.' };

  const boot = {
    title: trim(input.title, 60) || 'Harbourview',
    tagline: trim(input.tagline, 80),
    content: input.content === 'none' ? 'none' : 'starter',
    plugins: [],
    images: [],
    pages: [],
  };

  // The demo site's own name must not be the name the tester is playing, or
  // "give the site your own name" has nothing to change. The service cannot
  // know the persona here, so lintTest() checks that pairing; this only makes
  // sure there IS a name to change.
  const theme = trim(input.theme, 300) || 'twentytwentyfive';
  if (theme.includes('://')) {
    const checked = checkPublicUrl(theme, 'theme zip');
    if (checked.error) return { error: checked.error };
    boot.theme = checked.url;
  } else {
    if (!SLUG_RE.test(theme)) return { error: 'The theme has to be a wordpress.org slug or an https zip URL.' };
    boot.theme = theme;
  }

  for (const raw of (Array.isArray(input.plugins) ? input.plugins : []).slice(0, 6)) {
    const one = trim(raw, 300);
    if (!one) continue;
    if (one.includes('://')) {
      const checked = checkPublicUrl(one, 'plugin zip');
      if (checked.error) return { error: checked.error };
      boot.plugins.push(checked.url);
    } else {
      if (!SLUG_RE.test(one)) return { error: `"${one}" is not a wordpress.org slug or an https zip URL.` };
      boot.plugins.push(one);
    }
  }

  for (const raw of (Array.isArray(input.images) ? input.images : []).slice(0, 6)) {
    const checked = checkPublicUrl(trim(raw, 500), 'picture URL');
    if (checked.error) return { error: checked.error };
    boot.images.push(checked.url);
  }

  for (const raw of (Array.isArray(input.pages) ? input.pages : []).slice(0, 6)) {
    if (!raw || typeof raw !== 'object') continue;
    const title = trim(raw.title, 60);
    if (!title) continue;
    boot.pages.push({
      title,
      heading: trim(raw.heading, 140),
      text: trimMultiline(raw.text, 1200),
    });
  }

  return { boot };
}

// Everything the boot needs rides inside the step as base64 JSON rather than
// being interpolated into PHP source. Quoting a person's apostrophes into a
// string that is itself inside JSON inside a blueprint is a losing game.
function starterPhp(boot) {
  const data = {
    title: boot.title,
    tagline: boot.tagline,
    images: boot.images,
    pages: boot.pages.length ? boot.pages : defaultPages(boot),
  };
  const b64 = btoa(unescape(encodeURIComponent(JSON.stringify(data))));

  return [
    '<?php',
    "require '/wordpress/wp-load.php';",
    "require_once ABSPATH . 'wp-admin/includes/image.php';",
    'wp_set_current_user( 1 );',
    `$d = json_decode( base64_decode( '${b64}' ), true );`,
    '',
    '// Two traps live here, and both fail silently. media_sideload_image() takes',
    '// the filename from the URL, so a URL ending in an id with no extension is',
    '// refused as an invalid file type; and download_url() streams to a temp file,',
    '// which Playground does not do. Fetch it in one go, name it',
    '// ourselves, attach it by hand.',
    '$ids = array();',
    'foreach ( (array) $d[\'images\'] as $i => $url ) {',
    '\ttry {',
    '\t\t$res = wp_remote_get( $url, array( \'timeout\' => 30 ) );',
    '\t\tif ( is_wp_error( $res ) || 200 !== wp_remote_retrieve_response_code( $res ) ) { continue; }',
    '\t\t$bytes = wp_remote_retrieve_body( $res );',
    '\t\tif ( strlen( $bytes ) < 1000 ) { continue; }',
    '\t\t$put = wp_upload_bits( \'picture-\' . ( $i + 1 ) . \'.jpg\', null, $bytes );',
    '\t\tif ( ! empty( $put[\'error\'] ) ) { continue; }',
    '\t\t$id = wp_insert_attachment( array(',
    '\t\t\t\'post_mime_type\' => \'image/jpeg\',',
    '\t\t\t\'post_title\'     => \'Picture \' . ( $i + 1 ),',
    '\t\t\t\'post_status\'    => \'inherit\',',
    '\t\t), $put[\'file\'] );',
    '\t\tif ( is_wp_error( $id ) || ! $id ) { continue; }',
    '\t\twp_update_attachment_metadata( $id, wp_generate_attachment_metadata( $id, $put[\'file\'] ) );',
    '\t\t$ids[] = $id;',
    '\t} catch ( \\Throwable $e ) {}',
    '}',
    '',
    '$img = function ( $i ) use ( $ids ) {',
    '\tif ( empty( $ids[ $i ] ) ) { return \'\'; }',
    '\t$src = wp_get_attachment_image_url( $ids[ $i ], \'full\' );',
    '\treturn \'<!-- wp:image {"id":\' . $ids[ $i ] . \',"sizeSlug":"full","linkDestination":"none"} -->\'',
    '\t\t. \'<figure class="wp-block-image size-full"><img src="\' . esc_url( $src ) . \'" alt="" class="wp-image-\' . $ids[ $i ] . \'"/></figure>\'',
    '\t\t. \'<!-- /wp:image -->\';',
    '};',
    '',
    '$front = 0;',
    'foreach ( (array) $d[\'pages\'] as $n => $page ) {',
    '\t$blocks = \'\';',
    '\tif ( ! empty( $page[\'heading\'] ) ) {',
    '\t\t$blocks .= \'<!-- wp:heading {"level":1} --><h1 class="wp-block-heading">\' . esc_html( $page[\'heading\'] ) . \'</h1><!-- /wp:heading -->\';',
    '\t}',
    '\tforeach ( preg_split( \'/\\n{2,}/\', (string) $page[\'text\'] ) as $para ) {',
    '\t\t$para = trim( $para );',
    '\t\tif ( \'\' === $para ) { continue; }',
    '\t\t$blocks .= \'<!-- wp:paragraph --><p>\' . esc_html( $para ) . \'</p><!-- /wp:paragraph -->\';',
    '\t}',
    '\tif ( 0 === $n ) {',
    '\t\tforeach ( array_keys( $ids ) as $k ) { $blocks .= $img( $k ); }',
    '\t}',
    '\t$existing = get_page_by_path( sanitize_title( $page[\'title\'] ) );',
    '\t$id = $existing ? $existing->ID : wp_insert_post( array(',
    '\t\t\'post_title\'   => $page[\'title\'],',
    '\t\t\'post_name\'    => sanitize_title( $page[\'title\'] ),',
    '\t\t\'post_content\' => $blocks,',
    '\t\t\'post_status\'  => \'publish\',',
    '\t\t\'post_type\'    => \'page\',',
    '\t) );',
    '\tif ( 0 === $n && ! is_wp_error( $id ) ) { $front = $id; }',
    '}',
    'if ( $front ) {',
    '\tupdate_option( \'show_on_front\', \'page\' );',
    '\tupdate_option( \'page_on_front\', $front );',
    '}',
    '',
    '// Clear the samples WordPress ships, so nobody tidies up before they start.',
    '$hello = get_page_by_path( \'hello-world\', OBJECT, \'post\' );',
    'if ( $hello ) { wp_delete_post( $hello->ID, true ); }',
    '$sample = get_page_by_path( \'sample-page\' );',
    'if ( $sample ) { wp_delete_post( $sample->ID, true ); }',
  ].join('\n');
}

// Filler with a shape to it. Bland copy is its own kind of failure here: a
// tester who does not believe in the site will not put any care into changing
// it, and then the test measures nothing.
function defaultPages(boot) {
  const what = boot.tagline || 'what we do';
  return [
    {
      title: 'Home',
      heading: boot.tagline || boot.title,
      text: `${boot.title} has been going for a few years now, in a small way, and mostly by word of mouth.\n\nThis is the sentence most visitors read first, so it is the one worth getting right.`,
    },
    {
      title: 'About',
      heading: `About ${boot.title}`,
      text: `A few paragraphs about who is behind ${boot.title} and why they started.\n\nPeople read this page more than anyone expects them to.`,
    },
    {
      title: 'Contact',
      heading: 'Get in touch',
      text: `The best way to reach ${boot.title} about ${what}.\n\nhello@example.com`,
    },
  ];
}

function blueprintFromBoot(boot) {
  const steps = [];

  steps.push({
    step: 'installTheme',
    themeData: boot.theme.includes('://')
      ? { resource: 'url', url: boot.theme }
      : { resource: 'wordpress.org/themes', slug: boot.theme },
    options: { activate: true },
  });

  for (const one of boot.plugins) {
    steps.push({
      step: 'installPlugin',
      pluginData: one.includes('://')
        ? { resource: 'url', url: one }
        : { resource: 'wordpress.org/plugins', slug: one },
      options: { activate: true },
    });
  }

  steps.push({
    step: 'setSiteOptions',
    options: { blogname: boot.title, blogdescription: boot.tagline || '' },
  });

  if (boot.content !== 'none') steps.push({ step: 'runPHP', code: starterPhp(boot) });

  return {
    $schema: 'https://playground.wordpress.net/blueprint-schema.json',
    landingPage: '/',
    preferredVersions: { php: '8.2', wp: 'latest' },
    features: { networking: true },
    login: true,
    steps,
  };
}

/* ---------------------------------------------------------------- create a test */

async function createTest(env, req) {
  let body = {};
  try { body = JSON.parse(await req.text()) || {}; } catch (e) { body = {}; }
  return makeTest(env, req, body);
}

// Everything past the parsing, so MCP can hand in a body it already has rather
// than building a Request to feed back to ourselves.
async function makeTest(env, req, body) {
  if (!env.DB) return json({ error: 'The store is not set up yet.' }, 503, CORS);
  await ensureSchema(env);

  // Only a test that actually gets made counts against the day's allowance: a
  // typo in the form, or a blueprint URL that turns out to be wrong, must not
  // cost someone one of their five.
  const cap = parseInt(env.CREATE_DAILY_LIMIT || '5', 10);
  const capKey = `ip:create:${today()}:${ipOf(req)}`;
  const made = await peekCount(env, capKey);
  if (made >= cap) return json({ error: `That is ${cap} tests today from here. Try again tomorrow.` }, 429, CORS);

  // A per-address cap does nothing about agents, which arrive from shared
  // cloud egress by the thousand. This one bounds the store no matter who asks.
  const globalCap = parseInt(env.GLOBAL_CREATE_DAILY_LIMIT || '200', 10);
  const globalKey = `all:create:${today()}`;
  const madeToday = await peekCount(env, globalKey);
  if (madeToday >= globalCap) return json({ error: 'The service has made as many tests as it will today. Try again tomorrow.' }, 429, CORS);

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

  // Three ways to say what the tester's site should be: a URL to fetch each
  // time, JSON pasted once, or a description of what to boot that the service
  // turns into a blueprint itself. All three are checked now, so a broken one
  // is an error here rather than a blank tab for a tester.
  let blueprintUrl = '';
  let blueprintJson = null;
  let blueprintBoot = null;
  const rawUrl = trim(body.blueprintUrl, 500);
  const rawJson = String(body.blueprintJson || '').trim();

  if (body.boot) {
    const checked = cleanBoot(body.boot);
    if (checked.error) return json({ error: checked.error }, 400, CORS);
    blueprintBoot = checked.boot;
  } else if (rawUrl) {
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
    return json({ error: 'Say what the tester should get: a blueprint URL, blueprint JSON, or a boot description.' }, 400, CORS);
  }

  const { salt, hash } = await hashPassword(password);
  const id = makeId();
  const now = Date.now();

  await run(
    env,
    `INSERT INTO tests (id, created, touched, expires, subject, persona, tasks,
                        blueprint_url, blueprint_json, blueprint_boot, pw_salt, pw_hash)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    id, now, now, now + NINETY_DAYS * 1000, subject, persona, JSON.stringify(tasks),
    blueprintUrl || null,
    blueprintJson ? JSON.stringify(blueprintJson) : null,
    blueprintBoot ? JSON.stringify(blueprintBoot) : null,
    salt, hash
  );
  await bumpCount(env, capKey, made, 2 * 24 * 60 * 60);
  await bumpCount(env, globalKey, madeToday, 2 * 24 * 60 * 60);

  const origin = publicOrigin(req);
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

// What a HEAD can tell us about a URL: there, gone, or no idea.
//
// "No idea" is the answer that matters. Playground fetches the card from the
// tester's browser, not from here, so this service being unable to see a URL
// says nothing about whether a tester can. Some hosts refuse the worker
// outbound fetch altogether — Spacefast answers every request with its own 403
// unless the version is granted egress — and reading that as "gone" refused
// every blueprint there for a zip sitting in plain sight.
//
// So only a definite 404 or 410 counts as gone.
async function zipStatus(url) {
  try {
    const res = await fetch(url, {
      method: 'HEAD',
      redirect: 'follow',
      cf: { cacheTtl: 3600, cacheEverything: true },
    });
    if (res.status === 404 || res.status === 410) return 'gone';
    if (res.status < 400) return 'there';
    return 'unknown';
  } catch (e) {
    return 'unknown';
  }
}

// The card the blueprint installs. Defaulted rather than required, so the
// service works on a fresh host with nothing configured; set PLUGIN_ZIP_URL to
// point tests at a different card, or at a copy nearer the host.
function cardZip(env) {
  return env.PLUGIN_ZIP_URL || DEFAULT_CARD_ZIP;
}

async function serveBlueprint(env, req, id) {
  if (!env.DB) return json({ error: 'The store is not set up yet.' }, 503, CORS);
  await ensureSchema(env);
  const test = await getTest(env, id);
  if (!test) return json({ error: 'No such test.' }, 404, CORS);

  let base = test.blueprintJson;
  if (!base && test.blueprintBoot) base = blueprintFromBoot(test.blueprintBoot);
  if (!base) {
    const got = await fetchBlueprint(test.blueprintUrl);
    if (got.error) return json({ error: got.error }, 502, CORS);
    base = got.blueprint;
  }

  const origin = publicOrigin(req);
  const zip = cardZip(env);

  // Serving a blueprint that installs a zip which is not there is the worst
  // thing this service can do: Playground shrugs off the failed step, the
  // tester gets a perfectly good site with no card on it, does the whole test,
  // and nothing is recorded. A HEAD catches that — but only when it can see the
  // answer, so a refusal needs a definite "gone" rather than a failure to look.
  if (await zipStatus(zip) === 'gone') {
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

async function appendEvents(env, req) {
  if (!env.DB) return json({ error: 'The store is not set up yet.' }, 503, CORS);
  await ensureSchema(env);

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

  const now = Date.now();

  // A tester's events are append-only, so a sequence per session is enough to
  // keep them in order — no shared counter, no read-modify-write of a blob.
  const top = await one(
    env,
    'SELECT COUNT(*) AS n, MAX(seq) AS top FROM events WHERE test_id = ? AND session_id = ?',
    id, session
  );
  const have = Number((top && top.n) || 0);
  let seq = Number((top && top.top) || 0);

  if (have >= MAX_EVENTS_PER_SESSION) {
    return json({ ok: true, n: have, full: true }, 200, CORS);
  }
  const room = events.slice(0, MAX_EVENTS_PER_SESSION - have);

  const start = room.find((e) => e.type === 'start');
  const wrapped = room.filter((e) => e.type === 'wrap').slice(-1)[0];
  const viewport = start && start.data ? String(start.data.viewport || '').slice(0, 40) : '';
  const name = wrapped && wrapped.data ? String(wrapped.data.name || '').slice(0, 120) : '';

  const writes = room.map((e) => q(
    env,
    'INSERT INTO events (test_id, session_id, seq, t, type, task, path, note, data) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    id, session, ++seq, e.t, e.type, e.task || null, e.path || null, e.note || null,
    e.data ? JSON.stringify(e.data) : null
  ));
  if (env.DB.batch) await env.DB.batch(writes);
  else for (const w of writes) await w.run();

  // Only overwrite the tester's viewport and name when this batch carried one,
  // or a later batch would wipe what an earlier one learned.
  await upsert(
    env,
    `UPDATE sessions SET last_at = ?,
            viewport = CASE WHEN ? = '' THEN viewport ELSE ? END,
            name     = CASE WHEN ? = '' THEN name     ELSE ? END
      WHERE test_id = ? AND id = ?`,
    [now, viewport, viewport, name, name, id, session],
    'INSERT INTO sessions (test_id, id, first_at, last_at, viewport, name) VALUES (?, ?, ?, ?, ?, ?)',
    [id, session, now, now, viewport, name]
  );

  // Ninety days from the last event, not from the day it was made — but only
  // push the expiry out once a day, so a busy test does not spend a write per
  // batch keeping itself alive.
  if (now - (test.touched || test.created || 0) > TOUCH_AFTER) {
    await run(env, 'UPDATE tests SET touched = ?, expires = ? WHERE id = ?', now, now + NINETY_DAYS * 1000, id);
  }

  return json({ ok: true, n: have + room.length }, 200, CORS);
}

// Clearing a test is part of running one. Every dry run is a row, and the
// advice has always been to empty the store before the real invitations go
// out — which on the old host meant reaching past the service with a CLI. It
// needs to be the service's own job, and the results password is already the
// thing that says who owns a test.
async function deleteTest(env, id) {
  await run(env, 'DELETE FROM events WHERE test_id = ?', id);
  await run(env, 'DELETE FROM sessions WHERE test_id = ?', id);
  await run(env, 'DELETE FROM tests WHERE id = ?', id);
}

/* -------------------------------------------------------------------- digest */
// Raw events are the right thing to keep and the wrong thing to hand back. A
// tester can spend six hundred of them, and nobody — person or agent — reads a
// stream to find out that four people in five gave up on task three. This folds
// the whole test down to one object: per task, how it went, and everything
// anyone typed.

const DIGEST_MAX_SESSIONS = 100;

function median(nums) {
  const xs = nums.filter((n) => typeof n === 'number' && isFinite(n)).sort((a, b) => a - b);
  if (!xs.length) return null;
  const mid = Math.floor(xs.length / 2);
  return xs.length % 2 ? xs[mid] : Math.round((xs[mid - 1] + xs[mid]) / 2);
}

async function buildDigest(env, id, test) {
  const everyone = await sessionIndex(env, id, MAX_SESSIONS_PER_TEST);
  const rows = everyone.slice(0, DIGEST_MAX_SESSIONS);

  const byTask = new Map();
  for (const task of test.tasks) {
    byTask.set(task.id, {
      id: task.id, title: task.title,
      done: 0, couldnt: 0, notReached: 0,
      hintOpened: 0, secs: [], notes: [],
    });
  }

  const wrapUps = [];
  let errors = 0;
  let lastEventAt = 0;

  for (const row of rows) {
    const events = await sessionEvents(env, id, row.id);
    if (!events.length) continue;
    lastEventAt = Math.max(lastEventAt, row.last || 0);

    const who = row.name || row.id;
    const reached = new Set();

    for (const e of events) {
      if (e.type === 'error') { errors++; continue; }
      if (e.type === 'wrap') {
        const d = e.data || {};
        wrapUps.push({
          who,
          happy: d.happy || '', confident: d.confident || '',
          feel: d.feel || '', confused: d.confused || '',
          minutes: d.minutes || 0,
        });
        continue;
      }
      const t = byTask.get(e.task);
      if (!t) continue;
      reached.add(e.task);
      if (e.type === 'hint') t.hintOpened++;
      if (e.type === 'task_done' || e.type === 'task_skip') {
        if (e.type === 'task_done') t.done++; else t.couldnt++;
        if (e.data && typeof e.data.secs === 'number') t.secs.push(e.data.secs);
        if (e.note) t.notes.push({ who, note: e.note, got: e.type === 'task_done' ? 'done' : 'couldn’t', path: e.path || '' });
      }
    }

    // A task nobody started is not the same as one everybody failed, and the
    // difference is usually "they ran out of patience three tasks ago".
    for (const [taskId, t] of byTask) {
      if (!reached.has(taskId)) t.notReached++;
    }
  }

  const tasks = [...byTask.values()].map((t) => ({
    id: t.id, title: t.title,
    done: t.done, couldnt: t.couldnt, notReached: t.notReached,
    hintOpened: t.hintOpened,
    medianSecs: median(t.secs),
    notes: t.notes,
  }));

  return {
    subject: test.subject,
    created: test.created,
    testers: everyone.length,
    counted: rows.length,
    truncated: everyone.length > DIGEST_MAX_SESSIONS,
    lastEventAt,
    finished: wrapUps.length,
    errors,
    tasks,
    wrapUps,
  };
}

/* ------------------------------------------------------------------- results */

// Hash even when there is no such test, so a wrong id and a wrong password take
// the same time and come back saying the same thing: ids cannot be fished for.
async function openTest(env, id, given) {
  if (env.DB) await ensureSchema(env);
  const test = await getTest(env, id);
  const salt = test ? test.pwSalt : '00000000000000000000000000000000';
  const { hash } = await hashPassword(String(given || ''), salt);
  if (!test || !sameSecret(hash, test.pwHash)) return null;
  return test;
}

async function readResults(env, req, url) {
  const id = url.searchParams.get('test') || '';
  const test = await openTest(env, id, req.headers.get('x-test-password') || '');
  if (!test) {
    return json({ error: 'That password is not right.' }, 401, { 'cache-control': 'no-store' });
  }

  if (url.searchParams.get('digest')) {
    return json(await buildDigest(env, id, test), 200, { 'cache-control': 'no-store' });
  }

  const session = url.searchParams.get('session') || '';
  if (session) {
    if (!SESSION_RE.test(session)) return json({ error: 'session' }, 400, { 'cache-control': 'no-store' });
    const events = await sessionEvents(env, id, session);
    return json({ session, events }, 200, { 'cache-control': 'no-store' });
  }

  return json(
    {
      subject: test.subject,
      created: test.created,
      tasks: test.tasks,
      sessions: await sessionIndex(env, id),
    },
    200,
    { 'cache-control': 'no-store' }
  );
}

/* ------------------------------------------------------------------- agents */
// The same three things the form does, as tools an assistant can call: check a
// draft, make the test, read what came back. Nothing here can do anything the
// HTTP routes cannot — it is the same functions underneath — but an agent gets
// told what the arguments mean and gets results in a shape that fits in a
// context window.

const MCP_CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'POST, OPTIONS',
  'access-control-allow-headers': 'content-type, accept, mcp-session-id, mcp-protocol-version, authorization',
  'access-control-expose-headers': 'mcp-session-id',
};

const MCP_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];

const TASKS_SCHEMA = {
  type: 'array',
  description: 'Five to seven things to try, in order. Say what the tester wants to end up with, never which control to use — the control goes in the hint, so you find out who needed it.',
  items: {
    type: 'object',
    properties: {
      title: { type: 'string', description: 'What they are trying to get done, in their words. "Give the site your own name", not "click Settings".' },
      hint: { type: 'string', description: 'Shown only if they ask for it. This is where a control may be named.' },
      why: { type: 'string', description: 'Optional one line of context under the task.' },
    },
    required: ['title'],
  },
};

const BOOT_SCHEMA = {
  type: 'object',
  description: 'What the tester\'s site should be, if you do not already have a Playground blueprint. The service assembles the blueprint from this.',
  properties: {
    title: { type: 'string', description: 'The demo site\'s own name. It must NOT be the name the persona is playing, or tasks about making the site theirs have nothing to change.' },
    tagline: { type: 'string' },
    theme: { type: 'string', description: 'A wordpress.org theme slug, or an https URL to a theme zip. Defaults to twentytwentyfive.' },
    plugins: { type: 'array', items: { type: 'string' }, description: 'Up to six wordpress.org slugs or https zip URLs. This is where the thing being tested usually goes.' },
    images: { type: 'array', items: { type: 'string' }, description: 'Up to six https photographs to put on the front page. A site with no pictures is one nobody believes in, and a tester who does not believe in it will not put care into changing it.' },
    pages: { type: 'array', items: { type: 'object' }, description: 'Optional [{title, heading, text}]. The first is the front page. Leave it out for a readable default.' },
    content: { type: 'string', enum: ['starter', 'none'], description: 'starter builds pages and clears WordPress\'s samples. none leaves a bare site.' },
  },
};

const TOOLS = [
  {
    name: 'usertest_check',
    description: 'Check a draft test before making it. Returns problems worth fixing and softer notes, plus the task list read back. Call it first — two mistakes are easy to make and quietly ruin a test rather than breaking it.',
    inputSchema: {
      type: 'object',
      properties: {
        subject: { type: 'string', description: 'What is being tested. It becomes the tester\'s first line: "Thank you for helping make X better".' },
        persona: { type: 'string', description: 'A paragraph, second person, giving them a reason to want the site — not just a job title.' },
        tasks: TASKS_SCHEMA,
        boot: BOOT_SCHEMA,
      },
      required: ['subject', 'persona', 'tasks'],
    },
  },
  {
    name: 'usertest_create',
    description: 'Make a test. Returns a link to send a tester and a link to read the results, plus the results password — which cannot be recovered, so give it to the person and keep it. Say what the tester should get with EITHER boot, or blueprint_url, or blueprint_json.',
    inputSchema: {
      type: 'object',
      properties: {
        subject: { type: 'string' },
        persona: { type: 'string' },
        tasks: TASKS_SCHEMA,
        boot: BOOT_SCHEMA,
        blueprint_url: { type: 'string', description: 'An https URL to an existing Playground blueprint. Re-read each time a tester starts, so it can keep changing.' },
        blueprint_json: { type: 'string', description: 'A Playground blueprint as a JSON string, kept as-is.' },
        password: { type: 'string', description: 'For the results page. One is made for you if you leave it out.' },
      },
      required: ['subject', 'persona', 'tasks'],
    },
  },
  {
    name: 'usertest_delete',
    description: 'Delete a test and everything testers left on it. Use it to clear dry runs before the real invitations go out — every rehearsal is a row, and it is hard to read ten real testers past your own five attempts. It cannot be undone.',
    inputSchema: {
      type: 'object',
      properties: {
        test: { type: 'string', description: 'The test id from usertest_create.' },
        password: { type: 'string', description: 'The results password from usertest_create.' },
      },
      required: ['test', 'password'],
    },
  },
  {
    name: 'usertest_results',
    description: 'Read what testers did. Returns, per task: how many managed it, how many could not, how many never reached it, the median time, how many opened the hint, and every note anyone typed — plus the wrap-up answers. Testing is slow; expect nothing for a day.',
    inputSchema: {
      type: 'object',
      properties: {
        test: { type: 'string', description: 'The test id from usertest_create.' },
        password: { type: 'string', description: 'The results password from usertest_create.' },
      },
      required: ['test', 'password'],
    },
  },
];

function mcpText(t, extra) {
  return Object.assign({ content: [{ type: 'text', text: t }] }, extra || {});
}

async function mcpCall(env, req, name, args) {
  if (name === 'usertest_check') {
    const r = lintTest(args);
    const lines = [];
    lines.push(r.ok ? 'Nothing blocking.' : 'Worth fixing first:');
    r.problems.forEach((x) => lines.push('- ' + x));
    if (r.notes.length) {
      lines.push(r.ok ? 'Some notes:' : '\nAnd some notes:');
      r.notes.forEach((x) => lines.push('- ' + x));
    }
    if (r.summary) lines.push('\n' + r.summary);
    return mcpText(lines.join('\n'), { structuredContent: r });
  }

  if (name === 'usertest_create') {
    // A password nobody chose is better than no password, and an agent has
    // nowhere sensible to invent one from.
    const password = String((args && args.password) || '') || makeId(16);
    const res = await makeTest(env, req, {
      subject: args && args.subject,
      persona: args && args.persona,
      tasks: args && args.tasks,
      boot: args && args.boot,
      blueprintUrl: args && args.blueprint_url,
      blueprintJson: args && args.blueprint_json,
      password,
    });
    const made = await res.json();
    if (!res.ok) return mcpText(made.error || 'That did not work.', { isError: true, structuredContent: made });

    const out = Object.assign({}, made, { password });
    return mcpText(
      `Made. Send this to a tester:\n${made.tester}\n\n` +
      `Read the results here:\n${made.results}\n\nPassword: ${password}\n\n` +
      'Give the person both links and the password — none of it can be looked up again. ' +
      'The test keeps itself for ninety days after the last tester.',
      { structuredContent: out }
    );
  }

  if (name === 'usertest_delete') {
    const id = String((args && args.test) || '');
    const test = await openTest(env, id, (args && args.password) || '');
    if (!test) return mcpText('That test id and password do not go together.', { isError: true });
    const before = await buildDigest(env, id, test);
    await deleteTest(env, id);
    return mcpText(
      `Deleted ${id}${test.subject ? ` (${test.subject})` : ''}, along with ${before.testers} tester session(s). ` +
      'The tester link and the results page are both gone now.',
      { structuredContent: { ok: true, deleted: id, testers: before.testers } }
    );
  }

  if (name === 'usertest_results') {
    const id = String((args && args.test) || '');
    const test = await openTest(env, id, (args && args.password) || '');
    if (!test) return mcpText('That test id and password do not go together.', { isError: true });
    const d = await buildDigest(env, id, test);
    if (!d.testers) return mcpText(`Nobody has started ${d.subject ? 'the ' + d.subject + ' test' : 'it'} yet.`, { structuredContent: d });

    const lines = [`${d.testers} tester(s), ${d.finished} of them finished.`, ''];
    for (const t of d.tasks) {
      const bits = [`${t.done} done`, `${t.couldnt} couldn’t`];
      if (t.notReached) bits.push(`${t.notReached} never got there`);
      if (t.hintOpened) bits.push(`${t.hintOpened} opened the hint`);
      if (t.medianSecs != null) bits.push(`${t.medianSecs}s median`);
      lines.push(`${t.title} — ${bits.join(', ')}`);
      t.notes.forEach((n) => lines.push(`    "${n.note}" — ${n.who} (${n.got})`));
    }
    if (d.wrapUps.length) {
      lines.push('', 'At the end:');
      d.wrapUps.forEach((w) => lines.push(`  ${w.who}: ${w.happy}/5, could finish: ${w.confident}${w.feel ? `, felt "${w.feel}"` : ''}${w.confused ? `, confused by "${w.confused}"` : ''}`));
    }
    if (d.truncated) lines.push('', `Only the most recent ${DIGEST_MAX_SESSIONS} testers are counted here.`);
    return mcpText(lines.join('\n'), { structuredContent: d });
  }

  return mcpText(`Unknown tool ${name}`, { isError: true });
}

async function mcpMessage(env, req, msg) {
  if (!msg || typeof msg !== 'object' || msg.jsonrpc !== '2.0') {
    return { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid request' } };
  }
  const { id, method, params } = msg;
  if (id === undefined) return null; // a notification: nothing to say back
  const ok = (result) => ({ jsonrpc: '2.0', id, result });
  const err = (code, message) => ({ jsonrpc: '2.0', id, error: { code, message } });
  try {
    if (method === 'initialize') {
      const want = params && params.protocolVersion;
      return ok({
        protocolVersion: MCP_VERSIONS.includes(want) ? want : MCP_VERSIONS[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'playground-usertest', version: '1.0.0' },
        instructions:
          'Sets up a user test of a WordPress theme, plugin or site: the tester opens a link, ' +
          'gets a throwaway WordPress site in their browser with a card of things to try, and what ' +
          'they do comes back here. Draft the persona and tasks with the person, usertest_check them, ' +
          'then usertest_create and hand over both links and the password. Come back later for ' +
          'usertest_results — real testers take days, not minutes.',
      });
    }
    if (method === 'ping') return ok({});
    if (method === 'tools/list') return ok({ tools: TOOLS });
    if (method === 'tools/call') {
      const name = params && params.name;
      if (!TOOLS.some((t) => t.name === name)) return err(-32602, `Unknown tool: ${name}`);
      return ok(await mcpCall(env, req, name, (params && params.arguments) || {}));
    }
    return err(-32601, `Method not found: ${method}`);
  } catch (e) {
    return err(-32603, e.message || String(e));
  }
}

async function handleMcp(req, env) {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: MCP_CORS });
  if (req.method !== 'POST') {
    return json({ error: 'This is an MCP server: POST JSON-RPC here, or add it as a connector in your AI app.' }, 405, Object.assign({ allow: 'POST, OPTIONS' }, MCP_CORS));
  }
  let body;
  try {
    body = await req.json();
  } catch (e) {
    return json({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }, 400, MCP_CORS);
  }
  const batch = Array.isArray(body);
  const out = [];
  for (const msg of batch ? body : [body]) {
    const r = await mcpMessage(env, req, msg);
    if (r) out.push(r);
  }
  if (!out.length) return new Response(null, { status: 202, headers: MCP_CORS });
  return json(batch ? out : out[0], 200, Object.assign({ 'cache-control': 'no-store' }, MCP_CORS));
}

// For agents that read rather than speak MCP. Kept short on purpose: the whole
// service is three calls, and a page of prose would only get skimmed.
const LLMS_TXT = (origin) => `# Playground user testing

User-test a WordPress theme, plugin or site with anyone who has a browser. The
tester opens a link, gets a throwaway WordPress site (WordPress Playground) with
a card of things to try, and what they do comes back here. Nothing to install at
either end, and no accounts.

## As MCP

POST ${origin}/mcp — tools: usertest_check, usertest_create, usertest_results.

## As HTTP

POST ${origin}/api/tests
  { subject, persona, tasks: [{ title, hint }], password,
    boot: { title, tagline, theme, plugins: [], images: [] } }
  -> { id, tester, results }

  Say what the tester gets with ONE of: boot (the service builds the blueprint),
  blueprintUrl (re-read each time), blueprintJson (kept as-is).

GET ${origin}/api/results?test=<id>&digest=1
  header: x-test-password: <the password>
  -> per task: done, couldnt, notReached, hintOpened, medianSecs, notes[]
     plus wrapUps[]. Drop &digest=1 for one row per tester, add
     &session=<id> for one tester's raw events.

DELETE ${origin}/api/results?test=<id>
  header: x-test-password: <the password>
  Clears a test and everything on it. Use it on dry runs before the real
  invitations go out — every rehearsal is a row.

## Two things that quietly ruin a test

- A task that names a control ("click Settings") tests whether they can follow
  an instruction, not whether they can find it. Say what they want to end up
  with; put the control in the hint, which tells you who needed it.
- A persona named after the demo site leaves nothing to change when the task is
  about making the site their own.

usertest_check catches both.

## Pace

Real testers take days. Create, hand over the links, come back later.
`;

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

    if (url.pathname === '/mcp') return handleMcp(req, env);

    if (url.pathname === '/llms.txt') {
      return new Response(LLMS_TXT(publicOrigin(req)), {
        headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'public, max-age=3600' },
      });
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
      if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
      if (req.method === 'DELETE') {
        const id = url.searchParams.get('test') || '';
        const test = await openTest(env, id, req.headers.get('x-test-password') || '');
        if (!test) return json({ error: 'That password is not right.' }, 401, { 'cache-control': 'no-store' });
        await deleteTest(env, id);
        return json({ ok: true, deleted: id }, 200, { 'cache-control': 'no-store' });
      }
      if (req.method !== 'GET') return json({ error: 'GET or DELETE' }, 405);
      return readResults(env, req, url);
    }

    const hit = TEST_PATH.exec(url.pathname);
    if (hit) {
      const [, id, tail] = hit;
      if (tail === '/blueprint.json') return serveBlueprint(env, req, id);
      // The results page is the same HTML for every test; it reads the id out of
      // its own path and asks for the password before anything is fetched.
      if (tail === '/results') return html(RESULTS, { 'cache-control': 'no-store' });
      if (env.DB) await ensureSchema(env);
      const test = await getTest(env, id);
      if (!test) return html(NOT_FOUND, { 'cache-control': 'no-store' }, 404);
      return html(introPage(test, publicOrigin(req)), { 'cache-control': 'public, max-age=300' });
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
export { lintTest, cleanEvent, cleanTasks, ensureSchema, wrapBlueprint, checkBlueprintUrl, checkPublicUrl, cleanBoot, blueprintFromBoot, starterPhp, hashPassword, sameSecret, taskId, makeId, TEST_PATH };
