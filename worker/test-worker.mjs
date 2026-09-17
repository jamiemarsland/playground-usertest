// The Worker, end to end against a KV mock: making a test, the tester's intro
// page, the wrapped blueprint, events coming in, and the results coming out —
// including the parts that keep one owner's test out of another's.
// Run: node test-worker.mjs
import { DatabaseSync } from 'node:sqlite';
import worker, { cleanEvent, cleanTasks, wrapBlueprint, checkBlueprintUrl, cleanBoot, blueprintFromBoot, starterPhp, lintTest, taskId } from './worker.js';

// A real SQL engine rather than a mock. The worker talks to a D1-shaped
// binding, which is what both Spacefast Functions and Cloudflare D1 hand it, so
// these tests run the actual statements — including the ones a mock would
// happily accept and a database would not.
const d1 = () => {
  const db = new DatabaseSync(':memory:');
  const prepare = (sql) => {
    let args = [];
    const stmt = {
      bind(...a) { args = a; return stmt; },
      async run() { const r = db.prepare(sql).run(...args); return { success: true, meta: { changes: Number(r.changes) } }; },
      async all() { return { results: db.prepare(sql).all(...args) }; },
      async first() { const r = db.prepare(sql).get(...args); return r === undefined ? null : r; },
    };
    return stmt;
  };
  return {
    prepare,
    async batch(stmts) { const out = []; for (const st of stmts) out.push(await st.run()); return out; },
  };
};

let failures = 0;
const check = (cond, msg) => { if (!cond) { failures++; console.error('FAIL', msg); } else console.log('ok  ', msg); };

const ORIGIN = 'https://usertest.test';
const env = () => ({ DB: d1(), PLUGIN_ZIP_URL: 'https://example.com/card.zip', CREATE_DAILY_LIMIT: '5' });

