# Playground user testing

User-test a WordPress theme, plugin or site with anyone who has a browser, in
ten minutes, with nothing to install.

The tester opens a link and gets a throwaway WordPress site in the browser
([WordPress Playground](https://playground.wordpress.net)), with a small card on
the right listing a few things to try. They press Done or Couldn't do it on each,
type a note if they like, and answer four questions at the end. Whoever made the
test reads the results on a page behind a password.

Live at **https://playground-usertest.view.fast** — the form for people, `/mcp`
for agents.

## Why a service and not just a plugin

The test site is a Playground tab. It vanishes when the tab closes, and the
tester has no site of their own, so results have to leave the sandbox as they
happen. Something has to receive them — which is what the Worker is. It holds
the tests, serves the tester's intro page, serves the wrapped blueprint,
receives the events, and shows the results. The plugin is just the card and the
sender.

## The owner's flow

1. Open the service and fill in one form: who the tester should pretend to be, a
   handful of things to try, and the blueprint already used to demo the thing —
   a URL, or pasted JSON. Choose a password for the results.
2. Get two links back: a tester link like `/t/abc123` and a results link.
3. Send the tester link. Read the results whenever.

No account. Nothing to host. No JSON to edit.

## What is in here

```
worker/worker.js               the service: form, intro page, blueprint, events, results, MCP
worker/wrangler.jsonc          Cloudflare config — worker.js deploys as it stands
worker/test-worker.mjs         the whole thing against a real SQL engine

spacefast/sf.jsonc             Spacefast config: Functions, with a database
spacefast/build.sh             assembles the two files Spacefast publishes

plugin/playground-usertest.php the card plugin — inert unless the site is a test
plugin/card.js                 the card itself: tasks, notes, the wrap-up, the queue
plugin/build-zip.sh            builds the zip the blueprint route installs
plugin/test-plugin.php         the plugin against WordPress stubs
```

The two halves meet at one URL: `PLUGIN_ZIP_URL` in `worker/wrangler.jsonc`.
Every test's blueprint installs whatever is at that URL, so a fix to the card
reaches everybody's next tester without redeploying the Worker.

## Routes

| | |
|---|---|
| `GET /` | the create form |
| `POST /api/tests` | make a test → `{ id, tester, results }` |
| `GET /t/<id>` | the tester's intro page |
| `GET /t/<id>/blueprint.json` | the owner's blueprint plus the card |
| `GET /t/<id>/results` | the results page (asks for the password) |
| `POST /api/events` | the card reporting in |
| `GET /api/results` | results as JSON, `x-test-password` header; `&digest=1` folds them down |
| `DELETE /api/results` | clears a test and everything on it, same password |
| `POST /mcp` | the same three things, as tools an assistant can call |
| `GET /llms.txt` | what this is, for agents that read rather than speak MCP |

## For agents

An assistant that has just built someone a theme is the natural place to say
"want to test this with five people?" — so the whole service is callable as
three MCP tools at `/mcp`, and as plain HTTP for anything that would rather
curl. No accounts either way: the results password is the key, and
`usertest_create` makes one if you do not.

| | |
|---|---|
| `usertest_check` | Check a draft. Returns problems and softer notes. |
| `usertest_create` | Make the test. Returns both links and the password. |
| `usertest_results` | The digest: per task, how it went, and everything anyone typed. |
| `usertest_delete` | Clears a test. Use it on dry runs before the real invitations. |

Three things make this usable by an agent rather than merely callable.

**It will build the blueprint.** Nobody arrives holding a Playground blueprint,
and writing one is fiddly in ways that bite quietly — a failed step does not
stop the boot, it leaves a hole in the site. So a test can describe what it
wants instead:

```json
{ "boot": { "title": "Halden Studio", "tagline": "Furniture, made slowly",
            "theme": "twentytwentyfive", "plugins": ["the-thing-being-tested"],
            "images": ["https://…jpg"] } }
```

and the service assembles the theme, the plugins, the site options and a
starter site with those photographs on the front page. The two traps that make
pictures vanish — a URL with no file extension, and a streaming download
Playground cannot do — are handled, and written down in the generated PHP for
whoever reads it next.

**The results come back folded up.** A tester can spend six hundred events, and
nobody reads a stream to learn that four people in five gave up on task three.
The digest gives you, per task: done, couldn't, never reached, median seconds,
how many opened the hint, and every note anyone typed.

**The check knows the two mistakes.** An agent drafting tasks makes both by
default, and both ruin a test quietly rather than breaking it:

- A task that names a control — "click Settings" — tests whether someone can
  follow an instruction, not whether they can find it. Say what they want to end
  up with; the control belongs in the hint, which is how you learn who needed it.
- A persona named after the demo site leaves nothing to change when the task is
  about making the site their own. That one cost a whole round of testing in
  gogh: an Elliot Grey site and an Elliot Smith persona.

`usertest_check` catches both, and never blocks — someone who means it can
ignore every word.

## Where it runs, and what it stores in

One SQL database behind a D1-shaped binding — which is what Spacefast's
Functions runtime hands a worker that declares `"database": true`, and what
Cloudflare D1 gives you. The same `worker.js` runs on either; only the config
differs.

```
tests     one row per test: tasks, persona, blueprint, password hash, expiry
sessions  one row per tester
events    one row per thing a tester did, keyed (test, session, seq)
counters  the rate caps
```

The SQL is deliberately plain — VARCHAR with lengths, no AUTOINCREMENT, no
`ON CONFLICT`, no `CREATE INDEX` — because "D1-shaped" describes the API, not
the engine underneath, and MySQL and SQLite disagree about all of those. Every
lookup rides a primary key that already covers it. Tables are created on first
use; there is no migration step.

Everything expires ninety days after the last event, checked on read rather
than trusted to a sweep, so a link is dead the moment it should be.

## What it collects

Which task the tester is on, whether they managed it, how long it took, whether
they opened the hint, which page they were on, and anything they type into the
card. Nothing else: not what they write on the site, and not their name unless
they choose to type it. The intro page says so.

## The card

It shows one task at a time, with a note box, a hint the tester has to ask for,
and Done / Couldn't do it. Then the wrap-up: happy 1–5, could you finish, how it
felt, what confused you, and a name if they want to give one.

Two things it does that are worth knowing:

- **It measures rather than guesses where to sit.** A fixed offset lands on the
  site's own menu for some themes and floats in space for others, so it takes
  the lowest edge of whatever is stacked at the top of the page — admin bar,
  header, editor chrome — and starts below that. If the measurement is still
  wrong, the tester can drag it by its top bar, and where they put it is
  remembered.
- **It keeps its place.** The session id is a site option, not something the
  browser makes, so a reload does not turn one tester into two rows, and the
  list follows them between the editor and the published site.

Events queue in `localStorage` and retry, so a flaky minute loses nothing.

## Running it

```bash
cd worker
npm test                    # the service against a real SQL engine — no network, no account
npm run dev                 # wrangler dev on localhost:8787

cd ../plugin
php test-plugin.php         # the plugin against WordPress stubs
./build-zip.sh              # dist/playground-usertest-card.zip
```

**On Spacefast**, which is where it lives:

```bash
cd spacefast
./build.sh --publish --slug playground-usertest --access public
```

`build.sh` assembles the only two files Spacefast publishes — `sf.jsonc` and the
worker. A declared runtime takes every request, so anything else published
alongside would be uploaded and never served.

**On Cloudflare**, from the same `worker.js`: create a database with
`wrangler d1 create playground-usertest`, put its id in `wrangler.jsonc`, then
`wrangler deploy`.

## The card

The blueprint installs the card from `PLUGIN_ZIP_URL`, defaulting to the GitHub
release. That fetch happens in the **tester's browser**, not on the server, so
it works even where the service itself cannot reach out. The service checks the
URL before serving a blueprint, but only a definite 404 counts as missing: a
host that cannot see a file knows nothing about whether a tester can.

## Saying what the tester gets

Three ways, and on a host without outbound fetch only two of them work.

| | Needs the service to fetch? |
|---|---|
| `boot` — describe the site, the service builds the blueprint | no |
| `blueprintJson` — paste it | no |
| `blueprintUrl` — a URL, re-read each time a tester starts | **yes** |

The URL is the one that can fail, and not because of the URL. Unlike the card,
this blueprint has to be *read* here — the owner's steps are wrapped with two
more before a tester sees them, and you cannot wrap what you cannot fetch.

**Spacefast denies workers outbound fetch** unless the version is granted it
(`egress_denied`: "This version was not granted outbound fetch"), so on the
live host `blueprintUrl` returns a message saying exactly that, rather than
blaming a URL that is sitting there readable. `boot` and `blueprintJson` are
unaffected, which includes the whole agent path.

## Cost

Rows in a database are not rationed by the day, so the ceiling that used to
bound this — Cloudflare KV's 1,000 free writes, about twenty-five testers —
is gone. What is left is what the plan gives the space, and Spacefast does not
publish a figure for function invocations or database size. Undocumented is not
the same as unlimited; if this ever carries real volume, that is the question to
ask rather than assume.

## Abuse

Five tests a day per address (a rejected form does not count against it), a
global ceiling of 200 a day — because a per-address cap does nothing about
agents, which arrive from shared cloud egress — 300 events an hour per address,
everything expires, and no free text reaches
anything but the results page, escaped there. The blueprint URL is the one thing
the Worker fetches on someone's say-so: https only, no IP literals, no localhost,
no `.internal`, and capped at 256KB.
