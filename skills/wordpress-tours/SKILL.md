---
name: wordpress-tours
description: Write a guided tour of WordPress, or of a plugin or theme, for the Playground user testing service (mode "tour"). The tour plays itself in a real WordPress in the visitor's browser, pressing through each step while a pointer shows the way and a voice reads a script. Use when someone wants to show people a WordPress feature, a release, or their plugin, rather than test them on it, or asks for a "tour", "walkthrough", "demo" or "showcase" in WordPress.
---

# Writing WordPress tours

A tour is a test turned round. The visitor opens a link, gets a real
WordPress in their browser, and a card shows them round: each step says what
it shows, a pointer glides to each button and presses it, the site confirms
the step happened, and the tour ends with a button ("Get the plugin", "Read
the release post"). Nobody has to do anything. They can pause and try a step
themselves, skip, or restart.

Your job is to write the steps so that they play cleanly and read well.

## How it is made

The service is at `https://playground-usertest.view.fast` (MCP at `/mcp`,
plain HTTP described in `/llms.txt`). Make a tour with `usertest_check`
first, then `usertest_create`, both with `mode: "tour"`:

```json
{
  "mode": "tour",
  "subject": "Open Today",
  "persona": "For anyone who runs a shop.",
  "button": { "label": "Get the plugin", "url": "https://wordpress.org/plugins/open-today/" },
  "theme": { "accent": "#6b3fa0", "card": "light" },
  "boot": { "title": "Crumb & Co", "plugins": ["open-today"] },
  "tasks": [
    {
      "title": "Your opening hours",
      "hint": "One block shows your hours and whether you're open now.",
      "say": "Let's add your opening hours to the home page. I'll open the block inserter, search for hours, and drop the block in.",
      "do": ["go /wp-admin/post-new.php?post_type=page", "[aria-label=\"Block Inserter\"]", "type \"hours\" into [placeholder=\"Search\"]", "button \"Opening hours\""],
      "check": { "type": "block", "block": "open-today/hours" }
    }
  ]
}
```

(The plugin in that example is made up, and so are its search box and block
button. Use the real block name, screen and buttons of the plugin you are
writing for, checked in a Playground.)

Hand back both links and the password from `usertest_create`; the password
cannot be recovered.

## Made from a chat

A tour should be makeable from one sentence, like "make a tour of my plugin
that shows off the hours block, in my brand purple". Do the rest in the
conversation:

1. Find out what the tour is for and where it ends: the plugin or feature,
   who it is for, and the button at the end (words and link).
2. Draft three to six steps with their `say` lines, and read the plan back
   in plain words before making anything.
3. Turn colours into hex yourself: "my brand purple" means asking for the
   hex if you do not know it, or proposing one and saying so. Light or dark
   card: pick from their site's look, or ask. Colours come from this chat:
   if they name none, leave `theme` out rather than reach for a brand you
   remember from elsewhere.
4. `usertest_check`, fix what it names, `usertest_create`, hand over both
   links and the password, and suggest they watch it once with sound on.

## Colours

`theme: { accent, card }`. The accent (a hex colour) fills the card's
buttons and colours its edge, the ring round the next thing to press and
the pointer's halo. `card` is `"dark"` (the default) or `"light"`. The
service works out what reads on the accent and, if the accent is too pale
or too dark to read as words on the card, uses a readable shade for the
words and says so in the check. Leave `theme` out for the service's mint on
a dark card.

## Languages

`lang` puts the whole tour in another language: a WordPress locale
(`fr_FR`, `de_DE`, `es_ES`, `it_IT`, `nl_NL`, `pt_BR`) or a short code
(`fr`). The visitor's WordPress boots in it, and the card's own buttons and
the welcome page follow it in French, German, Spanish, Italian, Dutch and
Portuguese. Any other locale still sets the site's language, but the card's
own words stay English.

Everything you write stays as you write it, so write the subject, titles,
hints and `say` lines in that language. Steps that find a button by its
words (`button "Styles"`) need the words WordPress shows in that language
(`button "Estilos"` in Spanish); ids and classes work in every language.
The browser reads the script in a voice for that language where the
computer has one, and an `audio` recording in the language sounds better.

For several languages, make one tour per language: same steps, translated
words. Check each with `usertest_check`, which points out steps that press
buttons by their words.

## Moves that work

These moves through WordPress's own screens were each played end to end in
Playground (WordPress 7.1). Copy the `do` lists as they are, with your own
words where it says …. None depends on a button's words except Styles, so
they work in every language. A tour of WordPress itself can be built from
them alone; a plugin tour uses them for the WordPress parts (a new post,
publishing) and records the rest.

- Start a new post: `["go /wp-admin/post-new.php"]`
- Start a new page (closes the pattern chooser): `["go /wp-admin/post-new.php?post_type=page","maybe press Escape"]`
- Type the title of a post or page: `["type \"…\" into .editor-post-title__input || h1.editor-post-title"]`
- Write the first paragraph: `[".block-editor-default-block-appender__content","type \"…\" into p[data-type=\"core/paragraph\"]"]`
- Set a featured image (needs "images" on the site): `["[data-tab-id=\"edit-post/document\"]",".editor-post-featured-image__toggle","#menu-item-browse",".attachments .attachment",".media-button-select"]`
- Publish (check new_post or new_page): `[".editor-post-publish-panel__toggle",".editor-post-publish-button","wait 2"]`
- Change the site title (check site_name): `["go /wp-admin/options-general.php","type \"…\" into #blogname","#submit"]`
- See all posts: `["go /wp-admin/edit.php"]`
- See all pages: `["go /wp-admin/edit.php?post_type=page"]`
- Open the Site Editor: `["go /wp-admin/site-editor.php"]`
- Pick a ready-made style in the Site Editor (check styles): `["button \"Styles\"","button \"Browse styles\"",".global-styles-ui-variations_item:not(.is-active)",".edit-site-save-hub__button || button \"Save\"","maybe .editor-entities-saved-states__save-button"]`
- Open the command palette: `["#wp-admin-bar-command-palette > .ab-item"]`

A step that picks a picture needs pictures in the Media Library: give the
site `"images": [links]`, because an upload from someone's own computer
cannot be played back.

## Recording the clicks

Guessing what a step presses is where tours go wrong, above all for
someone's own plugin, whose buttons you cannot see. Record them instead:
POST the draft (the same JSON, no password) to `/api/record`, or have the
person press **Record the clicks in Playground** on the form. They get a
Playground link with their site and the card in record mode; they do each
step themselves and press Next step, and the card writes down exactly what
they pressed and typed, in playback's own words (a button by its words in
the site's language, an id or classes otherwise, `type "…" into …`,
`press Escape`). At the end they copy the whole tour from the card and paste
it into the form's **Paste from your assistant** box, or give it back to you.
Keep your titles, hints and `say` lines; the recording fills `do` and
`point`. Nothing is stored until the tour is made.