const call = (e, path, { method = 'GET', body, ip = '203.0.113.9', headers = {} } = {}) =>
  worker.fetch(
    new Request(ORIGIN + path, {
      method,
      headers: Object.assign({ 'content-type': 'application/json', 'cf-connecting-ip': ip }, headers),
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
    e
  );

// The owner's blueprint lives somewhere else; every fetch of one is answered here.
const DEMO = { $schema: 'x', steps: [{ step: 'installTheme', themeData: { resource: 'wordpress.org/themes', slug: 'twentytwentyfive' } }] };
let served = 0;
globalThis.fetch = async (url) => {
  served++;
  if (String(url).includes('/broken')) return new Response('not json', { status: 200 });
  if (String(url).includes('forbidden.zip')) return new Response('', { status: 403 });
  if (String(url).includes('/gone')) return new Response('', { status: 404 });
  // A release asset redirects to a CDN, and not every runtime follows that on a
  // HEAD — so the card answers the way Spacefast sees it.
  if (String(url).includes('card.zip')) return new Response('', { status: 302, headers: { location: 'https://cdn.example/card.zip' } });
  return new Response(JSON.stringify(DEMO), { status: 200 });
};

const GOOD = {
  subject: 'my theme',
  persona: 'You are a photographer a few months in.\n\nCustomers keep asking whether you have a website.',
  tasks: [
    { title: 'Give the site your own name', hint: 'Look in Settings' },
    { title: 'Put one of your own photos on the front page' },
    { title: 'Write a line about yourself' },
  ],
  blueprintJson: JSON.stringify(DEMO),
  password: 'hunter2please',
};

/* ---------------------------------------------------------------- the pieces */

check(taskId('Give the site your own name', 0) === '1-give-the-site-your-own-name', 'a task id is made from its title: ' + taskId('Give the site your own name', 0));
check(taskId('!!!', 2) === 'task-3', 'a title with nothing to slug still gets an id');
check(cleanTasks([{ title: 'a' }, { title: '' }, { title: 'a' }]).map((t) => t.id).join() === '1-a,2-a', 'two tasks with the same title still get different ids');
check(cleanTasks([{ title: 'x', hint: 'h', why: 'w', nonsense: 1 }])[0].nonsense === undefined, 'a field nobody asked for is dropped from a task');
check(cleanTasks(Array(20).fill({ title: 'x' })).length === 12, 'no more than twelve tasks');

check(checkBlueprintUrl('http://example.com/b.json').error, 'an http blueprint URL is refused');
check(checkBlueprintUrl('https://127.0.0.1/b.json').error, 'an IP-literal blueprint host is refused');
check(checkBlueprintUrl('https://localhost/b.json').error, 'localhost is refused');
check(checkBlueprintUrl('https://foo.internal/b.json').error, 'an .internal host is refused');
check(checkBlueprintUrl('https://example.com/b.json').url === 'https://example.com/b.json', 'a public https URL is kept');

const ev = cleanEvent({ type: 'nonsense', task: 'x'.repeat(99), path: '/wp-admin/', note: 'n'.repeat(5000), data: { secs: 12, junk: {}, s: 'y'.repeat(900) } });
check(ev.type === 'note', 'an event type nobody declared becomes a note');
check(ev.task.length === 40 && ev.note.length === 2000, 'the task id and the note are cut to their limits');
check(ev.path === '/wp-admin/', 'the page path is kept, so "where did they get stuck" falls out later');
check(ev.data.secs === 12 && ev.data.junk === undefined && ev.data.s.length === 500, 'event data keeps numbers and short strings, drops objects');

const wrapped = wrapBlueprint(DEMO, { id: 'abc123def4', subject: 'my theme', tasks: GOOD.tasks }, ORIGIN, 'https://example.com/card.zip');
check(wrapped.steps[0].step === 'installTheme', "the owner's own steps still run first");
check(wrapped.steps[1].step === 'installPlugin' && wrapped.steps[1].pluginData.url === 'https://example.com/card.zip', 'the card is installed after them');
check(wrapped.features.networking === true, 'networking is forced on, or the card cannot report in');
check(JSON.parse(wrapped.steps[2].options.playground_user_test).report === ORIGIN + '/api/events', 'the card is told where to report');
check(DEMO.steps.length === 1, 'wrapping does not touch the blueprint it was given');

/* ------------------------------------------------- a blueprint, without one */

let b = cleanBoot({ title: 'Harbourview', tagline: 'Sea kayaking', theme: 'twentytwentyfive', plugins: ['contact-form-7'] });
check(!b.error && b.boot.theme === 'twentytwentyfive', 'a wordpress.org theme slug is taken as a slug');
b = cleanBoot({ theme: 'https://example.com/my-theme.zip' });
check(!b.error && b.boot.theme === 'https://example.com/my-theme.zip', 'a zip URL is taken as a zip');
check(cleanBoot({ theme: 'http://example.com/t.zip' }).error, 'a theme zip over plain http is refused');
check(cleanBoot({ plugins: ['https://127.0.0.1/p.zip'] }).error, 'a plugin zip on an IP literal is refused');
check(cleanBoot({ images: ['https://10.0.0.1/x.jpg'] }).error, 'a picture on an IP literal is refused');
check(cleanBoot({ theme: 'Not A Slug!' }).error, 'a theme that is neither slug nor URL is refused');
check(cleanBoot({ plugins: Array(20).fill('akismet') }).boot.plugins.length === 6, 'no more than six plugins');
check(cleanBoot({}).boot.theme === 'twentytwentyfive', 'a boot with nothing in it still gives a working site');

const boot = cleanBoot({
  title: 'Harbourview', tagline: 'Sea kayaking, all year',
  plugins: ['contact-form-7'],
  images: ['https://example.com/a.jpg', 'https://example.com/b.jpg'],
}).boot;
const built = blueprintFromBoot(boot);
check(built.steps.map((s) => s.step).join() === 'installTheme,installPlugin,setSiteOptions,runPHP', 'the boot becomes theme, plugin, options, content: ' + built.steps.map((s) => s.step).join(' '));
check(built.features.networking === true, 'the built blueprint turns networking on — the pictures need it');
check(built.steps[2].options.blogname === 'Harbourview', 'the demo site gets the name it was given');
check(blueprintFromBoot(cleanBoot({ content: 'none' }).boot).steps.every((s) => s.step !== 'runPHP'), 'content "none" leaves the site bare');

const php = starterPhp(boot);
// The PHP explains both traps in comments, so the assertions have to look at
// the code rather than the prose — otherwise they pass on the warning itself.
const phpCode = php.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
check(php.startsWith('<?php') && phpCode.includes('wp_upload_bits'), 'the generated PHP writes the bytes itself');
check(!phpCode.includes('download_url'), 'and never streams the download, which comes back empty in Playground');
check(!phpCode.includes('media_sideload_image'), 'and never sideloads by URL, which rejects a URL with no file extension');
check(/base64_decode\( '[A-Za-z0-9+/=]+' \)/.test(php), 'the copy rides as base64 rather than being quoted into PHP source');
// An apostrophe in a title is the thing that breaks naive interpolation.
const tricky = starterPhp(cleanBoot({ title: "Nita's Bakery", tagline: "Bread, and that's it" }).boot);
check(/base64_decode/.test(tricky) && !tricky.includes("Nita's"), 'an apostrophe in the site name never reaches the PHP source');

/* ---------------------------------------------------------------- the check */

let lint = lintTest({
  subject: 'my theme',
  persona: 'You are Elliot Grey, a photographer a few months into running your own business, and customers keep asking whether you have a website.',
  boot: { title: 'Elliot Grey' },
  tasks: [{ title: 'Click Settings and change the site title', hint: 'h' }, { title: 'Write a line about yourself', hint: 'h' }],
});
check(lint.problems.some((x) => /already called Elliot Grey/.test(x)), 'a persona named after the demo site is caught — the gogh bug, in one line');
check(lint.problems.some((x) => /Click/.test(x) && /control/.test(x)), 'a task that names a control is caught');
check(lint.notes.some((x) => /Five is a good number/.test(x)), 'two tasks gets a note about it');

lint = lintTest({
  subject: 'my theme',
  persona: 'You are Priya Raman. For three years you have been making furniture in a rented workshop, mostly for people who found you through a friend, and you have just registered a business name.',
  boot: { title: 'Halden Studio' },
  tasks: [
    { title: 'Put your own business name on the site', hint: 'h' },
    { title: 'Change the big headline so it says what you make', hint: 'h' },
    { title: 'Swap one of the photographs', hint: 'h' },
    { title: 'Give the site a different look', hint: 'h' },
    { title: 'Write a couple of sentences about yourself', hint: 'h' },
  ],
});
check(lint.ok && !lint.problems.length, 'the Halden Studio test passes clean: ' + JSON.stringify(lint.problems));
check(!lint.notes.length, 'and draws no notes either: ' + JSON.stringify(lint.notes));

lint = lintTest({ subject: 's', persona: 'p', tasks: [{ title: 'a', hint: 'h' }, { title: 'A', hint: 'h' }] });
check(lint.problems.some((x) => /repeats an earlier one/.test(x)), 'the same task twice is caught');

/* ------------------------------------------------------------- end to end */

const e1 = env();

let r = await call(e1, '/');
check(r.status === 200 && (await r.text()).includes('User-test it with anyone'), 'the front page is the create form');

r = await call(e1, '/api/tests', { method: 'POST', body: Object.assign({}, GOOD, { persona: '' }) });
check(r.status === 400 && (await r.json()).error.includes('pretend to be'), 'a test with no persona is refused');

r = await call(e1, '/api/tests', { method: 'POST', body: Object.assign({}, GOOD, { tasks: [] }) });
check(r.status === 400, 'a test with nothing to try is refused');

r = await call(e1, '/api/tests', { method: 'POST', body: Object.assign({}, GOOD, { password: 'short' }) });
check(r.status === 400, 'a results password that short is refused');

r = await call(e1, '/api/tests', { method: 'POST', body: Object.assign({}, GOOD, { blueprintJson: '{ not json' }) });
check(r.status === 400 && (await r.json()).error.includes('valid JSON'), 'a pasted blueprint that is not JSON is refused');

r = await call(e1, '/api/tests', { method: 'POST', body: Object.assign({}, GOOD, { blueprintJson: '', blueprintUrl: 'https://example.com/broken.json' }) });
check(r.status === 400, 'a blueprint URL that does not answer JSON is refused at the form, not at the tester');

r = await call(e1, '/api/tests', { method: 'POST', body: Object.assign({}, GOOD, { blueprintJson: '', blueprintUrl: 'https://example.com/gone.json' }) });
check(r.status === 400 && (await r.json()).error.includes('404'), 'a blueprint URL that 404s says so');

r = await call(e1, '/api/tests', { method: 'POST', body: GOOD });
const made = await r.json();
check(r.status === 200 && /^https:\/\/usertest\.test\/t\/[a-z0-9]{10}$/.test(made.tester), 'making a test gives back a tester link: ' + made.tester);
check(made.results === made.tester + '/results', 'and a results link beside it');
const ID = made.id;

// the tester's page
r = await call(e1, '/t/' + ID);
let page = await r.text();
check(r.status === 200 && page.includes('Thank you for helping make my theme better'), 'the intro page thanks them for the right thing');
check(page.includes('Customers keep asking whether you have a website.'), 'the persona is on the page, paragraph breaks kept');
check(page.includes('lists 3 things to try'), 'it counts the tasks for them');
check(!page.includes('half an hour') && !/\bminutes\b/.test(page), 'it never says how long it takes');
check(page.includes(encodeURIComponent(ORIGIN + '/t/' + ID + '/blueprint.json')), 'Start opens Playground on this test’s own blueprint');

// the wrapped blueprint
r = await call(e1, '/t/' + ID + '/blueprint.json');
const bp = await r.json();
check(r.status === 200 && bp.steps.length === 3, 'the blueprint route adds exactly two steps');
const opt = JSON.parse(bp.steps[2].options.playground_user_test);
check(opt.test === ID && opt.tasks.length === 3 && opt.subject === 'my theme', 'the card is handed the test id, the tasks and the subject');
check(opt.tasks[0].hint === 'Look in Settings', 'hints travel with the tasks');

r = await call(e1, '/t/aaaaaaaaaa/blueprint.json');
check(r.status === 404, 'a blueprint for a test that is not there is a 404');

// The one failure a tester would never notice: Playground shrugs off a failed
// installPlugin, so a missing zip means a working site with no card on it and a
// whole test recorded nowhere. It has to be refused before it is served.
const eGone = Object.assign(env(), { DB: e1.DB, PLUGIN_ZIP_URL: 'https://example.com/gone.zip' });
r = await call(eGone, '/t/' + ID + '/blueprint.json');
check(r.status === 503 && (await r.json()).error.includes('not where the service expects'), 'a card zip that is definitely gone stops the blueprint being served at all');

// GitHub answers 403 to every request from some hosts, Spacefast's among them.
// Reading that as "gone" refused every blueprint there for a zip sitting in
// plain sight — and the tester's browser, which is what actually fetches it,
// was never blocked at all.
const eBlocked = Object.assign(env(), { DB: e1.DB, PLUGIN_ZIP_URL: 'https://example.com/forbidden.zip' });
r = await call(eBlocked, '/t/' + ID + '/blueprint.json');
check(r.status === 200, 'a card zip the service cannot see is served anyway — the tester fetches it, not us');

// a tester reports in
const SID = 'ab12cd34ef56';
const post = (events, session = SID, test = ID) => call(e1, '/api/events', { method: 'POST', body: { test, session, events } });

r = await post([{ type: 'start', data: { viewport: '1440x900', tasks: 3 } }]);
check(r.status === 200, 'the card can report with no password of any kind');

r = await post([{ type: 'task_done', task: opt.tasks[0].id, note: 'easy enough', path: '/wp-admin/options-general.php', data: { secs: 74 } }]);
check(r.status === 200 && (await r.json()).n === 2, 'events pile up on the session');

r = await post([{ type: 'task_skip', task: opt.tasks[1].id, note: 'could not find it', data: { secs: 220 } }]);
r = await post([{ type: 'wrap', task: 'wrap', data: { happy: '4', confident: 'yes', feel: 'fine', confused: 'the header', name: 'Sam', minutes: 22 } }]);
check(r.status === 200, 'the wrap-up is just another event');

r = await post([{ type: 'start' }], SID, 'aaaaaaaaaa');
check(r.status === 404, 'reporting against a test that does not exist is refused');
r = await post([{ type: 'start' }], 'NOT-A-SESSION');
check(r.status === 400, 'a session id that is not one of ours is refused');

// the owner reads them
const results = (pw, q = '') => call(e1, '/api/results?test=' + ID + q, { headers: { 'x-test-password': pw } });

r = await results('wrong password');
check(r.status === 401, 'the wrong password reads nothing');
r = await call(e1, '/api/results?test=' + ID);
check(r.status === 401, 'and no password reads nothing');

r = await results(GOOD.password);
const idx = await r.json();
check(r.status === 200 && idx.sessions.length === 1, 'the right password gives one row per tester');
check(idx.sessions[0].done === 1 && idx.sessions[0].skipped === 1 && idx.sessions[0].wrapped === true, 'the row counts what they managed');
check(idx.sessions[0].name === 'Sam', 'a name they chose to type shows on the row');
check(idx.tasks.length === 3 && idx.subject === 'my theme', 'the results carry the task titles, so the table is not a list of slugs');

r = await results(GOOD.password, '&session=' + SID);
const detail = await r.json();
check(detail.events.length === 4, 'one tester’s events read back whole');
check(detail.events[1].path === '/wp-admin/options-general.php', 'the page they were on came with them');

// a second tester on the same test
await call(e1, '/api/events', { method: 'POST', body: { test: ID, session: 'ffffffff9999', events: [{ type: 'start' }] } });
r = await results(GOOD.password);
check((await r.json()).sessions.length === 2, 'a second tester is a second row');

/* --------------------------------------------- one owner cannot read another */

r = await call(e1, '/api/tests', { method: 'POST', body: Object.assign({}, GOOD, { subject: 'someone else', password: 'different-one' }) });
const other = await r.json();
check(r.status === 200 && other.id !== ID, 'a second test gets its own id');

r = await call(e1, '/api/results?test=' + other.id, { headers: { 'x-test-password': GOOD.password } });
check(r.status === 401, 'the first owner’s password does not open the second owner’s results');

r = await call(e1, '/api/results?test=' + other.id, { headers: { 'x-test-password': 'different-one' } });
check(r.status === 200 && (await r.json()).sessions.length === 0, 'the second test starts empty — the first test’s testers are not in it');

r = await call(e1, '/api/results?test=aaaaaaaaaa', { headers: { 'x-test-password': GOOD.password } });
check(r.status === 401, 'a test that does not exist answers the same as a wrong password, so ids cannot be fished for');

/* ------------------------------------------------------------------- limits */

const e2 = env();
let codes = [];
for (let i = 0; i < 7; i++) {
  const res = await call(e2, '/api/tests', { method: 'POST', body: GOOD, ip: '198.51.100.4' });
  codes.push(res.status);
}
check(codes.filter((c) => c === 200).length === 5 && codes.slice(5).every((c) => c === 429), 'five tests a day from one address, then no: ' + codes.join(','));
const e3 = env();
r = await call(e3, '/api/tests', { method: 'POST', body: GOOD, ip: '198.51.100.9' });
check(r.status === 200, 'the cap is per address, not for everybody at once');

/* ------------------------------------------------------------- for agents */

const eAgent = env();
const rpc = async (msg, e) => {
  const res = await call(e || eAgent, '/mcp', { method: 'POST', body: msg });
  return { status: res.status, body: res.status === 202 ? null : await res.json() };
};

let m = await rpc({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '0' } } });
check(m.status === 200 && m.body.result.protocolVersion === '2025-06-18' && m.body.result.serverInfo.name === 'playground-usertest', 'initialize answers with the version asked for');
check(/days, not minutes/.test(m.body.result.instructions), 'the instructions tell an agent that testing is slow, so it does not poll');

