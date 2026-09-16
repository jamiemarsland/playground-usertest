// The Worker, end to end against a KV mock: making a test, the tester's intro
// page, the wrapped blueprint, events coming in, and the results coming out —
// including the parts that keep one owner's test out of another's.
// Run: node test-worker.mjs
import worker, { cleanEvent, cleanTasks, wrapBlueprint, checkBlueprintUrl, taskId } from './worker.js';

const kv = () => {
  const m = new Map();
  return {
    async get(k) { return m.has(k) ? m.get(k) : null; },
    async put(k, v) { m.set(k, v); },
    async delete(k) { m.delete(k); },
    _m: m,
  };
};

let failures = 0;
const check = (cond, msg) => { if (!cond) { failures++; console.error('FAIL', msg); } else console.log('ok  ', msg); };

const ORIGIN = 'https://usertest.test';
const env = () => ({ TESTS: kv(), PLUGIN_ZIP_URL: 'https://example.com/card.zip', CREATE_DAILY_LIMIT: '5' });

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
  if (String(url).includes('/gone')) return new Response('', { status: 404 });
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

/* -------------------------------------------------------------------- misc */

r = await call(e1, '/nope');
check(r.status === 404, 'anything else is a 404');
r = await call(e1, '/t/' + ID + '/results');
check(r.status === 200 && (await r.text()).includes('x-test-password'), 'the results page is served to anyone; it is the password that gates the data');
r = await call(e1, '/api/tests', { method: 'GET' });
check(r.status === 405, 'the create route is POST only');

const noStore = await worker.fetch(new Request(ORIGIN + '/api/tests', { method: 'POST', body: JSON.stringify(GOOD) }), { PLUGIN_ZIP_URL: 'x' });
check(noStore.status === 503, 'with no KV bound, the Worker says so rather than pretending');

console.log(failures ? '\n' + failures + ' failed' : '\nall good');
process.exit(failures ? 1 : 0);
