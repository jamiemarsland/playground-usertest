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
 * One SQL database (env.DB, the space's own):
 *   tests                       one row per test (tasks, persona, blueprint, password hash)
 *   sessions                    one row per tester
 *   events                      one row per thing a tester did
 *   counters                    the rate caps
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

// Who asked, in a form that cannot be read back into an address. The day is in
// the hash, so an allowance resets on its own and yesterday's rows stop
// matching without anything having to sweep them.
async function creatorKey(day, ip) {
  const bytes = new TextEncoder().encode(`${day}:${ip}`);
  return hex(await crypto.subtle.digest('SHA-256', bytes)).slice(0, 32);
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
// One SQL database: the binding Spacefast's Functions runtime hands a worker
// when it declares `"database": true`.
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
     pw_hash        VARCHAR(64)  NOT NULL,
     creator        VARCHAR(64),
     webhook        VARCHAR(600),
     versions       TEXT,
     wording        TEXT,
     tour           TEXT
   )`,
  `CREATE TABLE IF NOT EXISTS sessions (
     test_id  VARCHAR(16) NOT NULL,
     id       VARCHAR(40) NOT NULL,
     first_at BIGINT      NOT NULL,
     last_at  BIGINT      NOT NULL,
     viewport VARCHAR(40),
     name     VARCHAR(120),
     version  VARCHAR(4),
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

const MIGRATIONS = ['ALTER TABLE tests ADD COLUMN creator VARCHAR(64)', 'ALTER TABLE tests ADD COLUMN webhook VARCHAR(600)', 'ALTER TABLE tests ADD COLUMN versions TEXT', 'ALTER TABLE sessions ADD COLUMN version VARCHAR(4)', 'ALTER TABLE tests ADD COLUMN wording TEXT', 'ALTER TABLE tests ADD COLUMN tour TEXT'];

// Once per database, not once per request — and keyed on the binding rather
// than kept in one module-level variable, so a second database in the same
// isolate gets its own tables instead of inheriting someone else's "done".
const schemaReady = new WeakMap();
function ensureSchema(env) {
  let pending = schemaReady.get(env.DB);
  if (!pending) {
    pending = (async () => {
      for (const sql of SCHEMA) await env.DB.prepare(sql).run();
      // Added after the first tables were already in use. ADD COLUMN is the one
      // piece of schema change both engines agree on, and it throws once the
      // column is there — which is the signal that there is nothing to do.
      for (const sql of MIGRATIONS) {
        try { await env.DB.prepare(sql).run(); } catch (e) { /* already applied */ }
      }
    })().catch((e) => {
      schemaReady.delete(env.DB); // a failed migration must not be remembered as done
      throw e;
    });
    schemaReady.set(env.DB, pending);
  }
  return pending;
}

// The live database and node:sqlite report a write's row count in different places.
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
    webhook: row.webhook || '',
    versions: parse(row.versions, null),
    wording: parse(row.wording, null),
    // a tour rather than a test: { button: { label, url } | null }
    tour: parse(row.tour, null),
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
    `SELECT s.test_id, s.id, s.first_at, s.last_at, s.viewport, s.name, s.version,
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
    version: r.version || '',
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
  taskTitle: 200,
  taskWhy: 300,
  taskHint: 300,
  intro: 300,       // one line of the test's own under the persona
  question: 120,    // a closing question in the test's own words
  point: 200,       // a tour step's CSS selector for the thing to click
  actions: 10,      // what one tour step presses by itself
  say: 600,         // what the voice says on a tour step, written to be heard
  buttonLabel: 40,  // the words on the button a tour ends with
  tasksMin: 1,
  tasksMax: 12,
  blueprintBytes: 256 * 1024,
  passwordMin: 6,
  passwordMax: 200,
};

// The four closing questions, in words that suit any test rather than only one
// about building a site. A test can put any of them its own way.
const QUESTION_KEYS = ['happy', 'finish', 'feel', 'confused'];
/* ----------------------------------------------------------------- languages */
// A test or tour can be in another language. The site is set to it (WordPress
// fetches its own translations as the site boots), the card's own words follow
// it, and so does the tester's welcome page. The owner writes the tasks, hints
// and voice script in it themselves. A short code picks the usual locale; any
// WordPress locale works for the site, and these seven also have the card's
// and the welcome page's words.
const LOCALES = { en: 'en_US', fr: 'fr_FR', de: 'de_DE', es: 'es_ES', it: 'it_IT', nl: 'nl_NL', pt: 'pt_BR' };
const LANG_NAMES = { en: 'English', fr: 'French', de: 'German', es: 'Spanish', it: 'Italian', nl: 'Dutch', pt: 'Portuguese' };

function cleanLang(raw) {
  const given = String(raw == null ? '' : raw).trim();
  if (!given) return { lang: '' };
  const m = given.replace('-', '_').match(/^([a-zA-Z]{2,3})(?:_([a-zA-Z]{2}))?(?:_([a-zA-Z0-9]+))?$/);
  if (!m) return { error: `“${given.slice(0, 30)}” is not a language WordPress knows. Use a locale like fr_FR or de_DE, or just fr.` };
  const base = m[1].toLowerCase();
  let lang = m[2] ? `${base}_${m[2].toUpperCase()}` : (LOCALES[base] || base);
  if (m[3]) lang += '_' + m[3].toLowerCase();
  // English is what a site boots in anyway
  if (lang === 'en_US' || lang === 'en') return { lang: '' };
  return { lang };
}

function langKey(lang) {
  const k = String(lang || '').slice(0, 2).toLowerCase();
  return INTRO_WORDS[k] ? k : 'en';
}

// The welcome pages' own words. The buttons they name match the card's.
const INTRO_WORDS = {
  en: {
    x_title: 'Thank you for helping make {subject} better',
    x_lead: 'You are about to get a real WordPress in your browser, already set up, with a small card of things to try. Nobody is watching. There are no wrong answers.',
    who: 'Who you are while you try it', how: 'How it goes',
    x_1: 'Press Start. Give it a minute to build.',
    x_2: 'A small card lists {n} things to try. Do each one your own way, then press Done. If you can’t, press Couldn’t do it. Both are useful. You can drag the card out of the way.',
    x_2_one: 'A small card lists 1 thing to try. Do it your own way, then press Done. If you can’t, press Couldn’t do it. Both are useful. You can drag the card out of the way.',
    x_3: 'At the end there are four quick questions.', x_go: 'Start',
    x_fine: 'Use a computer, not a phone, and Chrome, Edge or Firefox. This WordPress is throwaway: close the tab and it is gone. The only thing kept is what the card learns — which tasks you did, how long they took, which page you were on, and anything you type into it. Nothing else: not what you write in WordPress, and not your name unless you choose to type it.',
    t_title: 'A short tour of {subject}',
    t_lead: 'You are about to get a real WordPress in your browser, already set up, with a small card that shows you round it in {n} steps. You do not have to do anything.',
    t_lead_one: 'You are about to get a real WordPress in your browser, already set up, with a small card that shows you round it in 1 step. You do not have to do anything.',
    t_2: 'Press Start the tour on the card, then sit back. It clicks through each step by itself while a ring shows where. Turn on sound on the card and it reads each step out too.',
    t_3: 'Pause whenever you like and try it yourself, or skip a step. When it is done, the site is yours to keep playing with until you close the tab.',
    t_go: 'Start the tour',
    t_fine: 'Use a computer, not a phone, and Chrome, Edge or Firefox. This WordPress is throwaway: close the tab and it is gone. The only thing kept is which steps you did, how long they took and which page you were on. Nothing you write in WordPress is kept.',
  },
  fr: {
    x_title: 'Merci de nous aider à améliorer {subject}',
    x_lead: 'Vous allez obtenir un vrai WordPress dans votre navigateur, déjà configuré, avec une petite carte de choses à essayer. Personne ne vous regarde. Il n’y a pas de mauvaise réponse.',
    who: 'Qui vous êtes pendant l’essai', how: 'Comment ça se passe',
    x_1: 'Appuyez sur Commencer. Laissez-lui une minute pour se préparer.',
    x_2: 'Une petite carte liste {n} choses à essayer. Faites chacune à votre façon, puis appuyez sur Terminé. Si vous n’y arrivez pas, appuyez sur Je n’ai pas réussi. Les deux sont utiles. Vous pouvez déplacer la carte.',
    x_3: 'À la fin, il y a quatre questions rapides.', x_go: 'Commencer',
    x_fine: 'Utilisez un ordinateur, pas un téléphone, avec Chrome, Edge ou Firefox. Ce WordPress est jetable : fermez l’onglet et il disparaît. Seul est conservé ce que la carte apprend — les tâches faites, le temps passé, la page où vous étiez et ce que vous y écrivez. Rien d’autre : ni ce que vous écrivez dans WordPress, ni votre nom, sauf si vous choisissez de le saisir.',
    t_title: 'Une courte visite de {subject}',
    t_lead: 'Vous allez obtenir un vrai WordPress dans votre navigateur, déjà configuré, avec une petite carte qui vous le fait visiter en {n} étapes. Vous n’avez rien à faire.',
    t_2: 'Appuyez sur Commencer la visite sur la carte, puis installez-vous. Elle parcourt chaque étape toute seule pendant qu’un cercle montre où. Activez le son sur la carte et elle lit aussi chaque étape.',
    t_3: 'Mettez en pause quand vous voulez pour essayer vous-même, ou passez une étape. À la fin, le site est à vous jusqu’à ce que vous fermiez l’onglet.',
    t_go: 'Commencer la visite',
    t_fine: 'Utilisez un ordinateur, pas un téléphone, avec Chrome, Edge ou Firefox. Ce WordPress est jetable : fermez l’onglet et il disparaît. Seules sont conservées les étapes vues, leur durée et la page où vous étiez. Rien de ce que vous écrivez dans WordPress n’est conservé.',
  },
  de: {
    x_title: 'Danke, dass du hilfst, {subject} besser zu machen',
    x_lead: 'Gleich bekommst du ein echtes WordPress in deinem Browser, schon eingerichtet, mit einer kleinen Karte voller Dinge zum Ausprobieren. Niemand schaut zu. Es gibt keine falschen Antworten.',
    who: 'Wer du beim Ausprobieren bist', how: 'So läuft es ab',
    x_1: 'Drück auf Start. Gib ihm eine Minute zum Aufbauen.',
    x_2: 'Eine kleine Karte zeigt {n} Dinge zum Ausprobieren. Mach jedes auf deine Art und drück dann auf Erledigt. Wenn es nicht klappt, drück auf Hat nicht geklappt. Beides hilft. Du kannst die Karte zur Seite ziehen.',
    x_3: 'Am Ende gibt es vier kurze Fragen.', x_go: 'Start',
    x_fine: 'Nutze einen Computer, kein Handy, und Chrome, Edge oder Firefox. Dieses WordPress ist zum Wegwerfen: Schließ den Tab und es ist weg. Gespeichert wird nur, was die Karte erfährt – welche Aufgaben du erledigt hast, wie lange sie gedauert haben, auf welcher Seite du warst und was du in die Karte schreibst. Sonst nichts: nicht, was du in WordPress schreibst, und nicht dein Name, außer du gibst ihn ein.',
    t_title: 'Eine kurze Tour durch {subject}',
    t_lead: 'Gleich bekommst du ein echtes WordPress in deinem Browser, schon eingerichtet, mit einer kleinen Karte, die dich in {n} Schritten herumführt. Du musst nichts tun.',
    t_2: 'Drück auf der Karte auf Tour starten und lehn dich zurück. Sie klickt sich selbst durch jeden Schritt, während ein Kreis zeigt, wo. Schalte auf der Karte den Ton ein, dann liest sie jeden Schritt auch vor.',
    t_3: 'Pausiere jederzeit und probier es selbst, oder überspring einen Schritt. Danach gehört die Website dir, bis du den Tab schließt.',
    t_go: 'Tour starten',
    t_fine: 'Nutze einen Computer, kein Handy, und Chrome, Edge oder Firefox. Dieses WordPress ist zum Wegwerfen: Schließ den Tab und es ist weg. Gespeichert wird nur, welche Schritte du gesehen hast, wie lange sie gedauert haben und auf welcher Seite du warst. Nichts, was du in WordPress schreibst, wird gespeichert.',
  },
  es: {
    x_title: 'Gracias por ayudar a mejorar {subject}',
    x_lead: 'Vas a tener un WordPress real en tu navegador, ya configurado, con una pequeña tarjeta de cosas para probar. Nadie te está mirando. No hay respuestas incorrectas.',
    who: 'Quién eres mientras lo pruebas', how: 'Cómo funciona',
    x_1: 'Pulsa Empezar. Dale un minuto para que se prepare.',
    x_2: 'Una pequeña tarjeta muestra {n} cosas para probar. Haz cada una a tu manera y luego pulsa Hecho. Si no puedes, pulsa No lo conseguí. Las dos respuestas son útiles. Puedes arrastrar la tarjeta para apartarla.',
    x_3: 'Al final hay cuatro preguntas rápidas.', x_go: 'Empezar',
    x_fine: 'Usa un ordenador, no un móvil, con Chrome, Edge o Firefox. Este WordPress es desechable: cierra la pestaña y desaparece. Solo se guarda lo que aprende la tarjeta: qué tareas hiciste, cuánto tardaste, en qué página estabas y lo que escribas en ella. Nada más: ni lo que escribas en WordPress, ni tu nombre, salvo que decidas escribirlo.',
    t_title: 'Un breve recorrido por {subject}',
    t_lead: 'Vas a tener un WordPress real en tu navegador, ya configurado, con una pequeña tarjeta que te lo enseña en {n} pasos. No tienes que hacer nada.',
    t_2: 'Pulsa Empezar el recorrido en la tarjeta y relájate. Recorre cada paso sola mientras un círculo muestra dónde. Activa el sonido en la tarjeta y también leerá cada paso.',
    t_3: 'Pausa cuando quieras y pruébalo tú, o salta un paso. Al terminar, el sitio es tuyo hasta que cierres la pestaña.',
    t_go: 'Empezar el recorrido',
    t_fine: 'Usa un ordenador, no un móvil, con Chrome, Edge o Firefox. Este WordPress es desechable: cierra la pestaña y desaparece. Solo se guarda qué pasos viste, cuánto duraron y en qué página estabas. No se guarda nada de lo que escribas en WordPress.',
  },
  it: {
    x_title: 'Grazie per aiutarci a migliorare {subject}',
    x_lead: 'Stai per avere un vero WordPress nel tuo browser, già configurato, con un piccolo riquadro di cose da provare. Nessuno ti guarda. Non ci sono risposte sbagliate.',
    who: 'Chi sei mentre lo provi', how: 'Come funziona',
    x_1: 'Premi Inizia. Dagli un minuto per prepararsi.',
    x_2: 'Un piccolo riquadro elenca {n} cose da provare. Falle a modo tuo, poi premi Fatto. Se non ci riesci, premi Non ci sono riuscito. Entrambe le risposte sono utili. Puoi trascinare il riquadro da parte.',
    x_3: 'Alla fine ci sono quattro domande veloci.', x_go: 'Inizia',
    x_fine: 'Usa un computer, non un telefono, con Chrome, Edge o Firefox. Questo WordPress è usa e getta: chiudi la scheda e sparisce. Si conserva solo ciò che il riquadro registra: quali attività hai fatto, quanto tempo ci hai messo, in quale pagina eri e ciò che ci scrivi. Nient’altro: né ciò che scrivi in WordPress, né il tuo nome, a meno che tu non scelga di scriverlo.',
    t_title: 'Un breve tour di {subject}',
    t_lead: 'Stai per avere un vero WordPress nel tuo browser, già configurato, con un piccolo riquadro che te lo mostra in {n} passaggi. Non devi fare nulla.',
    t_2: 'Premi Inizia il tour nel riquadro, poi mettiti comodo. Passa da solo per ogni passaggio mentre un cerchio mostra dove. Attiva l’audio nel riquadro e leggerà anche ogni passaggio.',
    t_3: 'Metti in pausa quando vuoi e prova tu, o salta un passaggio. Alla fine il sito è tuo finché non chiudi la scheda.',
    t_go: 'Inizia il tour',
    t_fine: 'Usa un computer, non un telefono, con Chrome, Edge o Firefox. Questo WordPress è usa e getta: chiudi la scheda e sparisce. Si conserva solo quali passaggi hai visto, quanto sono durati e in quale pagina eri. Nulla di ciò che scrivi in WordPress viene conservato.',
  },
  nl: {
    x_title: 'Bedankt dat je helpt {subject} beter te maken',
    x_lead: 'Je krijgt zo een echte WordPress in je browser, al ingericht, met een kleine kaart met dingen om te proberen. Niemand kijkt mee. Er zijn geen foute antwoorden.',
    who: 'Wie je bent terwijl je het probeert', how: 'Zo gaat het',
    x_1: 'Druk op Start. Geef het een minuutje om op te bouwen.',
    x_2: 'Een kleine kaart toont {n} dingen om te proberen. Doe ze elk op je eigen manier en druk dan op Klaar. Lukt het niet, druk dan op Het lukte niet. Allebei nuttig. Je kunt de kaart opzij slepen.',
    x_3: 'Aan het eind zijn er vier korte vragen.', x_go: 'Start',
    x_fine: 'Gebruik een computer, geen telefoon, en Chrome, Edge of Firefox. Deze WordPress is wegwerp: sluit het tabblad en hij is weg. Het enige wat bewaard wordt is wat de kaart leert: welke taken je deed, hoe lang ze duurden, op welke pagina je was en wat je erin typt. Verder niets: niet wat je in WordPress schrijft, en niet je naam, tenzij je die zelf invult.',
    t_title: 'Een korte rondleiding door {subject}',
    t_lead: 'Je krijgt zo een echte WordPress in je browser, al ingericht, met een kleine kaart die je in {n} stappen rondleidt. Je hoeft niets te doen.',
    t_2: 'Druk op de kaart op Rondleiding starten en leun achterover. Hij klikt zelf door elke stap terwijl een cirkel laat zien waar. Zet op de kaart het geluid aan en hij leest elke stap ook voor.',
    t_3: 'Pauzeer wanneer je wilt en probeer het zelf, of sla een stap over. Daarna is de site van jou tot je het tabblad sluit.',
    t_go: 'Rondleiding starten',
    t_fine: 'Gebruik een computer, geen telefoon, en Chrome, Edge of Firefox. Deze WordPress is wegwerp: sluit het tabblad en hij is weg. Alleen welke stappen je zag, hoe lang ze duurden en op welke pagina je was wordt bewaard. Niets wat je in WordPress schrijft wordt bewaard.',
  },
  pt: {
    x_title: 'Obrigado por ajudar a melhorar {subject}',
    x_lead: 'Você vai receber um WordPress de verdade no seu navegador, já configurado, com um pequeno cartão de coisas para experimentar. Ninguém está olhando. Não existem respostas erradas.',
    who: 'Quem você é enquanto experimenta', how: 'Como funciona',
    x_1: 'Toque em Começar. Dê um minuto para ele ser montado.',
    x_2: 'Um pequeno cartão lista {n} coisas para experimentar. Faça cada uma do seu jeito e toque em Feito. Se não conseguir, toque em Não consegui. As duas respostas ajudam. Você pode arrastar o cartão para o lado.',
    x_3: 'No final, há quatro perguntas rápidas.', x_go: 'Começar',
    x_fine: 'Use um computador, não um celular, com Chrome, Edge ou Firefox. Este WordPress é descartável: feche a aba e ele some. Só fica guardado o que o cartão registra: quais tarefas você fez, quanto tempo levaram, em que página você estava e o que você digitar nele. Mais nada: nem o que você escreve no WordPress, nem seu nome, a não ser que você decida digitá-lo.',
    t_title: 'Um tour rápido por {subject}',
    t_lead: 'Você vai receber um WordPress de verdade no seu navegador, já configurado, com um pequeno cartão que mostra tudo em {n} passos. Você não precisa fazer nada.',
    t_2: 'Toque em Começar o tour no cartão e relaxe. Ele passa por cada passo sozinho enquanto um círculo mostra onde. Ative o som no cartão e ele também lê cada passo.',
    t_3: 'Pause quando quiser e tente você mesmo, ou pule um passo. No final, o site é seu até você fechar a aba.',
    t_go: 'Começar o tour',
    t_fine: 'Use um computador, não um celular, com Chrome, Edge ou Firefox. Este WordPress é descartável: feche a aba e ele some. Só ficam guardados quais passos você viu, quanto tempo levaram e em que página você estava. Nada do que você escreve no WordPress é guardado.',
  },
};

// One welcome-page line, in the test's language, with {subject} and {n} filled.
function introWord(lang, key, vars) {
  const words = INTRO_WORDS[langKey(lang)];
  let out = (vars && vars.n === 1 && words[key + '_one']) || words[key] || INTRO_WORDS.en[key];
  Object.keys(vars || {}).forEach((k) => { out = out.split(`{${k}}`).join(String(vars[k])); });
  return out;
}

const DEFAULT_QUESTIONS = {
  happy: 'How happy are you with how it went?',
  finish: 'If you had kept going, could you have finished?',
  feel: 'How did it feel to use?',
  confused: 'What confused you, if anything?',
};

// Text over a limit is refused, not cut. A title trimmed mid-sentence reads to
// the tester as a finished instruction, and nobody finds out until the results.
function overLimits(body) {
  const out = [];
  const len = (v) => String(v == null ? '' : v).trim().length;
  const over = (v, max, what) => {
    if (len(v) > max) out.push(`${what} is ${len(v)} characters; the most is ${max}. Shorten it rather than have it cut off.`);
  };
  if (!body || typeof body !== 'object') return out;
  over(body.subject, LIMITS.subject, 'What is being tested');
  over(body.persona, LIMITS.persona, 'The persona');
  over(body.intro, LIMITS.intro, 'The intro line');
  (Array.isArray(body.tasks) ? body.tasks : []).forEach((t, i) => {
    over(t && t.title, LIMITS.taskTitle, `Task ${i + 1}’s title`);
    over(t && t.hint, LIMITS.taskHint, `Task ${i + 1}’s hint`);
    over(t && t.why, LIMITS.taskWhy, `Task ${i + 1}’s note`);
    over(t && t.point, LIMITS.point, `Task ${i + 1}’s pointer`);
    over(t && t.say, LIMITS.say, `Task ${i + 1}’s spoken words`);
  });
  over(body.button && body.button.label, LIMITS.buttonLabel, 'The button’s words');
  const qs = body.questions && typeof body.questions === 'object' ? body.questions : {};
  QUESTION_KEYS.forEach((k) => over(qs[k], LIMITS.question, `The ${k} question`));
  if (Array.isArray(body.tasks) && body.tasks.length > LIMITS.tasksMax) {
    out.push(`That is ${body.tasks.length} tasks; the most is ${LIMITS.tasksMax}.`);
  }
  return out;
}

// A test's own words for the intro and the closing questions. Only what was
// given is kept, so the defaults above stay the defaults.
function cleanWording(body) {
  const w = {};
  const intro = trim(body && body.intro, LIMITS.intro);
  if (intro) w.intro = intro;
  const raw = body && body.questions && typeof body.questions === 'object' ? body.questions : {};
  const questions = {};
  // a question left as its default is not kept as the test's own, so a
  // better default later reaches it too
  QUESTION_KEYS.forEach((k) => { const v = trim(raw[k], LIMITS.question); if (v && v !== DEFAULT_QUESTIONS[k]) questions[k] = v; });
  if (Object.keys(questions).length) w.questions = questions;
  const lang = cleanLang(body && body.lang).lang;
  if (lang) w.lang = lang;
  return Object.keys(w).length ? w : null;
}

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

// How the service can tell a task really happened, by reading the tester's
// site rather than taking the Done button's word for it. People press Done on
// things they did not manage more often than anyone expects; the site keeps
// count honestly. The card asks the plugin on Done and on Couldn't, and the
// answer rides along with the result.
const CHECKS = {
  site_name: 'The site name changed',
  tagline: 'The tagline changed',
  site_icon: 'A site icon was set',
  logo: 'A logo was set',
  new_page: 'A new page was published',
  new_post: 'A new post was published',
  styles: 'The colours or fonts changed',
  menu: 'The menu changed',
  home: 'The home page changed',
  text: 'Some words appear on the home page',
  // read from the editor in the tester's browser, before anything is saved;
  // made for tours, where a plugin's own block is usually the point
  block: 'A block was added in the editor',
  block_changed: 'A block’s settings changed in the editor',
  // the address of the screen they are on, read in the browser: for a step
  // that is only about getting somewhere, like the Site Editor
  page: 'They reached a screen',
};

const BLOCK_NAME_RE = /^[a-z0-9-]+\/[a-z0-9-]+$/;

// A check in words, with the words or block it looks for.
function checkLabel(c) {
  if (!c || !CHECKS[c.type]) return '';
  return CHECKS[c.type] + (c.text ? ` (“${c.text}”)` : '') + (c.block ? ` (${c.block})` : '') + (c.path ? ` (${c.path})` : '');
}

// A first guess from the task's own words, so most tests are checked without
// anyone choosing anything. Order matters: "tagline" before "name", "menu"
// before "page" (putting a page in the menu is a menu task).
function guessCheck(title) {
  const t = String(title || '').toLowerCase();
  if (/\b(tagline|slogan|strapline|subtitle)\b/.test(t)) return 'tagline';
  if (/\b(site icon|favicon|browser tab icon)\b/.test(t)) return 'site_icon';
  if (/\blogo\b/.test(t)) return 'logo';
  if (/\bsite\b.*\bname\b|\bname\b.*\bsite\b|\bsite title\b|\brename\b/.test(t)) return 'site_name';
  if (/\b(menu|navigation|nav bar)\b/.test(t)) return 'menu';
  if (/\b(colou?rs?|fonts?|typeface|palette|style|look and feel|warmer|cooler|brighter|darker)\b|\b(new|different|fresh|another) look\b/.test(t)) return 'styles';
  if (/\b(blog post|post|article|news)\b/.test(t) && /\b(write|publish|add|post)\b/.test(t)) return 'new_post';
  if (/\bpage\b/.test(t) && /\b(add|create|make|new|build)\b/.test(t) && !/\b(home ?page|front page|this page)\b/.test(t)) return 'new_page';
  if (/\b(home ?page|front page|headline|heading|hero|photos?|photographs?|pictures?|images?|opening hours|button)\b/.test(t)) return 'home';
  return '';
}

// A check as an owner or an agent gave it: a type name, or { type, text }.
// Absent means "guess from the title"; 'none' means "do not check this one".
function cleanCheck(raw, title) {
  if (raw === undefined || raw === null || raw === '') {
    const g = guessCheck(title);
    return g ? { type: g } : null;
  }
  const type = typeof raw === 'string' ? raw : raw && raw.type;
  if (!type || type === 'none' || !CHECKS[type]) return null;
  if (type === 'text') {
    const text = trim(typeof raw === 'object' ? raw.text : '', 120);
    return text ? { type, text } : null;
  }
  if (type === 'block' || type === 'block_changed') {
    const block = trim(typeof raw === 'object' ? raw.block : '', 100).toLowerCase();
    return BLOCK_NAME_RE.test(block) ? { type, block } : null;
  }
  if (type === 'page') {
    const path = trim(typeof raw === 'object' ? raw.path : '', 120);
    return path ? { type, path } : null;
  }
  return { type };
}

// What a tour step does by itself, so nobody has to: press things, type into
// a field, press a key, open a screen, wait. Given as a list of objects, or as
// lines a person can write, one action each:
//
//   button "Styles"                      press it (any pointer works here)
//   click .edit-site-save-hub__button    the same, said out loud
//   type "styles" into input             type into a field
//   press Escape                         Escape, Enter or Tab
//   go /wp-admin/site-editor.php         open a screen on the site
//   wait 2                               seconds, up to ten
//   maybe <any of those>                 pass over it if it is not there
const ACTION_KEYS = ['Escape', 'Enter', 'Tab'];

function parseAction(line) {
  let text = String(line == null ? '' : line).trim();
  if (!text) return null;
  const a = {};
  if (/^maybe\s+/i.test(text)) { a.maybe = true; text = text.replace(/^maybe\s+/i, ''); }
  let m;
  if ((m = text.match(/^go\s+(\/\S*)$/i))) return Object.assign(a, { go: m[1] });
  if (/^go\s/i.test(text)) return null; // only a screen on the site, never another address
  if ((m = text.match(/^press\s+(\w+)$/i))) return Object.assign(a, { key: m[1].charAt(0).toUpperCase() + m[1].slice(1).toLowerCase() });
  if ((m = text.match(/^wait\s+([\d.]+)/i))) return Object.assign(a, { wait: parseFloat(m[1]) });
  if ((m = text.match(/^type\s+"([^"]*)"\s+into\s+(.+)$/i))) return Object.assign(a, { type: m[1], into: m[2] });
  if ((m = text.match(/^click\s+(.+)$/i))) return Object.assign(a, { click: m[1] });
  return Object.assign(a, { click: text });
}

function cleanActions(raw) {
  const list = typeof raw === 'string' ? raw.split('\n') : (Array.isArray(raw) ? raw : []);
  const out = [];
  for (const item of list) {
    if (out.length >= LIMITS.actions) break;
    const a = typeof item === 'string' ? parseAction(item) : (item && typeof item === 'object' ? item : null);
    if (!a) continue;
    const one = {};
    if (typeof a.click === 'string' && trim(a.click, LIMITS.point)) one.click = trim(a.click, LIMITS.point);
    else if (typeof a.type === 'string' && typeof a.into === 'string' && trim(a.into, LIMITS.point)) { one.type = trim(a.type, 120); one.into = trim(a.into, LIMITS.point); }
    else if (typeof a.key === 'string' && ACTION_KEYS.includes(a.key)) one.key = a.key;
    else if (typeof a.go === 'string' && /^\/[^\s<>"]*$/.test(a.go.trim())) one.go = a.go.trim().slice(0, 200);
    else if (typeof a.wait === 'number' && isFinite(a.wait)) one.wait = Math.min(10, Math.max(0.5, a.wait));
    else continue;
    if (a.maybe) one.maybe = true;
    out.push(one);
  }
  return out;
}

// The same actions written back as lines, for the forms.
function actionLines(list) {
  return (list || []).map((a) => (a.maybe ? 'maybe ' : '') + (
    a.click ? a.click : a.into ? `type "${a.type}" into ${a.into}` : a.key ? `press ${a.key}` : a.go ? `go ${a.go}` : `wait ${a.wait}`
  )).join('\n');
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
    // a tour step's words for the voice, longer and looser than the card's
    const say = trim(raw && raw.say, LIMITS.say);
    if (say) task.say = say;
    // a recording of those words, in a real voice, played instead of the
    // browser's; https only, like every other address handed to the service
    const audio = trim(raw && raw.audio, 600);
    if (audio && !checkPublicUrl(audio, 'recording').error) task.audio = checkPublicUrl(audio, 'recording').url;
    // a tour step's pointer: only ever handed to querySelector by the card
    const point = trim(raw && raw.point, LIMITS.point);
    if (point) task.point = point;
    const actions = cleanActions(raw && raw.do);
    if (actions.length) task.do = actions;
    const check = cleanCheck(raw && raw.check, title);
    if (check) task.check = check;
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

// Ready-made task sets for the tests most people want to run. Each is a
// starting point, not a script: the form fills itself from one and the owner
// edits from there. Every task says what the tester wants to end up with (the
// control is in the hint), carries a hint, and is checked against the site
// where the site can show it. Every set passes lintTest clean.
const TASK_SETS = [
  {
    key: 'make-it-yours',
    name: 'Make it yours',
    for: 'A theme, a site builder or a starter site: the first edits anyone makes.',
    persona: 'You make pots in a small studio called Ash & Clay, and people keep asking where they can see your work. A friend set up this site for you to start from. You want it to feel like yours before you send the link to anyone.',
    tasks: [
      { title: 'Give the site your studio’s name', hint: 'Settings → General, or the site title in the header.', check: 'site_name' },
      { title: 'Change the main headline on the home page so it says what you make', hint: 'Edit the home page and type over the big heading.', check: 'home' },
      { title: 'Swap one of the photos on the home page for another', hint: 'Use Replace on the image, then pick a photo from the media library.', check: 'home' },
      { title: 'Give the site colours that feel like your studio', hint: 'Appearance → Editor → Styles.', check: 'styles' },
      { title: 'Add a Contact page with your email address on it', hint: 'Pages → Add New, then Publish.', check: 'new_page' },
      { title: 'See how the home page looks on a phone', hint: 'The device preview at the top of the editor.', check: 'none' },
    ],
  },
  {
    key: 'pages-and-menu',
    name: 'Pages and the menu',
    for: 'Navigation: adding pages and getting them into the menu, which trips up more people than anything else.',
    persona: 'You teach yoga in a village hall called Still Point and you are building a small site for your classes. You have the home page; now you need somewhere for your timetable and your prices, and you want people to find them from the menu.',
    tasks: [
      { title: 'Add a page for your prices', hint: 'Pages → Add New. Give it a title and Publish.', check: 'new_page' },
      { title: 'Put the prices page in the menu at the top of the site', hint: 'Edit the header in the Site Editor and use the menu’s + to add a page link.', check: 'menu' },
      { title: 'Make the prices page the first thing in the menu', hint: 'Drag the menu item, or use the arrows on its toolbar.', check: 'menu' },
      { title: 'Change the words of one menu item so they are shorter', hint: 'Edit the menu item’s label in the header.', check: 'menu' },
      { title: 'See the menu on a phone and make sure the prices page is there', hint: 'The device preview at the top of the editor.', check: 'none' },
    ],
  },
  {
    key: 'write-a-post',
    name: 'Write a post',
    for: 'Blogging and the editor: writing, a picture, a category, and getting it on the site.',
    persona: 'You write about food from your allotment, and you have finally started a blog called Second Helpings so you stop losing your recipes in notebooks. Today you want to get your first proper post up.',
    tasks: [
      { title: 'Write a short post about something you cooked this week and publish it', hint: 'Posts → Add New, then Publish.', check: 'new_post' },
      { title: 'Put a picture in the middle of the post', hint: 'The + in the editor, then Image.', check: 'none' },
      { title: 'Give the post a picture that shows on the blog page', hint: 'Featured image, in the post settings on the right.', check: 'none' },
      { title: 'Put the post in a category called Recipes', hint: 'Categories, in the post settings on the right.', check: 'none' },
      { title: 'Find your post on the site as a visitor would', hint: 'View post, or the site’s blog page.', check: 'none' },
    ],
  },
  {
    key: 'brand-the-site',
    name: 'Brand the site',
    for: 'Site identity: the name, tagline, logo and the little icon in the browser tab.',
    persona: 'You run a bike repair workshop called Spoke & Chain. Your nephew made you a logo and you want the site to look like the sign above your door, from the name in the header to the icon in the browser tab.',
    tasks: [
      { title: 'Give the site your workshop’s name', hint: 'Settings → General, or the site title in the header.', check: 'site_name' },
      { title: 'Give the site a tagline that says what you do', hint: 'Settings → General, or the tagline block in the header.', check: 'tagline' },
      { title: 'Put your logo in the header', hint: 'The site logo block in the header. Any picture will do for the test.', check: 'logo' },
      { title: 'Give the site its own little icon for the browser tab', hint: 'Site icon, in Settings → General or the site logo block’s settings.', check: 'site_icon' },
      { title: 'Change the words at the bottom of every page to your opening hours', hint: 'Edit the footer in the Site Editor.', check: 'home' },
    ],
  },
  {
    key: 'build-a-page',
    name: 'Build a page from scratch',
    for: 'Page building: a blank page, the pieces people reach for first, and publishing it.',
    persona: 'You organise a small craft fair called The Saturday Market, twice a year in the town hall. You need one page that tells people when it is, what they will find, and how to get a stall.',
    tasks: [
      { title: 'Make a new page for the next market and publish it', hint: 'Pages → Add New, then Publish.', check: 'new_page' },
      { title: 'Give the page a big heading with the date of the market', hint: 'The + in the editor, then Heading.', check: 'none' },
      { title: 'Add a photo under the heading', hint: 'The + in the editor, then Image.', check: 'none' },
      { title: 'Put text and a picture side by side', hint: 'The Columns block, or Media & Text.', check: 'none' },
      { title: 'Add a button people can use to email you about a stall', hint: 'The Buttons block. A mailto: link works.', check: 'none' },
      { title: 'Look at the published page as a visitor would', hint: 'View page, after publishing.', check: 'none' },
    ],
  },
  {
    key: 'set-up-a-shop',
    name: 'Set up a shop',
    for: 'WooCommerce: a product, a sale and the shop in the menu. Your blueprint needs WooCommerce installed.',
    needs: 'woocommerce',
    persona: 'You make candles at your kitchen table and sell them at markets under the name Wick & Wax. People keep asking if they can buy online, so you are setting up a small shop before the Christmas fairs.',
    tasks: [
      { title: 'Add a product: a large candle for £18', hint: 'Products → Add New. The price is under Product data.', check: 'none' },
      { title: 'Give the product a photo', hint: 'Product image, on the right of the product screen.', check: 'none' },
      { title: 'Put one product on sale for a lower price', hint: 'Sale price, under Product data.', check: 'none' },
      { title: 'Make sure people can find the shop from the menu', hint: 'Edit the header and add a link to the Shop page.', check: 'menu' },
      { title: 'Buy something as a customer would, up to the payment step', hint: 'View the shop, Add to cart, then the cart and checkout.', check: 'none' },
    ],
  },
];

// Ready-made tours. A tour plays itself: the hint is what the card says, and
// each step presses through its own actions while people watch. The steps of
// this one are a starting place for a release showcase, to be rewritten for
// each release. Its selectors were checked against the Site Editor of the day.
const TOUR_SETS = [
  {
    key: 'whats-new',
    mode: 'tour',
    name: 'What’s new in WordPress',
    for: 'A release showcase. A starting point: rewrite the steps for whatever the next release brings.',
    persona: 'Anyone who runs a site on WordPress and wants to see what it can do now.',
    button: { label: 'Read the release post', url: 'https://wordpress.org/news/' },
    tasks: [
      { title: 'The Site Editor', hint: 'Everything about how your site looks lives in one place: the Site Editor.', point: '#wp-admin-bar-site-editor > a',
        say: 'Let’s start in the Site Editor. This is where everything about how your site looks lives, from the header right down to the footer. I’ll open it for you.',
        do: ['#wp-admin-bar-site-editor > a'], check: { type: 'page', path: 'site-editor.php' } },
      { title: 'Find anything with ⌘K', hint: 'Press ⌘K anywhere to find a screen or a setting by name. Here it looks for Styles.', point: '#wp-admin-bar-command-palette > .ab-item',
        say: 'Here’s a shortcut worth knowing. Press Command K, or Control K on Windows, and you can jump to any screen or setting just by typing its name. Watch, I’ll look for Styles.',
        do: ['#wp-admin-bar-command-palette > .ab-item', 'type "styles" into .commands-command-menu input || [cmdk-input]', 'wait 1.5', 'press Escape'], check: 'none' },
      { title: 'A new look in one click', hint: 'Styles has ready-made looks. One click changes the colours and fonts across the whole site.', point: '.global-styles-ui-variations_item:not(.is-active) || button "Browse styles" || button "Styles"',
        say: 'Styles is where the look of the whole site comes together. These are ready-made styles. Pick one and the colours and fonts change everywhere at once. I’ll choose one and save it.',
        do: ['button "Styles"', 'button "Browse styles"', '.global-styles-ui-variations_item:not(.is-active)', '.edit-site-save-hub__button || button "Save"', 'maybe .editor-entities-saved-states__save-button'], check: 'styles' },
      { title: 'Fonts that go together', hint: 'Typography has pairs of fonts chosen to work together. Pick one and every heading and paragraph follows.', point: 'button "Typography"',
        say: 'Fonts work the same way. Under Typography there are pairs of fonts chosen to go well together. One click, and every heading and paragraph on the site follows. Let’s try one.',
        do: ['maybe [aria-label="Back"]', 'button "Typography"', '.global-styles-ui-variations_item:not(.is-active)', '.edit-site-save-hub__button || button "Save"', 'maybe .editor-entities-saved-states__save-button'], check: 'styles' },
      { title: 'Every page in one list', hint: 'Pages lists everything on your site. Sort it, filter it, and open any page to edit it right here.', point: 'button "Pages"',
        say: 'Last stop, your pages. I’ll step back out of the editor with the button at the top left, then open Pages. Every page on the site is in this one list. You can sort it, filter it, and open any page to edit it from right here.',
        do: ['go /wp-admin/site-editor.php?p=%2Fpage', 'wait 2'], check: { type: 'page', path: 'p=%2Fpage' } },
    ],
  },
];
const ALL_SETS = TASK_SETS.concat(TOUR_SETS);

// A tour's colours. An accent (any hex colour: a brand purple, say) and a
// dark or light card. The accent fills the card's buttons and colours its
// edge, the ring and the pointer's halo; what goes on it (ink) and the shade
// used for words on the card (text) are worked out here so both can be read.
// An accent too pale or too dark for words on the card keeps its own colour
// for buttons and gets a readable shade for words, and the check says so.
const DEFAULT_ACCENT = '#7cf2b0';
const CARD_BG = { dark: '#16181c', light: '#ffffff' };

function hex6(v) {
  const t = String(v || '').trim().toLowerCase();
  if (/^#[0-9a-f]{6}$/.test(t)) return t;
  if (/^#[0-9a-f]{3}$/.test(t)) return '#' + t.slice(1).split('').map((c) => c + c).join('');
  return '';
}

function luminance(hex) {
  const n = parseInt(hex.slice(1), 16);
  const lin = (c) => { c /= 255; return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); };
  return 0.2126 * lin((n >> 16) & 255) + 0.7152 * lin((n >> 8) & 255) + 0.0722 * lin(n & 255);
}

function contrast(a, b) {
  const x = luminance(a), y = luminance(b);
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

// The accent moved toward black or white, a step at a time, until it can be read.
function readableOn(accent, bg, need) {
  const toward = luminance(bg) > 0.5 ? 0 : 255;
  const n = parseInt(accent.slice(1), 16);
  let rgb = [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  let out = accent;
  for (let i = 0; i < 20 && contrast(out, bg) < need; i++) {
    rgb = rgb.map((c) => Math.round(c + (toward - c) * 0.12));
    out = '#' + rgb.map((c) => c.toString(16).padStart(2, '0')).join('');
  }
  return out;
}

function cleanTheme(raw) {
  if (!raw || typeof raw !== 'object') return { theme: null };
  const given = raw.accent === undefined || raw.accent === '' ? DEFAULT_ACCENT : hex6(raw.accent);
  if (!given) return { error: `The accent colour has to be a hex colour, like #6b3fa0; “${String(raw.accent).slice(0, 30)}” is not.` };
  const card = raw.card === 'light' ? 'light' : 'dark';
  const bg = CARD_BG[card];
  const ink = contrast(given, '#0e0f12') >= contrast(given, '#ffffff') ? '#0e0f12' : '#ffffff';
  const text = readableOn(given, bg, 4.5);
  return { theme: { accent: given, card, ink, text }, adjusted: text !== given };
}

// Whether a draft is a tour, and the button it ends with. A tour made from a
// ready-made tour set is a tour without saying so; its button fills in too.
function readTour(body, set) {
  const isTour = (body && body.mode === 'tour') || (!(body && body.mode) && set && set.mode === 'tour');
  if (!isTour) return { tour: null };
  const raw = body && body.button && typeof body.button === 'object' ? body.button : (set && set.button) || null;
  // a recording of the closing words, if the tour has its own voice
  const endRaw = trim((body && body.endAudio) || (set && set.endAudio), 600);
  const endAudio = endRaw && !checkPublicUrl(endRaw, 'recording').error ? checkPublicUrl(endRaw, 'recording').url : '';
  const themed = cleanTheme((body && body.theme) || (set && set.theme));
  if (themed.error) return { error: themed.error };
  const withEnd = (tour) => Object.assign(tour, endAudio ? { endAudio } : {}, themed.theme ? { theme: themed.theme } : {});
  if (!raw || (!trim(raw.label, 100) && !trim(raw.url, 600))) return { tour: withEnd({ button: null }) };
  const label = trim(raw.label, LIMITS.buttonLabel);
  if (!label) return { error: 'The button at the end needs some words, like “Get the plugin”.' };
  const checked = checkPublicUrl(trim(raw.url, 600), 'button’s link');
  if (checked.error) return { error: checked.error };
  return { tour: withEnd({ button: { label, url: checked.url } }) };
}

const BUTTON_WORDS = /\b(click|press|tap|hit|select|choose|drag|navigate to|go to the|open the)\b/i;

// A test in another language: the site and the card follow it, but a step
// that finds what to press by its words ("button \"Styles\"") only finds it
// if those words are written in the site's language too.
function lintLang(input, tasks, problems, notes) {
  const langed = cleanLang(input && input.lang);
  if (langed.error) { problems.push(langed.error); return; }
  const lang = langed.lang;
  if (!lang) return;
  const key = lang.slice(0, 2);
  const name = LANG_NAMES[key] || lang;
  if (!INTRO_WORDS[key]) notes.push(`The site will be in ${lang}, but the card and the welcome page only have their own words in ${Object.values(LANG_NAMES).join(', ')}, so theirs stay in English. Your tasks and hints show as you write them.`);
  const worded = [];
  tasks.forEach((t, i) => {
    const said = [t.point].concat((t.do || []).map((a) => a && (a.click || a.into || ''))).filter(Boolean);
    if (said.some((x) => /"[^"]+"/.test(String(x)))) worded.push(i + 1);
  });
  if (worded.length) notes.push(`Step${worded.length === 1 ? '' : 's'} ${worded.join(', ')} find${worded.length === 1 ? 's' : ''} what to press by the words on it, like button "Styles". On a site in ${name} those words are in ${name} too, so write them as WordPress shows them in ${name}, or use a selector that does not depend on words (an id or a class).`);
  notes.push(`Write the titles, hints and anything said out loud in ${name}: the card shows them as they are. The browser reads them in a ${name} voice where the computer has one; a recording (audio) in ${name} sounds better.`);
}

function lintTest(input) {
  const problems = [];
  const notes = [];

  const subject = trim(input && input.subject, LIMITS.subject);
  const set = ALL_SETS.find((x) => x.key === (input && (input.task_set || input.taskSet)));
  const persona = trimMultiline(input && input.persona, LIMITS.persona) || (set ? set.persona : '');
  const tasks = cleanTasks(input && Array.isArray(input.tasks) && input.tasks.length ? input.tasks : (set ? set.tasks : []));
  const boot = input && input.boot && typeof input.boot === 'object' ? input.boot : null;
  const siteName = boot ? trim(boot.title, 60) : '';

  overLimits(input).forEach((x) => problems.push(x));
  lintLang(input, tasks, problems, notes);
  const toured = readTour(input, set);
  if (toured.error) problems.push(toured.error);
  if (toured.tour) return lintTour(input, subject, tasks, toured.tour, problems, notes);
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

  (Array.isArray(input && input.tasks) ? input.tasks : []).forEach((raw, i) => {
    const c = raw && raw.check;
    const type = typeof c === 'string' ? c : c && c.type;
    if (type && type !== 'none' && !CHECKS[type]) problems.push(`Task ${i + 1} asks for a check called “${type}”, which there is not. The checks are: ${Object.keys(CHECKS).join(', ')}, or none.`);
    if (type === 'text' && !(c && c.text)) problems.push(`Task ${i + 1} checks for words on the home page but does not say which words.`);
    if (type === 'page' && !(c && String(c.path || '').trim())) problems.push(`Task ${i + 1} checks for a screen but does not say which: give part of its address, like “site-editor.php”.`);
  });
  const unchecked = tasks.filter((t) => !t.check).length;
  // only worth saying when nothing at all is checked: a task like "write a
  // few sentences about yourself" has nothing the site can show, and that is fine
  if (tasks.length && unchecked === tasks.length) notes.push('No task has a check, so you only have the tester’s word that they managed. Where the site can show it (a name, a page, the colours), give it a check.');

  const summary = tasks.length
    ? `${tasks.length} task(s) for someone testing ${subject || 'something'}:\n` + tasks.map((t, i) => `  ${i + 1}. ${t.title}${t.hint ? '' : '  (no hint)'}${t.check ? `  [checked: ${checkLabel(t.check).toLowerCase()}]` : '  [not checked]'}`).join('\n')
    : '';

  return { ok: problems.length === 0, problems, notes, summary };
}

// A tour is checked the other way round. Naming the button is right here: the
// tour presses it. What goes wrong is a step with nothing to say, a tour that
// only talks, and a step that presses things nobody checks happened.
function lintTour(input, subject, tasks, tour, problems, notes) {
  if (!subject) problems.push('Say what the tour shows — it heads the welcome page: “A short tour of X”.');
  if (!tasks.length) problems.push('There are no steps.');
  tasks.forEach((task, i) => {
    if (!task.hint) problems.push(`Step ${i + 1} has nothing to say. In a tour the hint is what the card says while the step plays: what this shows, and why it is good.`);
  });
  const titles = tasks.map((t) => t.title.toLowerCase());
  titles.forEach((t, i) => { if (titles.indexOf(t) !== i) problems.push(`Step ${i + 1} repeats an earlier one.`); });
  (Array.isArray(input && input.tasks) ? input.tasks : []).forEach((raw, i) => {
    const c = raw && raw.check;
    const type = typeof c === 'string' ? c : c && c.type;
    if (type && type !== 'none' && !CHECKS[type]) problems.push(`Step ${i + 1} asks for a check called “${type}”, which there is not. The checks are: ${Object.keys(CHECKS).join(', ')}, or none.`);
    if (type === 'text' && !(c && c.text)) problems.push(`Step ${i + 1} checks for words on the home page but does not say which words.`);
    if ((type === 'block' || type === 'block_changed') && !(c && BLOCK_NAME_RE.test(String(c.block || '').toLowerCase()))) problems.push(`Step ${i + 1} checks a block but does not name it the way WordPress does, like “core/heading” or “my-plugin/my-block”.`);
    if (type === 'page' && !(c && String(c.path || '').trim())) problems.push(`Step ${i + 1} checks for a screen but does not say which: give part of its address, like “site-editor.php”.`);
  });
  if (tasks.length > 6) notes.push(`${tasks.length} steps is a long tour. Most people stop somewhere around five.`);
  if (tasks.length && tasks.every((t) => !t.do)) notes.push('No step does anything by itself, so the tour only talks. Give steps their clicks (do) and it presses through them while people watch.');
  if (tasks.some((t) => t.do && !t.check)) notes.push('A step that presses things but has no check carries on whether it worked or not. Where the site or the editor can show it (the colours, a page, your block), give it a check.');
  if (tour.theme && tour.theme.text !== tour.theme.accent) notes.push(`The accent ${tour.theme.accent} is hard to read as words on a ${tour.theme.card} card, so the card’s words use ${tour.theme.text} instead. Buttons, the ring and the pointer keep ${tour.theme.accent}.`);
  if (!tour.button) notes.push('There is no button at the end. Say what they should do once they have seen it: “Get the plugin”, “Read the release post”.');
  const summary = tasks.length
    ? `A tour of ${subject || 'something'} in ${tasks.length} step(s):\n` + tasks.map((t, i) => `  ${i + 1}. ${t.title}${t.do ? `  [presses ${t.do.length} thing(s) by itself]` : '  [only talks]'}${t.check ? `  [checked: ${checkLabel(t.check).toLowerCase()}]` : ''}${t.point ? '  [points at ' + t.point + ']' : ''}`).join('\n') +
      (tour.button ? `\n  Ends with a button: ${tour.button.label} → ${tour.button.url}` : '') +
      (tour.theme ? `\n  Colours: ${tour.theme.accent} on a ${tour.theme.card} card` : '')
    : '';
  return { ok: problems.length === 0, problems, notes, summary, mode: 'tour' };
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
  return makeTest(env, req, sameAsPaste(body));
}

// The prompt gives assistants one shape for both ways of finishing: pasted
// into the form, or sent here. That shape is the tools' (blueprint_url,
// task_set, a blueprint as an object), so it is read here too.
function sameAsPaste(body) {
  const out = Object.assign({}, body);
  if (out.blueprintUrl == null && out.blueprint_url != null) out.blueprintUrl = out.blueprint_url;
  if (out.blueprintJson == null && out.blueprint_json != null) out.blueprintJson = out.blueprint_json;
  if (out.blueprintJson == null && out.blueprint != null) out.blueprintJson = out.blueprint;
  if (out.blueprintJson && typeof out.blueprintJson === 'object') out.blueprintJson = JSON.stringify(out.blueprintJson);
  if (out.taskSet == null && out.task_set != null) out.taskSet = out.task_set;
  // most people have no blueprint: name the plugin or theme (a wordpress.org
  // slug or a zip link), or ask for WordPress itself, and the service builds it
  const plugins = [].concat(out.plugin || [], out.plugins || []).filter(Boolean);
  if (!out.boot && !out.blueprintUrl && !out.blueprintJson && (plugins.length || out.theme || out.site === 'wordpress')) {
    out.boot = { plugins, theme: typeof out.theme === 'string' ? out.theme : undefined, title: out.site_title || undefined };
  }
  return out;
}

// Everything past the parsing, so MCP can hand in a body it already has rather
// than building a Request to feed back to ourselves.
// Three ways to say what the tester's site should be: a URL to fetch each
// time, JSON pasted once, or a description of what to boot that the service
// turns into a blueprint itself. All three are checked now, so a broken one is
// an error here rather than a blank tab for a tester. Used once per version.
async function readSiteSpec(body) {
  let blueprintUrl = '';
  let blueprintJson = null;
  let blueprintBoot = null;
  const rawUrl = trim(body.blueprintUrl, 500);
  const rawJson = String(body.blueprintJson || '').trim();

  if (body.boot) {
    const checked = cleanBoot(body.boot);
    if (checked.error) return { error: checked.error };
    blueprintBoot = checked.boot;
  } else if (rawUrl) {
    const checked = checkBlueprintUrl(rawUrl);
    if (checked.error) return { error: checked.error };
    const got = await fetchBlueprint(checked.url);
    if (got.error) return { error: got.error };
    blueprintUrl = checked.url;
  } else if (rawJson) {
    if (rawJson.length > LIMITS.blueprintBytes) return { error: 'That blueprint is too big.' };
    try {
      const parsed = JSON.parse(rawJson);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return { error: 'The pasted blueprint is not a JSON object.' };
      }
      blueprintJson = parsed;
    } catch (e) {
      return { error: 'The pasted blueprint is not valid JSON.' };
    }
  } else {
    return { error: 'Say what the tester should get: a blueprint URL, blueprint JSON, or a boot description.' };
  }
  return { blueprintUrl, blueprintJson, blueprintBoot };
}

const VERSION_KEYS = ['a', 'b', 'c'];

async function makeTest(env, req, body) {
  if (!env.DB) return json({ error: 'The store is not set up yet.' }, 503, CORS);
  await ensureSchema(env);

  // The allowance counts tests that EXIST, not creates that once happened. A
  // typo in the form never cost anyone a slot, and now neither does a dry run
  // they have since cleared up — which matters, because the advice is to make a
  // few rehearsals and delete them before inviting anybody.
  const day = today();
  const creator = await creatorKey(day, ipOf(req));
  const cap = parseInt(env.CREATE_DAILY_LIMIT || '5', 10);
  const mine = await one(env, 'SELECT COUNT(*) AS n FROM tests WHERE creator = ?', creator);
  if (Number((mine && mine.n) || 0) >= cap) {
    return json({ error: `That is ${cap} tests today from here, and they are all still live. Delete one you have finished with, or try again tomorrow.` }, 429, CORS);
  }

  // A per-address cap does nothing about agents, which arrive from shared cloud
  // egress by the thousand. This one bounds the store no matter who asks.
  const globalCap = parseInt(env.GLOBAL_CREATE_DAILY_LIMIT || '200', 10);
  const since = Date.parse(day + 'T00:00:00Z');
  const everyone = await one(env, 'SELECT COUNT(*) AS n FROM tests WHERE created >= ?', since);
  if (Number((everyone && everyone.n) || 0) >= globalCap) {
    return json({ error: 'The service has made as many tests as it will today. Try again tomorrow.' }, 429, CORS);
  }

  const tooLong = overLimits(body);
  if (tooLong.length) return json({ error: tooLong.join(' '), problems: tooLong }, 400, CORS);

  const subject = trim(body.subject, LIMITS.subject);
  const langed = cleanLang(body.lang);
  if (langed.error) return json({ error: langed.error }, 400, CORS);
  const wording = cleanWording(body);
  // a ready-made set fills whatever was left out: the tasks, the persona
  const set = ALL_SETS.find((x) => x.key === body.taskSet);
  const persona = trimMultiline(body.persona, LIMITS.persona) || (set ? set.persona : '');
  const tasks = cleanTasks(Array.isArray(body.tasks) && body.tasks.length ? body.tasks : (set ? set.tasks : []));
  const password = String(body.password || '');
  // a tour has no persona to play (they are themselves), only who it is for
  const toured = readTour(body, set);
  if (toured.error) return json({ error: toured.error }, 400, CORS);
  const tour = toured.tour;

  if (!subject) return json({ error: tour ? 'Say what the tour shows — it heads the welcome page.' : 'Say what is being tested — it goes in the tester’s thank-you line.' }, 400, CORS);
  if (!persona && !tour) return json({ error: 'Write a paragraph about who the tester should pretend to be.' }, 400, CORS);
  if (tasks.length < LIMITS.tasksMin) return json({ error: 'Give the tester at least one thing to try.' }, 400, CORS);
  if (password.length < LIMITS.passwordMin || password.length > LIMITS.passwordMax) {
    return json({ error: `The results password has to be at least ${LIMITS.passwordMin} characters.` }, 400, CORS);
  }
  let webhook = '';
  const rawHook = trim(body.webhook, 600);
  if (rawHook) {
    const checked = checkPublicUrl(rawHook, 'webhook');
    if (checked.error) return json({ error: checked.error }, 400, CORS);
    webhook = checked.url;
  }

  // One site, or two or three versions of it to compare: the same tasks on
  // each, with testers shared out evenly by one link.
  let blueprintUrl = '';
  let blueprintJson = null;
  let blueprintBoot = null;
  let versions = null;
  if (Array.isArray(body.versions) && body.versions.length) {
    if (body.versions.length < 2 || body.versions.length > VERSION_KEYS.length) {
      return json({ error: `To compare, give two or three versions — that was ${body.versions.length}.` }, 400, CORS);
    }
    versions = [];
    for (let i = 0; i < body.versions.length; i++) {
      const v = body.versions[i] || {};
      const spec = await readSiteSpec(v);
      const label = trim(v.label, 60) || `Version ${VERSION_KEYS[i].toUpperCase()}`;
      if (spec.error) return json({ error: `${label}: ${spec.error}` }, 400, CORS);
      versions.push(Object.assign({ key: VERSION_KEYS[i], label }, spec));
    }
    ({ blueprintUrl, blueprintJson, blueprintBoot } = versions[0]);
  } else {
    const spec = await readSiteSpec(body);
    if (spec.error) return json({ error: spec.error }, 400, CORS);
    ({ blueprintUrl, blueprintJson, blueprintBoot } = spec);
  }

  const { salt, hash } = await hashPassword(password);
  const id = makeId();
  const now = Date.now();

  await run(
    env,
    `INSERT INTO tests (id, created, touched, expires, subject, persona, tasks,
                        blueprint_url, blueprint_json, blueprint_boot, pw_salt, pw_hash, creator, webhook, versions, wording, tour)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    id, now, now, now + NINETY_DAYS * 1000, subject, persona, JSON.stringify(tasks),
    blueprintUrl || null,
    blueprintJson ? JSON.stringify(blueprintJson) : null,
    blueprintBoot ? JSON.stringify(blueprintBoot) : null,
    salt, hash, creator, webhook || null,
    versions ? JSON.stringify(versions) : null,
    wording ? JSON.stringify(wording) : null,
    tour ? JSON.stringify(tour) : null
  );

  const origin = publicOrigin(req);
  return json({
    id, tester: `${origin}/t/${id}`, results: `${origin}/t/${id}/results`,
    checks: tasks.map((t) => ({ title: t.title, check: checkLabel(t.check) })),
    mode: tour ? 'tour' : 'test',
    button: tour && tour.button ? tour.button : undefined,
    theme: tour && tour.theme ? tour.theme : undefined,
    lang: (wording && wording.lang) || undefined,
    webhook: webhook ? hookKind(webhook) : '',
    versions: versions ? versions.map((v) => ({ key: v.key, label: v.label })) : undefined,
  }, 200, CORS);
}

/* ------------------------------------------------------- the wrapped blueprint */

// The owner's blueprint plus the two steps that make it a test: install the card
// plugin, and hand it the test id, the tasks and where to report. Their own steps
// run first so the card lands on a site that is already set up.
function wrapBlueprint(base, test, origin, pluginZipUrl, version) {
  const out = Object.assign({}, base);
  const steps = Array.isArray(base.steps) ? base.steps.slice() : [];

  // Networking is what lets the card reach this Worker from inside the sandbox.
  out.features = Object.assign({}, base.features, { networking: true });

  // The card only shows to someone logged in, and nobody should have to log
  // in to take a test or watch a tour. A blueprint that does not log them in
  // itself gets Playground's own login added.
  const logsIn = base.login || steps.some((st) => st && st.step === 'login');
  if (!logsIn) out.login = true;

  // the site in the test's language, after the owner's own steps so their
  // plugins and theme get their translations too
  const lang = test.wording && test.wording.lang;
  if (lang) steps.push({ step: 'setSiteLanguage', language: lang });

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
        // a compared test's tester reports under the version they were given,
        // so the card needs to know nothing about versions
        report: `${origin}/api/events${version ? `?v=${version}` : ''}`,
        subject: test.subject,
        tasks: test.tasks,
        // only a test's own closing questions; the card has neutral defaults
        questions: (test.wording && test.wording.questions) || undefined,
        mode: test.tour ? 'tour' : undefined,
        button: test.tour && test.tour.button ? test.tour.button : undefined,
        endAudio: test.tour && test.tour.endAudio ? test.tour.endAudio : undefined,
        theme: test.tour && test.tour.theme ? test.tour.theme : undefined,
        lang: lang || undefined,
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

// Recording a tour: the draft from the form (or an assistant), opened in
// Playground with the card in record mode, so the maker does each step and the
// card writes down what they pressed. Nothing is stored: the whole blueprint
// rides in the link, and the finished tour comes back through the clipboard.
async function recordLink(env, req) {
  let body = {};
  try { body = sameAsPaste(JSON.parse(await req.text()) || {}); } catch (e) { body = {}; }
  const tooLong = overLimits(body);
  if (tooLong.length) return json({ error: tooLong.join(' ') }, 400, CORS);
  const spec = await readSiteSpec(body);
  if (spec.error) return json({ error: spec.error }, 400, CORS);
  let base = spec.blueprintJson || (spec.blueprintBoot ? blueprintFromBoot(spec.blueprintBoot) : null);
  if (!base && spec.blueprintUrl) {
    const got = await fetchBlueprint(spec.blueprintUrl);
    if (got.error) return json({ error: got.error + ' Paste the blueprint JSON instead.' }, 400, CORS);
    base = got.blueprint;
  }
  const langed = cleanLang(body.lang);
  if (langed.error) return json({ error: langed.error }, 400, CORS);
  const toured = readTour(Object.assign({}, body, { mode: 'tour' }), null);
  if (toured.error) return json({ error: toured.error }, 400, CORS);
  let tasks = cleanTasks(body.tasks);
  // a tour with no steps yet is recorded as one, to be named in the form
  if (!tasks.length) tasks = cleanTasks([{ title: 'Step 1' }]);
  const test = { id: 'record', subject: trim(body.subject, LIMITS.subject) || 'my plugin', tasks, tour: toured.tour, wording: langed.lang ? { lang: langed.lang } : null };
  const bp = wrapBlueprint(base, test, publicOrigin(req), cardZip(env), null);
  const opts = bp.steps.find((x) => x && x.step === 'setSiteOptions');
  const cfg = JSON.parse(opts.options.playground_user_test);
  cfg.mode = 'record';
  opts.options.playground_user_test = JSON.stringify(cfg);
  return json({ link: 'https://playground.wordpress.net/#' + btoa(unescape(encodeURIComponent(JSON.stringify(bp)))) }, 200, CORS);
}

// The ready-made What's new tour, for the home page's Watch a tour: nothing to
// make or store, so the whole blueprint rides in the Playground link itself.
// It carries the recorded voice the set alone does not, since a recording only
// fits the words it was made from.
const DEMO_VOICE = 'https://raw.githubusercontent.com/jamiemarsland/playground-usertest/main/voice/whats-new-v4-';

function demoTourLink(origin, zip) {
  const set = TOUR_SETS.find((x) => x.key === 'whats-new');
  const tasks = cleanTasks(set.tasks.map((t, i) => Object.assign({}, t, { audio: `${DEMO_VOICE}${i + 1}.mp3` })));
  const tour = Object.assign(readTour({}, set).tour, { endAudio: `${DEMO_VOICE}end.mp3` });
  const base = {
    $schema: 'https://playground.wordpress.net/blueprint-schema.json',
    landingPage: '/',
    preferredVersions: { php: '8.3', wp: 'latest' },
    steps: [],
  };
  const bp = wrapBlueprint(base, { id: 'demo-whats-new', subject: set.name, tasks, tour }, origin, zip, null);
  return 'https://playground.wordpress.net/#' + btoa(unescape(encodeURIComponent(JSON.stringify(bp))));
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

  // which version: ?v= on the link the intro page handed out
  const wantV = new URL(req.url).searchParams.get('v') || '';
  const ver = test.versions ? (test.versions.find((v) => v.key === wantV) || test.versions[0]) : null;
  const site = ver || test;

  let base = site.blueprintJson;
  if (!base && site.blueprintBoot) base = blueprintFromBoot(site.blueprintBoot);
  if (!base) {
    const got = await fetchBlueprint(site.blueprintUrl);
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

  const wrapped = wrapBlueprint(base, test, origin, zip, ver ? ver.key : '');
  return json(wrapped, 200, Object.assign({ 'cache-control': 'public, max-age=60' }, CORS));
}

/* -------------------------------------------------------------------- events */

// A tour reports with the same events: task_done carries how the step moved on
// (by itself, or Next), wrap marks the end, and cta is the button at the end.
const EVENT_TYPES = ['start', 'task_start', 'task_done', 'task_skip', 'hint', 'error', 'wrap', 'note', 'cta'];
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

async function appendEvents(env, req, ctx) {
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
  const vParam = new URL(req.url).searchParams.get('v') || '';
  const version = test.versions && test.versions.some((v) => v.key === vParam) ? vParam : '';
  const name = wrapped && wrapped.data ? String(wrapped.data.name || '').slice(0, 120) : '';

  // the wrap-up is the finish line: tell the owner's channel, once per tester
  const wasWrapped = wrapped && test.webhook
    ? Number(((await one(env, "SELECT COUNT(*) AS n FROM events WHERE test_id = ? AND session_id = ? AND type = 'wrap'", id, session)) || {}).n || 0) > 0
    : true;

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
            name     = CASE WHEN ? = '' THEN name     ELSE ? END,
            version  = CASE WHEN ? = '' THEN version  ELSE ? END
      WHERE test_id = ? AND id = ?`,
    [now, viewport, viewport, name, name, version, version, id, session],
    'INSERT INTO sessions (test_id, id, first_at, last_at, viewport, name, version) VALUES (?, ?, ?, ?, ?, ?, ?)',
    [id, session, now, now, viewport, name, version || null]
  );

  // Ninety days from the last event, not from the day it was made — but only
  // push the expiry out once a day, so a busy test does not spend a write per
  // batch keeping itself alive.
  if (now - (test.touched || test.created || 0) > TOUCH_AFTER) {
    await run(env, 'UPDATE tests SET touched = ?, expires = ? WHERE id = ?', now, now + NINETY_DAYS * 1000, id);
  }

  if (wrapped && test.webhook && !wasWrapped) {
    const posting = announceFinish(env, test, session, publicOrigin(req));
    if (ctx && ctx.waitUntil) ctx.waitUntil(posting); else await posting;
  }

  return json({ ok: true, n: have + room.length }, 200, CORS);
}

/* ------------------------------------------------------------------ webhooks */
// The owner can leave a Slack or Discord channel (or any address that takes a
// JSON POST) when they make a test, and each tester who finishes is posted
// there: who, what they managed, what the site showed, the four answers, and
// the results link. Never the password. A webhook that fails is let go: the
// results page is the record, the post is only a nudge.

function hookKind(url) {
  const host = new URL(url).hostname;
  if (host === 'hooks.slack.com') return 'slack';
  if (/(^|\.)discord(app)?\.com$/.test(host)) return 'discord';
  return 'json';
}

function finishSummary(test, events, origin) {
  if (test.tour) return tourSummary(test, events, origin);
  const titles = new Map(test.tasks.map((t) => [t.id, t.title]));
  const wrap = (events.filter((e) => e.type === 'wrap').slice(-1)[0] || {}).data || {};
  const lines = [];
  const tasks = [];
  for (const t of test.tasks) {
    const ends = events.filter((e) => e.task === t.id && (e.type === 'task_done' || e.type === 'task_skip'));
    const last = ends.slice(-1)[0];
    const hint = events.some((e) => e.task === t.id && e.type === 'hint');
    const site = last && last.data && (last.data.check === 'yes' || last.data.check === 'no') ? last.data.check : '';
    const got = !last ? 'not reached' : last.type === 'task_done' ? 'done' : 'couldn’t';
    tasks.push({ title: t.title, result: got, site, hint, note: last && last.note ? last.note : '' });
    let mark = got === 'done' ? '✓' : got === 'couldn’t' ? '✗' : '·';
    let tail = '';
    if (site === 'no' && got === 'done') tail = ' (said done, but the site did not change)';
    if (site === 'yes' && got === 'couldn’t') tail = ' (but the site changed)';
    if (hint) tail += ' · opened the hint';
    lines.push(`${mark} ${titles.get(t.id)}${tail}`);
    if (last && last.note) lines.push(`    “${String(last.note).slice(0, 200)}”`);
  }
  const who = String(wrap.name || '').trim() || 'A tester';
  const results = `${origin}/t/${test.id}/results`;
  const answers = [
    wrap.happy ? `happy with how it went: ${wrap.happy}/5` : '',
    wrap.confident ? `could have finished: ${wrap.confident}` : '',
    wrap.feel ? `felt: “${String(wrap.feel).slice(0, 200)}”` : '',
    wrap.confused ? `confused by: “${String(wrap.confused).slice(0, 200)}”` : '',
    wrap.minutes ? `${wrap.minutes} min` : '',
  ].filter(Boolean);
  const head = `${who} finished the ${test.subject} test.`;
  const text = [head, '', ...lines, '', ...answers, '', `Results: ${results}`].join('\n');
  return { head, text, tasks, wrap: { name: wrap.name || '', happy: wrap.happy || '', confident: wrap.confident || '', feel: wrap.feel || '', confused: wrap.confused || '', minutes: wrap.minutes || 0 }, results };
}

// The end of a tour: which steps moved on by themselves, which needed Next and
// which were skipped. There are no answers to report.
function tourSummary(test, events, origin) {
  const lines = [];
  const tasks = [];
  for (const t of test.tasks) {
    const last = events.filter((e) => e.task === t.id && (e.type === 'task_done' || e.type === 'task_skip')).slice(-1)[0];
    const how = !last ? 'not reached' : last.type === 'task_skip' ? 'skipped' : (last.data && (last.data.how === 'auto' || last.data.how === 'played')) ? 'moved on by itself' : 'pressed Next';
    tasks.push({ title: t.title, result: how });
    lines.push(`${how === 'skipped' ? '↷' : how === 'not reached' ? '·' : '✓'} ${t.title} (${how})`);
  }
  const results = `${origin}/t/${test.id}/results`;
  const head = `Someone finished the ${test.subject} tour.`;
  const text = [head, '', ...lines, '', `Tour numbers: ${results}`].join('\n');
  return { head, text, tasks, wrap: {}, results };
}

async function announceFinish(env, test, session, origin) {
  try {
    const events = await sessionEvents(env, test.id, session);
    const s = finishSummary(test, events, origin);
    const kind = hookKind(test.webhook);
    const body = kind === 'slack' ? { text: s.text }
      : kind === 'discord' ? { content: s.text.slice(0, 1990) }
      : { type: 'tester_finished', test: test.id, subject: test.subject, session, text: s.text, tasks: s.tasks, wrap: s.wrap, results: s.results };
    const ctl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const timer = ctl ? setTimeout(() => ctl.abort(), 8000) : null;
    await fetch(test.webhook, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: ctl ? ctl.signal : undefined, redirect: 'manual' });
    if (timer) clearTimeout(timer);
  } catch (e) {}
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

// How many tests have been taken: a tester counts once they have done or given
// up on at least one task, so someone who opened the link and left does not.
// The service grew out of an earlier one-off tester, whose 147 testers count
// too; their results live in that service, not here.
const EARLIER_TESTS = 147;
async function testsTaken(env) {
  if (!env.DB) return EARLIER_TESTS;
  await ensureSchema(env);
  const row = await one(
    env,
    // a tour is not a test, so its visitors are not counted here
    "SELECT COUNT(*) AS n FROM (SELECT DISTINCT test_id, session_id FROM events WHERE type IN ('task_done', 'task_skip') AND test_id NOT IN (SELECT id FROM tests WHERE tour IS NOT NULL)) taken"
  );
  return EARLIER_TESTS + Number((row && row.n) || 0);
}

// A tester who has not been heard from in this long, and has not answered the
// closing questions, has most likely stopped. The card reports on every task
// and hint, so half an hour of silence is a long time on one task.
const STILL_WORKING_MS = 30 * 60 * 1000;

function testerStatus(row, now) {
  if (row.wrapped) return 'finished';
  return now - row.last < STILL_WORKING_MS ? 'working' : 'stopped';
}

function median(nums) {
  const xs = nums.filter((n) => typeof n === 'number' && isFinite(n)).sort((a, b) => a - b);
  if (!xs.length) return null;
  const mid = Math.floor(xs.length / 2);
  return xs.length % 2 ? xs[mid] : Math.round((xs[mid - 1] + xs[mid]) / 2);
}

async function buildDigest(env, id, test, only) {
  // only: one version of a compared test (its testers, nobody else's)
  const everyone = (await sessionIndex(env, id, MAX_SESSIONS_PER_TEST)).filter((r) => !only || r.version === only);
  const rows = everyone.slice(0, DIGEST_MAX_SESSIONS);

  const byTask = new Map();
  for (const task of test.tasks) {
    byTask.set(task.id, {
      id: task.id, title: task.title,
      done: 0, couldnt: 0, notReached: 0,
      hintOpened: 0, secs: [], notes: [],
      check: checkLabel(task.check),
      shown: 0, notShown: 0, didAnyway: 0,
      // for a tour: moved on by itself, or Next; and who stopped on this step
      auto: 0, next: 0, stoppedHere: 0, onItNow: 0,
    });
  }

  const wrapUps = [];
  let errors = 0;
  let lastEventAt = 0;
  let ctaPresses = 0;
  const now = Date.now();

  // Every event for the test in one query, then split by tester here. A query
  // per tester read the same rows and cost a round trip each, and it put the
  // digest over the fifty-queries-per-invocation limit somewhere around the
  // forty-eighth tester — which is to say, exactly when a test went well.
  const wanted = new Set(rows.map((r) => r.id));
  const everything = await all(
    env,
    'SELECT session_id, t, type, task, path, note, data FROM events WHERE test_id = ? ORDER BY session_id, seq',
    id
  );
  const bySession = new Map();
  for (const r of everything) {
    if (!wanted.has(r.session_id)) continue;
    if (!bySession.has(r.session_id)) bySession.set(r.session_id, []);
    bySession.get(r.session_id).push(eventRow(r));
  }

  for (const row of rows) {
    const events = test.tour ? lastRunOnly(bySession.get(row.id) || []) : (bySession.get(row.id) || []);
    if (!events.length) continue;
    lastEventAt = Math.max(lastEventAt, row.last || 0);

    const who = row.name || row.id;
    const reached = new Set();
    const ended = new Set();
    let pressed = false;

    for (const e of events) {
      if (e.type === 'error') { errors++; continue; }
      if (e.type === 'cta') { pressed = true; continue; }
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
        ended.add(e.task);
        if (e.type === 'task_done') t.done++; else t.couldnt++;
        if (e.type === 'task_done' && e.data && (e.data.how === 'auto' || e.data.how === 'played')) t.auto++;
        if (e.type === 'task_done' && e.data && e.data.how === 'next') t.next++;
        // what the site said, when the task had a check: yes, no or unknown
        const seen = e.data && e.data.check;
        if (e.type === 'task_done' && seen === 'yes') t.shown++;
        if (e.type === 'task_done' && seen === 'no') t.notShown++;
        if (e.type === 'task_skip' && seen === 'yes') t.didAnyway++;
        if (e.data && typeof e.data.secs === 'number') t.secs.push(e.data.secs);
        if (e.note) t.notes.push({ who, note: e.note, got: e.type === 'task_done' ? 'done' : 'couldn’t', site: seen === 'yes' || seen === 'no' ? seen : '', path: e.path || '' });
      }
    }

    // A task nobody started is not the same as one everybody failed, and the
    // difference is usually "they ran out of patience three tasks ago".
    for (const [taskId, t] of byTask) {
      if (!reached.has(taskId)) t.notReached++;
      // where an unfinished visitor is: gone quiet on it, or still on it
      else if (!ended.has(taskId) && !row.wrapped) {
        if (testerStatus(row, now) === 'stopped') t.stoppedHere++; else t.onItNow++;
      }
    }
    if (pressed) ctaPresses++;
  }

  const tasks = [...byTask.values()].map((t) => ({
    id: t.id, title: t.title,
    done: t.done, couldnt: t.couldnt, notReached: t.notReached,
    hintOpened: t.hintOpened,
    medianSecs: median(t.secs),
    check: t.check,
    shown: t.shown, notShown: t.notShown, didAnyway: t.didAnyway,
    notes: t.notes,
    ...(test.tour ? { auto: t.auto, next: t.next, skipped: t.couldnt, stoppedHere: t.stoppedHere, onItNow: t.onItNow } : {}),
  }));

  const happies = wrapUps.map((w) => Number(w.happy)).filter((n) => n >= 1 && n <= 5);
  return {
    subject: test.subject,
    created: test.created,
    happyAvg: happies.length ? Math.round(happies.reduce((a, b) => a + b, 0) / happies.length * 10) / 10 : null,
    couldFinish: { yes: wrapUps.filter((w) => w.confident === 'yes').length, maybe: wrapUps.filter((w) => w.confident === 'maybe').length, no: wrapUps.filter((w) => w.confident === 'no').length },
    testers: everyone.length,
    counted: rows.length,
    // finished, still going, or gone quiet before the end: the drop-off
    status: everyone.reduce((acc, r) => { acc[testerStatus(r, Date.now())]++; return acc; }, { finished: 0, working: 0, stopped: 0 }),
    truncated: everyone.length > DIGEST_MAX_SESSIONS,
    lastEventAt,
    finished: wrapUps.length,
    errors,
    tasks,
    wrapUps: test.tour ? [] : wrapUps,
    ...(test.tour ? { mode: 'tour', button: test.tour.button || null, buttonPresses: ctaPresses } : {}),
  };
}