m = await rpc({ jsonrpc: '2.0', method: 'notifications/initialized' });
check(m.status === 202 && m.body === null, 'a notification gets 202 and no body');

m = await rpc({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
check(m.body.result.tools.map((t) => t.name).join() === 'usertest_check,usertest_create,usertest_delete,usertest_results', 'four tools, check first');

m = await rpc({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'nonsense', arguments: {} } });
check(m.body.error && m.body.error.code === -32602, 'a tool nobody has is an error, not a shrug');

const goodDraft = {
  subject: 'my theme',
  persona: 'You are Priya Raman. For three years you have been making furniture in a rented workshop, mostly for people who found you through a friend, and you have just registered a business name.',
  tasks: [
    { title: 'Put your own business name on the site', hint: 'The name shows top-left' },
    { title: 'Change the big headline so it says what you make', hint: 'Click the words and type' },
    { title: 'Swap one of the photographs', hint: 'Look for Replace' },
    { title: 'Give the site a different look', hint: 'Styles is the half-dark circle' },
    { title: 'Write a couple of sentences about yourself', hint: 'The About page' },
  ],
  boot: { title: 'Halden Studio', tagline: 'Furniture, made slowly', theme: 'twentytwentyfive' },
};

m = await rpc({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'usertest_check', arguments: goodDraft } });
check(m.body.result.structuredContent.ok === true, 'a good draft checks clean');

