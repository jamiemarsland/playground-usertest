# Playground user testing

User-test a WordPress theme, plugin or site with anyone who has a browser, in
ten minutes, with nothing to install.

The tester opens a link and gets a throwaway WordPress site in the browser
([WordPress Playground](https://playground.wordpress.net)), with a small card on
the right listing a few things to try. They press Done or Couldn't do it on each,
type a note if they like, and answer four questions at the end. Whoever made the
test reads the results on a page behind a password.

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
worker/worker.js               the service: form, intro page, blueprint, events, results
worker/wrangler.jsonc          config — no build step, worker.js deploys as it stands
worker/test-worker.mjs         the whole thing against a KV mock

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
| `GET /api/results` | results as JSON, `x-test-password` header |

## KV

One namespace, bound as `TESTS`:

```
test:<id>                 the test (tasks, persona, blueprint, password hash)
test:<id>:session:<sid>   one tester's events, newest last, capped at 600
test:<id>:index           one row per tester session, newest first
ip:*                      rate counters
```

Everything expires ninety days after the last event, so an abandoned test cleans
itself up and the store never grows without bound.

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
npm test                    # the service against a KV mock — no network, no account
npm run dev                 # wrangler dev on localhost:8787, local KV
npm run deploy              # wrangler deploy; Cloudflare makes the KV namespace

cd ../plugin
php test-plugin.php         # the plugin against WordPress stubs
./build-zip.sh              # dist/playground-usertest-card.zip
```

Before the first real tester, the zip has to be somewhere Playground can fetch
it, at the URL `PLUGIN_ZIP_URL` names — a GitHub release asset is the easiest.
Until then the blueprint route answers 503 rather than serving a blueprint that
would build a site with no card on it.

## Cost

Cloudflare's free KV tier allows 1,000 writes a day. A tester spends about
fifteen, so roughly sixty testers a day before Workers Paid at $5/month is worth
it. Past that ceiling the rate counters fail and the Worker keeps serving rather
than going down — the caps are there to stop one address filling the store, not
to bound a bill.

## Abuse

Five tests a day per address (a rejected form does not count against it), 300
events an hour per address, everything expires, and no free text reaches
anything but the results page, escaped there. The blueprint URL is the one thing
the Worker fetches on someone's say-so: https only, no IP literals, no localhost,
no `.internal`, and capped at 256KB.