## Planning

- Three to six steps. Most people stop somewhere around five.
- One idea per step, and an order that tells a story: where things are, the
  thing worth seeing, the thing it lets you do, the result.
- Start where the visitor lands (usually the front of the site) and move
  between screens the way a person would. Use `go` for that: see below.
- Leave the site better than you found it in a way they can see: a new look,
  a block on the page, a published post.
- End with something to do next. The button at the end is the point of the
  tour for whoever made it.

## A step

| field | what it is |
|---|---|
| `title` | The card's heading. Short: "A new look in one click". |
| `hint` | The card's line under it. One sentence about what this shows and why it's good. |
| `say` | What the voice says, if they turn sound on. Written to be heard: see below. |
| `do` | What the step presses by itself, one action per line. |
| `check` | How the site confirms the step happened before the tour moves on. |
| `point` | Optional: where the ring sits while the tour is paused. |
| `audio` | Optional: an https link to a recording of `say` in a real voice. |

The tour itself also takes `button` (where it ends), `theme` (its colours,
below) and `endAudio` (a recording of the closing words).

### `do`: the actions

One per line, at most ten:

```
go /wp-admin/site-editor.php?p=%2Fpage    open a screen, showing the way there
button "Styles"                           press it: a button by its words or label
.edit-site-save-hub__button               press it: any CSS selector
a || b                                    the first of these that is on screen
type "styles" into input                  type into a field
press Escape                              Escape, Enter or Tab
wait 2                                    seconds, up to ten
maybe button "Get started"                pass over it if it is not there
```