m = await rpc({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'usertest_check', arguments: Object.assign({}, goodDraft, { tasks: [{ title: 'Click the Settings menu' }] }) } });
check(m.body.result.structuredContent.ok === false && /control/.test(m.body.result.content[0].text), 'a draft that names a control is sent back with the reason');

m = await rpc({ jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'usertest_create', arguments: goodDraft } });
const agentTest = m.body.result.structuredContent;
check(!m.body.result.isError && agentTest.id && agentTest.tester && agentTest.results, 'an agent can make a test with no blueprint at all');
check(agentTest.password && agentTest.password.length >= 12, 'and gets a password made for it: ' + (agentTest.password || '').slice(0, 4) + '…');
check(/none of it can be looked up again/.test(m.body.result.content[0].text), 'and is told to hand the password on, since nothing can recover it');

m = await rpc({ jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'usertest_results', arguments: { test: agentTest.id, password: agentTest.password } } });
check(/Nobody has started/.test(m.body.result.content[0].text), 'reading results before anyone has tested says so plainly');

m = await rpc({ jsonrpc: '2.0', id: 8, method: 'tools/call', params: { name: 'usertest_results', arguments: { test: agentTest.id, password: 'wrong' } } });
check(m.body.result.isError === true, 'the wrong password reads nothing through MCP either');

