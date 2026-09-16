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
worker/worker.js        the service: form, intro page, blueprint, events, results
worker/wrangler.jsonc   config — no build step, worker.js deploys as it stands
worker/test-worker.mjs  the whole thing against a KV mock: node test-worker.mjs
```

The card plugin lives beside this and is pointed at by `PLUGIN_ZIP_URL`.

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

## Running it

```bash
cd worker
npm test          # the suite, against a KV mock — no network, no account
npm run dev       # wrangler dev on localhost:8787, local KV
npm run deploy    # wrangler deploy; Cloudflare makes the KV namespace
```

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