// Someone can watch a tour twice (Start over). Each step counts once per
// person, as it went the last time they reached it.
function lastRunOnly(events) {
  const last = new Map();
  events.forEach((e, i) => { if (e.type === 'task_done' || e.type === 'task_skip') last.set(e.task, i); });
  return events.filter((e, i) => !((e.type === 'task_done' || e.type === 'task_skip') && last.get(e.task) !== i));
}

// A compared test: the whole digest once per version, side by side.
async function compareDigest(env, id, test) {
  const out = [];
  for (const v of test.versions) {
    const d = await buildDigest(env, id, test, v.key);
    out.push(Object.assign({ key: v.key, label: v.label }, d));
  }
  return out;
}

// Small numbers lie: say so plainly when the groups are too small to trust.
function compareCaution(versions) {
  const ns = versions.map((v) => v.testers);
  const fewest = Math.min(...ns);
  if (fewest < 8) return `With ${ns.join(' and ')} testers, a difference of one or two people is noise. Read the notes before deciding anything.`;
  return '';
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

// Fixing a typo should not cost new links and a new password. Wording can
// always change; the shape of the test only until somebody has started it,
// because results are kept per task and a task that moved would take another
// task's answers with it. Tasks are matched by position, and keep their ids.
async function updateTest(env, test, body) {
  const tooLong = overLimits(body);
  if (tooLong.length) return { status: 400, body: { error: tooLong.join(' '), problems: tooLong } };

  const has = (k) => body && Object.prototype.hasOwnProperty.call(body, k);
  const subject = has('subject') ? trim(body.subject, LIMITS.subject) : test.subject;
  const persona = has('persona') ? trimMultiline(body.persona, LIMITS.persona) : test.persona;
  if (!subject) return { status: 400, body: { error: 'Say what is being tested — it goes in the tester’s thank-you line.' } };
  if (!persona && !test.tour) return { status: 400, body: { error: 'The persona cannot be empty.' } };

  const counted = await one(env, 'SELECT COUNT(*) AS n FROM sessions WHERE test_id = ?', test.id);
  const started = Number((counted && counted.n) || 0);

  let tasks = test.tasks;
  if (has('tasks')) {
    // an edit that leaves a task's check out keeps the check it had, rather
    // than having one guessed afresh from the new wording
    const given = (Array.isArray(body.tasks) ? body.tasks : []).map((raw, i) => {
      const old = test.tasks[i];
      if (!raw || !old) return raw;
      const kept = Object.assign({}, raw);
      if (raw.check === undefined) kept.check = old.check || 'none';
      // and a step sent without a pointer or actions keeps the ones it had
      if (raw.point === undefined && old.point) kept.point = old.point;
      if (raw.do === undefined && old.do) kept.do = old.do;
      if (raw.say === undefined && old.say) kept.say = old.say;
      if (raw.audio === undefined && old.audio) kept.audio = old.audio;
      return kept;
    });
    const fresh = cleanTasks(given);
    if (fresh.length < LIMITS.tasksMin) return { status: 400, body: { error: 'Give the tester at least one thing to try.' } };
    if (started) {
      if (fresh.length !== test.tasks.length) {
        return {
          status: 409,
          body: { error: `${started} tester(s) have already started, so the tasks can be reworded but not added, removed or reordered — their answers are kept per task. Make a new test for a different set of tasks.` },
        };
      }
      fresh.forEach((t, i) => { t.id = test.tasks[i].id; });
    }
    tasks = fresh;
  }

  const before = test.wording || {};
  if (has('lang') && cleanLang(body.lang).error) return json({ error: cleanLang(body.lang).error }, 400, CORS);
  const wording = cleanWording({
    intro: has('intro') ? body.intro : before.intro,
    questions: has('questions') ? body.questions : before.questions,
    lang: has('lang') ? body.lang : before.lang,
  });

  // a tour's button can change; a test cannot become a tour, nor the other way
  let tour = test.tour;
  if (tour && (has('button') || has('theme'))) {
    const toured = readTour({
      mode: 'tour',
      button: has('button') ? body.button || {} : tour.button || {},
      theme: has('theme') ? body.theme : tour.theme,
      endAudio: tour.endAudio,
    });
    if (toured.error) return { status: 400, body: { error: toured.error } };
    tour = toured.tour;
  }

  await run(
    env,
    'UPDATE tests SET subject = ?, persona = ?, tasks = ?, wording = ?, tour = ?, touched = ? WHERE id = ?',
    subject, persona, JSON.stringify(tasks), wording ? JSON.stringify(wording) : null, tour ? JSON.stringify(tour) : null, Date.now(), test.id
  );
  return {
    status: 200,
    body: {
      ok: true, id: test.id, started,
      subject, tasks: tasks.map((t) => ({ title: t.title, hint: t.hint || '' })),
      mode: tour ? 'tour' : 'test',
      button: tour ? tour.button || null : undefined,
      theme: tour ? tour.theme || null : undefined,
      intro: (wording && wording.intro) || '',
      questions: Object.assign({}, DEFAULT_QUESTIONS, (wording && wording.questions) || {}),
    },
  };
}

async function editTest(env, req, url) {
  const id = url.searchParams.get('test') || '';
  const test = await openTest(env, id, req.headers.get('x-test-password') || '');
  if (!test) return json({ error: 'That password is not right.' }, 401, { 'cache-control': 'no-store' });
  let body;
  try { body = await req.json(); } catch (e) { return json({ error: 'Send the changes as JSON.' }, 400); }
  const r = await updateTest(env, test, body);
  return json(r.body, r.status, { 'cache-control': 'no-store' });
}

async function readResults(env, req, url) {
  const id = url.searchParams.get('test') || '';
  const test = await openTest(env, id, req.headers.get('x-test-password') || '');
  if (!test) {
    return json({ error: 'That password is not right.' }, 401, { 'cache-control': 'no-store' });
  }

  if (url.searchParams.get('digest')) {
    const d = await buildDigest(env, id, test);
    if (test.versions) {
      d.versions = await compareDigest(env, id, test);
      d.caution = compareCaution(d.versions);
    }
    return json(d, 200, { 'cache-control': 'no-store' });
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
      now: Date.now(),
      // the wording as it stands, for the results page's Edit form
      persona: test.persona,
      intro: (test.wording && test.wording.intro) || '',
      questions: Object.assign({}, DEFAULT_QUESTIONS, (test.wording && test.wording.questions) || {}),
      tasks: test.tasks.map((t) => (t.check ? Object.assign({}, t, { checkLabel: checkLabel(t.check) }) : t)),
      mode: test.tour ? 'tour' : 'test',
      button: test.tour ? test.tour.button || null : undefined,
      theme: test.tour ? test.tour.theme || null : undefined,
      sessions: await sessionIndex(env, id),
      versions: test.versions ? await compareDigest(env, id, test) : undefined,
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
      title: { type: 'string', maxLength: LIMITS.taskTitle, description: `What they are trying to get done, in their words. "Give the site your own name", not "click Settings". In a tour, the step's heading. At most ${LIMITS.taskTitle} characters — longer is refused, not cut.` },
      hint: { type: 'string', maxLength: LIMITS.taskHint, description: `Shown only if they ask for it. This is where a control may be named. In a tour it is the instruction, shown straight away: say what to do, button and all. At most ${LIMITS.taskHint} characters.` },
      audio: { type: 'string', description: 'Tours only, optional: an https link to a recording of this step’s words (an mp3, say, made with a voice service). Played instead of the browser’s voice when sound is on; if it will not load, the browser reads the words instead.' },
      say: { type: 'string', maxLength: LIMITS.say, description: `Tours only, optional: what the voice says on this step, if the person turns sound on. Write it to be heard: a sentence or three, the way you would say it standing next to them, and words rather than symbols ("Command K", not "⌘K"). Left out, the voice reads the hint. At most ${LIMITS.say} characters.` },
      do: {
        description: `Tours only: what the step presses by itself while people watch, up to ${LIMITS.actions} actions, as lines (or objects). Each line is a pointer to press (CSS, or button "Styles", or a || b), or: type "words" into <pointer>; press Escape|Enter|Tab; go /wp-admin/some-screen.php (shows the way there through WordPress's own menus, pressing each one); wait 2; and "maybe " in front of any of them to pass over it when it is not there. E.g. ["button \\"Styles\\"", "button \\"Browse styles\\"", ".edit-site-save-hub__button"].`,
        oneOf: [{ type: 'string' }, { type: 'array', items: { oneOf: [{ type: 'string' }, { type: 'object' }] } }],
      },
      point: { type: 'string', maxLength: LIMITS.point, description: `Tours only, optional: a CSS selector for the thing to click, e.g. [aria-label="Styles"]. Add words in quotes to match an element by its text, e.g. button "Styles"; separate several with || and the first on screen wins, so the ring can follow them across panels. A ring is drawn round it, inside the editor's canvas too. A selector that finds nothing shows no ring. At most ${LIMITS.point} characters.` },
      why: { type: 'string', maxLength: LIMITS.taskWhy, description: `Optional one line of context under the task. At most ${LIMITS.taskWhy} characters.` },
      check: {
        description: 'How the service can see the task really happened, by reading the tester\'s site when they press Done or Couldn\'t do it. One of: ' +
          Object.keys(CHECKS).map((k) => `${k} (${CHECKS[k].toLowerCase()})`).join(', ') +
          '. For text, pass { "type": "text", "text": "the words" }; for block and block_changed, { "type": "block", "block": "my-plugin/my-block" }; for page, { "type": "page", "path": "site-editor.php" } (part of the screen’s address). Leave it out and the service guesses from the title; pass "none" to check nothing. In a tour, a checked step moves on by itself when the check sees it done; an unchecked one shows Next.',
        oneOf: [
          { type: 'string', enum: Object.keys(CHECKS).filter((k) => k !== 'text' && k !== 'block' && k !== 'block_changed' && k !== 'page').concat(['none']) },
          { type: 'object', properties: { type: { type: 'string', enum: Object.keys(CHECKS) }, text: { type: 'string' }, block: { type: 'string' }, path: { type: 'string' } }, required: ['type'] },
        ],
      },
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

// A test is not always about building a website — a plugin's settings screen,
// an app inside wp-admin — so the intro line and the closing questions can be
// the test's own. Left out, the tester gets neutral defaults.
const WORDING_SCHEMA = {
  lang: { type: 'string', description: 'Optional: the language, as a WordPress locale (fr_FR, de_DE, es_ES, it_IT, nl_NL, pt_BR) or a short code (fr). The tester’s site is set to it, and the card’s own buttons and the welcome page follow it in French, German, Spanish, Italian, Dutch and Portuguese. Write the subject, persona, tasks, hints and say lines in that language yourself, and write any step that finds a button by its words (button "Styles") with the words WordPress shows in that language. Leave it out for English. For several languages, make one test or tour per language.' },
  intro: { type: 'string', maxLength: LIMITS.intro, description: `Optional line under the persona on the tester's intro page, e.g. "The site you get is a start someone made for you. Make it yours." At most ${LIMITS.intro} characters.` },
  questions: {
    type: 'object',
    description: 'Optional: the four closing questions in your own words, for a test that is not about making a site. Leave any out to keep its default. ' +
      QUESTION_KEYS.map((k) => `${k} (default "${DEFAULT_QUESTIONS[k]}")`).join('; ') + `. At most ${LIMITS.question} characters each.`,
    properties: Object.fromEntries(QUESTION_KEYS.map((k) => [k, { type: 'string', maxLength: LIMITS.question }])),
  },
};

// A tour shows people a thing rather than testing them on it: the same link,
// site and card, but each step's hint is the instruction, a checked step moves
// on by itself, and it ends with a button instead of questions.
const TOUR_SCHEMA = {
  mode: { type: 'string', enum: ['test', 'tour'], description: 'test (the default) watches people try things on their own. tour shows people around and plays itself: each step says what it shows (its hint), presses through its own actions (do) while a ring shows where, waits for its check to confirm it, and the tour ends with a button instead of the closing questions. Nobody has to do anything; they can pause and try. For a tour, persona is optional: one line on who it is for.' },
  theme: { type: 'object', description: 'Tours only, optional: the tour’s colours, { accent, card }. accent is a hex colour (#6b3fa0) for the card’s buttons, its edge, the ring round the next thing to press and the pointer’s halo; turn a brand colour the person names into hex. card is "dark" (the default) or "light". The service checks the accent can be read and uses a readable shade of it for words if not.', properties: { accent: { type: 'string' }, card: { type: 'string', enum: ['dark', 'light'] } } },
  button: { type: 'object', description: `Tours only: the button at the end, { label, url }. The label at most ${LIMITS.buttonLabel} characters, the url https. E.g. { "label": "Get the plugin", "url": "https://wordpress.org/plugins/…" }.`, properties: { label: { type: 'string', maxLength: LIMITS.buttonLabel }, url: { type: 'string' } } },
};

const TOOLS = [
  {
    name: 'usertest_task_sets',
    description: 'Ready-made task sets for the tests most people run (first edits, pages and the menu, writing a post, branding, building a page, a WooCommerce shop), and ready-made tours (what’s new in WordPress). Each has a persona and five or six tasks with hints and site checks. Pass task_set to usertest_check or usertest_create to use one, or copy and change its tasks.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'usertest_check',
    description: 'Check a draft test before making it. Returns problems worth fixing and softer notes, plus the task list read back. Call it first — two mistakes are easy to make and quietly ruin a test rather than breaking it.',
    inputSchema: {
      type: 'object',
      properties: {
        subject: { type: 'string', maxLength: LIMITS.subject, description: 'What is being tested. It becomes the tester\'s first line: "Thank you for helping make X better".' },
        task_set: { type: 'string', enum: ALL_SETS.map((x) => x.key), description: 'Optional: start from a ready-made set (see usertest_task_sets). Fills the persona and tasks you leave out.' },
        persona: { type: 'string', maxLength: LIMITS.persona, description: 'A paragraph, second person, giving them a reason to want the site — not just a job title.' },
        tasks: TASKS_SCHEMA,
        plugin: { type: 'string', description: 'The plugin to set the site up with: its wordpress.org slug (the end of wordpress.org/plugins/…) or an https link to its zip. The usual way to say what to test or tour.' },
        theme: { type: 'string', description: 'A theme to set the site up with: a wordpress.org slug or an https zip link. On its own for a theme, or with plugin.' },
        site: { type: 'string', enum: ['wordpress'], description: '"wordpress" for WordPress itself with nothing added: a tour that teaches WordPress, or a test of core.' },
        boot: BOOT_SCHEMA,
        intro: WORDING_SCHEMA.intro,
        questions: WORDING_SCHEMA.questions,
        lang: WORDING_SCHEMA.lang,
        mode: TOUR_SCHEMA.mode,
        button: TOUR_SCHEMA.button,
        theme: TOUR_SCHEMA.theme,
      },
      required: ['subject'],
    },
  },
  {
    name: 'usertest_create',
    description: 'Make a test. Returns a link to send a tester and a link to read the results, plus the results password — which cannot be recovered, so give it to the person and keep it. Say what the tester should get with ONE of: plugin and/or theme (a wordpress.org slug or an https zip link: most people have no blueprint), site: "wordpress" for WordPress itself, boot, blueprint_url or blueprint_json.',
    inputSchema: {
      type: 'object',
      properties: {
        subject: { type: 'string', maxLength: LIMITS.subject },
        task_set: { type: 'string', enum: ALL_SETS.map((x) => x.key), description: 'Optional: start from a ready-made set (see usertest_task_sets). Fills the persona and tasks you leave out.' },
        persona: { type: 'string', maxLength: LIMITS.persona },
        tasks: TASKS_SCHEMA,
        plugin: { type: 'string', description: 'The plugin to set the site up with: its wordpress.org slug (the end of wordpress.org/plugins/…) or an https link to its zip. The usual way to say what to test or tour.' },
        theme: { type: 'string', description: 'A theme to set the site up with: a wordpress.org slug or an https zip link. On its own for a theme, or with plugin.' },
        site: { type: 'string', enum: ['wordpress'], description: '"wordpress" for WordPress itself with nothing added: a tour that teaches WordPress, or a test of core.' },
        boot: BOOT_SCHEMA,
        intro: WORDING_SCHEMA.intro,
        questions: WORDING_SCHEMA.questions,
        lang: WORDING_SCHEMA.lang,
        mode: TOUR_SCHEMA.mode,
        button: TOUR_SCHEMA.button,
        theme: TOUR_SCHEMA.theme,
        end_audio: { type: 'string', description: 'Tours only, optional: an https link to a recording of the closing words, to go with the steps’ own recordings.' },
        blueprint_url: { type: 'string', description: 'An https URL to an existing Playground blueprint. Re-read each time a tester starts, so it can keep changing.' },
        blueprint_json: { type: 'string', description: 'A Playground blueprint as a JSON string, kept as-is.' },
        password: { type: 'string', description: 'For the results page. One is made for you if you leave it out.' },
        versions: {
          type: 'array',
          description: 'Optional, to compare: two or three versions of the site, each { label, boot | blueprint_url | blueprint_json }, given INSTEAD of boot/blueprint_url/blueprint_json. Same persona and tasks on each; one tester link shares testers out evenly; results come back side by side.',
          items: { type: 'object', properties: { label: { type: 'string' }, boot: BOOT_SCHEMA, blueprint_url: { type: 'string' }, blueprint_json: { type: 'string' } }, required: ['label'] },
        },
        webhook: { type: 'string', description: 'Optional. A Slack or Discord webhook URL (or any https address that takes a JSON POST). Each tester who finishes is posted there: what they managed, what the site showed, their answers and the results link. Never the password.' },
      },
      required: ['subject'],
    },
  },
  {
    name: 'usertest_update',
    description: 'Change a test that already exists — fix a typo, reword a task, a hint, the persona, the intro line or the closing questions — keeping the same links and password. Send only what changes. Tasks are matched by position: once anyone has started the test they can be reworded but not added, removed or reordered, because answers are kept per task. A task sent without a check keeps the check it had.',
    inputSchema: {
      type: 'object',
      properties: {
        test: { type: 'string', description: 'The test id from usertest_create.' },
        password: { type: 'string', description: 'The results password from usertest_create.' },
        subject: { type: 'string', maxLength: LIMITS.subject },
        persona: { type: 'string', maxLength: LIMITS.persona },
        tasks: TASKS_SCHEMA,
        intro: WORDING_SCHEMA.intro,
        questions: WORDING_SCHEMA.questions,
        lang: WORDING_SCHEMA.lang,
        button: TOUR_SCHEMA.button,
        theme: TOUR_SCHEMA.theme,
      },
      required: ['test', 'password'],
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
    description: 'Read what testers did. Returns, per task: how many managed it, how many could not, how many never reached it, the median time, how many opened the hint, what the site itself showed for checked tasks (done and visible, said done but unchanged, said couldn\'t but changed), and every note anyone typed — plus the wrap-up answers. Testing is slow; expect nothing for a day.',
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
  if (name === 'usertest_task_sets') {
    const lines = ALL_SETS.map((x) => `${x.key} — ${x.name}${x.mode === 'tour' ? ' (a tour)' : ''}: ${x.for}\n` + x.tasks.map((t, i) => `    ${i + 1}. ${t.title}`).join('\n'));
    return mcpText(lines.join('\n\n') + '\n\nPass task_set: "<key>" to usertest_check or usertest_create; your own tasks or persona, if given, win. A tour set makes a tour.', { structuredContent: { sets: TASK_SETS, tours: TOUR_SETS } });
  }

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
    const res = await makeTest(env, req, sameAsPaste({
      plugin: args && args.plugin,
      theme: args && args.theme,
      site: args && args.site,
      subject: args && args.subject,
      persona: args && args.persona,
      tasks: args && args.tasks,
      taskSet: args && args.task_set,
      intro: args && args.intro,
      questions: args && args.questions,
      lang: args && args.lang,
      mode: args && args.mode,
      button: args && args.button,
      theme: args && args.theme,
      endAudio: args && args.end_audio,
      boot: args && args.boot,
      blueprintUrl: args && args.blueprint_url,
      blueprintJson: args && args.blueprint_json,
      password,
      webhook: args && args.webhook,
      versions: args && Array.isArray(args.versions)
        ? args.versions.map((v) => ({ label: v && v.label, boot: v && v.boot, blueprintUrl: v && v.blueprint_url, blueprintJson: v && v.blueprint_json }))
        : undefined,
    }));
    const made = await res.json();
    if (!res.ok) return mcpText(made.error || 'That did not work.', { isError: true, structuredContent: made });

    const out = Object.assign({}, made, { password });
    const touring = made.mode === 'tour';
    return mcpText(
      (touring ? `Made a tour. Send this link to anyone:\n${made.tester}\n\nSee where people stop here:\n${made.results}` : `Made. Send this to a tester:\n${made.tester}\n\nRead the results here:\n${made.results}`) +
      `\n\nPassword: ${password}\n\n` +
      'Give the person both links and the password — none of it can be looked up again. ' +
      'The test keeps itself for ninety days after the last tester.' +
      (made.versions ? `\n\nOne link for all ${made.versions.length} versions (${made.versions.map((v) => v.label).join(', ')}): testers are shared out evenly, and usertest_results compares them.` : '') +
      (made.webhook ? `\n\nEach tester who finishes will be posted to the ${made.webhook === 'json' ? 'webhook' : made.webhook[0].toUpperCase() + made.webhook.slice(1) + ' channel'}.` : ''),
      { structuredContent: out }
    );
  }

  if (name === 'usertest_update') {
    const id = String((args && args.test) || '');
    const test = await openTest(env, id, (args && args.password) || '');
    if (!test) return mcpText('That test id and password do not go together.', { isError: true });
    const changes = {};
    ['subject', 'persona', 'tasks', 'intro', 'questions', 'lang', 'button', 'theme'].forEach((k) => { if (args && args[k] !== undefined) changes[k] = args[k]; });
    if (!Object.keys(changes).length) return mcpText('Nothing to change: send the fields that should be different.', { isError: true });
    const r = await updateTest(env, test, changes);
    if (r.status !== 200) return mcpText(r.body.error, { isError: true, structuredContent: r.body });
    const b = r.body;
    return mcpText(
      `Updated ${id}. Same links, same password; testers who start from now on see this.\n\n` +
      `${b.subject}\n` + b.tasks.map((t, i) => `  ${i + 1}. ${t.title}`).join('\n') +
      (b.intro ? `\n\nIntro line: ${b.intro}` : '') +
      (b.mode === 'tour'
        ? (b.button ? `\n\nEnds with a button: ${b.button.label} → ${b.button.url}` : '\n\nNo button at the end.')
        : '\n\nClosing questions:\n' + QUESTION_KEYS.map((k) => `  ${b.questions[k]}`).join('\n')),
      { structuredContent: b }
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

    if (test.versions) {
      const vs = await compareDigest(env, id, test);
      d.versions = vs;
      d.caution = compareCaution(vs);
      const L = [`Comparing ${vs.map((v) => `${v.key.toUpperCase()} (${v.label}): ${v.testers} tester(s), ${v.finished} finished`).join('; ')}.`];
      if (d.caution) L.push(d.caution);
      L.push('');
      test.tasks.forEach((task, i) => {
        L.push(task.title);
        vs.forEach((v) => {
          const t = v.tasks[i];
          const bits = [`${t.done} done`, `${t.couldnt} couldn’t`];
          if (t.notReached) bits.push(`${t.notReached} never got there`);
          if (t.hintOpened) bits.push(`${t.hintOpened} opened the hint`);
          if (t.medianSecs != null) bits.push(`${t.medianSecs}s median`);
          if (t.notShown) bits.push(`${t.notShown} said done but the site did not change`);
          if (t.didAnyway) bits.push(`${t.didAnyway} said couldn’t but the site changed`);
          L.push(`  ${v.key.toUpperCase()}: ${bits.join(', ')}`);
          t.notes.forEach((n) => L.push(`      "${n.note}" — ${n.who} (${n.got})`));
        });
      });
      L.push('', 'At the end:');
      vs.forEach((v) => {
        const c = v.couldFinish;
        L.push(`  ${v.key.toUpperCase()}: happy ${v.happyAvg == null ? '–' : v.happyAvg + '/5 on average'}; could have finished: ${c.yes} yes, ${c.maybe} maybe, ${c.no} no`);
        v.wrapUps.forEach((w) => { if (w.confused) L.push(`      confused ${w.who}: "${w.confused}"`); });
      });
      return mcpText(L.join('\n'), { structuredContent: d });
    }

    if (d.mode === 'tour') {
      const L = [`${d.testers} people started the tour: ${d.status.finished} saw the end, ${d.status.working} still going, ${d.status.stopped} stopped part way.` +
        (d.button ? ` ${d.buttonPresses} pressed “${d.button.label}”.` : ''), ''];
      d.tasks.forEach((t, i) => {
        const reached = d.testers - t.notReached;
        const bits = [`${reached} reached it`];
        if (t.auto) bits.push(`${t.auto} moved on by itself`);
        if (t.next) bits.push(`${t.next} pressed Next`);
        if (t.skipped) bits.push(`${t.skipped} skipped`);
        if (t.stoppedHere) bits.push(`${t.stoppedHere} stopped here`);
        if (t.onItNow) bits.push(`${t.onItNow} on it now`);
        if (t.medianSecs != null) bits.push(`${t.medianSecs}s median`);
        L.push(`${i + 1}. ${t.title} — ${bits.join(', ')}`);
      });
      if (d.truncated) L.push('', `Only the most recent ${DIGEST_MAX_SESSIONS} visitors are counted here.`);
      return mcpText(L.join('\n'), { structuredContent: d });
    }

    const lines = [`${d.testers} tester(s): ${d.status.finished} finished, ${d.status.working} still going, ${d.status.stopped} stopped before the end.`, ''];
    for (const t of d.tasks) {
      const bits = [`${t.done} done`, `${t.couldnt} couldn’t`];
      if (t.notReached) bits.push(`${t.notReached} never got there`);
      if (t.hintOpened) bits.push(`${t.hintOpened} opened the hint`);
      if (t.medianSecs != null) bits.push(`${t.medianSecs}s median`);
      lines.push(`${t.title} — ${bits.join(', ')}`);
      if (t.check && (t.shown || t.notShown || t.didAnyway)) {
        const seen = [];
        if (t.shown) seen.push(`${t.shown} done and the site shows it`);
        if (t.notShown) seen.push(`${t.notShown} said done but the site did not change`);
        if (t.didAnyway) seen.push(`${t.didAnyway} said they couldn’t but the site changed`);
        lines.push(`    checked — ${t.check.charAt(0).toLowerCase() + t.check.slice(1)}: ${seen.join('; ')}`);
      }
      t.notes.forEach((n) => lines.push(`    "${n.note}" — ${n.who} (${n.got}${n.site === 'no' && n.got === 'done' ? ', site unchanged' : ''})`));
    }
    if (d.wrapUps.length) {
      lines.push('', 'At the end:');
      d.wrapUps.forEach((w) => lines.push(`  ${w.who}: ${w.happy}/5, could have finished: ${w.confident}${w.feel ? `, felt "${w.feel}"` : ''}${w.confused ? `, confused by "${w.confused}"` : ''}`));
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
          'usertest_results — real testers take days, not minutes. ' +
          'To show people a thing instead of testing them on it, make a tour (mode: "tour"): it plays ' +
          'itself, each step pressing through its own actions (do) while people watch, and ends with a button.',
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

## Before anything else

usertest_create hands back a results password that CANNOT be looked up again by
anyone, including this service. Give it to the person you are working for, in
your reply, the moment you have it. A test whose password is lost is a test
nobody can ever read.

## As MCP

POST ${origin}/mcp — tools: usertest_task_sets, usertest_check, usertest_create,
usertest_update, usertest_delete, usertest_results.

## As HTTP

POST ${origin}/api/tests
  { subject, persona, tasks: [{ title, hint, check }], password,
    boot: { title, tagline, theme, plugins: [], images: [] },
    intro, questions, webhook }
  -> { id, tester, results, checks, webhook }

  Limits, in characters: subject ${LIMITS.subject}, persona ${LIMITS.persona}, task title
  ${LIMITS.taskTitle}, hint ${LIMITS.taskHint}, intro ${LIMITS.intro}, each question ${LIMITS.question};
  up to ${LIMITS.tasksMax} tasks. Anything longer is refused with a 400 that says
  which field, never cut short — shorten it and send again.
  intro (optional): one line under the persona on the tester's intro page.
  lang (optional): the language, as a WordPress locale (fr_FR) or a short
  code (fr). The site is set to it, and the card's own words and the welcome
  page follow it in ${Object.values(LANG_NAMES).join(', ')}. Write everything
  you send (subject, persona, tasks, hints, say) in that language, and any
  step that finds a button by its words with the words WordPress shows in it.
  For several languages, make one test or tour per language.

  Recording a tour's clicks: POST ${origin}/api/record with the same JSON
  (no password) and you get back { link }: the person opens it, does each step
  themselves in Playground, and the card writes down exactly what they pressed
  and typed. They copy the finished tour from the card and paste it into the
  form, or hand it back to you to create. Use it whenever you are guessing
  what a step should press, which is almost always for someone's own plugin.
  questions (optional): the closing questions in your own words, for a test
  that is not about making a site: { ${QUESTION_KEYS.join(', ')} }. Any left out
  keep their defaults: ${QUESTION_KEYS.map((k) => `${k} "${DEFAULT_QUESTIONS[k]}"`).join('; ')}.

  check (optional): how the site can show the task happened, read when the
  tester presses Done: ${Object.keys(CHECKS).join(', ')}, or none;
  text takes { type: "text", text: "the words" }. Left out, it is guessed.
  webhook (optional): a Slack or Discord webhook (or any https JSON endpoint);
  each tester who finishes is posted there. Never the password.
  taskSet (optional): start from a ready-made set (GET ${origin}/api/task-sets,
  or the usertest_task_sets tool): ${TASK_SETS.map((x) => x.key).join(', ')}.
  It fills the persona and tasks you leave out.
  versions (optional, to compare): [{ label, boot | blueprintUrl | blueprintJson }, …]
  two or three, instead of one site. One tester link shares testers out
  evenly; the digest gains versions[] side by side.

  Say what the tester gets with ONE of: boot (the service builds the blueprint),
  blueprintUrl (re-read each time), blueprintJson (kept as-is).

GET ${origin}/api/results?test=<id>&digest=1
  header: x-test-password: <the password>
  -> per task: done, couldnt, notReached, hintOpened, medianSecs, notes[]
     plus wrapUps[], and status { finished, working, stopped }: a tester
     quiet for half an hour without finishing counts as stopped. Drop &digest=1 for one row per tester, add
     &session=<id> for one tester's raw events.
  If you cannot send a header, ask the person to open the results page and
  press Copy prompt: it copies this same digest for them to paste to you.

PATCH ${origin}/api/tests?test=<id>
  header: x-test-password: <the password>
  { subject?, persona?, tasks?, intro?, questions? } — only what changes.
  Same links, same password; testers who start afterwards see the new words.
  Tasks are matched by position. Once anyone has started, they can be
  reworded but not added, removed or reordered (a 409 says so), because
  answers are kept per task. A task sent without a check keeps its check.

DELETE ${origin}/api/results?test=<id>
  header: x-test-password: <the password>
  Clears a test and everything on it. Use it on dry runs before the real
  invitations go out — every rehearsal is a row.

## Show it instead: a tour

The same thing with mode: "tour" shows people around rather than testing
them, and plays itself: nobody has to do anything. Each step's hint is what
the card says; its actions (do) are pressed one by one while a ring shows
where; its check confirms it happened before the next step. People can pause,
try it themselves, or skip. It ends with a button instead of the questions.

  { mode: "tour", subject: "Open Today", persona: "For anyone who runs a shop.",
    button: { label: "Get the plugin", url: "https://…" },
    theme: { accent: "#6b3fa0", card: "light" },
    tasks: [{ title: "Your opening hours",
              hint: "One block shows your hours and whether you are open now.",
              do: ["[aria-label=\\"Block Inserter\\"]", "type \\"hours\\" into [placeholder=\\"Search\\"]",
                   "button \\"Opening hours\\""],
              check: { type: "block", block: "open-today/hours" } }] }

  do: up to ${LIMITS.actions} actions, one per line. A pointer presses it (CSS;
  button "Styles" by its words; a || b, the first on screen). Or:
  type "words" into <pointer> · press Escape|Enter|Tab · go /wp-admin/x.php ·
  wait 2 · and "maybe " in front to pass over one that is not there.
  go shows the way: the card presses through WordPress's own navigation
  (the admin menu, the admin bar's Edit Site, the Site Editor's sidebar) to
  reach the screen, so people see how to get there. It only jumps straight
  there when it can find no way. Prefer go over pressing menus by hand.
  audio (optional): an https link to a recording of the step's words, played
  instead of the browser's voice; endAudio does the same for the closing words.
  say (optional): what the voice says, if they turn sound on. Write it to be
  heard: a sentence or three, words not symbols ("Command K", not "⌘K").
  Left out, the voice reads the hint.
  point (optional): where the ring sits when the tour is paused.
  theme (optional): { accent: "#hex", card: "dark" | "light" }. The accent
  colours the card's buttons and edge, the ring and the pointer's halo; turn
  a brand colour the person names ("my brand purple") into hex. The service
  checks it can be read and uses a readable shade for words if not.
  Pin the WordPress version in the blueprint: a release can move what a
  selector finds, and a step that cannot find its button pauses with a word.
  Checks: block / block_changed read the editor before anything is saved;
  page { type: "page", path: "site-editor.php" } is reaching a screen; every
  other check is measured from when the step began.
  The digest of a tour gives, per step: auto (moved on by itself), next,
  skipped, stoppedHere, onItNow, medianSecs; plus buttonPresses.
  Ready-made: taskSet "${TOUR_SETS.map((x) => x.key).join('", "')}".
  Writing one? The skill at
  https://github.com/jamiemarsland/playground-usertest/tree/main/skills/wordpress-tours
  covers planning, the voice script, and a map of where things are in
  WordPress, with selectors checked against a real one.

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
// Sharing testers out: the version with the fewest testers started so far,
// with an assignment count breaking ties, so two people opening the link in the
// same minute do not both land on A.
async function versionFor(env, test, req) {
  const keys = test.versions.map((v) => v.key);
  const cookie = (req.headers.get('cookie') || '').split(/;\s*/).find((c) => c.startsWith(`pgut_v_${test.id}=`));
  const had = cookie ? cookie.split('=')[1] : '';
  if (keys.includes(had)) return had;
  const rows = await all(env, 'SELECT version, COUNT(*) AS n FROM sessions WHERE test_id = ? GROUP BY version', test.id);
  const started = Object.fromEntries(keys.map((k) => [k, 0]));
  for (const r of rows) if (keys.includes(r.version)) started[r.version] = Number(r.n) || 0;
  const handed = {};
  for (const k of keys) handed[k] = await peekCount(env, `assign:${test.id}:${k}`);
  const pick = keys.slice().sort((x, y) => (started[x] - started[y]) || (handed[x] - handed[y]))[0];
  await bumpCount(env, `assign:${test.id}:${pick}`, handed[pick], NINETY_DAYS);
  return pick;
}

function introPage(test, origin, version) {
  const playground = 'https://playground.wordpress.net/?blueprint-url=' +
    encodeURIComponent(`${origin}/t/${test.id}/blueprint.json${version ? `?v=${version}` : ''}`) + '&storage=temp&mode=seamless';
  if (test.tour) return tourIntroPage(test, playground);
  // seamless: Playground's own toolbar stays out of the way, so the tester
  // sees a website and the card, nothing about the machinery underneath
  const paras = test.persona
    .split(/\n{2,}/)
    .map((p) => `<p>${esc(p)}</p>`)
    .join('');
  const lang = test.wording && test.wording.lang;
  const say = (key, vars) => esc(introWord(lang, key, Object.assign({ subject: test.subject }, vars)));
  return `<!doctype html>
<html lang="${esc(langKey(lang))}"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${say('x_title')}</title>
<style>${PAGE_CSS}</style></head><body><div class="wrap">
<h1>${say('x_title')}</h1>
<p>${say('x_lead')}</p>
<div class="card"><h2>${say('who')}</h2>
${paras}
${test.wording && test.wording.intro ? `<p class="soft" style="margin:0">${esc(test.wording.intro)}</p>` : ''}</div>
<div class="card"><h2>${say('how')}</h2>
<ol><li>${say('x_1')}</li>
<li>${say('x_2', { n: test.tasks.length })}</li>
<li>${say('x_3')}</li></ol></div>
<a class="go" href="${esc(playground)}" target="_blank" rel="noopener">${say('x_go')}</a>
<p class="fine">${say('x_fine')}</p>
</div></body></html>`;
}

// A tour's welcome page. No persona to play and no thank-you for helping: they
// are here to see something. It still says plainly what is kept.
function tourIntroPage(test, playground) {
  const n = test.tasks.length;
  const lang = test.wording && test.wording.lang;
  const say = (key, vars) => esc(introWord(lang, key, Object.assign({ subject: test.subject }, vars)));
  return `<!doctype html>
<html lang="${esc(langKey(lang))}"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${say('t_title')}</title>
<style>${PAGE_CSS}</style></head><body><div class="wrap">
<h1>${say('t_title')}</h1>
<p>${say('t_lead', { n })}</p>
${test.persona ? `<p class="soft">${esc(test.persona)}</p>` : ''}
${test.wording && test.wording.intro ? `<p class="soft">${esc(test.wording.intro)}</p>` : ''}
<div class="card"><h2>${say('how')}</h2>
<ol><li>${say('x_1')}</li>
<li>${say('t_2')}</li>
<li>${say('t_3')}</li></ol></div>
<a class="go" href="${esc(playground)}" target="_blank" rel="noopener">${say('t_go')}</a>
<p class="fine">${say('t_fine')}</p>
</div></body></html>`;
}

// The one prompt, for any assistant. The whole format travels in it, because
// many cannot open a web address at all (ChatGPT's web tool turns most away).
// One that can make requests creates the test itself; one that cannot hands
// back a block the owner pastes into the form, and nothing is made until they
// press the form's own button. {ORIGIN} is filled in by the page.
const SITE_LINE = 'For the site, ask me what it is: a plugin goes in "plugin" and a theme in "theme", each as its WordPress.org slug (the end of its wordpress.org/plugins/ or /themes/ address) or a public link to its zip; for WordPress itself put "site":"wordpress" instead. Only if I already have a Playground blueprint, put its link in "blueprint_url" instead of those. The service sets the site up from them.';

function plainPrompt(mode) {
  const checks = Object.keys(CHECKS).filter((k) => !['text', 'page', 'block', 'block_changed'].includes(k)).join(', ');
  const lang = 'lang is a WordPress locale such as fr_FR or es_ES if it should be in another language, and then everything you write goes in that language. Leave it out for English.';
  const end = [
    'Draft it with me first and ask for anything you need. When I say it is ready, finish it one of two ways:',
    '- If you can make web requests (Claude Code, Cursor, or this service added as a connector): create it yourself. POST the JSON, plus a "password" you make up, to {ORIGIN}/api/tests, or call usertest_create on {ORIGIN}/mcp. Then give me the tester link, the results link and the password, which cannot be looked up again.',
    '- If you cannot reach that address, do not keep trying: give me the finished JSON in one code block. I will paste it into the "Paste from your assistant" box on {ORIGIN}, which fills in the form for me to check.',
  ].join('\n');
  if (mode === 'tour') {
    return [
      'Help me make a guided tour with Playground user testing ({ORIGIN}), of a WordPress plugin, a theme, or WordPress itself (to teach someone how it works). The tour plays itself in a real WordPress in the visitor\u2019s browser: each step presses through its own actions while a pointer shows where, and a voice can read a script. Everything you need is in this message, so do not go looking for instructions.',
      'The JSON looks like this:',
      '{"mode":"tour","subject":"…","persona":"…","plugin":"…","button":{"label":"Get the plugin","url":"https://…"},"theme":{"accent":"#6b3fa0","card":"dark"},"tasks":[{"title":"…","hint":"…","say":"…","do":["#some-id","button \\"Label\\"","type \\"words\\" into input.search","press Escape","go /wp-admin/options-general.php","wait 2"],"check":"none"}]}',
      `subject is what it shows (it heads the welcome page: "A short tour of X"), up to ${LIMITS.subject} characters. persona is optional, one line on who it is for. ${SITE_LINE} Three to six steps. title is short; hint is what the card says while the step plays; say is the voice script, written to be heard, with words not symbols. do lists what the step presses, in order: a CSS selector, button "Label" for a button by its words, type "words" into <selector>, press <Key>, go <address in the site>, wait <seconds>; put maybe in front of one that might not be there. You cannot see the site, so do not guess what a step presses: leave do out where you are unsure. Once the tour is in the form I will press Record the clicks in Playground and do each step myself, and the card fills in exactly what to press. check is optional: none, or {"type":"page","path":"part of the address"}, or one of ${checks}. button is where it ends. theme is optional: my brand colour as a hex accent, and a dark or light card.`,
      lang,
      end,
    ].join('\n\n');
  }
  return [
    'Help me set up a user test with Playground user testing ({ORIGIN}), of a WordPress plugin, a theme, or WordPress itself. Testers open a link, get a real WordPress in their browser, already set up, and work through a card of tasks while it records what happens. Everything you need is in this message, so do not go looking for instructions.',
    'The JSON looks like this:',
    '{"mode":"test","subject":"…","persona":"…","plugin":"…","tasks":[{"title":"…","hint":"…","check":"site_name"}]}',
    `subject is what is being tested (the tester reads "Thank you for helping make X better"), up to ${LIMITS.subject} characters. persona is a paragraph in the second person that gives the tester a reason to want the site; do not name them after the demo site. ${SITE_LINE} Five to seven tasks. Each title says what they want to end up with, never which button to press: the button goes in the hint, so the results show who needed it. check is optional: one of ${checks}, or {"type":"text","text":"words on the home page"}, or {"type":"page","path":"part of the address"}, or none.`,
    lang,
    end,
  ].join('\n\n');
}

// The owner's whole flow. Most people arrive with an assistant to hand, so the
// page leads with the one sentence to give it; the form is right underneath for
// anyone who would rather type. Between them, a tester's-eye demo: the card
// working on a pretend site, so you see what you are sending people.
const DEMO = TASK_SETS.find((x) => x.key === 'make-it-yours');
const HOME = `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>WordPress user testing and tours, made easy</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Instrument+Sans:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500;700&display=swap" rel="stylesheet">
<style>${PAGE_CSS}
  :root { --night:#0e0f12; --panel:#17191e; --rule:#2a2d35; --text:#f2f2f0; --muted:#b9bcc6; --dim:#9da1ab; --mint:#7cf2b0; --mint-hi:#b5f8d3; --amber:#ffb86b; }
  body { background:var(--night); color:var(--text); font-family:"Instrument Sans",-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; }
  a { color:var(--mint); } a:hover { color:var(--mint-hi); }
  .mono { font-family:"JetBrains Mono",ui-monospace,SFMono-Regular,Menlo,monospace; }
  .shell { max-width:1160px; margin:0 auto; padding:0 24px; }
  section { padding:88px 0; }
  h2.big { font-weight:700; font-size:40px; line-height:1.1; letter-spacing:-.025em; margin:0 0 16px; }
  .lede { color:var(--muted); max-width:640px; }
  .label { font:500 12px/1.4 "JetBrains Mono",ui-monospace,monospace; letter-spacing:.06em; text-transform:uppercase; color:var(--dim); margin:0 0 8px; }
  :focus-visible { outline:2px solid var(--mint); outline-offset:2px; }

  .topbar { display:flex; flex-wrap:wrap; gap:16px; align-items:center; justify-content:space-between; padding-top:22px; padding-bottom:22px; }
  .brand { font:700 16px/1 "JetBrains Mono",ui-monospace,monospace; color:var(--text); text-decoration:none; }
  .brand b { color:var(--mint); }
  .topbar nav { display:flex; flex-wrap:wrap; gap:22px; align-items:center; font-size:15px; }
  .topbar nav a { color:var(--text); text-decoration:none; } .topbar nav a:hover { color:var(--mint); }
  .topbar nav .mono { font-size:14px; }

  .hero { padding-top:64px; padding-bottom:40px; text-align:center; }
  .hero .eyebrow { margin:0 0 20px; font:13px/1.4 "JetBrains Mono",ui-monospace,monospace; color:var(--dim); letter-spacing:.06em; }
  .hero h1 { margin:0 auto 22px; font-family:"Instrument Sans",sans-serif; font-weight:700; font-size:76px; line-height:1; letter-spacing:-.035em; max-width:960px; }
  .hero .sub { margin:0 auto 40px; font-size:20px; color:var(--muted); max-width:640px; }
  .prompt { position:relative; max-width:820px; margin:0 auto; text-align:left; background:var(--panel); border:1px solid var(--rule); border-radius:16px; padding:24px 24px 20px; box-shadow:0 0 0 6px rgba(124,242,176,.08); }
  .prompt p { margin:0 0 18px; font:17px/1.7 "JetBrains Mono",ui-monospace,monospace; color:var(--text); }
  .prompt p::before { content:"› "; color:var(--mint); }
  .prompt p.more { margin:-10px 0 16px; font:13px/1.5 "JetBrains Mono",ui-monospace,monospace; color:var(--dim); }
  .prompt p.more::before { content:""; }
  .prompt .under { display:flex; flex-wrap:wrap; gap:10px; justify-content:space-between; align-items:center; font-size:14px; color:var(--dim); }
  .addr { font:13px/1.7 "JetBrains Mono",ui-monospace,monospace; word-break:break-all; color:var(--text); }
  .copy { font:inherit; font-weight:700; font-size:15px; padding:12px 22px; border-radius:999px; border:0; background:var(--mint); color:var(--night); cursor:pointer; }
  .copy:hover { background:var(--mint-hi); }
  /* a link dressed as this button keeps its dark words: the page's own link
     hover would turn them the colour of the button */
  a.copy, a.copy:hover { color:var(--night); }
  .ask { display:inline-flex; gap:6px; padding:6px; margin:0 auto 18px; background:var(--panel); border:1px solid var(--rule); border-radius:999px; }
  .ask button { all:unset; cursor:pointer; display:flex; align-items:baseline; gap:8px; padding:10px 20px; border-radius:999px; color:var(--muted); font-size:15px; }
  .ask button b { color:var(--text); font-size:16px; }
  .ask button span { font-size:14px; }
  .ask button em { font:700 11px/1 "JetBrains Mono",monospace; font-style:normal; letter-spacing:.06em; text-transform:uppercase; color:var(--night); background:var(--mint); padding:4px 7px; border-radius:6px; align-self:center; }
  .ask button[aria-checked="true"] { background:var(--mint); color:var(--night); }
  .ask button[aria-checked="true"] b, .ask button[aria-checked="true"] span { color:var(--night); }
  .ask button[aria-checked="true"] em { background:var(--night); color:var(--mint); }
  .ask button:focus-visible { outline:2px solid var(--mint); outline-offset:2px; }
  .tourshow { --tour:#6c5ce7; --tour-text:#a99cff; }
  .tourshow .tcard2.light { background:#fff; color:#1e1e1e; } .tourshow .tcard2.light .say { background:#f1f2f4; color:#3a3e46; } .tourshow .tcard2.light .btns span { border-color:#d5d8dd; }
  .tourshow .tcard2 .hideb { all:unset; cursor:pointer; color:#9aa0ab; }
  .tourshow .pill2 { all:unset; cursor:pointer; position:absolute; right:16px; top:16px; background:var(--tour); color:#fff; font-weight:700; font-size:14px; padding:10px 16px; border-radius:999px; box-shadow:0 6px 20px rgba(0,0,0,.25); }
  .brandrow { display:flex; flex-wrap:wrap; align-items:center; gap:10px; margin:0 0 24px; font-size:14px; color:var(--dim); }
  .brandrow button.sw { all:unset; cursor:pointer; width:28px; height:28px; border-radius:50%; box-shadow:0 0 0 2px var(--night), 0 0 0 3px var(--rule); }
  .brandrow button.sw[aria-pressed="true"] { box-shadow:0 0 0 2px var(--night), 0 0 0 4px var(--text); }
  .brandrow input[type=color] { width:32px; height:32px; border:0; padding:0; background:none; cursor:pointer; }
  .brandrow .cardpick { all:unset; cursor:pointer; padding:6px 12px; border-radius:999px; border:1px solid var(--rule); color:var(--text); }
  .tourshow .stage2 { position:relative; background:#f6f7f9; border-radius:0 0 14px 14px; height:420px; overflow:hidden; color:#1e1e1e; }
  .tourshow .side { position:absolute; inset:0 auto 0 0; width:120px; background:#1e1e1e; color:#ddd; padding:22px 18px; font-size:14px; }
  .tourshow .side p { margin:0 0 14px; } .tourshow .side .on { color:#fff; font-weight:700; }
  .tourshow .looks { position:absolute; left:140px; top:236px; right:20px; display:grid; grid-template-columns:repeat(3,1fr); gap:12px; }
  .tourshow .looks i { position:relative; height:74px; border-radius:8px; border:1px solid #dcdfe4; background:#fff; display:flex; align-items:center; justify-content:center; font:600 22px/1 Georgia,serif; font-style:normal; }
  .tourshow .looks i.dark { background:#1d1f24; color:#fff; } .tourshow .looks i.sage { background:#dfe6d2; } .tourshow .looks i.plum { background:#4a1f33; color:#f4d6e2; }
  .tourshow .looks i.pick { outline:3px solid var(--tour); outline-offset:3px; }
  .tourshow .ptr { position:absolute; left:58%; top:52%; width:34px; height:34px; }
  .tourshow .ptr::before { content:""; position:absolute; left:-18px; top:-18px; width:44px; height:44px; border-radius:50%; background:color-mix(in srgb, var(--tour) 35%, transparent); box-shadow:0 0 0 10px color-mix(in srgb, var(--tour) 15%, transparent); }
  .tourshow .tcard2 { position:absolute; right:16px; top:16px; width:270px; background:#16181c; color:#e8eaee; border:2px solid var(--tour); border-radius:14px; padding:16px; font-size:14px; }
  .tourshow .tcard2 .top { display:flex; justify-content:space-between; font:600 11px/1 "JetBrains Mono",monospace; letter-spacing:.06em; color:var(--tour-text); margin-bottom:12px; }
  .tourshow .tcard2 .top span:last-child { color:#9aa0ab; letter-spacing:0; font-family:inherit; }
  .tourshow .tcard2 h4 { margin:0 0 8px; font-size:16px; }
  .tourshow .tcard2 .say { background:#24272d; border-radius:8px; padding:10px; margin:0 0 10px; color:#cfd3da; }
  .tourshow .tcard2 .playing { font-size:13px; color:#9aa0ab; margin:0 0 10px; } .tourshow .tcard2 .playing::before { content:"● "; color:var(--tour-text); }
  .tourshow .tcard2 .btns { display:flex; gap:8px; } .tourshow .tcard2 .btns span { flex:1; text-align:center; padding:9px; border-radius:999px; border:1px solid #3a3e46; font-weight:600; }
  .tourshow .tcard2 .btns span.go { background:var(--tour); border-color:var(--tour); color:#fff; }
  .tourshow ul.points { list-style:none; padding:0; margin:20px 0 26px; } .tourshow ul.points li { margin:0 0 12px; padding-left:26px; position:relative; color:var(--muted); }
  .tourshow ul.points li::before { content:"→"; position:absolute; left:0; color:var(--mint); } .tourshow ul.points b { color:var(--text); }
  @media (max-width:640px) {
    .ask button { padding:10px 16px; } .ask button span { display:none; }
    .tourshow .side { display:none; }
    .tourshow .looks { left:16px; right:16px; }
    .tourshow .tcard2 { left:16px; right:16px; width:auto; }
  }
  .linkish { all:unset; cursor:pointer; color:var(--mint); text-decoration:underline; text-underline-offset:3px; }
  .linkish:hover { color:var(--mint-hi); }
  .linkish:focus-visible { outline:2px solid var(--mint); outline-offset:2px; border-radius:4px; }
  .or { margin:24px 0 0; font-size:15px; color:var(--dim); }
  .taken { display:inline-flex; align-items:center; gap:10px; margin:22px 0 0; font:500 15px/1 "JetBrains Mono",ui-monospace,monospace; color:var(--dim); }
  .taken[hidden] { display:none; }
  .taken b { color:var(--text); font-weight:700; font-size:17px; font-variant-numeric:tabular-nums; transition:color .4s; }
  .taken b.up { color:var(--mint); }
  .taken i { width:9px; height:9px; border-radius:50%; background:var(--mint); animation:takenPulse 2s infinite; }
  @keyframes takenPulse { 0% { box-shadow:0 0 0 0 rgba(124,242,176,.55); } 70% { box-shadow:0 0 0 10px rgba(124,242,176,0); } 100% { box-shadow:0 0 0 0 rgba(124,242,176,0); } }
  @media (prefers-reduced-motion: reduce) { .taken i { animation:none; } }
  @media (max-width:640px) { .hero h1 { font-size:46px; } h2.big { font-size:32px; } section { padding:64px 0; } .prompt p { font-size:15px; } }

  .warn { display:flex; flex-wrap:wrap; gap:20px; align-items:center; border:1px solid var(--amber); border-radius:16px; padding:24px 28px; }
  .warn svg { flex:none; }
  .warn div { flex:1 1 420px; min-width:0; }
  .warn h3 { margin:0 0 6px; font-size:20px; }
  .warn p { margin:0; color:var(--muted); }

  .split { display:flex; flex-wrap:wrap; gap:48px; align-items:flex-start; }
  .split > .words { flex:1 1 320px; min-width:0; }
  .split > .words p { color:var(--muted); }
  .chat { flex:1 1 560px; min-width:0; display:flex; flex-direction:column; gap:14px; }
  .bubble { max-width:88%; border-radius:14px; padding:16px 18px; font-size:15px; }
  .bubble p { margin:0 0 10px; } .bubble p:last-child { margin:0; }
  .bubble.you { align-self:flex-end; max-width:80%; background:var(--rule); border-radius:14px 14px 4px 14px; padding:14px 18px; }
  .bubble.it { background:var(--panel); border:1px solid var(--rule); border-radius:14px 14px 14px 4px; }
  .bubble .tool { font:12px/1.4 "JetBrains Mono",ui-monospace,monospace; color:var(--amber); }
  .bubble .fix { font:14px/1.5 "JetBrains Mono",ui-monospace,monospace; color:var(--mint); }
  .bubble .hintline { font:14px/1.5 "JetBrains Mono",ui-monospace,monospace; color:var(--dim); }
  .handover { display:grid; grid-template-columns:96px minmax(0,1fr); gap:8px 12px; font:13px/1.5 "JetBrains Mono",ui-monospace,monospace; }
  .handover dt { color:var(--dim); } .handover dd { margin:0; }
  .handover .key { color:var(--mint); }

  .demo-intro { color:var(--muted); margin:0 0 24px; max-width:640px; }
  .browser { border:1px solid var(--rule); border-radius:18px; overflow:hidden; background:#f3f4f7; box-shadow:0 40px 80px -40px rgba(0,0,0,.8); color:#111216; }
  .chrome { display:flex; gap:8px; align-items:center; padding:12px 14px; background:#fff; border-bottom:1px solid #e4e6eb; }
  .chrome i { width:11px; height:11px; border-radius:50%; background:#d5d7de; flex:none; }
  .chrome span { flex:1; min-width:0; margin-left:10px; padding:5px 12px; border-radius:8px; background:#f3f4f7; font:12px/1.4 "JetBrains Mono",ui-monospace,monospace; color:#5b5e68; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
  .stage { display:flex; flex-wrap:wrap; gap:20px; padding:20px; align-items:flex-start; }
  .site { --site-ink:#2e3440; --site-wash:#f3f4f7; flex:1 1 520px; min-width:0; background:#fff; border-radius:12px; overflow:hidden; border:1px solid #e4e6eb; }
  .site.styled { --site-ink:#8a3b17; --site-wash:#f6ebdd; }
  .site-head { display:flex; flex-wrap:wrap; gap:12px; align-items:center; justify-content:space-between; padding:16px 22px; border-bottom:1px solid #eef0f3; }
  .site-name { font-weight:700; font-size:20px; color:var(--site-ink); transition:color .4s; }
  .site-menu { display:flex; gap:16px; font-size:14px; color:#4a4c55; }
  .site-menu .new { color:var(--site-ink); font-weight:600; }
  .site-hero { padding:36px 22px 28px; background:var(--site-wash); transition:background .4s; }
  .site-hero p { margin:0 0 18px; font-weight:700; font-size:36px; line-height:1.1; letter-spacing:-.02em; color:var(--site-ink); max-width:460px; transition:color .4s; }
  .site-hero span { display:inline-block; padding:10px 18px; border-radius:999px; background:var(--site-ink); color:#fff; font-size:14px; font-weight:600; transition:background .4s; }
  .site-body { padding:22px; display:flex; gap:16px; flex-wrap:wrap; }
  .photo { flex:2 1 220px; height:170px; border-radius:10px; background:#dce0e8; display:flex; align-items:center; justify-content:center; transition:background .4s; }
  .photo.swapped { background:#e9c9a8; }
  .lines { flex:1 1 160px; display:flex; flex-direction:column; gap:10px; padding-top:4px; }
  .lines i { height:10px; border-radius:4px; background:#eef0f3; }
  .flash { animation:flash 1s ease-out; }
  @keyframes flash { from { box-shadow:0 0 0 4px rgba(31,122,77,.5); } to { box-shadow:0 0 0 0 rgba(31,122,77,0); } }
  @media (prefers-reduced-motion:reduce) { .flash { animation:none; } .site, .site * { transition:none !important; } }

  .tcard { flex:0 1 330px; min-width:260px; background:#fff; border-radius:16px; padding:20px; border:1px solid #d5d7de; box-shadow:0 20px 40px -20px rgba(17,18,22,.35); }
  .tcard .who { margin:0 0 12px; font-size:13px; color:#5b5e68; }
  .tcard .head { display:flex; justify-content:space-between; align-items:baseline; margin:0 0 12px; }
  .tcard .head strong { font-size:18px; }
  .tcard .head span { font:12px/1 "JetBrains Mono",ui-monospace,monospace; color:#5b5e68; }
  .tlist { list-style:none; margin:0; padding:0; display:flex; flex-direction:column; gap:4px; font-size:14px; line-height:1.4; }
  .tlist li { display:flex; gap:10px; padding:8px 10px; margin:0; border-radius:10px; color:#5b5e68; }
  .tlist li svg { flex:none; }
  .tlist li.now { background:#e6f8ee; color:#111216; font-weight:600; }
  .tlist li.done span { text-decoration:line-through; }
  .thint { margin:12px 0 0; padding:10px 12px; border-radius:10px; background:#fff6e0; font-size:13px; color:#5c4300; }
  .tbtns { display:flex; flex-wrap:wrap; gap:8px; margin:16px 0 0; }
  .tbtns button { font:inherit; font-size:14px; padding:10px 16px; border-radius:999px; border:1px solid #d5d7de; background:#fff; color:#111216; cursor:pointer; }
  .tbtns button.primary { background:#111216; color:#fff; border-color:#111216; font-weight:600; }
  .tbtns button:focus-visible { outline:2px solid #1f7a4d; }
  .tdone { margin:16px 0 0; padding:14px; border-radius:12px; background:#e8f6ee; }
  .tdone p { margin:0 0 10px; font-size:14px; color:#2c4a3a; }
  .tdone strong { color:#145a37; }
  .tdone a { color:#145a37; }

  .table { margin-top:20px; background:var(--panel); border:1px solid var(--rule); border-radius:16px; overflow-x:auto; }
  .table table { width:100%; min-width:520px; border-collapse:collapse; font-size:15px; }
  .table caption { text-align:left; padding:14px 20px; border-bottom:1px solid var(--rule); font:13px/1.4 "JetBrains Mono",ui-monospace,monospace; color:var(--dim); }
  .table th { text-align:left; font-weight:400; font-size:13px; color:var(--dim); padding:12px 20px; border-bottom:1px solid var(--rule); }
  .table td { padding:13px 20px; border-bottom:1px solid var(--rule); }
  .table td.y { color:var(--mint); font-weight:600; } .table td.n { color:#ff9b85; font-weight:600; }
  .table tr.now td { background:rgba(124,242,176,.08); }
  .table .foot { padding:16px 20px; font-size:15px; color:var(--muted); margin:0; }

  .chips { display:flex; flex-wrap:wrap; gap:10px; margin:32px 0 24px; }
  .chip { font:inherit; font-size:15px; font-weight:600; padding:11px 18px; border-radius:999px; cursor:pointer; background:transparent; color:var(--text); border:1px solid var(--rule); }
  .chip:hover { border-color:var(--dim); }
  .chip[aria-pressed="true"] { background:var(--mint); color:var(--night); border-color:var(--mint); }
  .setview { display:flex; flex-wrap:wrap; gap:20px; align-items:stretch; }
  .setview > div { flex:1 1 380px; min-width:0; border-radius:16px; padding:28px; background:var(--panel); border:1px solid var(--rule); }
  .setview ol { padding-left:22px; margin:0; } .setview li { margin:0 0 8px; }
  .ghost { font:inherit; font-weight:700; font-size:15px; margin-top:8px; padding:12px 20px; border-radius:999px; border:1px solid var(--mint); background:transparent; color:var(--mint); cursor:pointer; }
  .ghost:hover { background:rgba(124,242,176,.1); }

  .features { display:grid; grid-template-columns:repeat(auto-fit,minmax(280px,1fr)); gap:20px; }
  .features > div { background:var(--panel); border-radius:16px; padding:28px; }
  .features .label { color:var(--mint); text-transform:none; letter-spacing:0; font-size:13px; }
  .features h3 { margin:0 0 8px; font-size:22px; }
  .features p { margin:0; color:var(--muted); }

  #start { border-top:1px solid var(--rule); }
  #start .head { text-align:center; margin:0 0 32px; }
  #start .head .lede { margin:0 auto; }
  .panel { --ink:#111216; --soft:#4a4c55; --line:#d5d7de; --mist:#f3f4f7; --bad:#b23a1e; max-width:760px; margin:0 auto; background:#fff; color:var(--ink); border-radius:20px; padding:36px; }
  .panel a { color:#1f6b45; }
  .panel :focus-visible { outline-color:#1f7a4d; }
  @media (max-width:640px) { .panel { padding:22px; } }
  .foot-note { border-top:1px solid var(--rule); padding:28px 24px 48px; font-size:14px; color:var(--dim); }

  .panel label { display:block; font-weight:600; margin:0 0 6px; }
  .hint { font-size:14px; color:var(--soft); margin:0 0 8px; font-weight:400; }
  input[type=text], input[type=password], input[type=url], textarea {
    width:100%; font:inherit; padding:10px 12px; border:1px solid var(--line);
    border-radius:10px; background:#fff; color:inherit; resize:vertical; }
  textarea { min-height:90px; }
  fieldset { border:0; padding:0; margin:0 0 26px; }
  .task { display:grid; gap:8px; padding:14px 16px; border:1px solid var(--line); border-radius:12px; background:#fff; margin:0 0 10px; }
  .task .top { display:flex; gap:10px; align-items:center; }
  .task .top input { flex:1; }
  .task .chk { display:flex; gap:8px; align-items:center; flex-wrap:wrap; font-size:14px; color:var(--soft); font-weight:400; }
  .task .chk select { font:inherit; font-size:14px; padding:6px 8px; border:1px solid var(--line); border-radius:8px; background:#fff; color:inherit; max-width:100%; }
  .task .chk .t-words { flex:1; min-width:160px; }
  .drop { all:unset; cursor:pointer; color:var(--soft); font-size:20px; line-height:1; padding:2px 8px; border-radius:8px; }
  .drop:hover { background:rgba(22,24,28,.06); }
  .add { all:unset; cursor:pointer; font-weight:600; text-decoration:underline; text-underline-offset:3px; }
  .tabs { display:flex; gap:8px; margin:0 0 10px; }
  .setpick { font:inherit; padding:10px 12px; border:1px solid var(--line); border-radius:10px; background:#fff; color:inherit; width:100%; }
  .cmp-toggle { display:flex; gap:8px; align-items:center; margin:14px 0 0; font-weight:500; cursor:pointer; }
  .names { display:grid; grid-template-columns:1fr 1fr; gap:8px; margin:0 0 10px; }
  @media (max-width:560px) { .names { grid-template-columns:1fr; } }
  .tabs button { all:unset; cursor:pointer; padding:7px 14px; border-radius:999px; border:1px solid var(--line); background:#fff; font-size:15px; }
  .tabs button.on { background:var(--ink); color:#fff; border-color:var(--ink); }
  .add:focus-visible, .drop:focus-visible, .tabs button:focus-visible { outline:2px solid #1f7a4d; outline-offset:2px; }
  .err { color:var(--bad); font-weight:600; }
  /* the first question: test it, or show it */
  .modes { display:grid; grid-template-columns:1fr 1fr; gap:10px; }
  @media (max-width:560px) { .modes { grid-template-columns:1fr; } }
  .panel .mode { position:relative; display:flex; flex-direction:column; gap:4px; padding:16px 16px 16px 46px; border:1px solid var(--line); border-radius:14px; cursor:pointer; font-weight:400; margin:0; }
  .mode input { position:absolute; left:16px; top:18px; width:18px; height:18px; accent-color:var(--ink); margin:0; }
  .mode strong { font-size:17px; }
  .mode span { font-size:14px; color:var(--soft); }
  .mode:has(input:checked) { border-color:var(--ink); box-shadow:0 0 0 1px var(--ink); background:#f7fbf8; }
  #f[data-mode="test"] .t-point { display:none; }
  .panel input[type=color] { width:100%; height:44px; padding:4px; border:1px solid var(--line); border-radius:10px; background:#fff; cursor:pointer; }
  .panel .go { background:var(--ink); color:#fff; }
  .panel .go:hover { background:#2a2c33; }
  .out { margin:26px 0 0; padding:20px 22px; border:1px solid var(--line); border-radius:16px; background:#fff; }
  .out code { display:block; font:14px/1.6 ui-monospace,SFMono-Regular,Menlo,monospace; word-break:break-all; padding:8px 10px; background:var(--mist); border-radius:8px; margin:4px 0 14px; }
  /* Spelled out because the controls here use all:unset, which throws away the
     browser's own rule for the hidden attribute. */
  [hidden] { display:none !important; }
</style></head><body>

<header class="shell topbar">
  <a class="brand" href="/"><b aria-hidden="true">▍</b>playground/usertest</a>
  <nav aria-label="On this page">
    <a href="#start">Use the form</a>
    <a href="#sets">Ready-made sets</a>
    <a class="mono" href="/llms.txt">/llms.txt</a>
    <a class="mono" href="/mcp">/mcp</a>
  </nav>
</header>

<div class="shell hero">
  <p class="eyebrow">NO INSTALL · NO ACCOUNTS · BUILT ON WORDPRESS PLAYGROUND</p>
  <h1>WordPress user testing and tours, made easy.</h1>
  <p class="sub" id="askSub">Watch real people try your plugin or theme in a real WordPress. Copy this into ChatGPT, Claude or any assistant: it drafts the test with you, then makes it or hands it to you to paste.</p>
  <div class="ask" role="radiogroup" aria-label="What do you want to do?">
    <button type="button" role="radio" aria-checked="true" data-ask="test"><b>Test it</b><span>people try it on their own</span></button>
    <button type="button" role="radio" aria-checked="false" data-ask="tour"><b>Show it</b><span>a tour that plays itself</span><em>New</em></button>
  </div>
  <div class="prompt">
    <p id="promptText">Help me set up a user test of my WordPress plugin, theme or site with Playground user testing. Draft the persona and tasks with me, then make it, or give me the block to paste.</p>
    <p class="more">+ the full instructions for your assistant, copied with it</p>
    <div class="under">
      <span>Or add it to ChatGPT or Claude as a custom connector: <span class="addr" id="mcpAddr">https://playground-usertest.view.fast/mcp</span></span>
      <button type="button" class="copy" id="copy">Copy prompt</button>
    </div>
  </div>
  <p class="or">Works in ChatGPT, Claude, Cursor or any assistant. If yours can’t reach this site, it hands you a block to <a href="#paste">paste in here</a>.</p>
  <p class="or">Rather type it yourself? <a href="#start">Fill in the form</a>. It takes about half a minute.</p>
  <p class="taken" id="taken" hidden aria-live="polite"><i aria-hidden="true"></i><span><b id="takenN">0</b> tests taken so far</span></p>
</div>

<div class="shell">
  <div class="warn">
    <svg aria-hidden="true" width="40" height="40" viewBox="0 0 40 40" fill="none" stroke="#ffb86b" stroke-width="2.4"><rect x="9" y="18" width="22" height="16" rx="3"/><path d="M14 18v-5a6 6 0 0 1 12 0v5"/></svg>
    <div>
      <h3>Ask it for the password.</h3>
      <p>There are no accounts, so the results password is the only key, and it cannot be looked up again by anyone, including us. If your assistant makes a test and does not pass the password on, nothing your testers write can ever be read.</p>
    </div>
  </div>
</div>

<section aria-labelledby="catch">
  <div class="shell split">
    <div class="words">
      <h2 class="big" id="catch">It catches the mistakes for you.</h2>
      <p>Two things quietly ruin a test: a task that names the button, and a persona named after the demo site. Your assistant runs the check before anything goes out.</p>
      <p>Then it hands over a link for testers, a link for results, and the password.</p>
    </div>
    <div class="chat" aria-label="What the conversation looks like">
      <div class="bubble you">Tasks look good? “Click Appearance → Editor → Styles to change the colours.”</div>
      <div class="bubble it">
        <p class="tool">usertest_check · 1 issue</p>
        <p>That one names the control, so it tests whether they can follow instructions, not whether they can find it. Try:</p>
        <p class="fix">“Give the site colours that feel like your studio”</p>
        <p class="hintline">hint: Appearance → Editor → Styles</p>
      </div>
      <div class="bubble it">
        <p>Your test is ready.</p>
        <dl class="handover"><dt>testers</dt><dd>the link to send people</dd><dt>results</dt><dd>the link to read what happened</dd><dt>password</dt><dd class="key">shown once, so save it now</dd></dl>
      </div>
    </div>
  </div>
</section>

<section aria-labelledby="see" style="padding-top:0">
  <div class="shell">
    <h2 class="big" id="see">What your testers get.</h2>
    <p class="demo-intro">A real WordPress in their browser, and a card of things to try. Have a go: press Done and watch the site change.</p>
    <div class="browser">
      <div class="chrome" aria-hidden="true"><i></i><i></i><i></i><span>A fresh WordPress, just for this tester</span></div>
      <div class="stage">
        <div class="site" id="dSite" aria-label="The pretend site" role="img">
          <div class="site-head">
            <span class="site-name" id="dName">My Starter Site</span>
            <span class="site-menu"><span>Home</span><span>Shop</span><span>About</span><span class="new" id="dContact" hidden>Contact</span></span>
          </div>
          <div class="site-hero"><p id="dHeadline">Welcome to your new site</p><span>See the work</span></div>
          <div class="site-body">
            <div class="photo" id="dPhoto">
              <svg id="dPlain" aria-hidden="true" width="56" height="44" viewBox="0 0 56 44" fill="none" stroke="#8a90a0" stroke-width="2.5"><rect x="2" y="2" width="52" height="40" rx="4"/><path d="M2 34l16-14 12 10 8-6 16 12"/><circle cx="40" cy="13" r="4"/></svg>
              <svg id="dPot" hidden aria-hidden="true" width="90" height="110" viewBox="0 0 90 110" fill="none" stroke="#6e3a1e" stroke-width="3"><path d="M28 10h34M32 10c0 14-22 24-22 52 0 22 16 38 35 38s35-16 35-38c0-28-22-38-22-52"/><path d="M14 60h62"/></svg>
            </div>
            <div class="lines" aria-hidden="true"><i style="width:70%;height:12px;background:#e4e6eb"></i><i></i><i style="width:90%"></i><i style="width:60%"></i></div>
          </div>
        </div>
        <div class="tcard">
          <p class="who">You make pots in a small studio called Ash &amp; Clay. Make this site feel like yours.</p>
          <div class="head"><strong>Things to try</strong><span id="dProgress" aria-live="polite">1 of ${DEMO.tasks.length}</span></div>
          <ol class="tlist" id="dList">${DEMO.tasks.map((t, i) => `<li${i === 0 ? ' class="now"' : ''}><svg aria-hidden="true" width="18" height="18" viewBox="0 0 18 18" fill="none" stroke-width="2"></svg><span>${esc(t.title)}</span></li>`).join('')}</ol>
          <p class="thint" id="dHint" hidden></p>
          <div class="tbtns" id="dBtns">
            <button type="button" class="primary" id="dDone">Done</button>
            <button type="button" id="dCouldnt">I couldn’t</button>
            <button type="button" id="dHintBtn" aria-expanded="false" aria-controls="dHint">Hint</button>
          </div>
          <div class="tdone" id="dFinished" hidden>
            <p><strong>That’s everything. Thank you.</strong></p>
            <p>Your run just landed in <a href="#results">the results below</a>.</p>
            <div class="tbtns" style="margin:0"><button type="button" id="dReset">Start again</button></div>
          </div>
        </div>
      </div>
    </div>
    <div class="table" id="results">
      <table>
        <caption id="rCaption">Results · ${esc(DEMO.name)} · try the demo above and your run shows up here</caption>
        <thead><tr><th scope="col">Task</th><th scope="col">Done</th><th scope="col">Couldn’t</th><th scope="col">Hint</th></tr></thead>
        <tbody id="rBody">${DEMO.tasks.map((t) => `<tr><td>${esc(t.title)}</td><td>–</td><td>–</td><td>–</td></tr>`).join('')}</tbody>
      </table>
      <p class="foot">What you read back: who finished each task, who couldn’t, who never got there and who opened the hint, checked against the site itself. Plus their notes and four quick questions at the end. Then one button copies the lot for Claude or ChatGPT to tell you what to fix first.</p>
    </div>
  </div>
</section>

<section class="tourshow" aria-labelledby="tour-h" style="padding-top:0">
  <div class="shell split">
    <div class="words">
      <p class="label" style="color:var(--mint)">New · Show it</p>
      <h2 class="big" id="tour-h">Or show them round.</h2>
      <p>The same link, turned round. Instead of watching people try your plugin, a tour shows them: it clicks through a real WordPress by itself while they watch, and they can pause and try it any time.</p>
      <ul class="points">
        <li><b>A pointer you can’t miss</b>, with a halo in your colour.</li>
        <li><b>Out of the way when they want it.</b> Hide the card and it tucks into a pill; the tour carries on.</li>
        <li><b>Your colours, your voice.</b> Add a recording to each step, or let the browser read it.</li>
        <li><b>Made by chatting.</b> Tell your assistant what to show; it writes the steps and the script.</li>
        <li><b>Ends on your button:</b> “Get the plugin”, “Read the release post”.</li>
      </ul>
      <div class="brandrow" role="group" aria-label="Try your brand colour">
        <span>Try your colour:</span>
        <button type="button" class="sw" style="background:#6c5ce7" data-c="#6c5ce7" aria-pressed="true" aria-label="Purple"></button>
        <button type="button" class="sw" style="background:#7cf2b0" data-c="#7cf2b0" aria-pressed="false" aria-label="Mint"></button>
        <button type="button" class="sw" style="background:#ff6b3d" data-c="#ff6b3d" aria-pressed="false" aria-label="Orange"></button>
        <button type="button" class="sw" style="background:#0a7cff" data-c="#0a7cff" aria-pressed="false" aria-label="Blue"></button>
        <input type="color" id="brandPick" value="#6c5ce7" aria-label="Any colour">
        <button type="button" class="cardpick" id="cardPick">Light card</button>
      </div>
      <a class="copy" href="/demo/tour" target="_blank" rel="noopener" style="text-decoration:none;display:inline-block">Watch a tour</a>
    </div>
    <div class="browser">
      <div class="chrome" aria-hidden="true"><i></i><i></i><i></i><span>A tour, playing in a real WordPress</span></div>
      <div class="stage2" aria-label="A tour playing" role="img">
        <div class="side"><p class="on">Styles</p><p>Browse styles</p><p>Typography</p><p>Colors</p><p>Layout</p></div>
        <div class="looks"><i>Aa</i><i class="dark pick">Aa<svg class="ptr" viewBox="0 0 24 24" aria-hidden="true"><path d="M3 2l7 19 2.6-7.4L20 11z" fill="#fff" stroke="#111" stroke-width="1.6" stroke-linejoin="round"/></svg></i><i>Aa</i><i class="sage">Aa</i><i>Aa</i><i class="plum">Aa</i></div>
        <div class="tcard2">
          <div class="top"><span>STEP 3 OF 5</span><span>Sound on · <button type="button" class="hideb" id="hideCard">Hide</button></span></div>
          <h4>A new look in one click</h4>
          <p class="say">Styles has ready-made looks. One click changes the colours and fonts across the whole site.</p>
          <p class="playing">Playing</p>
          <div class="btns"><span>Skip</span><span class="go">Pause</span></div>
        </div>
        <button type="button" class="pill2" id="showCard" hidden>Tour · step 3 of 5</button>
      </div>
    </div>
  </div>
</section>

<section id="sets" aria-labelledby="sets-h" style="padding-top:0">
  <div class="shell">
    <h2 class="big" id="sets-h">Not sure what to ask? Start from a set.</h2>
    <p class="lede">A persona and tasks for the tests most people run, with hints and checks already in. Tell your assistant the set’s name, or use it in the form.</p>
    <div class="chips" role="group" aria-label="Ready-made sets">${TASK_SETS.map((x, i) => `<button type="button" class="chip" data-set="${x.key}" aria-pressed="${i === 0}">${esc(x.name)}</button>`).join('')}</div>
    <div class="setview">
      <div>
        <p class="label">Good for</p><p id="sFor" style="font-weight:600">${esc(DEMO.for)}</p>
        <p class="label">The tester is</p><p id="sPersona" style="color:var(--muted)">${esc(DEMO.persona)}</p>
        <button type="button" class="ghost" id="sUse">Use this set in the form</button>
      </div>
      <div>
        <p class="label">Things to try</p>
        <ol id="sTasks">${DEMO.tasks.map((t) => `<li>${esc(t.title)}</li>`).join('')}</ol>
      </div>
    </div>
  </div>
</section>

<section style="padding-top:0">
  <div class="shell features">
    <div><p class="label">→ compare</p><h3>Test two versions</h3><p>Same tasks, two or three sites. One link shares testers out evenly, and the results come back side by side.</p></div>
    <div><p class="label">→ webhook</p><h3>Hear when they finish</h3><p>Each tester who finishes is posted to Slack, Discord or any HTTPS endpoint. Never the password.</p></div>
    <div><p class="label">→ nothing to install</p><h3>At either end</h3><p>Testers need a browser and nothing else. You need a blueprint, the one you already demo with.</p></div>
  </div>
</section>

<section id="start">
<div class="shell">
<div class="head">
  <h2 class="big">Or fill it in yourself.</h2>
  <p class="lede">The same test, made by hand. About half a minute.</p>
</div>
<div class="panel" id="paste" style="margin-bottom:24px">
  <label for="pasted">Paste from your assistant</label>
  <p class="hint">The block of text it gave you. It fills in the form below; nothing is made until you press the button at the bottom.</p>
  <textarea id="pasted" rows="5" spellcheck="false" placeholder='{ "mode": "tour", "subject": "…", "tasks": [ … ] }'></textarea>
  <button type="button" class="go" id="usePasted" style="margin-top:12px">Fill in the form</button>
  <p class="hint" id="pasteMsg" role="status" aria-live="polite" style="margin:10px 0 0"></p>
</div>
<div class="panel">
<form id="f" data-mode="test">
<fieldset>
  <label>What is this link for?</label>
  <div class="modes" role="radiogroup" aria-label="What is this link for?">
    <label class="mode" for="mTest"><input type="radio" name="mode" id="mTest" value="test" checked><strong>Test it</strong><span>People try things on their own. Hints stay hidden until they are stuck, and four questions come at the end.</span></label>
    <label class="mode" for="mShow"><input type="radio" name="mode" id="mShow" value="tour"><strong>Show it</strong><span>A tour that plays itself. Each step clicks through while people watch, and they can pause and try. It ends with a button.</span></label>
  </div>
</fieldset>

<fieldset>
  <label for="set">Start from a ready-made set <span class="soft">(optional)</span></label>
  <p class="hint">A persona and tasks for the tests most people run, with hints and checks already in. Change anything you like.</p>
  <select id="set" class="setpick"><option value="">My own tasks</option>${TASK_SETS.map((x) => `<option value="${x.key}">${esc(x.name)}</option>`).join('')}<optgroup label="Tours">${TOUR_SETS.map((x) => `<option value="${x.key}">${esc(x.name)}</option>`).join('')}</optgroup></select>
  <p class="hint" id="setfor" hidden></p>
</fieldset>

<fieldset>
  <label for="subject" data-test="What are you testing?" data-tour="What are you showing?">What are you testing?</label>
  <p class="hint" data-test="Goes in the tester’s first line: “Thank you for helping make this better.”" data-tour="Heads the welcome page: “A short tour of this.”">Goes in the tester’s first line: “Thank you for helping make this better.”</p>
  <input type="text" id="subject" maxlength="80" placeholder="my theme" required>
</fieldset>

<fieldset>
  <label for="persona" data-test="Who should they pretend to be?" data-tour="Who is it for? (optional)">Who should they pretend to be?</label>
  <p class="hint" data-test="A paragraph. Give them a reason to want the site, not just instructions. Don’t use the demo site’s own name, or “rename the site” has nothing to change." data-tour="One line on the welcome page. Nobody plays a part in a tour: they are themselves.">A paragraph. Give them a reason to want the site, not just instructions. Don’t use the demo site’s own name, or “rename the site” has nothing to change.</p>
  <textarea id="persona" maxlength="2000" required placeholder="You are a photographer a few months into running your own business. Customers keep asking whether you have a website…"></textarea>
</fieldset>

<fieldset>
  <label data-test="What should they try?" data-tour="What should they see?">What should they try?</label>
  <p class="hint" data-test="Five to seven works well. Say what they want, not which button to press — the hint is there for when they are stuck." data-tour="Three to six steps. Each says what it shows, and lists what it presses, one per line: a CSS selector or button &quot;Styles&quot;, or type &quot;words&quot; into …, press Escape, go /wp-admin/…, wait 2. A check confirms each step worked.">Five to seven works well. Say what they want, not which button to press — the hint is there for when they are stuck.</p>
  <div id="tasks"></div>
  <button type="button" class="add" id="add" data-test="Add another" data-tour="Add a step">Add another</button>
  <div data-only="tour" hidden style="margin-top:14px">
    <button type="button" class="add" id="recordBtn">Record the clicks in Playground</button>
    <p class="hint" id="recordMsg" style="margin:8px 0 0">Not sure what each step should press? Open the site in Playground, do each step yourself, and the card writes down exactly what you pressed. Then copy it and paste it into Paste from your assistant above. Say what WordPress to open (below) first.</p>
  </div>
</fieldset>

<fieldset>
  <label for="lang">Language</label>
  <p class="hint">The tester’s WordPress, the card and the welcome page all switch to it. Write your tasks in it too.</p>
  <select id="lang" class="setpick">${Object.keys(LOCALES).map((k) => `<option value="${k === 'en' ? '' : LOCALES[k]}">${esc(LANG_NAMES[k])}</option>`).join('')}</select>
</fieldset>

<fieldset data-only="tour" hidden>
  <label for="accent">Colours <span class="soft">(optional)</span></label>
  <p class="hint">An accent for the card’s buttons, the ring and the pointer, and a dark or light card. Your brand colour works; it is kept readable.</p>
  <div class="names"><input type="color" id="accent" value="#7cf2b0" aria-label="Accent colour"><select id="cardTone" class="setpick" aria-label="Card"><option value="dark">Dark card</option><option value="light">Light card</option></select></div>
</fieldset>

<fieldset data-only="tour" hidden>
  <label for="btnLabel">End with a button <span class="soft">(optional)</span></label>
  <p class="hint">Instead of the four questions. What should they do once they have seen it?</p>
  <div class="names"><input type="text" id="btnLabel" maxlength="40" placeholder="Get the plugin"><input type="url" id="btnUrl" maxlength="600" placeholder="https://wordpress.org/plugins/…"></div>
</fieldset>

<fieldset>
  <label>What WordPress should they get?</label>
  <p class="hint">WordPress on its own, or with your plugin or theme added. Already demo with a Playground blueprint? Use that instead: a URL is read once, now, and kept, so everyone gets the same site.</p>
  <div class="tabs" style="flex-wrap:wrap"><button type="button" data-bp="wp">Just WordPress</button><button type="button" class="on" data-bp="boot">A plugin or theme</button><button type="button" data-bp="url">Blueprint URL</button><button type="button" data-bp="json">Blueprint JSON</button></div>
  <div id="bpboot" class="names"><input type="text" id="sitePlugin" maxlength="300" placeholder="Plugin: WordPress.org slug or zip link" aria-label="Plugin"><input type="text" id="siteTheme" maxlength="300" placeholder="Theme (optional): slug or zip link" aria-label="Theme"></div>
  <p class="hint" id="bpwp" hidden style="margin:0">A fresh WordPress with a few sample pages: good for teaching WordPress itself.</p>
  <input type="url" id="bpurl" hidden placeholder="https://example.com/blueprint.json">
  <textarea id="bpjson" hidden placeholder='{ "steps": [ … ] }'></textarea>
  <label class="cmp-toggle"><input type="checkbox" id="compare"> Compare it with a second version</label>
  <p class="hint">Same tasks on both. One link shares testers out evenly, and the results come back side by side.</p>
</fieldset>

<fieldset id="second" hidden>
  <label>The second version</label>
  <p class="hint">Name both, so the results say which is which.</p>
  <div class="names"><input type="text" id="labelA" maxlength="60" placeholder="First version, e.g. Today’s onboarding"><input type="text" id="labelB" maxlength="60" placeholder="Second version, e.g. New onboarding"></div>
  <div class="tabs"><button type="button" class="on" data-bp2="url">A URL</button><button type="button" data-bp2="json">Paste JSON</button></div>
  <input type="url" id="bp2url" placeholder="https://example.com/blueprint-b.json">
  <textarea id="bp2json" hidden placeholder='{ "steps": [ … ] }'></textarea>
</fieldset>

<fieldset>
  <label for="password" data-test="A password for the results page" data-tour="A password for the tour numbers">A password for the results page</label>
  <p class="hint">There are no accounts here. This password is the only thing in front of your testers’ notes, and it cannot be recovered — keep it somewhere.</p>
  <input type="password" id="password" minlength="6" maxlength="200" required>
</fieldset>

<fieldset>
  <label for="webhook">Tell a channel when someone finishes <span class="soft">(optional)</span></label>
  <p class="hint">Paste a Slack or Discord webhook link and each tester who finishes is posted there: what they managed, what the site showed, and their answers. Never the password.</p>
  <input type="url" id="webhook" maxlength="600" placeholder="https://hooks.slack.com/services/…">
</fieldset>

<p id="msg" class="err" role="alert"></p>
<button type="submit" class="go" id="submit" data-test="Make the test" data-tour="Make the tour">Make the test</button>
</form>

<div id="out"></div>
</div>
</div>
</section>

<footer class="foot-note"><div class="shell" style="padding:0">Every tester gets a throwaway site in their own browser. The only thing kept is what the card learns. <a href="/llms.txt">llms.txt</a> · <a href="/mcp">MCP</a></div></footer>
<script>
(function () {
  var tasksEl = document.getElementById('tasks');
  var mode = 'boot';

  // The prompt leads the page; it names this address, so a copy of the
  // service answers for itself rather than sending people to someone else's.
  var origin = location.origin;
  document.getElementById('mcpAddr').textContent = origin + '/mcp';
  var testText = document.getElementById('promptText').textContent;
  var tourText = 'Help me make a guided tour of a WordPress plugin, theme or WordPress itself that plays itself. Write the steps and the voice script with me, in my colours, then make it, or give me the block to paste.';
  var PLAIN = ${JSON.stringify({ test: plainPrompt('test'), tour: plainPrompt('tour') })};
  function fullPrompt() {
    var on = document.querySelector('.ask button[aria-checked="true"]');
    return PLAIN[on && on.getAttribute('data-ask') === 'tour' ? 'tour' : 'test'].split('{ORIGIN}').join(origin);
  }
  var subs = {
    test: document.getElementById('askSub').textContent,
    tour: 'Show people round your plugin, your theme or WordPress itself, in a real WordPress, in your colours and your voice. Copy this into ChatGPT, Claude or any assistant: it writes the tour with you, then makes it or hands it to you to paste.'
  };
  Array.prototype.forEach.call(document.querySelectorAll('.ask button'), function (b) {
    b.addEventListener('click', function () {
      var k = b.getAttribute('data-ask');
      Array.prototype.forEach.call(document.querySelectorAll('.ask button'), function (x) { x.setAttribute('aria-checked', String(x === b)); });
      document.getElementById('promptText').textContent = k === 'tour' ? tourText : testText;
      document.getElementById('askSub').textContent = subs[k];
    });
  });

  // The tour preview: a brand colour, a dark or light card, and Hide.
  (function () {
    var box = document.querySelector('.tourshow'), card = box.querySelector('.tcard2'), pill = document.getElementById('showCard');
    function lum(h) { var n = parseInt(h.slice(1), 16), f = function (c) { c /= 255; return c <= .03928 ? c / 12.92 : Math.pow((c + .055) / 1.055, 2.4); }; return .2126 * f(n >> 16 & 255) + .7152 * f(n >> 8 & 255) + .0722 * f(n & 255); }
    function paint(c) {
      box.style.setProperty('--tour', c);
      var light = card.classList.contains('light'), bg = light ? 1 : lum('#16181c'), l = lum(c);
      var ratio = (Math.max(l, bg) + .05) / (Math.min(l, bg) + .05);
      box.style.setProperty('--tour-text', ratio >= 4.5 ? c : (light ? '#3a3e46' : '#e8eaee'));
      pill.style.color = lum(c) > .4 ? '#16181c' : '#fff';
      card.querySelector('.go').style.color = lum(c) > .4 ? '#16181c' : '#fff';
    }
    var current = '#6c5ce7';
    Array.prototype.forEach.call(document.querySelectorAll('.brandrow .sw'), function (b) {
      b.addEventListener('click', function () {
        Array.prototype.forEach.call(document.querySelectorAll('.brandrow .sw'), function (x) { x.setAttribute('aria-pressed', String(x === b)); });
        current = b.getAttribute('data-c'); document.getElementById('brandPick').value = current; paint(current);
      });
    });
    document.getElementById('brandPick').addEventListener('input', function () {
      Array.prototype.forEach.call(document.querySelectorAll('.brandrow .sw'), function (x) { x.setAttribute('aria-pressed', 'false'); });
      current = this.value; paint(current);
    });
    document.getElementById('cardPick').addEventListener('click', function () {
      var light = card.classList.toggle('light'); this.textContent = light ? 'Dark card' : 'Light card'; paint(current);
    });
    document.getElementById('hideCard').addEventListener('click', function () { card.hidden = true; pill.hidden = false; });
    pill.addEventListener('click', function () { pill.hidden = true; card.hidden = false; });
  })();

  // Tests taken, counted up when the page opens and again whenever someone
  // else finishes a task while it is open. It looks every half minute.
  var takenBox = document.getElementById('taken'), takenN = document.getElementById('takenN'), shown = 0;
  function countTo(n) {
    var from = shown, start = null, ms = from ? 900 : 1400;
    if (n <= from) return;
    shown = n;
    takenN.classList.toggle('up', from > 0);
    var reduce = window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (reduce) { takenN.textContent = n; return; }
    // a timer rather than animation frames: some views never paint frames
    // (embedded panes, screenshot tools), and the number must still arrive
    start = Date.now();
    (function step() {
      var k = Math.min(1, (Date.now() - start) / ms), eased = 1 - Math.pow(1 - k, 3);
      takenN.textContent = Math.round(from + (n - from) * eased);
      if (k < 1) setTimeout(step, 30);
      else setTimeout(function () { takenN.classList.remove('up'); }, 1200);
    })();
  }
  function lookTaken() {
    fetch('/api/stats', { cache: 'no-store' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (d) { if (d && d.tests) { takenBox.hidden = false; countTo(d.tests); } })
      .catch(function () {});
  }
  lookTaken();
  setInterval(function () { if (!document.hidden) lookTaken(); }, 30000);

  document.getElementById('copy').addEventListener('click', function () {
    var btn = this;
    var text = fullPrompt();
    var done = function () { btn.textContent = 'Copied'; setTimeout(function () { btn.textContent = 'Copy prompt'; }, 1600); };
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(done, function () {});
    else {
      // Older browsers, and any page not served over https.
      var ta = document.createElement('textarea');
      ta.value = text; document.body.appendChild(ta); ta.select();
      try { document.execCommand('copy'); done(); } catch (e) {}
      ta.remove();
    }
  });

  function esc(v) { return String(v == null ? '' : v).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
  var CHECK_OPTIONS = ${JSON.stringify(Object.keys(CHECKS).map((k) => `<option value="${k}">${CHECKS[k]}</option>`).join(''))};
  var SETS = ${JSON.stringify(ALL_SETS)};
  var form = document.getElementById('f');
  var WORDS = {
    test: { title: 'Give the site your own name', hint: 'Hint, shown only if they ask (optional)', none: 'Don\u2019t check this one', know: 'How we\u2019ll know they did it' },
    tour: { title: 'A new look in one click', hint: 'What the card says, e.g. Styles has ready-made looks for the whole site.', none: 'Don\\u2019t check this one', know: 'Check it worked' },
  };
  function wordsFor(d) {
    var w = WORDS[form.dataset.mode];
    d.querySelector('.t-title').placeholder = w.title;
    d.querySelector('.t-hint').placeholder = w.hint;
    d.querySelector('.t-none').textContent = w.none;
    d.querySelector('.t-know').textContent = w.know;
  }
  function addTask(title, hint, check, point, does, said) {
    var d = document.createElement('div');
    d.className = 'task';
    d.innerHTML =
      '<div class="top"><input type="text" class="t-title" maxlength="200" placeholder="Give the site your own name"></div>' +
      '<input type="text" class="t-hint" maxlength="300" placeholder="Hint, shown only if they ask (optional)">' +
      // how the site can show it happened: read off the tester\u2019s site when
      // they press Done, so the results are not only their word for it
      '<label class="chk"><span class="t-know">How we\u2019ll know they did it</span> <select class="t-check">' +
        '<option value="">Work it out from the task</option>' + CHECK_OPTIONS +
        '<option value="none" class="t-none">Don\u2019t check this one</option></select>' +
        '<input type="text" class="t-words" maxlength="120" placeholder="The words to look for" hidden>' +
        '<input type="text" class="t-block" maxlength="100" placeholder="The block, e.g. my-plugin/my-block" hidden>' +
        '<input type="text" class="t-path" maxlength="120" placeholder="Part of its address, e.g. site-editor.php" hidden></label>' +
      // a tour step can point at the thing to click
      '<label class="chk t-point">The voice says <textarea class="t-words t-say" rows="2" maxlength="600" placeholder="Optional. Written to be heard, e.g. Styles is where the look of the whole site comes together."></textarea></label>' +
      '<label class="chk t-point">It presses <textarea class="t-words t-do" rows="3" placeholder="One per line, e.g.&#10;button &quot;Styles&quot;&#10;button &quot;Browse styles&quot;"></textarea></label>' +
      '<label class="chk t-point">Ring when paused <input type="text" class="t-words t-sel" maxlength="200" placeholder="A CSS selector, or button &quot;Styles&quot; (optional)"></label>';
    var drop = document.createElement('button');
    drop.type = 'button';
    drop.className = 'drop';
    drop.title = 'Remove';
    drop.textContent = '\\u00d7';
    drop.addEventListener('click', function () { d.remove(); });
    d.querySelector('.top').appendChild(drop);
    if (title) d.querySelector('.t-title').value = title;
    if (hint) d.querySelector('.t-hint').value = hint;
    if (point) d.querySelector('.t-sel').value = point;
    if (said) d.querySelector('.t-say').value = said;
    if (does) d.querySelector('.t-do').value = typeof does === 'string' ? does : does.map(function (a) { return typeof a === 'string' ? a : (a.click || ''); }).join('\\n');
    var sel = d.querySelector('.t-check');
    var shape = function () {
      d.querySelector('.t-words').hidden = sel.value !== 'text';
      d.querySelector('.t-block').hidden = sel.value !== 'block' && sel.value !== 'block_changed';
      d.querySelector('.t-path').hidden = sel.value !== 'page';
    };
    if (check && typeof check === 'object') {
      sel.value = check.type;
      if (check.text) d.querySelector('.t-words').value = check.text;
      if (check.block) d.querySelector('.t-block').value = check.block;
      if (check.path) d.querySelector('.t-path').value = check.path;
    } else if (check) sel.value = check;
    sel.addEventListener('change', shape);
    shape();
    wordsFor(d);
    tasksEl.appendChild(d);
  }

  // Test it or show it. The form keeps everything typed and changes its words;
  // a tour has no persona to play, so that box is no longer required.
  function setMode(m) {
    form.dataset.mode = m;
    document.getElementById(m === 'tour' ? 'mShow' : 'mTest').checked = true;
    [].slice.call(form.querySelectorAll('[data-test]')).forEach(function (el) { el.textContent = el.getAttribute('data-' + m); });
    [].slice.call(form.querySelectorAll('[data-only]')).forEach(function (el) { el.hidden = el.dataset.only !== m; });
    document.getElementById('persona').required = m !== 'tour';
    [].slice.call(tasksEl.querySelectorAll('.task')).forEach(wordsFor);
  }
  [].slice.call(form.querySelectorAll('input[name=mode]')).forEach(function (r) {
    r.addEventListener('change', function () { setMode(r.value); });
  });
  for (var i = 0; i < 5; i++) addTask();

  // a ready-made set fills the persona and the tasks; the owner edits from there
  var setPick = document.getElementById('set'), setFor = document.getElementById('setfor'), lastSetPersona = '';
  setPick.addEventListener('change', function () {
    var set = SETS.filter(function (x) { return x.key === setPick.value; })[0];
    setFor.hidden = !set;
    if (!set) return;
    setFor.textContent = set.for;
    // a ready-made tour makes the form a tour, and a test set a test
    setMode(set.mode === 'tour' ? 'tour' : 'test');
    if (set.button) {
      document.getElementById('btnLabel').value = set.button.label;
      document.getElementById('btnUrl').value = set.button.url;
    }
    var persona = document.getElementById('persona');
    if (!persona.value.trim() || persona.value === lastSetPersona) { persona.value = set.persona; lastSetPersona = set.persona; }
    tasksEl.innerHTML = '';
    set.tasks.forEach(function (t) { addTask(t.title, t.hint, t.check, t.point, t.do, t.say); });
  });
  document.getElementById('add').addEventListener('click', function () { addTask(); });

  // What an assistant handed back, pasted whole: the JSON is found inside
  // whatever came with it (a code fence, a sentence either side), and fills
  // the form the way a ready-made set does. The password stays the owner's.
  var LOCALES = ${JSON.stringify(LOCALES)};
  var pasteMsg = document.getElementById('pasteMsg');
  document.getElementById('usePasted').addEventListener('click', function () {
    var raw = document.getElementById('pasted').value;
    var a = raw.indexOf('{'), b = raw.lastIndexOf('}');
    var d;
    try { d = JSON.parse(raw.slice(a, b + 1)); } catch (e) { d = null; }
    if (!d || typeof d !== 'object' || Array.isArray(d)) { pasteMsg.textContent = 'That doesn’t read as the JSON block. Paste the whole block your assistant gave you, from { to }.'; return; }
    var tasks = Array.isArray(d.tasks) ? d.tasks : [];
    if (!tasks.length) { pasteMsg.textContent = 'There are no tasks in it. Ask your assistant to include them.'; return; }
    setMode(d.mode === 'tour' ? 'tour' : 'test');
    setPick.value = ''; setFor.hidden = true;
    var put = function (id, v) { if (v != null && v !== '') document.getElementById(id).value = String(v); };
    put('subject', d.subject);
    put('persona', d.persona);
    var lang = String(d.lang || '').replace('-', '_');
    if (LOCALES[lang.toLowerCase()]) lang = LOCALES[lang.toLowerCase()];
    var langPick = document.getElementById('lang');
    if (lang && lang !== 'en_US' && !langPick.querySelector('option[value="' + lang.replace(/"/g, '') + '"]')) {
      var o = document.createElement('option'); o.value = lang; o.textContent = lang; langPick.appendChild(o);
    }
    langPick.value = lang === 'en_US' ? '' : lang;
    tasksEl.innerHTML = '';
    tasks.forEach(function (t) { if (t && t.title) addTask(t.title, t.hint, t.check, t.point, t['do'], t.say); });
    if (d.button) { put('btnLabel', d.button.label); put('btnUrl', d.button.url); }
    if (d.theme) {
      if (/^#[0-9a-f]{6}$/i.test(String(d.theme.accent || ''))) document.getElementById('accent').value = d.theme.accent.toLowerCase();
      if (d.theme.card === 'light' || d.theme.card === 'dark') document.getElementById('cardTone').value = d.theme.card;
    }
    var bpUrl = d.blueprint_url || d.blueprintUrl;
    var bpJson = d.blueprint_json || d.blueprintJson || d.blueprint;
    var plug = [].concat(d.plugin || [], d.plugins || [])[0];
    if (!bpJson && !bpUrl && (plug || d.theme)) {
      document.querySelector('[data-bp="boot"]').click();
      put('sitePlugin', plug);
      put('siteTheme', typeof d.theme === 'string' ? d.theme : '');
    } else if (!bpJson && !bpUrl && d.site === 'wordpress') {
      document.querySelector('[data-bp="wp"]').click();
    } else if (bpJson) {
      document.querySelector('[data-bp="json"]').click();
      put('bpjson', typeof bpJson === 'string' ? bpJson : JSON.stringify(bpJson, null, 2));
    } else if (bpUrl) {
      document.querySelector('[data-bp="url"]').click();
      put('bpurl', bpUrl);
    }
    var missing = bpJson || bpUrl || plug || d.theme || d.site === 'wordpress' ? '' : ' It didn’t say which plugin, theme or WordPress to use, so choose below.';
    pasteMsg.textContent = 'Filled in: ' + tasks.length + (d.mode === 'tour' ? ' step' : ' task') + (tasks.length === 1 ? '.' : 's.') + missing + ' Check it, choose a results password, then press the button at the bottom.';
    document.getElementById('f').scrollIntoView({ behavior: 'smooth', block: 'start' });
  });

  var mode2 = 'url';
  document.getElementById('compare').addEventListener('change', function () { document.getElementById('second').hidden = !this.checked; });
  [].slice.call(document.querySelectorAll('[data-bp2]')).forEach(function (b) {
    b.addEventListener('click', function () {
      mode2 = b.dataset.bp2;
      [].slice.call(document.querySelectorAll('[data-bp2]')).forEach(function (o) { o.classList.toggle('on', o === b); });
      document.getElementById('bp2url').hidden = mode2 !== 'url';
      document.getElementById('bp2json').hidden = mode2 !== 'json';
    });
  });
  [].slice.call(document.querySelectorAll('[data-bp]')).forEach(function (b) {
    b.addEventListener('click', function () {
      mode = b.dataset.bp;
      [].slice.call(document.querySelectorAll('[data-bp]')).forEach(function (o) { o.classList.toggle('on', o === b); });
      document.getElementById('bpurl').hidden = mode !== 'url';
      document.getElementById('bpjson').hidden = mode !== 'json';
      document.getElementById('bpboot').hidden = mode !== 'boot';
      document.getElementById('bpwp').hidden = mode !== 'wp';
    });
  });

  // Record: the draft as it stands goes to the service, which hands back a
  // Playground link with the card in record mode. The tab is opened at once,
  // inside the click, so no pop-up blocker stops it, and pointed there after.
  document.getElementById('recordBtn').addEventListener('click', function () {
    var rmsg = document.getElementById('recordMsg');
    var steps = [].slice.call(tasksEl.querySelectorAll('.task')).map(function (d) {
      var c = d.querySelector('.t-check').value;
      var t = { title: d.querySelector('.t-title').value.trim(), hint: d.querySelector('.t-hint').value };
      if (c === 'page') t.check = { type: 'page', path: d.querySelector('.t-path').value.trim() };
      else if (c === 'text') t.check = { type: 'text', text: d.querySelector('.t-words').value };
      else if (c === 'block' || c === 'block_changed') t.check = { type: c, block: d.querySelector('.t-block').value.trim() };
      else if (c) t.check = c;
      if (d.querySelector('.t-say').value.trim()) t.say = d.querySelector('.t-say').value.trim();
      if (d.querySelector('.t-sel').value.trim()) t.point = d.querySelector('.t-sel').value.trim();
      if (d.querySelector('.t-do').value.trim()) t['do'] = d.querySelector('.t-do').value;
      return t;
    }).filter(function (t) { return t.title; });
    var url = mode === 'url' ? document.getElementById('bpurl').value.trim() : '';
    var text = mode === 'json' ? document.getElementById('bpjson').value.trim() : '';
    if (siteMissing()) { rmsg.textContent = siteMissing() + ' (below), so Playground knows what to open.'; return; }
    var boot = siteBoot();
    var tab = window.open('about:blank', '_blank');
    rmsg.textContent = 'Opening Playground…';
    var got = url ? fetch(url, { headers: { accept: 'application/json' } }).then(function (r) { return r.ok ? r.text() : ''; }, function () { return ''; }) : Promise.resolve(text);
    got.then(function (bp) {
      return fetch('/api/record', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          subject: document.getElementById('subject').value,
          lang: document.getElementById('lang').value || undefined,
          tasks: steps,
          boot: boot || undefined,
          blueprintJson: boot ? undefined : (bp || undefined),
          blueprintUrl: boot || bp ? undefined : url,
          button: (document.getElementById('btnLabel').value.trim() && document.getElementById('btnUrl').value.trim()) ? { label: document.getElementById('btnLabel').value.trim(), url: document.getElementById('btnUrl').value.trim() } : undefined,
          theme: { accent: document.getElementById('accent').value, card: document.getElementById('cardTone').value },
        }),
      });
    }).then(function (r) { return r.json(); }).then(function (d) {
      if (!d.link) throw new Error(d.error || 'That did not work.');
      if (tab) tab.location = d.link; else location.href = d.link;
      rmsg.textContent = 'Opened in a new tab. Do each step yourself and press Next step on the card; at the end, Copy the tour and paste it into Paste from your assistant above.';
    }).catch(function (e) {
      if (tab) tab.close();
      rmsg.textContent = String(e.message || e);
    });
  });

  // the site as the service builds it: WordPress on its own, or with a plugin
  // or theme (slug or zip link); null when a blueprint says it instead
  function siteBoot() {
    if (mode === 'wp') return {};
    if (mode !== 'boot') return null;
    var plugin = document.getElementById('sitePlugin').value.trim(), theme = document.getElementById('siteTheme').value.trim();
    return { plugins: plugin ? [plugin] : [], theme: theme || undefined };
  }
  function siteMissing() {
    if (mode === 'boot' && !document.getElementById('sitePlugin').value.trim() && !document.getElementById('siteTheme').value.trim()) return 'Name the plugin or theme (its WordPress.org slug or a zip link), or choose Just WordPress.';
    if (mode === 'url' && !document.getElementById('bpurl').value.trim()) return 'Add the blueprint URL, or choose another way to set up the site.';
    if (mode === 'json' && !document.getElementById('bpjson').value.trim()) return 'Paste the blueprint JSON, or choose another way to set up the site.';
    return '';
  }

  var msg = document.getElementById('msg'), submit = document.getElementById('submit');
  document.getElementById('f').addEventListener('submit', function (ev) {
    ev.preventDefault();
    msg.textContent = '';
    var touring = form.dataset.mode === 'tour';
    var tasks = [].slice.call(tasksEl.querySelectorAll('.task')).map(function (d) {
      var c = d.querySelector('.t-check').value;
      var check = c === 'text' ? { type: 'text', text: d.querySelector('.t-words').value }
        : (c === 'block' || c === 'block_changed') ? { type: c, block: d.querySelector('.t-block').value.trim() }
        : c === 'page' ? { type: 'page', path: d.querySelector('.t-path').value.trim() }
        : (c || undefined);
      var t = { title: d.querySelector('.t-title').value, hint: d.querySelector('.t-hint').value, check: check };
      if (touring && d.querySelector('.t-sel').value.trim()) t.point = d.querySelector('.t-sel').value.trim();
      if (touring && d.querySelector('.t-do').value.trim()) t.do = d.querySelector('.t-do').value;
      if (touring && d.querySelector('.t-say').value.trim()) t.say = d.querySelector('.t-say').value.trim();
      return t;
    }).filter(function (t) { return t.title.trim(); });
    if (!tasks.length) { msg.textContent = touring ? 'Give the tour at least one step.' : 'Give the tester at least one thing to try.'; return; }
    if (siteMissing()) { msg.textContent = siteMissing(); return; }
    var button = touring && (document.getElementById('btnLabel').value.trim() || document.getElementById('btnUrl').value.trim())
      ? { label: document.getElementById('btnLabel').value.trim(), url: document.getElementById('btnUrl').value.trim() } : undefined;

    submit.disabled = true;
    submit.textContent = 'Checking the blueprint…';

    var url = mode === 'url' ? document.getElementById('bpurl').value.trim() : '';
    var comparing = document.getElementById('compare').checked;
    var url2 = comparing && mode2 === 'url' ? document.getElementById('bp2url').value.trim() : '';

    // Read the blueprint here rather than asking the service to. The browser can
    // reach anywhere the owner can, which the service cannot always say — and a
    // copy taken now means every tester gets the same site, which is what you
    // want from a test anyway. If the page cannot read it (a site that sends no
    // CORS header), hand the URL over and let the service try.
    var read = function (u) {
      return !u ? Promise.resolve(null) : fetch(u, { headers: { accept: 'application/json' } })
        .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.text(); })
        .then(function (t) { JSON.parse(t); return t; })
        .catch(function () { return null; });
    };
    var fetched = Promise.all([read(url), read(url2)]);

    fetched.then(function (texts) {
      var text = texts[0], text2 = texts[1];
      var first = siteBoot() ? { boot: siteBoot() } : { blueprintUrl: text ? '' : url, blueprintJson: text || (mode === 'json' ? document.getElementById('bpjson').value : '') };
      var versions = comparing ? [
        Object.assign({ label: document.getElementById('labelA').value.trim() }, first),
        { label: document.getElementById('labelB').value.trim(), blueprintUrl: text2 ? '' : url2, blueprintJson: text2 || (mode2 === 'json' ? document.getElementById('bp2json').value : '') },
      ] : undefined;
      return fetch('/api/tests', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          subject: document.getElementById('subject').value,
          persona: document.getElementById('persona').value,
          tasks: tasks,
          boot: first.boot,
          blueprintUrl: first.blueprintUrl,
          blueprintJson: first.blueprintJson,
          versions: versions,
          password: document.getElementById('password').value,
          webhook: document.getElementById('webhook').value.trim(),
          lang: document.getElementById('lang').value || undefined,
          mode: touring ? 'tour' : undefined,
          button: button,
          theme: touring ? { accent: document.getElementById('accent').value, card: document.getElementById('cardTone').value } : undefined,
        }),
      });
    }).then(function (r) {
      // Not every failure comes from the service. Something in front of it can
      // answer instead — an edge rate limiter returns an HTML page — and
      // assuming JSON turns a clear "too many requests" into "could not reach
      // the service", which sends you looking in the wrong place.
      return r.text().then(function (body) {
        var d = {};
        try { d = JSON.parse(body) || {}; } catch (e) {
          d = { error: r.ok ? 'The service sent something unreadable back.'
                            : (r.status === 429
                               ? 'Too many requests to this address for the moment. Wait a minute and try again.'
                               : 'The service answered ' + r.status + '.') };
        }
        return { ok: r.ok, d: d };
      });
    })
      .then(function (res) {
        submit.disabled = false;
        submit.textContent = submit.getAttribute('data-' + form.dataset.mode);
        if (!res.ok) { msg.textContent = res.d.error || 'That did not work.'; return; }
        var tour = res.d.mode === 'tour';
        document.getElementById('f').hidden = true;
        document.getElementById('out').innerHTML =
          '<div class="out"><h2 style="margin-top:0">Two links</h2>' +
          '<p style="margin-bottom:4px"><strong>' + (tour ? 'Send this to anyone' : 'Send this to a tester') + '</strong></p><code>' + res.d.tester + '</code>' +
          '<p style="margin-bottom:4px"><strong>' + (tour ? 'See where people stop' : 'Read the results here') + '</strong>, with the password you chose</p><code>' + res.d.results + '</code>' +
          ((res.d.checks || []).length ? '<p style="margin-bottom:4px"><strong>' + (tour ? 'How each step moves on' : 'How each task is checked') + '</strong></p><ul class="soft" style="margin-top:0">' +
            res.d.checks.map(function (c) { return '<li>' + esc(c.title) + ' \u2014 ' + esc(c.check || (tour ? 'they press Next' : 'not checked: only their word for it')) + '</li>'; }).join('') + '</ul>' : '') +
          (res.d.versions ? '<p class="soft">One link for both: testers are shared out between ' + res.d.versions.map(function (v) { return '<strong>' + esc(v.label) + '</strong>'; }).join(' and ') + ', and the results come back side by side.</p>' : '') +
          (res.d.webhook ? '<p class="soft">Each tester who finishes will be posted to your ' + (res.d.webhook === 'json' ? 'webhook' : res.d.webhook.charAt(0).toUpperCase() + res.d.webhook.slice(1) + ' channel') + '.</p>' : '') +
          '<p class="soft" style="margin:0">Keep both. Neither can be looked up again, and the test keeps itself for ninety days after the last tester.</p></div>';
        window.scrollTo(0, document.body.scrollHeight);
      })
      .catch(function () {
        submit.disabled = false;
        submit.textContent = submit.getAttribute('data-' + form.dataset.mode);
        msg.textContent = 'Could not reach the service. Try again.';
      });
  });
})();
</script>
<script>
// The demo and the set browser. None of it talks to the service: it is all
// for looking at before you make anything.
(function () {
  var SETS = ${JSON.stringify(TASK_SETS)};
  var demo = SETS.filter(function (x) { return x.key === 'make-it-yours'; })[0];
  var $ = function (id) { return document.getElementById(id); };
  function esc(v) { return String(v == null ? '' : v).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }

  // What each finished task does to the pretend site, in the set's own order.
  var effects = [
    function (on) { $('dName').textContent = on ? 'Ash & Clay' : 'My Starter Site'; return $('dName'); },
    function (on) { $('dHeadline').textContent = on ? 'Hand-thrown pots from a small studio by the river' : 'Welcome to your new site'; return $('dHeadline'); },
    function (on) { $('dPhoto').classList.toggle('swapped', on); $('dPot').hidden = !on; $('dPlain').hidden = on; return $('dPhoto'); },
    function (on) { $('dSite').classList.toggle('styled', on); return $('dSite'); },
    function (on) { $('dContact').hidden = !on; return $('dContact'); },
    function () { return null; },
  ];
  var ICON = {
    done: '<circle cx="9" cy="9" r="8" stroke="#1f7a4d"/><path d="M5.5 9.2l2.3 2.3 4.7-4.7" stroke="#1f7a4d"/>',
    couldnt: '<circle cx="9" cy="9" r="8" stroke="#b23a1e"/><path d="M6 6l6 6M12 6l-6 6" stroke="#b23a1e"/>',
    now: '<circle cx="9" cy="9" r="8" stroke="#2448e0"/>',
    open: '<circle cx="9" cy="9" r="8" stroke="#b4b7c0"/>',
  };
  var step = 0, out = [], hints = [];

  function draw() {
    var n = demo.tasks.length, finished = step >= n;
    [].slice.call($('dList').children).forEach(function (li, i) {
      var s = out[i] || (i === step ? 'now' : 'open');
      li.className = s === 'open' ? '' : s;
      li.querySelector('svg').innerHTML = ICON[s];
    });
    $('dProgress').textContent = finished ? 'All done' : (step + 1) + ' of ' + n;
    $('dBtns').hidden = finished;
    $('dFinished').hidden = !finished;
    $('dHint').hidden = true;
    $('dHintBtn').textContent = 'Hint';
    $('dHintBtn').setAttribute('aria-expanded', 'false');
    var ran = step > 0;
    $('rCaption').textContent = 'Results · ' + demo.name + ' · ' + (ran ? 'your run, just now' : 'try the demo above and your run shows up here');
    $('rBody').innerHTML = demo.tasks.map(function (t, i) {
      var c = function (yes, cls) { return !ran || i >= step ? '<td>–</td>' : (yes ? '<td class="' + cls + '">1</td>' : '<td>0</td>'); };
      return '<tr' + (ran && i === step ? ' class="now"' : '') + '><td>' + esc(t.title) + '</td>' +
        c(out[i] === 'done', 'y') + c(out[i] === 'couldnt', 'n') + c(hints[i], 'y') + '</tr>';
    }).join('');
  }
  function mark(kind) {
    var el = effects[step] && effects[step](kind === 'done');
    if (el && kind === 'done') { el.classList.remove('flash'); void el.offsetWidth; el.classList.add('flash'); }
    out[step] = kind; step++; draw();
  }
  $('dDone').addEventListener('click', function () { mark('done'); });
  $('dCouldnt').addEventListener('click', function () { mark('couldnt'); });
  $('dHintBtn').addEventListener('click', function () {
    var h = $('dHint'), show = h.hidden;
    h.innerHTML = '<strong>Hint:</strong> ' + esc(demo.tasks[step].hint);
    h.hidden = !show;
    this.textContent = show ? 'Hide hint' : 'Hint';
    this.setAttribute('aria-expanded', String(show));
    if (show) hints[step] = true;
  });
  $('dReset').addEventListener('click', function () {
    effects.forEach(function (f) { f(false); });
    step = 0; out = []; hints = []; draw();
  });
  draw();

  // The set browser. "Use this set" hands it to the form's own picker, so the
  // form fills itself exactly as if it had been picked there.
  var picked = demo.key;
  [].slice.call(document.querySelectorAll('[data-set]')).forEach(function (b) {
    b.addEventListener('click', function () {
      picked = b.dataset.set;
      var set = SETS.filter(function (x) { return x.key === picked; })[0];
      [].slice.call(document.querySelectorAll('[data-set]')).forEach(function (o) { o.setAttribute('aria-pressed', String(o === b)); });
      $('sFor').textContent = set.for;
      $('sPersona').textContent = set.persona;
      $('sTasks').innerHTML = set.tasks.map(function (t) { return '<li>' + esc(t.title) + '</li>'; }).join('');
    });
  });
  $('sUse').addEventListener('click', function () {
    var sel = $('set');
    sel.value = picked;
    sel.dispatchEvent(new Event('change'));
    $('start').scrollIntoView({ behavior: 'smooth' });
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
  .ask { margin:18px 0; padding:16px 18px; border:1px solid var(--line); border-radius:12px; background:#fff; }
  .ask h2 { font-size:16px; margin:0 0 4px; }
  .ask p { margin:0; }
  .ask pre { white-space:pre-wrap; font:14px/1.6 ui-monospace,SFMono-Regular,Menlo,monospace; background:#f6f3ee; padding:12px 14px; border-radius:8px; margin:12px 0; }
  .titlerow { display:flex; align-items:center; justify-content:space-between; gap:12px; flex-wrap:wrap; }
  .edit label { display:block; font-weight:600; margin:14px 0 4px; }
  .edit label span { font-weight:400; color:var(--soft); }
  .edit input[type=text], .edit textarea { width:100%; box-sizing:border-box; }
  .edit textarea { min-height:90px; font:inherit; padding:8px 10px; border:1px solid var(--line); border-radius:8px; }
  .edit .task { margin:8px 0; padding:10px 12px; border:1px solid var(--line); border-radius:10px; }
  .edit .task input + input { margin-top:6px; }
  .edit .row { display:flex; gap:10px; align-items:center; margin-top:16px; }
  .edit .primary { background:var(--accent); color:#fff; border-color:var(--accent); }
  .working { color:var(--ok); font-weight:600; }
  /* a tour: where people stop, step by step */
  .stack { display:inline-flex; width:160px; height:10px; border-radius:5px; background:#efece6; overflow:hidden; vertical-align:middle; }
  .stack i { display:block; height:100%; }
  .stack .a { background:var(--ok); } .stack .s { background:#e8a33d; } .stack .l { background:var(--bad); }
  .key { display:flex; flex-wrap:wrap; gap:6px 16px; font-size:13px; color:var(--soft); margin:-8px 0 18px; }
  .key i { display:inline-block; width:10px; height:10px; border-radius:3px; margin-right:6px; vertical-align:-1px; }
  tr.flag td { background:#fff6e8; }
  .tag { display:inline-block; margin-left:8px; font-size:11px; font-weight:700; padding:2px 7px; border-radius:99px; background:#ffe3b8; color:#7a4300; }
  td.n, th.n { text-align:right; font-variant-numeric:tabular-nums; }
</style></head><body><div class="wrap">
<div class="titlerow"><h1 id="title">Results</h1><button type="button" id="editBtn" hidden>Edit the test</button></div>
<p class="soft">Each row is one tester. Click a row for the tasks and notes. <span id="sum"></span></p>
<div id="edit" class="ask edit" hidden></div>
<div id="auth"><input id="pw" type="password" placeholder="password" autocomplete="current-password"> <button id="go">Show</button> <span id="msg" class="err"></span></div>
<div id="ask" class="ask" hidden>
  <h2>Let your assistant read it</h2>
  <p class="soft">Copy this and paste it into Claude, ChatGPT or any assistant. It copies the question with every tester&rsquo;s results attached, so there is nothing for it to look up.</p>
  <pre id="askText"></pre>
  <button type="button" id="askCopy">Copy prompt</button>
</div>
<div id="out"></div>
<script>
(function () {
  var id = location.pathname.split('/')[2] || '';
  var key = 'pgut:pw:' + id;
  var pw = sessionStorage.getItem(key) || '';
  var out = document.getElementById('out'), auth = document.getElementById('auth');
  var sum = document.getElementById('sum'), msg = document.getElementById('msg');
  var titles = {}, checks = {};

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
      if (!by[e.task]) { by[e.task] = { id: e.task, status: '', secs: null, note: '', hint: false, errors: 0, path: '', site: '' }; order.push(e.task); }
      var t = by[e.task];
      if (e.type === 'task_done' || e.type === 'task_skip') {
        t.status = e.type === 'task_done' ? 'done' : 'couldn\\u2019t';
        t.secs = e.data && e.data.secs;
        t.site = (e.data && e.data.check) || '';
        if (e.note) t.note = e.note;
        if (e.path) t.path = e.path;
      }
      if (e.type === 'hint') t.hint = true;
      if (e.type === 'error') t.errors++;
    });
    return order.map(function (k) { return by[k]; });
  }

  function showSession(row, events) {
    if (current && current.mode === 'tour') return showVisit(row, events);
    var start = events.filter(function (e) { return e.type === 'start'; })[0] || {};
    var wrap = events.filter(function (e) { return e.type === 'wrap'; }).slice(-1)[0];
    var tasks = tasksOf(events);
    var errs = events.filter(function (e) { return e.type === 'error'; });
    var h = '<div class="detail"><h2>' + esc(row.name || row.id) + ' <span class="soft">\\u00b7 ' +
      esc(when(row.first)) + ' \\u00b7 ' + esc((start.data || {}).viewport || '') + '</span></h2>';
    h += '<table><tr><th>Task</th><th>Result</th><th>The site</th><th>Time</th><th>Hint</th><th>Ended on</th><th>Note</th></tr>' +
      tasks.map(function (t) {
        // what the site itself showed, for a task with a check
        var site = t.site === 'yes' ? (t.status === 'done' ? 'shows it' : 'changed anyway') :
          t.site === 'no' ? (t.status === 'done' ? 'unchanged' : 'unchanged') : '';
        var siteCls = t.site === 'yes' ? 'ok' : (t.site === 'no' && t.status === 'done' ? 'bad' : 'soft');
        return '<tr><td>' + esc(titles[t.id] || t.id) + '</td>' +
          '<td class="' + (t.status === 'done' ? 'ok' : (t.status ? 'bad' : 'soft')) + '">' + esc(t.status || 'not reached') + '</td>' +
          '<td class="' + siteCls + '" title="' + esc(checks[t.id] || '') + '">' + esc(site) + '</td>' +
          '<td>' + mins(t.secs) + '</td><td>' + (t.hint ? 'yes' : '') + '</td>' +
          '<td class="soft">' + esc(t.path) + '</td><td class="note">' + esc(t.note) + '</td></tr>';
      }).join('') + '</table>';
    if (wrap && wrap.data) {
      var w = wrap.data;
      h += '<div class="wrapq">' +
        '<span class="soft">Happy with how it went</span><span>' + esc(w.happy) + ' / 5</span>' +
        '<span class="soft">Could have finished</span><span>' + esc(w.confident) + '</span>' +
        '<span class="soft">How it felt</span><span class="note">' + esc(w.feel) + '</span>' +
        '<span class="soft">What confused them</span><span class="note">' + esc(w.confused) + '</span>' +
        '<span class="soft">Minutes</span><span>' + esc(w.minutes) + '</span></div>';
    } else h += '<p class="soft">No wrap-up yet.</p>';
    if (errs.length) h += '<p class="err">' + errs.length + ' script error(s): ' +
      esc(errs.map(function (e) { return e.note; }).join(' \\u00b7 ').slice(0, 400)) + '</p>';
    document.getElementById('d-' + row.id).innerHTML = h + '</div>';
  }

  // One visitor's walk through a tour: how each step moved on, and how long.
  function showVisit(row, events) {
    var start = events.filter(function (e) { return e.type === 'start'; })[0] || {};
    var how = {};
    events.forEach(function (e) {
      if (e.type === 'task_done') how[e.task] = { got: e.data && e.data.how === 'auto' ? 'moved on by itself' : 'pressed Next', cls: 'ok', secs: e.data && e.data.secs, path: e.path };
      if (e.type === 'task_skip') how[e.task] = { got: 'skipped', cls: 'bad', secs: e.data && e.data.secs, path: e.path };
    });
    var pressed = events.some(function (e) { return e.type === 'cta'; });
    var h = '<div class="detail"><h2>' + esc(row.id) + ' <span class="soft">\u00b7 ' + esc(when(row.first)) + ' \u00b7 ' + esc((start.data || {}).viewport || '') + '</span></h2>' +
      '<table><tr><th>Step</th><th>How it moved on</th><th>Time</th><th>Ended on</th></tr>' +
      (current.tasks || []).map(function (t) {
        var x = how[t.id];
        return '<tr><td>' + esc(t.title) + '</td><td class="' + (x ? x.cls : 'soft') + '">' + esc(x ? x.got : 'not reached') + '</td>' +
          '<td>' + (x ? mins(x.secs) : '') + '</td><td class="soft">' + esc(x ? x.path : '') + '</td></tr>';
      }).join('') + '</table>' +
      (current.button ? '<p class="soft" style="margin:0">' + (pressed ? 'Pressed \u201c' + esc(current.button.label) + '\u201d.' : 'Did not press \u201c' + esc(current.button.label) + '\u201d.') + '</p>' : '');
    document.getElementById('d-' + row.id).innerHTML = h + '</div>';
  }

  // Where people stop and which step needed help: one row per step, each a
  // share of everyone who started.
  function tourTable(d, dg) {
    var n = dg.testers || 0;
    var pct = function (x) { return n ? Math.round(x / n * 100) : 0; };
    var worst = -1, worstShare = 0.25;
    dg.tasks.forEach(function (t, i) {
      var reached = n - t.notReached;
      var share = reached ? (t.skipped + t.stoppedHere) / reached : 0;
      if (reached >= 2 && share >= worstShare) { worst = i; worstShare = share; }
    });
    var rows = dg.tasks.map(function (t, i) {
      var reached = n - t.notReached;
      var on = t.auto + t.next;
      return '<tr' + (i === worst ? ' class="flag"' : '') + '><td>' + (i + 1) + '. ' + esc(t.title) + (i === worst ? '<span class="tag">Needs help</span>' : '') + '</td>' +
        '<td class="n">' + reached + '</td><td class="n' + (t.auto ? ' ok' : '') + '">' + t.auto + '</td><td class="n">' + t.next + '</td>' +
        '<td class="n' + (t.skipped ? ' bad' : '') + '">' + t.skipped + '</td><td class="n' + (t.stoppedHere ? ' bad' : '') + '">' + t.stoppedHere + '</td>' +
        '<td class="n">' + (t.medianSecs == null ? '' : mins(t.medianSecs)) + '</td>' +
        '<td><span class="stack" role="img" aria-label="' + pct(on) + '% moved on, ' + pct(t.skipped) + '% skipped, ' + pct(t.stoppedHere) + '% stopped here">' +
          '<i class="a" style="width:' + pct(on) + '%"></i><i class="s" style="width:' + pct(t.skipped) + '%"></i><i class="l" style="width:' + pct(t.stoppedHere) + '%"></i></span></td></tr>';
    }).join('');
    var help = '';
    if (worst !== -1) {
      var w = dg.tasks[worst], reachedW = n - w.notReached;
      help = '<div class="ask"><h2>Step ' + (worst + 1) + ' needs help.</h2><p>' + Math.round((w.skipped + w.stoppedHere) / reachedW * 100) + '% of the people who reached \u201c' + esc(w.title) +
        '\u201d skipped it or stopped there. Try a shorter instruction, a pointer, or splitting it in two.</p></div>';
    }
    return '<table><tr><th>Step</th><th class="n">Reached</th><th class="n">By itself</th><th class="n">Next</th><th class="n">Skipped</th><th class="n">Stopped here</th><th class="n">Median</th><th>Of everyone</th></tr>' + rows + '</table>' +
      '<p class="key"><span><i style="background:var(--ok)"></i>moved on by itself, or pressed Next</span><span><i style="background:#e8a33d"></i>skipped</span><span><i style="background:var(--bad)"></i>stopped here</span></p>' + help;
  }

  // Finished, still going, or gone quiet: half an hour without a word from the
  // card, and no answers to the closing questions, is somebody who stopped.
  var STILL_WORKING_MS = 30 * 60 * 1000;
  function statusOf(r, now) {
    if (r.wrapped) return 'finished';
    return (now || Date.now()) - r.last < STILL_WORKING_MS ? 'working' : 'stopped';
  }
  function statusCell(r, now) {
    var m = Math.max(1, Math.round((r.last - r.first) / 60000)) + ' min';
    var s = statusOf(r, now);
    if (s === 'finished') return 'Finished \\u00b7 ' + m;
    if (s === 'working') return '<span class="working">In progress</span> \\u00b7 ' + m;
    return '<span class="soft">Stopped after ' + m + '</span>';
  }

  // Editing keeps the links and the password. Wording only: tasks are reworded
  // in place, never added or removed here, so nobody's answers change task.
  var current = null;
  function field(label, idAttr, value, max, area) {
    return '<label for="' + idAttr + '">' + label + '</label>' + (area
      ? '<textarea id="' + idAttr + '" maxlength="' + max + '">' + esc(value) + '</textarea>'
      : '<input type="text" id="' + idAttr + '" maxlength="' + max + '" value="' + esc(value) + '">');
  }
  function openEdit() {
    var d = current, box = document.getElementById('edit');
    if (!box.hidden) { box.hidden = true; return; }
    var q = d.questions || {};
    if (d.mode === 'tour') return openTourEdit(d, box);
    box.innerHTML = '<h2>Edit the test</h2><p class="soft">Fix a typo or change the wording. The links and the password stay the same, and testers who start from now on see the new words.</p>' +
      field('What is being tested <span>\\u2014 \\u201cThank you for helping make \\u2026 better\\u201d</span>', 'eSubject', d.subject, 80) +
      field('Who the tester is', 'ePersona', d.persona, 2000, true) +
      field('A line under that <span>(optional)</span>', 'eIntro', d.intro, 300) +
      '<label>Things to try <span>\\u2014 reword them here; the order and the number stay as they are</span></label>' +
      (d.tasks || []).map(function (t, i) {
        return '<div class="task"><input type="text" class="eTitle" maxlength="200" value="' + esc(t.title) + '" aria-label="Task ' + (i + 1) + '">' +
          '<input type="text" class="eHint" maxlength="300" value="' + esc(t.hint || '') + '" placeholder="Hint, shown only if they ask" aria-label="Hint for task ' + (i + 1) + '"></div>';
      }).join('') +
      '<label>The questions at the end</label>' +
      field('<span>1 to 5</span>', 'qHappy', q.happy, 120) +
      field('<span>Yes, maybe or no</span>', 'qFinish', q.finish, 120) +
      field('<span>Free text</span>', 'qFeel', q.feel, 120) +
      field('<span>Free text</span>', 'qConfused', q.confused, 120) +
      '<div class="row"><button type="button" class="primary" id="eSave">Save</button><button type="button" id="eCancel">Cancel</button><span id="eMsg"></span></div>';
    box.hidden = false;
    document.getElementById('eCancel').onclick = function () { box.hidden = true; };
    document.getElementById('eSave').onclick = function () {
      var val = function (x) { return document.getElementById(x).value; };
      var titlesIn = [].slice.call(box.querySelectorAll('.eTitle')), hintsIn = [].slice.call(box.querySelectorAll('.eHint'));
      var body = {
        subject: val('eSubject'), persona: val('ePersona'), intro: val('eIntro'),
        // each task keeps its check; only its words change
        tasks: (d.tasks || []).map(function (t, i) { return { title: titlesIn[i].value, hint: hintsIn[i].value, check: t.check || 'none' }; }),
        questions: { happy: val('qHappy'), finish: val('qFinish'), feel: val('qFeel'), confused: val('qConfused') },
      };
      var m = document.getElementById('eMsg');
      m.className = 'soft'; m.textContent = 'Saving\\u2026';
      fetch('/api/tests?test=' + encodeURIComponent(id), { method: 'PATCH', headers: { 'content-type': 'application/json', 'x-test-password': pw }, body: JSON.stringify(body) })
        .then(function (r) { return r.json().then(function (j) { if (!r.ok) throw new Error(j.error || 'Could not save.'); return j; }); })
        .then(function () { box.hidden = true; load(); })
        .catch(function (e) { m.className = 'err'; m.textContent = e.message; });
    };
  }
  // A step's actions as the lines they were written in.
  function lines(list) {
    return (list || []).map(function (a) {
      return (a.maybe ? 'maybe ' : '') + (a.click ? a.click : a.into ? 'type "' + a.type + '" into ' + a.into : a.key ? 'press ' + a.key : a.go ? 'go ' + a.go : 'wait ' + a.wait);
    }).join('\\n');
  }
  function openTourEdit(d, box) {
    var b = d.button || {};
    box.innerHTML = '<h2>Edit the tour</h2><p class="soft">Change the words or the button. The links and the password stay the same, and anyone who starts from now on sees the new words.</p>' +
      field('What it shows <span>\u2014 \u201cA short tour of \u2026\u201d</span>', 'eSubject', d.subject, 80) +
      field('Who it is for <span>(optional)</span>', 'ePersona', d.persona, 2000) +
      '<label>The steps <span>\u2014 reword them here; the order and the number stay as they are</span></label>' +
      (d.tasks || []).map(function (t, i) {
        return '<div class="task"><input type="text" class="eTitle" maxlength="200" value="' + esc(t.title) + '" aria-label="Step ' + (i + 1) + '">' +
          '<input type="text" class="eHint" maxlength="300" value="' + esc(t.hint || '') + '" placeholder="What the card says" aria-label="What step ' + (i + 1) + ' says">' +
          '<textarea class="eSay" maxlength="600" placeholder="What the voice says (optional)" aria-label="What the voice says on step ' + (i + 1) + '">' + esc(t.say || '') + '</textarea>' +
          '<textarea class="eDo" placeholder="What it presses, one per line" aria-label="What step ' + (i + 1) + ' presses">' + esc(lines(t.do)) + '</textarea>' +
          '<input type="text" class="ePoint" maxlength="200" value="' + esc(t.point || '') + '" placeholder="Ring when paused: a CSS selector (optional)" aria-label="What step ' + (i + 1) + ' points at"></div>';
      }).join('') +
      '<label for="eAccent">Colours</label><input type="color" id="eAccent" value="' + esc((d.theme && d.theme.accent) || '#7cf2b0') + '"> ' +
      '<select id="eCard"><option value="dark"' + (d.theme && d.theme.card === 'light' ? '' : ' selected') + '>Dark card</option><option value="light"' + (d.theme && d.theme.card === 'light' ? ' selected' : '') + '>Light card</option></select>' +
      field('The button at the end <span>\u2014 its words</span>', 'eBtnLabel', b.label || '', 40) +
      field('<span>and where it goes</span>', 'eBtnUrl', b.url || '', 600) +
      '<div class="row"><button type="button" class="primary" id="eSave">Save</button><button type="button" id="eCancel">Cancel</button><span id="eMsg"></span></div>';
    box.hidden = false;
    document.getElementById('eCancel').onclick = function () { box.hidden = true; };
    document.getElementById('eSave').onclick = function () {
      var val = function (x) { return document.getElementById(x).value; };
      var get3 = function (c) { return [].slice.call(box.querySelectorAll(c)); };
      var titlesIn = get3('.eTitle'), hintsIn = get3('.eHint'), pointsIn = get3('.ePoint'), doesIn = get3('.eDo'), saysIn = get3('.eSay');
      var body = {
        subject: val('eSubject'), persona: val('ePersona'),
        tasks: (d.tasks || []).map(function (t, i) { return { title: titlesIn[i].value, hint: hintsIn[i].value, say: saysIn[i].value, point: pointsIn[i].value, do: doesIn[i].value, check: t.check || 'none' }; }),
        button: { label: val('eBtnLabel'), url: val('eBtnUrl') },
        theme: { accent: val('eAccent'), card: val('eCard') },
      };
      var m = document.getElementById('eMsg');
      m.className = 'soft'; m.textContent = 'Saving\u2026';
      fetch('/api/tests?test=' + encodeURIComponent(id), { method: 'PATCH', headers: { 'content-type': 'application/json', 'x-test-password': pw }, body: JSON.stringify(body) })
        .then(function (r) { return r.json().then(function (j) { if (!r.ok) throw new Error(j.error || 'Could not save.'); return j; }); })
        .then(function () { box.hidden = true; load(); })
        .catch(function (e) { m.className = 'err'; m.textContent = e.message; });
    };
  }
  document.getElementById('editBtn').addEventListener('click', openEdit);

  function load() {
    get('').then(function (d) {
      auth.hidden = true;
      msg.textContent = '';
      sessionStorage.setItem(key, pw);
      document.getElementById('title').textContent = d.subject ? d.subject + ' \\u2014 results' : 'Results';
      (d.tasks || []).forEach(function (t) { titles[t.id] = t.title; if (t.checkLabel) checks[t.id] = t.checkLabel; });
      var rows = d.sessions || [], done = 0, skipped = 0;
      rows.forEach(function (r) { done += r.done || 0; skipped += r.skipped || 0; });
      current = d;
      document.getElementById('editBtn').hidden = false;
      document.getElementById('editBtn').textContent = d.mode === 'tour' ? 'Edit the tour' : 'Edit the test';
      if (d.mode === 'tour') return loadTour(d, rows);
      var counts = { finished: 0, working: 0, stopped: 0 };
      rows.forEach(function (r) { counts[statusOf(r, d.now)]++; });
      sum.textContent = rows.length + ' tester(s): ' + counts.finished + ' finished, ' + counts.working + ' in progress, ' +
        counts.stopped + ' stopped before the end. ' + done + ' tasks done, ' + skipped + ' not managed.';
      if (!rows.length) { out.innerHTML = '<p class="soft">Nobody has started yet.</p>'; return; }
      // a compared test: the versions side by side, task by task, first
      var vs = d.versions || null, labelOf = {};
      if (vs) vs.forEach(function (v) { labelOf[v.key] = v.key.toUpperCase(); });
      showAsk(!!vs);
      var cmp = '';
      if (vs) {
        var fewest = Math.min.apply(null, vs.map(function (v) { return v.testers; }));
        cmp = '<h2>Side by side</h2><p class="soft">' + vs.map(function (v) { return '<strong>' + v.key.toUpperCase() + '</strong> ' + esc(v.label) + ': ' + v.testers + ' tester(s), ' + v.finished + ' finished'; }).join(' \\u00b7 ') + '</p>' +
          (fewest < 8 ? '<p class="soft">With this few testers, a difference of one or two people is noise. Read the notes before deciding anything.</p>' : '') +
          '<table><tr><th>Task</th>' + vs.map(function (v) { return '<th>' + v.key.toUpperCase() + '</th>'; }).join('') + '</tr>' +
          (d.tasks || []).map(function (t, i) {
            return '<tr><td>' + esc(t.title) + '</td>' + vs.map(function (v) {
              var x = v.tasks[i] || {};
              var bits = [x.done + ' done', x.couldnt + ' couldn\\u2019t'];
              if (x.hintOpened) bits.push(x.hintOpened + ' hint');
              if (x.medianSecs != null) bits.push(mins(x.medianSecs));
              if (x.notShown) bits.push('<span class="bad">' + x.notShown + ' unchanged</span>');
              return '<td>' + bits.join(' \\u00b7 ') + '</td>';
            }).join('') + '</tr>';
          }).join('') +
          '<tr><td>Happy with how it went</td>' + vs.map(function (v) { return '<td>' + (v.happyAvg == null ? '\\u2013' : v.happyAvg + ' / 5') + '</td>'; }).join('') + '</tr>' +
          '<tr><td>Could have finished</td>' + vs.map(function (v) { var c = v.couldFinish || {}; return '<td>' + (c.yes || 0) + ' yes \\u00b7 ' + (c.maybe || 0) + ' maybe \\u00b7 ' + (c.no || 0) + ' no</td>'; }).join('') + '</tr>' +
          '</table><h2>Each tester</h2>';
      }
      out.innerHTML = cmp + '<table><tr><th>When</th><th>Who</th>' + (vs ? '<th>Version</th>' : '') + '<th>Done</th><th>Couldn\\u2019t</th><th>Status</th></tr>' +
        rows.map(function (r) {
          return '<tr class="s" data-id="' + esc(r.id) + '"><td>' + esc(when(r.first)) + '</td>' +
            '<td>' + esc(r.name || r.id) + '</td>' + (vs ? '<td>' + esc(labelOf[r.version] || '') + '</td>' : '') +
            '<td><span class="bar" style="width:' + (r.done * 14) + 'px"></span> ' + r.done + '</td>' +
            '<td><span class="bar b" style="width:' + (r.skipped * 14) + 'px"></span> ' + r.skipped + '</td>' +
            '<td>' + statusCell(r, d.now) + '</td></tr>' +
            '<tr><td colspan="' + (vs ? 6 : 5) + '" id="d-' + esc(r.id) + '"></td></tr>';
        }).join('') + '</table>';
      openRows(rows);
    }).catch(function (e) {
      auth.hidden = false;
      pw = '';
      sessionStorage.removeItem(key);
      msg.textContent = e.message;
    });
  }

  // A tour: the steps first, where people stop and which step needed help,
  // then one row per visitor.
  function loadTour(d, rows) {
    document.getElementById('title').textContent = (d.subject || 'The tour') + ' \u2014 tour numbers';
    document.querySelector('.wrap > p.soft').textContent = 'Each row below is one visitor. Click a row for their steps.';
    if (!rows.length) { sum.textContent = ''; out.innerHTML = '<p class="soft">Nobody has started yet.</p>'; return; }
    get('&digest=1').then(function (dg) {
      var st = dg.status || {};
      sum.textContent = '';
      showAsk(false, true);
      out.innerHTML = '<p>' + dg.testers + ' started: ' + (st.finished || 0) + ' saw the end, ' + (st.working || 0) + ' still going, ' + (st.stopped || 0) + ' stopped part way.' +
        (dg.button ? ' ' + dg.buttonPresses + ' pressed \u201c' + esc(dg.button.label) + '\u201d.' : '') + '</p>' +
        tourTable(d, dg) +
        '<h2>Each visitor</h2><table><tr><th>When</th><th>Who</th><th>Steps</th><th>Skipped</th><th>Status</th></tr>' +
        rows.map(function (r) {
          return '<tr class="s" data-id="' + esc(r.id) + '"><td>' + esc(when(r.first)) + '</td><td>' + esc(r.id) + '</td>' +
            '<td><span class="bar" style="width:' + (r.done * 14) + 'px"></span> ' + r.done + '</td>' +
            '<td><span class="bar b" style="width:' + (r.skipped * 14) + 'px"></span> ' + r.skipped + '</td>' +
            '<td>' + statusCell(r, d.now) + '</td></tr>' +
            '<tr><td colspan="5" id="d-' + esc(r.id) + '"></td></tr>';
        }).join('') + '</table>';
      openRows(rows);
    }).catch(function () { out.innerHTML = '<p class="err">Could not read the tour numbers.</p>'; });
  }

  function openRows(rows) {
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
  }

  // Reading a pile of rows is the assistant's job as much as the table's. A
  // chat assistant cannot send the password header, so rather than hand it a
  // link and a password, the button copies the question with the digest (one
  // answer per task, every note) attached. Any assistant can read that, and
  // the password never leaves this page.
  function askQuestion(compare, tour) {
    var subject = current && current.subject;
    if (tour) return 'These are the numbers from a guided tour of ' + (subject || 'something in WordPress') + '. Each step says what to do and moves on when it is done. ' +
      'Tell me where people skip or stop, which step most needs rewording, and how you would word it.';
    return 'These are the results of a user test of ' + (subject || 'something in WordPress') + '. Tell me where people got stuck, ' +
      'which hints they needed most, what they said in their notes, and the three changes that would help most.' +
      (compare ? ' The test compares versions, so tell me which did better and why.' : '');
  }
  // The digest is fetched up front: a clipboard write has to happen inside the
  // click, and Safari refuses one that waits on the network first.
  function showAsk(compare, tour) {
    var btn = document.getElementById('askCopy');
    get('&digest=1').then(function (d) {
      var text = askQuestion(compare, tour) + '\\n\\n' + JSON.stringify(d, null, 1);
      document.getElementById('askText').textContent = askQuestion(compare, tour) + '\\n\\n[' + (tour ? 'every step\\u2019s numbers are' : 'every tester\\u2019s results are') + ' attached when you copy]';
      document.getElementById('ask').hidden = false;
      btn.onclick = function () {
        var done = function () { btn.textContent = 'Copied'; setTimeout(function () { btn.textContent = 'Copy prompt'; }, 1600); };
        if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(done, function () {});
        else {
          var ta = document.createElement('textarea');
          ta.value = text; document.body.appendChild(ta); ta.select();
          try { document.execCommand('copy'); done(); } catch (e) {}
          ta.remove();
        }
      };
    }).catch(function () {});
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
  async fetch(req, env, ctx) {
    const url = new URL(req.url);

    if (url.pathname === '/' || url.pathname === '') {
      return html(HOME, { 'cache-control': 'public, max-age=300' });
    }

    if (url.pathname === '/mcp') return handleMcp(req, env);

    if (url.pathname === '/api/record') {
      if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
      if (req.method !== 'POST') return json({ error: 'POST the draft tour' }, 405, CORS);
      return recordLink(env, req);
    }

    if (url.pathname === '/demo/tour') {
      return new Response(null, { status: 302, headers: { location: demoTourLink(publicOrigin(req), cardZip(env)), 'cache-control': 'public, max-age=300' } });
    }

    if (url.pathname === '/llms.txt') {
      return new Response(LLMS_TXT(publicOrigin(req)), {
        headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'public, max-age=3600' },
      });
    }

    if (url.pathname === '/api/stats') {
      // the number on the home page; nothing about any one test
      return json({ tests: await testsTaken(env) }, 200, Object.assign({ 'cache-control': 'public, max-age=30' }, CORS));
    }

    if (url.pathname === '/api/task-sets') {
      return json({ sets: TASK_SETS, tours: TOUR_SETS }, 200, Object.assign({ 'cache-control': 'public, max-age=3600' }, CORS));
    }

    if (url.pathname === '/api/tests') {
      if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
      if (req.method === 'PATCH') {
        if (env.DB) await ensureSchema(env);
        return editTest(env, req, url);
      }
      if (req.method !== 'POST') return json({ error: 'POST to make a test, PATCH to change one' }, 405, CORS);
      return createTest(env, req);
    }

    if (url.pathname === '/api/events') {
      if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
      if (req.method !== 'POST') return json({ error: 'POST only' }, 405, CORS);
      return appendEvents(env, req, ctx);
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
      if (!test.versions) return html(introPage(test, publicOrigin(req)), { 'cache-control': 'public, max-age=300' });
      // a compared test: this visitor keeps the version they were first given
      // (a cookie on this test's path), and a new visitor gets whichever
      // version has had fewer testers start
      const v = await versionFor(env, test, req);
      return html(introPage(test, publicOrigin(req), v), {
        'cache-control': 'private, no-store',
        'set-cookie': `pgut_v_${test.id}=${v}; Path=/t/${test.id}; Max-Age=${30 * 24 * 60 * 60}; Secure; SameSite=Lax`,
      });
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
export { TASK_SETS, TOUR_SETS, cleanLang, readTour, cleanTheme, contrast, cleanActions, actionLines, guessCheck, CHECKS, lintTest, cleanEvent, cleanTasks, ensureSchema, wrapBlueprint, checkBlueprintUrl, checkPublicUrl, cleanBoot, blueprintFromBoot, starterPhp, hashPassword, sameSecret, taskId, makeId, TEST_PATH };