// the blueprint an agent never wrote
r = await call(eAgent, '/t/' + agentTest.id + '/blueprint.json');
const agentBp = await r.json();
check(r.status === 200 && agentBp.steps.map((s) => s.step).join().includes('installTheme,setSiteOptions,runPHP'), 'the test serves a blueprint built from the boot description');
check(agentBp.steps.slice(-2)[0].step === 'installPlugin' && agentBp.steps.slice(-1)[0].step === 'setSiteOptions', 'with the card added on the end, as for any other test');

/* --------------------------------------------------------------- the digest */

const sid = (n) => 'agent' + String(n).repeat(7);
const tasksOf = JSON.parse(agentBp.steps.slice(-1)[0].options.playground_user_test).tasks;
const postTo = (session, events) => call(eAgent, '/api/events', { method: 'POST', body: { test: agentTest.id, session, events } });

await postTo(sid(1), [
  { type: 'start', data: { viewport: '1440x900' } },
  { type: 'task_done', task: tasksOf[0].id, data: { secs: 60 } },
  { type: 'hint', task: tasksOf[1].id },
  { type: 'task_skip', task: tasksOf[1].id, note: 'could not find the headline', data: { secs: 300 } },
  { type: 'wrap', task: 'wrap', data: { happy: '4', confident: 'yes', feel: 'fine', confused: 'the headline', name: 'Sam', minutes: 18 } },
]);
await postTo(sid(2), [
  { type: 'start' },
  { type: 'task_done', task: tasksOf[0].id, data: { secs: 100 } },
  { type: 'task_skip', task: tasksOf[1].id, note: 'same, gave up', data: { secs: 200 } },
]);

