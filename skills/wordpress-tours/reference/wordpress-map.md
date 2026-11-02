# Where things are in WordPress

Checked against the latest WordPress in Playground, with Twenty Twenty-Five,
in November 2026, by playing tours through it. Anything marked *not checked*
is what WordPress is expected to do, not something a tour has proved. Before
relying on a selector this file does not list, open a Playground and look.

Addresses are given as `go` lines take them: a path on the site.

## The front of the site (logged in)

The admin bar runs across the top. `go` uses it by itself; these are for
pointing at or pressing within a step.

| what | selector | notes |
|---|---|---|
| Edit Site | `#wp-admin-bar-site-editor > a` | Opens the Site Editor **in edit mode** on the home template, not its sidebar. |
| Command palette | `#wp-admin-bar-command-palette > .ab-item` | Its search box: `.commands-command-menu input \|\| [cmdk-input]`. `press Escape` closes it. |
| + New | `#wp-admin-bar-new-content` | A menu: Post, Media, Page, User. `go /wp-admin/post-new.php?post_type=page` opens it and presses Page. |
| Site name | `#wp-admin-bar-site-name > a` | Goes to the dashboard. |

## The Site Editor (`/wp-admin/site-editor.php`)

It has two faces, and they do not share buttons.

### Its sidebar (browse mode)

The dark sidebar on the left, with the site shown beside it.

| what | how to press it | address |
|---|---|---|
| Identity, Styles, Pages, Navigation, Patterns, Templates | `button "Styles"` and so on, by their words | Styles is `?p=%2Fstyles`, Pages is `?p=%2Fpage` |
| Back up a level | `.edit-site-sidebar-button[aria-label="Back"]` | At the top level it leaves for the dashboard. |
| Save | `.edit-site-save-hub__button` | At the bottom. Reads "Saved", or "Review 1 change…" when there is something to save, which opens a panel: `maybe .editor-entities-saved-states__save-button`. |

### Edit mode (`?canvas=edit`)

The editor across the whole window. Edit Site lands here.

| what | how to press it |
|---|---|
| Out to the sidebar | `[aria-label="Open Navigation"]` (the W at the top left; it can open on the Templates list, so back up a level for the others) |
| Add a block | `.editor-document-tools__inserter-toggle` (aria-label "Block Inserter") |
| Styles | `button "Styles"` (an icon; matched by its label). Pressing it again closes the panel. |
| Save | `button "Save"`, then `maybe .editor-entities-saved-states__save-button` |
| Undo, Redo, Document Overview, View, Settings, Options | `[aria-label="…"]` with those words |

There is no zoom-out button at narrower widths (around 900 pixels); do not
build a step on it.

### The Styles panel (either face)

| what | how to press it |
|---|---|
| Ready-made looks | `button "Browse styles"`, then `.global-styles-ui-variations_item:not(.is-active)` for any look but the current one. Each look's aria-label is its name ("Evening", "Midnight"). |
| Font pairs | `button "Typography"`, then the same `.global-styles-ui-variations_item:not(.is-active)` (aria-labels like "Beiruti & Literata") |
| Back to the top of Styles | `[aria-label="Back"]`, or `maybe [aria-label="Back"]` when you are not sure it is open |

A look or font pair changes nothing for the `styles` check until it is saved.

## The block editor (posts and pages)

`go /wp-admin/post-new.php?post_type=page` for a new page,
`go /wp-admin/post-new.php` for a new post.

| what | how to press it |
|---|---|
| Add a block | `.editor-document-tools__inserter-toggle` |
| Publish | `.editor-post-publish-button__button`, then the panel's `.editor-post-publish-panel__header-publish-button button` |

The page being edited sits in a frame (`iframe[name="editor-canvas"]`).
Pointers find things inside it by themselves.

The editor saves a draft early. The `new_page` / `new_post` checks count a
draft made before the step as new once it is published.

## wp-admin

| screen | address | how `go` gets there |
|---|---|---|
| Dashboard | `/wp-admin/` | the admin bar's site name |
| Settings → General | `/wp-admin/options-general.php` | the admin menu |
| Appearance → Editor | `/wp-admin/site-editor.php` | the admin menu, opening Appearance first |
| New page | `/wp-admin/post-new.php?post_type=page` | + New, then Page |

*Not checked*, but the same route-finding applies: Pages
(`/wp-admin/edit.php?post_type=page`), Posts (`/wp-admin/edit.php`), Media
(`/wp-admin/upload.php`), Plugins (`/wp-admin/plugins.php`), Settings →
Reading (`/wp-admin/options-reading.php`).

## A plugin's own screens

*Not checked with a real plugin.* A plugin's settings screen is usually
`/wp-admin/admin.php?page=<its-slug>` or `/wp-admin/options-general.php?page=<its-slug>`.
If the plugin adds it to the admin menu, `go` reaches it like any other
screen. A plugin's block is found in the inserter by its name, and its
`block` check takes the name WordPress registers (`my-plugin/my-block`),
which is in the plugin's `block.json`.

## Things the service handles

- The visitor is logged in.
- On a tour, the editors' welcome popups ("Edit your site", "Welcome to the
  editor") are turned off.
- A step that moves to another screen with `go` shows the way; you only
  write where it is going.
