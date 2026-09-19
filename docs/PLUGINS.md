# Plugins

A plugin is a program somebody else wrote that watches or drives agentglass
over HTTP, packaged so that installing it, reading what it asks for, and
switching it on are three separate acts a person performs in Settings → Plugins.
This page is the design and the how-to in one place; the short version, with
the worked example, is [§6 of EXTENDING.md](EXTENDING.md#6-publish-a-plugin).

- [What a plugin is](#what-a-plugin-is)
- [The manifest](#the-manifest)
- [Scopes, in reviewer language](#scopes-in-reviewer-language)
- [Install, review, enable](#install-review-enable)
- [Catalogues](#catalogues)
- [Drawing in the app](#drawing-in-the-app)
- [What a plugin cannot do](#what-a-plugin-cannot-do)
- [Publishing one](#publishing-one)
- [A worked example](#a-worked-example)
- [Where this stops being small](#where-this-stops-being-small)

## What a plugin is

A folder with a `plugin.json` at its root. It is copied onto disk at install,
under `~/.config/agentglass/plugins/<name>/`, and nothing in it runs at that
point. When a person enables it, the server mints a token at the granted scope
and starts the manifest's `entrypoint` as **its own process**, with exactly four
variables in its environment: `PATH`, `HOME`, `AGENTGLASS_URL` and
`AGENTGLASS_READ_TOKEN`. The variable is named `AGENTGLASS_READ_TOKEN` whatever
scope was granted — the name predates plugins and was kept so the same script
works as a plugin and as a hand-run extension.

From there the plugin talks to agentglass the way any outside program does:
the HTTP routes and the `/stream` WebSocket, described in
[EXTENDING.md](EXTENDING.md). Nothing is loaded into the server or the desktop
window. The only thing the plugin mechanism adds over "write a script and export
a token" is the packaging: a manifest a reviewer can read, a catalogue to find it
in, and an on/off switch that revokes the token when it is off.

Disabling a plugin kills its process and revokes its token. A server restart
respawns every enabled plugin with a fresh token; tokens live in memory and are
never written to disk.

## The manifest

```json
{
  "name": "hello-stream",
  "publisher": "someone",
  "description": "Writes a line to its own log whenever an agent finishes a turn.",
  "entrypoint": "bun run watch.ts",
  "scope": "read"
}
```

| field | rule |
|---|---|
| `name` | 1–60 characters, `A-Z a-z 0-9 . - _`; not `.`, not `..`, and not starting with a dot. Becomes the directory name on disk. |
| `publisher` | 1–200 characters. Shown to the reviewer; not verified. |
| `description` | 1–500 characters. Shown to the reviewer; not verified. |
| `entrypoint` | a shell command, 1–500 characters, no control characters; run through `bash -c` with the install directory as its working directory. |
| `scope` | `read`, `answer` or `full` — what the plugin *asks for*. See below. |

A manifest that fails any rule is refused with the sentence naming the rule;
nothing is coerced into a wider shape than what was declared.

## Scopes, in reviewer language

The three scopes are the same three the server already uses for paired devices
(`server/src/auth.ts`), so no new permission language had to be invented and
nothing new has to be kept in step with the route table.

- **`read`** — every `GET` route, including `/stream`: a session's live output as
  it happens, the same prompts and replies shown on screen, costs, diffs, pull
  requests, the Lantern's board. Cannot write anything.
- **`answer`** — everything `read` gets, plus replying to a session that is
  already running (`/chat/send`, `/chat/pane/key`). It does **not** include
  releasing a permission gate — see the next paragraph.
- **`full`** — everything this machine can do: a terminal, git writes, Docker
  control, merging pull requests, installing other plugins.

**A plugin never answers a gate.** `POST /gate/decide` is the one act the server
reserves for a credential that no process on this machine could have minted for
itself — a paired phone's, or a person at the desktop. A plugin's token is minted
by this server and sits in the environment of a child process of this server, on
this machine, readable by any other process running as the same user. That is
exactly the kind of caller the gate exists to hold, so plugin tokens are their
own kind (`kind: "plugin"`) and are turned away from `/gate/decide` by name,
whatever scope the manifest declared and whatever scope was granted. A plugin at
`answer` can reply to an agent; it cannot release one.

The manifest is a request, not a grant. The reviewer sees the scope and decides
whether to enable the plugin at all; a plugin cannot obtain `full` by writing
`"full"` and being believed.

## Install, review, enable

1. **Install** copies the folder — from a git URL, a local path, or a catalogue
   entry — into the plugins directory and reads `plugin.json`. No code runs.
   The install refuses a `name` that is `.`, `..` or dotted, and every path it
   removes or copies is asserted to sit under the plugins root before anything
   touches the filesystem.
2. **Review** shows what the manifest declares: publisher, description, the
   entrypoint command, the scope asked for. What was reviewed is recorded as a
   fingerprint over the scope, the presence of an executable entrypoint and a
   content hash of **every file** in the folder (`.git` excluded) — not the name,
   and not the manifest alone.
3. **Enable** is a per-plugin switch under a master switch. Enabling mints the
   token and starts the process; disabling stops it and revokes the token.
   Turning the master switch off stops every plugin.

An update — from the same source — is installed into place and then compared
against the recorded fingerprint. If the manifest changed, or the manifest is
untouched but the files behind the entrypoint are not, the old approval is
cleared, a running instance is stopped, and the reviewer is asked again. Every
update re-asks, a typo fix included: a consent prompt that is only *sometimes*
honest teaches people to click through it faster than one that always is.

`~/.config/agentglass/plugins.json` records, per plugin, its source (git URL and
ref, local path, or catalogue plus entry id), the commit it resolved to, the
content hash, the fingerprint that was approved, whether it is enabled, and when
it was installed. That is every fact a lockfile would pin down, so there is no
separate lockfile.

## Catalogues

A catalogue is a plain JSON file at an `https://` URL, fetched fresh every time
somebody browses it. It is a list, not a registry: nothing from it is cached as
trustworthy between reads, and an unreachable or malformed catalogue is shown as
exactly that, never as an empty list.

```json
{
  "name": "community-plugins",
  "owner": "someone",
  "plugins": [
    {
      "id": "someone.hello-stream",
      "source": { "kind": "git", "url": "https://example.com/someone/hello-stream.git", "ref": null },
      "description": "Writes a line to its own log whenever an agent finishes a turn.",
      "categories": ["monitoring"]
    }
  ]
}
```

| field | rule |
|---|---|
| `name` | same rule as a plugin name |
| `owner` | 1–200 characters; shown, not verified |
| `plugins[].id` | 1–120 characters; the handle an install-from-catalogue names |
| `plugins[].source` | `{ "kind": "git", "url": "https://…", "ref": null \| "<branch, tag or commit>" }`; a missing `ref` installs the default branch |
| `plugins[].description` | 1–500 characters |
| `plugins[].categories` | optional list of short strings |

One malformed entry drops that entry, not the catalogue. Fetching a catalogue
goes through the same guarded fetch the server uses for any address it did not
choose itself: each hop is checked against private, loopback and link-local addresses before it
is connected to, redirects are followed one hop at a time (five at most) with the
same check on every hop, and a redirect off `https://` ends the fetch. The body
is capped at 5 MB and the whole fetch at 15 seconds.

Catalogues are optional. A plugin is installable from its git URL alone.

## Drawing in the app

A plugin declares where it draws, in its manifest, next to its scope:

```json
{
  "name": "orbit-reviewer",
  "publisher": "acme",
  "description": "Reviews pull requests and keeps the findings local.",
  "entrypoint": "python3 -u reviewer.py",
  "scope": "read",
  "contributes": {
    "panels": [{ "id": "main", "title": "Reviews", "icon": "review" }],
    "prNotes": true,
    "settings": [
      { "key": "repos", "type": "list", "label": "Repositories" },
      { "key": "model", "type": "select", "label": "Model", "options": ["opus", "sonnet"] }
    ]
  }
}
```

The declaration is part of what the person approves. The review screen lists it
in plain words ("adds a panel, Reviews, to the Plugins view"), and it is folded
into the manifest hash, so a plugin that starts drawing somewhere new is asked
about again. A manifest with no `contributes` hashes exactly as it did before
drawing existed, so upgrading the app clears no approval.

Three places a plugin can appear:

| Contribution | Where it shows | What the plugin sends |
|---|---|---|
| `panels` | A tab in the **Plugins** view, in the rail's bottom drawer | A tree of nodes (below), redrawn whenever it likes |
| `settings` | A page of its own in **Settings**, under Connections | Nothing: the app draws the fields and stores the values |
| `prNotes` | Inside a pull request: one entry per pass in the conversation's **Local** lane, and each note under its line in the Files tab | Runs and notes, with a severity, a path and a line |

Everything goes through the plugin's own channel, `/plugin/self/…`, over its own
token. That channel is open at any scope, because drawing is not a power over
anything else. The name comes from the token, never from the request, so one
plugin cannot draw into another's panel.

| Route | What it does |
|---|---|
| `GET /plugin/self` | Its name, its declared contributions and its settings |
| `GET /plugin/self/events?wait=25000` | Long poll: clicks, submitted forms, settings changes, a note marked resolved, a pull request opened |
| `POST /plugin/self/panel` `{id, tree}` | Draw a declared panel |
| `POST /plugin/self/options` `{key, options}` | Choices for a `select` it could only find at run time |
| `POST /plugin/self/pr/run` | Start or finish a pass over a pull request |
| `POST /plugin/self/pr/notes` `{notes}` | Add or update notes |

**The vocabulary** ([shared/pluginUi.ts](../shared/pluginUi.ts)) is a closed set
of nodes the app draws with its own parts:

- layout: `stack`, `row`, `section`, `split`, `tabs`;
- content: `heading`, `text`, `markdown`, `code`, `badge`, `stat`, `keyValue`, `list`, `timeline`, `progress`, `empty`, `link`, `divider`;
- controls: `button`, `form`.

There is no HTML, no style, no colour and no image by URL. A tone is a word
(`accent`, `success`, `warning`, `danger`, `muted`) that the app maps onto the
current theme. A link is `https` or nothing. A tree is checked before it is kept,
with limits on depth, node count and string length, and an unknown node is
refused rather than skipped. A click comes back as the action id and payload the
plugin put on the control, and nothing else.

**Notes on a pull request** are never sent anywhere. Each one is marked *local*,
has no Reply, and offers Resolve, Dismiss, Reopen and Copy. The person's choice
outranks the plugin's: a note they resolved stays resolved when the plugin sends
it again, and the plugin hears the change as an event, so its next pass can take
it into account. Removing a plugin removes its notes; disabling it keeps them
readable.

A worked plugin that uses all three is
[local-review](https://github.com/SirAllap/agentglass-local-review): it reviews
your labelled pull requests with the agent you choose, inside a sandbox, and
keeps the findings in the pull request view.

## What a plugin cannot do

**Run code in the window.** A plugin draws in the app ([Drawing in the
app](#drawing-in-the-app)), but only as data: it sends what to show, and the app
draws it with its own components. Not a line of the plugin's code runs in the
desktop window, which is the privileged surface: it holds the API token and can
open a shell, and anything executing inside it, an iframe tile included, would
live inside that trust. A screen the vocabulary cannot express can still be the
plugin's own window, a terminal UI or a web page it serves, talking to agentglass
over the same HTTP. That window is outside the app's trust boundary, which is the
point.

**Answer a gate.** See above. **Read the machine token.** The plugin gets its own
token at its own scope; the machine's is never in its environment. **Run before
it is enabled.** Install is a copy.

## Publishing one

1. Write the plugin as its own git repository with `plugin.json` at the root.
2. Push it to any host `git clone` reaches over `https://`, `ssh://` or the
   `git@host:path` form. The URL must not carry a credential — a plugin address
   is stored in `plugins.json` and reused for updates, so a `user:pass@` URL
   would sit on disk from then on and is refused; plain `http://` is refused
   too, since it would hand whatever the URL carries to anyone on the wire.
3. The URL is the publication. Pasting it into "Install a plugin" is enough. A
   catalogue is for when there is more than one plugin to list.

There is no build step, no registration and no account.

## A worked example

`hello-stream` — a `read`-scope watcher, two files.

```json
{
  "name": "hello-stream",
  "publisher": "someone",
  "description": "Writes a line to its own log whenever an agent finishes a turn.",
  "entrypoint": "bun run watch.ts",
  "scope": "read"
}
```

```ts
// watch.ts — a separate process. Everything it may do comes from two variables
// the server sets when a person enables it; nothing is imported from agentglass.
const URL_BASE = process.env.AGENTGLASS_URL ?? "http://127.0.0.1:4000";
const TOKEN = process.env.AGENTGLASS_READ_TOKEN ?? "";

const ws = new WebSocket(`${URL_BASE.replace(/^http/, "ws")}/stream?token=${encodeURIComponent(TOKEN)}`);
ws.addEventListener("message", (e) => {
  const frame = JSON.parse(String(e.data));
  if (frame.type === "event" && frame.event?.hook_event_type === "Stop") {
    console.log(new Date().toISOString(), "turn finished in", frame.event.session_id);
  }
});
```

Once enabled, its log shows the shape a `read` token has — a `GET` it was
allowed to make, and a write it was not:

```
GET /terminal/panes -> 200
POST /understudy/halt -> 403
watching /stream
```

The 403 is the mechanism working. `read` cannot halt a run, and nothing in the
plugin's own code changes that.

## Where this stops being small

The install / review / enable mechanism is the paired-device credential model
wearing an install button. Drawing is the same model with a screen: the plugin
still holds only its own token, and all it can add is data the app chooses how to
show.

What it does not do yet, and is the next thing after this:

- **A sandboxed frame** for a screen the vocabulary cannot express, such as a
  chart library or a canvas. It would be an iframe with no same-origin, a strict
  CSP and a message bridge that forwards only to the plugin's own actions. Until a
  real plugin needs it, the vocabulary grows instead.
- **A rail entry per plugin.** Every panel lives in one Plugins view, so the
  rail's hotkeys never move.
- **Drawing in other places than a pull request.** Notes attach to a pull
  request because that is where review happens; a card, a commit or a file would
  each be one more declared contribution of the same shape.