m = await rpc({ jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name: 'usertest_results', arguments: { test: agentTest.id, password: agentTest.password } } });
const dig = m.body.result.structuredContent;
check(dig.testers === 2 && dig.finished === 1, 'the digest counts testers and how many finished');
const t1 = dig.tasks[0], t2 = dig.tasks[1], t3 = dig.tasks[2];
check(t1.done === 2 && t1.medianSecs === 80, 'per task: how many managed it, and the median time — ' + t1.medianSecs + 's');
check(t2.couldnt === 2 && t2.hintOpened === 1 && t2.notes.length === 2, 'the task everyone failed carries both notes and the hint count');
check(t3.notReached === 2, 'a task nobody got to is counted apart from one everybody failed');
check(dig.wrapUps.length === 1 && dig.wrapUps[0].who === 'Sam', 'the wrap-up comes back with a name on it');
check(/could not find the headline/.test(m.body.result.content[0].text), 'and the text an agent reads quotes what people typed');
check(dig.tasks.every((t) => t.title), 'every task in the digest carries its title, not just a slug');

// the same thing over plain HTTP, for an agent that does not speak MCP
r = await call(eAgent, '/api/results?test=' + agentTest.id + '&digest=1', { headers: { 'x-test-password': agentTest.password } });
const httpDig = await r.json();
check(r.status === 200 && httpDig.tasks[1].couldnt === 2, 'the digest is on the HTTP route too');