- **Moving between screens: always `go`.** The card works out the route
  through WordPress's own navigation and presses it with the pointer: the
  admin menu, the admin bar's menus (+ New, then Page), Edit Site, the Site
  Editor's sidebar. Do not write those presses yourself, and do not worry
  about where the visitor is when the step starts. If the card cannot find a
  way it goes straight there and records a note on the step; a note in the
  results means that step needs a different start.
- **Pressing within a screen: words beat classes.** `button "Typography"`
  and `[aria-label="Styles"]` survive WordPress releases far better than
  class names. Never use generated classes like `css-1nxhn2u`.
- **Saving in the Site Editor takes two presses** when there are changes:
  `.edit-site-save-hub__button || button "Save"`, then
  `maybe .editor-entities-saved-states__save-button`.
- A step whose button cannot be found within twelve seconds pauses and says
  so, rather than carrying on as if it had worked.

### `check`: how a step proves itself

| check | for |
|---|---|
| `{ "type": "page", "path": "site-editor.php" }` | reaching a screen (part of its address) |
| `"styles"` | the colours or fonts changed (needs a Save) |
| `"home"` | the home page or its template changed (needs a Save) |
| `"new_page"`, `"new_post"` | a page or post was published |
| `"site_name"`, `"tagline"`, `"logo"`, `"site_icon"`, `"menu"` | those changed |
| `{ "type": "text", "text": "Open today" }` | words appear on the home page |
| `{ "type": "block", "block": "core/quote" }` | a block of that kind was added in the editor, saved or not |
| `{ "type": "block_changed", "block": "core/quote" }` | a block already there had its settings changed |
| `"none"` | nothing to confirm; the step carries on after its actions |

Checks are measured from when the step began, so two styles steps in a row
each need their own change. Give every step that changes something a check:
it is what stops a missed click passing as a success.

### `say`: writing for the voice

The voice is a person standing next to them. Write it that way.

- Two or three sentences. Say what we're looking at, why it matters, and
  what's about to happen: "Styles is where the look of the whole site comes
  together. Pick one and the colours and fonts change everywhere at once.
  I'll choose one and save it."
- When the step moves to another screen, say where you're going: "I'll step
  back out of the editor and open Pages."
- Words, not symbols: "Command K", not "⌘K"; "the plus button", not "+".
- Plain and warm. No hype, no "simply", no "just", no exclamation marks.
- The card's `hint` is read when there is no `say`, and the heading is never
  read, so do not repeat the title in `say`.

## The blueprint

Use `boot` (the service builds the blueprint) or the maker's own demo
blueprint. Either way:

- **Pin the WordPress version** (`preferredVersions.wp`) to the one you
  checked the tour against. Selectors can move between releases.
- The service logs the visitor in and turns off the editors' welcome popups
  for tours; you do not need to.
- Give the site some content and pictures so it looks like a real one.

## Testing it

1. `usertest_check` the draft and fix every problem it names.
2. `usertest_create`, open the tester link yourself, press Start the tour,
   and watch it to the end with sound on.
3. Read the results: any "Went straight to …" note means a `go` could not
   find the way; any step paused with "could not find what to press" means a
   selector is wrong for that WordPress. Fix with `usertest_update` (same
   links, same password).
4. `usertest_delete` your dry runs before sending the link to anyone.

## Where things are

`reference/wordpress-map.md` has the screens, their addresses, and the
buttons and selectors that were checked against a real WordPress. Read it
before writing `do` lines, and check anything it does not list in a
Playground before relying on it.