r = await call(eAgent, '/llms.txt');
const llms = await r.text();
check(r.status === 200 && /usertest_check/.test(llms) && /digest=1/.test(llms), 'llms.txt describes both doors');
check(/quietly ruin a test/.test(llms), 'and passes on the two mistakes that matter');

/* ------------------------------------------------------- the global ceiling */

const eFlood = Object.assign(env(), { CREATE_DAILY_LIMIT: '50', GLOBAL_CREATE_DAILY_LIMIT: '3' });
codes = [];
for (let i = 0; i < 5; i++) {
  const res = await call(eFlood, '/api/tests', { method: 'POST', body: GOOD, ip: '198.51.100.' + i });
  codes.push(res.status);
}
check(codes.filter((c) => c === 200).length === 3, 'a global daily ceiling holds even when every request comes from a different address: ' + codes.join(','));

/* ------------------------------------------------------ the public address */
// Spacefast runs the worker on an internal origin of its own and puts the real
// hostname in x-forwarded-host. Without this every link the service hands out —
// tester link, results page, and the report URL baked into each tester's card —
// points at that internal host instead.

const behindHost = async (headers) => {
  const e = env();
  const res = await worker.fetch(new Request(ORIGIN + '/api/tests', {
    method: 'POST',
    headers: Object.assign({ 'content-type': 'application/json', 'cf-connecting-ip': '203.0.113.9' }, headers),
    body: JSON.stringify(GOOD),
  }), e);
  return (await res.json()).tester;
};

check((await behindHost({ 'x-forwarded-host': 'usertest.example', 'x-forwarded-proto': 'https' })).startsWith('https://usertest.example/t/'),
  'links use x-forwarded-host when a host runs the worker on an origin of its own');
check((await behindHost({})).startsWith('https://usertest.test/t/'),
  'and fall back to the request when nothing is forwarded');
check((await behindHost({ 'x-forwarded-host': 'evil host/../x' })).startsWith('https://usertest.test/t/'),
  'a forwarded host that is not a hostname is ignored rather than trusted');

/* ------------------------------------------------------------- clearing up */
// Every dry run is a row, and it is hard to read ten real testers past your own
// five attempts. The password that reads a test is the one that clears it.

const eWipe = env();
r = await call(eWipe, '/api/tests', { method: 'POST', body: GOOD });
const doomed = await r.json();
await call(eWipe, '/api/events', { method: 'POST', body: { test: doomed.id, session: 'wipe11112222', events: [{ type: 'start' }, { type: 'task_done', task: 'x', data: { secs: 5 } }] } });

r = await call(eWipe, '/api/results?test=' + doomed.id, { method: 'DELETE', headers: { 'x-test-password': 'not-it' } });
check(r.status === 401, 'the wrong password deletes nothing');

r = await call(eWipe, '/api/results?test=' + doomed.id, { headers: { 'x-test-password': GOOD.password } });
check((await r.json()).sessions.length === 1, 'the test is there before');

r = await call(eWipe, '/api/results?test=' + doomed.id, { method: 'DELETE', headers: { 'x-test-password': GOOD.password } });
check(r.status === 200 && (await r.json()).deleted === doomed.id, 'the right password clears it');

r = await call(eWipe, '/t/' + doomed.id);
check(r.status === 404, 'and the tester link is gone with it');
r = await call(eWipe, '/api/results?test=' + doomed.id, { headers: { 'x-test-password': GOOD.password } });
check(r.status === 401, 'so is the results page');

// A second test in the same database must be untouched by the first's deletion.
r = await call(eWipe, '/api/tests', { method: 'POST', body: Object.assign({}, GOOD, { password: 'keep-this-one' }) });
const keeper = await r.json();
await call(eWipe, '/api/events', { method: 'POST', body: { test: keeper.id, session: 'keep11112222', events: [{ type: 'start' }] } });
r = await call(eWipe, '/api/results?test=' + doomed.id, { method: 'DELETE', headers: { 'x-test-password': GOOD.password } });
r = await call(eWipe, '/api/results?test=' + keeper.id, { headers: { 'x-test-password': 'keep-this-one' } });
check(r.status === 200 && (await r.json()).sessions.length === 1, 'deleting one test leaves the others alone');

/* -------------------------------------------------------------------- misc */

r = await call(e1, '/nope');
check(r.status === 404, 'anything else is a 404');
r = await call(e1, '/t/' + ID + '/results');
check(r.status === 200 && (await r.text()).includes('x-test-password'), 'the results page is served to anyone; it is the password that gates the data');
r = await call(e1, '/api/tests', { method: 'GET' });
check(r.status === 405, 'the create route is POST only');

const noStore = await worker.fetch(new Request(ORIGIN + '/api/tests', { method: 'POST', body: JSON.stringify(GOOD) }), { PLUGIN_ZIP_URL: 'x' });
check(noStore.status === 503, 'with no database bound, the Worker says so rather than pretending');

// The schema memo is keyed on the binding, so a second database in the same
// process gets its own tables rather than inheriting the first one's "done".
const eFresh = env();
r = await call(eFresh, '/api/tests', { method: 'POST', body: GOOD });
check(r.status === 200, 'a second, separate database is set up on its own');

console.log(failures ? '\n' + failures + ' failed' : '\nall good');
process.exit(failures ? 1 : 0);
