// The screen for docs/PLUGINS.md's six routes.
//
// The mechanism renders nothing of its own — see the note at the top of
// server/src/plugins.ts. This page is OUR screen, showing OUR data about
// what somebody installed: install copies a folder and runs nothing,
// enabling is the one moment a human grants a scope, and disabling stops
// the process that scope was minted for. Reviewing that from a terminal is
// not review, which is the whole reason this file exists.
import { PluginMark } from "./plugins/PluginMark.tsx";
import { emitControl } from "../lib/controlBus.ts";
import { clearPluginInstall, pluginInstallRequest, subscribePluginInstall } from "../lib/installPlugin.ts";
import { PluginSettingsPane } from "./plugins/PluginSettingsPane.tsx";
import { ICON } from "../lib/iconSize.ts";
import { useDialogs } from "./ConfirmDialog.tsx";
import { useCallback, useEffect, useState, useMemo, useSyncExternalStore } from "react";
import { Fold, SettingRow, Switch } from "./SettingRow.tsx";
import { api } from "../lib/api.ts";
import { fmtAgo } from "../lib/format.ts";
import { usePoll } from "../lib/usePoll.ts";
import type { Catalogue, DeviceScope, InstallSource, PublicPlugin } from "../../../shared/types.ts";

/** The one-line "From …" a reviewer reads — a local path plainly, a git
 *  source with its ref if one was pinned, a marketplace install naming the
 *  catalogue it came from. */
function formatSource(source: InstallSource): string {
  if (source.kind === "local-path") return source.path;
  if (source.kind === "git") return source.ref ? `${source.url}@${source.ref}` : source.url;
  return `${source.plugin.url}${source.plugin.ref ? `@${source.plugin.ref}` : ""} (via ${source.marketplace.url})`;
}

/**
 * What each scope actually permits, in the words a reviewer needs rather
 * than the field's name.
 *
 * `read` is the one that reads as harmless and is not: it is a GET on every
 * route this server has bar the terminal, which includes `/stream` — the
 * live event socket that carries a session's prompts and output as they
 * happen, the same feed server/src/index.ts calls "the whole fleet's
 * prompts, paths and errors as they stream". A plugin holding it is not
 * "read-only" the way a spreadsheet is; it is standing where you can see
 * yourself work. Say that here, once, so nobody approves it thinking it
 * only sees a list of pull requests.
 */
const SCOPE_SENTENCE: Record<DeviceScope, string> = {
  read: "Sees everything this app can read: every session's live output as it streams — the same prompts and replies you watch on screen — plus costs, diffs and pull requests. Cannot approve a gate, send a reply, or write anything.",
  answer: "Everything read gets, plus approving gates and replying to a session that is already running.",
  full: "Everything this machine can do: a terminal, git write access, docker control, merging pull requests.",
};
const SCOPE_WORD: Record<DeviceScope, string> = { read: "Read", answer: "Answer", full: "Full" };

/** The house card shape (see TriageBoard.tsx's `CardView`, SkillsModal.tsx's
 *  `SkillCard`): a bordered tile on `--bg2`, not a row. A plugin is a thing
 *  somebody else made — name, publisher, description, a state, a decision —
 *  and that is what this shape is for everywhere else it appears. */
const CARD_STYLE: React.CSSProperties = {
  border: "1px solid var(--surface-line)",
  background: "var(--surface-card)",
  boxShadow: "var(--surface-lift)",
};

/**
 * A tile the same size and shape as a plugin card, not a text field wedged
 * into a settings row — this page is a board of things, and adding one is
 * an action on that board. Closed, it reads as the "+" every other add
 * affordance in this app is; opened, it is the one field installing a
 * plugin actually needs. Install accepts an absolute local path or a git
 * URL — installPlugin on the server tells them apart by `isAbsolute`, so
 * this asks for one field rather than a toggle nobody needs to set.
 */
function AddPluginCard({ onInstalled, open, setOpen, prefill }: {
  onInstalled: () => void; open: boolean; setOpen: (v: boolean) => void;
  /** Put there by a link from the catalogue's page — see lib/installPlugin.ts.
   *  It fills the box and nothing else: the press is still the person's. */
  prefill?: string;
}) {
  const [source, setSource] = useState("");
  useEffect(() => { if (prefill) setSource(prefill); }, [prefill]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const install = async () => {
    if (!source.trim() || busy) return;
    setBusy(true);
    setError(null);
    const r = await api.pluginInstall(source.trim());
    setBusy(false);
    if (r.ok) { setSource(""); setOpen(false); onInstalled(); }
    else setError(r.error);
  };

  if (!open) return null;

  return (
    <div className="rounded-xl p-3 mb-3" style={CARD_STYLE}>
      <div className="text-[12.5px] font-medium" style={{ color: "var(--text)" }}>Install a plugin</div>
      <div className="text-[11px] t-dim mt-0.5">
        A local folder's absolute path, or a git URL. Copies the folder and reads its manifest — nothing in it runs yet.
      </div>
      <div className="flex items-center gap-2 mt-2">
        <input value={source} onChange={(e) => setSource(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") install(); if (e.key === "Escape") setOpen(false); }}
          placeholder="/path/to/plugin or https://…"
          disabled={busy}
          autoFocus
          className="t-mono text-[11.5px] px-2.5 py-1.5 rounded-lg min-w-0 flex-1"
          style={{ color: "var(--text)", background: "color-mix(in srgb, var(--bg) 70%, transparent)", border: "1px solid color-mix(in srgb, var(--border) 50%, transparent)" }} />
        <button onClick={install} disabled={busy || !source.trim()}
          className="text-[12px] px-2.5 py-1 rounded-lg whitespace-nowrap hover:opacity-80 disabled:opacity-50"
          style={{ color: "var(--text)", border: "1px solid color-mix(in srgb, var(--border) 45%, transparent)" }}>
          {busy ? "Installing…" : "Install"}
        </button>
        <button onClick={() => { setOpen(false); setError(null); }} disabled={busy}
          className="text-[12px] px-2 py-1 rounded-lg whitespace-nowrap hover:opacity-80"
          style={{ color: "var(--text3)" }}>
          Cancel
        </button>
      </div>
      {error && <Alert tone="error">{error}</Alert>}
    </div>
  );
}

/** Is this catalogue entry already on disk — installed from this exact
 *  catalogue entry, or from its git source directly. Matched on the git
 *  source, not the catalogue's own `id`: a plugin pasted in by URL and one
 *  found later in a catalogue are the same install either way, and an
 *  already-installed entry must read as installed, not as a fresh offer. */
function isInstalled(entry: Catalogue["plugins"][number], plugins: PublicPlugin[]): boolean {
  return !!installedFrom(entry.source.url, plugins);
}

/** The installed plugin that came from this git URL, if any. A trailing slash
 *  or a `.git` is the same repository to git and a different string here, so
 *  they are taken off both sides before comparing — a card that offers to
 *  install what is already installed is a card that lies. */
export function installedFrom(url: string, plugins: PublicPlugin[]): PublicPlugin | null {
  const same = (a: string, b: string) => tidy(a) === tidy(b);
  const tidy = (u: string) => u.trim().replace(/\.git$/i, "").replace(/\/+$/, "").toLowerCase();
  return plugins.find((p) => {
    if (p.source.kind === "git") return same(p.source.url, url);
    if (p.source.kind === "marketplace") return same(p.source.plugin.url, url);
    return false;
  }) ?? null;
}

/** One entry inside a browsed catalogue, drawn as the same tile a plugin
 *  card is — this is a thing on the shelf too, just not taken yet. The
 *  border is the dashed one `AddPluginCard` uses for its own closed state:
 *  a plugin already installed is claimed (solid), one still in the
 *  catalogue is offered (dashed) — the two states of one shelf, not a card
 *  next to a row. Installing runs the same review-then-enable path as any
 *  other install — installFromCatalogue on the server still only copies a
 *  folder and reads its manifest. */
/** The manifest's own words for where a plugin draws, in the catalogue's
 *  shorthand. A card says what installing gets you before it is installed. */
const DRAWS_WORD: Record<string, string> = {
  panel: "adds a panel", panels: "adds a panel",
  settings: "settings page",
  "pr-notes": "notes in pull requests", prNotes: "notes in pull requests",
  "pr-button": "a button in pull requests", prActions: "a button in pull requests",
};

function CatalogueEntryRow({
  entry, owner, catalogueUrl, installed, onInstalled,
}: { entry: Catalogue["plugins"][number]; owner: string; catalogueUrl: string; installed: boolean; onInstalled: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const install = async () => {
    setBusy(true);
    setError(null);
    const r = await api.pluginInstallFromCatalogue(catalogueUrl, entry.id);
    setBusy(false);
    if (r.ok) onInstalled();
    else setError(r.error);
  };

  return (
    <div className="rounded-xl p-3 flex flex-col" style={installed ? CARD_STYLE : {
      border: "1px dashed color-mix(in srgb, var(--border) 55%, transparent)",
      background: "transparent",
    }}>
      <div className="flex items-start gap-2.5">
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-2 flex-wrap">
            <span className="text-[13.5px]" style={{ color: "var(--text)" }}>{entry.title || entry.id}</span>
            <span className="text-[11.5px] t-dim">by {entry.publisher || owner}</span>
          </div>
          <div className="flex items-center gap-1 flex-wrap mt-1">
            {(entry.draws ?? []).map((d) => (
              <span key={`d-${d}`} className="chip text-[9.5px]" style={{
                color: "var(--primary)",
                background: "color-mix(in srgb, var(--primary) 12%, transparent)",
                borderColor: "color-mix(in srgb, var(--primary) 30%, transparent)",
              }}>{DRAWS_WORD[d] ?? d}</span>
            ))}
            {entry.categories.map((c) => (
              <span key={c} className="chip text-[9.5px]" style={{
                color: "var(--text3)",
                background: "color-mix(in srgb, var(--border) 16%, transparent)",
                borderColor: "color-mix(in srgb, var(--border) 40%, transparent)",
              }}>{c}</span>
            ))}
          </div>
        </div>
      </div>
      <div className="text-[12px] mt-1.5" style={{ color: "var(--text2)" }}>{entry.description}</div>
      {error && <Alert tone="error">{error}</Alert>}
      <div className="mt-auto pt-2.5 flex items-center justify-end">
        {installed ? (
          <span className="text-[11px] t-dim">On the shelf</span>
        ) : (
          <button onClick={install} disabled={busy}
            className="text-[12px] px-2.5 py-1 rounded-lg whitespace-nowrap hover:opacity-80 disabled:opacity-50 font-medium"
            style={{ color: "var(--bg)", background: "var(--primary)" }}>
            {busy ? "Installing…" : "Install"}
          </button>
        )}
      </div>
    </div>
  );
}

/**
 * The plugins in one catalogue, searched and read a page at a time.
 *
 * A catalogue is a list somebody else keeps, and it grows. Drawing all of it
 * was fine at one entry and is a thousand cards at a thousand — every one of
 * them a card with its own state, laid out on the thread the settings page
 * is scrolling on. So: a box that narrows it, and a page of two dozen.
 *
 * The filter is done here rather than asked of the server, because the whole
 * document is already in hand — it arrived in one fetch, which is what a
 * catalogue IS. The ceiling that matters is upstream: the server keeps the
 * first five hundred entries of a document and says how many it held, so a
 * catalogue past that says so rather than quietly becoming shorter.
 */
const PAGE = 24;

function CatalogueShelf({
  catalogue, url, plugins, onInstalled,
}: { catalogue: Catalogue; url: string; plugins: PublicPlugin[]; onInstalled: () => void }) {
  const [q, setQ] = useState("");
  const [page, setPage] = useState(0);
  const found = useMemo(() => {
    const needle = q.trim().toLowerCase();
    if (!needle) return catalogue.plugins;
    return catalogue.plugins.filter((e) => [e.id, e.title, e.publisher, e.description, ...(e.categories ?? [])]
      .some((f) => (f ?? "").toLowerCase().includes(needle)));
  }, [catalogue.plugins, q]);
  const pages = Math.max(1, Math.ceil(found.length / PAGE));
  const here = Math.min(page, pages - 1);
  const shown = found.slice(here * PAGE, here * PAGE + PAGE);
  const held = catalogue.total > catalogue.plugins.length;

  return (
    <div className="mt-2">
      <div className="flex items-center gap-2 flex-wrap">
        <input value={q} onChange={(e) => { setQ(e.target.value); setPage(0); }}
          placeholder={`Search ${catalogue.plugins.length} plugins`} spellCheck={false}
          className="agx-input text-[12px] px-2 py-1 rounded-lg min-w-[180px] flex-1" />
        <span className="text-[11px] t-dim whitespace-nowrap">
          {found.length === catalogue.plugins.length
            ? `${catalogue.plugins.length} listed`
            : `${found.length} of ${catalogue.plugins.length}`}
          {held ? ` · the document lists ${catalogue.total}` : ""}
        </span>
      </div>
      {found.length === 0 ? (
        <div className="py-3 text-[11.5px] t-dim">Nothing in this catalogue matches “{q}”.</div>
      ) : (
        <div className="grid gap-3 mt-2" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(260px, 1fr))" }}>
          {shown.map((entry) => (
            <CatalogueEntryRow key={entry.id} entry={entry} owner={catalogue.owner} catalogueUrl={url}
              installed={isInstalled(entry, plugins)} onInstalled={onInstalled} />
          ))}
        </div>
      )}
      {pages > 1 && (
        <div className="flex items-center justify-center gap-2 mt-3 text-[11.5px]">
          <button onClick={() => setPage(here - 1)} disabled={here === 0}
            className="px-2 py-0.5 rounded-lg disabled:opacity-40 hover:opacity-80"
            style={{ color: "var(--text2)", border: "1px solid var(--surface-line)" }}>Previous</button>
          <span className="t-dim tabular-nums">{here + 1} of {pages}</span>
          <button onClick={() => setPage(here + 1)} disabled={here >= pages - 1}
            className="px-2 py-0.5 rounded-lg disabled:opacity-40 hover:opacity-80"
            style={{ color: "var(--text2)", border: "1px solid var(--surface-line)" }}>Next</button>
        </div>
      )}
      {held && (
        <div className="mt-2 text-[11px] t-dim">
          This catalogue lists {catalogue.total} plugins and {catalogue.plugins.length} of them were read. A list this
          long is one the catalogue should publish in pages.
        </div>
      )}
    </div>
  );
}

/** One catalogue he has added: collapsed by default, fetched fresh (never
 *  cached) the moment it is opened — a catalogue is a stranger's document,
 *  not a registry, so there is nothing here worth trusting between reads.
 *  Unreachable or malformed reads as exactly that, not as an empty list. */
function CatalogueRow({
  url, plugins, onInstalled, onRemoved,
}: { url: string; plugins: PublicPlugin[]; onInstalled: () => void; onRemoved: () => void }) {
  const [openState, setOpenState] = useState(false);
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<{ ok: true; catalogue: Catalogue } | { ok: false; error: string } | null>(null);

  const toggle = async () => {
    const next = !openState;
    setOpenState(next);
    if (next && !result) {
      setLoading(true);
      const r = await api.pluginCatalogueFetch(url);
      setLoading(false);
      setResult(r);
    }
  };

  const refetch = async () => {
    const r = await api.pluginCatalogueFetch(url);
    setResult(r);
    onInstalled();
  };

  return (
    <div className="py-3">
      <div className="flex items-center gap-2.5">
        <button onClick={toggle} className="min-w-0 flex-1 flex items-baseline gap-2 text-left hover:opacity-80">
          <span className="t-mono text-[12.5px] truncate" style={{ color: "var(--text)" }}>{url}</span>
          {result?.ok && <span className="text-[11px] t-dim shrink-0">{result.catalogue.plugins.length} plugins</span>}
        </button>
        <button onClick={onRemoved}
          className="text-[11px] px-2 py-0.5 rounded-lg whitespace-nowrap hover:opacity-80 shrink-0"
          style={{ color: "var(--error)", border: "1px solid color-mix(in srgb, var(--error) 30%, transparent)" }}>
          Remove
        </button>
      </div>
      {openState && (
        loading ? (
          <div className="py-2 text-[11.5px] t-dim">Fetching…</div>
        ) : result && !result.ok ? (
          <Alert tone="error">Catalogue unreachable: {result.error}</Alert>
        ) : result?.ok ? (
          result.catalogue.plugins.length === 0 ? (
            <div className="py-2 text-[11.5px] t-dim">This catalogue lists no plugins.</div>
          ) : (
            <CatalogueShelf catalogue={result.catalogue} url={url} plugins={plugins} onInstalled={refetch} />
          )
        ) : null
      )}
    </div>
  );
}

/** Add a catalogue by URL and keep the ones already added — a catalogue is
 *  somebody else's list; he collects the ones he trusts, the way he
 *  collects anything else. Adding never installs anything on its own. */
/** The list this project publishes on its own site, the same file its plugins
 *  page is drawn from. Offered, never added on its own: fetching somebody's
 *  list is a request to their host, and that stays a choice. */
const PROJECT_CATALOGUE = "https://sirallap.github.io/agentglass/plugins.json";

function CataloguesSection({ plugins, onInstalled }: { plugins: PublicPlugin[]; onInstalled: () => void }) {
  const [catalogues, setCatalogues] = useState<string[]>([]);
  const [open, setOpen] = useState(false);
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    api.pluginCatalogues().then((r) => setCatalogues(r.catalogues)).catch(() => { /* left as last known */ });
  }, []);

  useEffect(() => { load(); }, [load]);

  const add = async () => {
    if (!url.trim() || busy) return;
    setBusy(true);
    setError(null);
    const r = await api.pluginCatalogueAdd(url.trim());
    setBusy(false);
    if (r.ok) { setUrl(""); setOpen(false); load(); }
    else setError(r.error ?? "Could not add that catalogue");
  };

  const remove = async (u: string) => {
    await api.pluginCatalogueRemove(u);
    load();
  };

  const addProject = async () => {
    setBusy(true);
    setError(null);
    const r = await api.pluginCatalogueAdd(PROJECT_CATALOGUE);
    setBusy(false);
    if (r.ok) load();
    else setError(r.error ?? "Could not add that catalogue");
  };

  /* Rows, like every other settings card: a line between them and the
     column's own margin, never a bordered box inside the card. Two boxes had
     been nested here — a dashed "add" button and the offer below — each with
     its border drawn on the card's edge. */
  const btn = "text-[12px] px-2.5 py-1 rounded-lg whitespace-nowrap hover:opacity-80 disabled:opacity-50";
  return (
    <div className="agx-settings-section">
      <div className="panel-eyebrow pb-1">Catalogues</div>
      <div className="agx-settings-rows">
        {!catalogues.includes(PROJECT_CATALOGUE) && (
          <div className="py-3 flex items-center gap-4">
            <div className="min-w-0 flex-1">
              <div className="text-[12.5px]" style={{ color: "var(--text)" }}>The agentglass catalogue</div>
              <div className="text-[11px] t-dim mt-0.5">
                The plugins listed on this project's site. Adding it fetches that list from GitHub Pages when you browse it; nothing installs until you pick one.
              </div>
            </div>
            <button onClick={addProject} disabled={busy} className={btn}
              style={{ color: "var(--primary)", border: "1px solid color-mix(in srgb, var(--primary) 45%, transparent)" }}>
              Add
            </button>
          </div>
        )}
        {catalogues.map((u) => (
          <CatalogueRow key={u} url={u} plugins={plugins} onInstalled={onInstalled} onRemoved={() => remove(u)} />
        ))}
        <div className="py-3">
          {open ? (
            <>
              <div className="text-[12.5px]" style={{ color: "var(--text)" }}>Add a catalogue</div>
              <div className="text-[11px] t-dim mt-0.5">
                A URL to a JSON catalogue somebody else publishes — a list of plugins by their git source. Nothing installs until you pick one from it.
              </div>
              <div className="flex items-center gap-2 mt-2.5">
                <input value={url} onChange={(e) => setUrl(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter") add(); if (e.key === "Escape") setOpen(false); }}
                  placeholder="https://…/catalogue.json" disabled={busy} autoFocus
                  className="agx-input t-mono min-w-0 flex-1" />
                <button onClick={add} disabled={busy || !url.trim()} className={btn}
                  style={{ color: "var(--text)", border: "1px solid color-mix(in srgb, var(--border) 45%, transparent)" }}>
                  {busy ? "Adding…" : "Add"}
                </button>
                <button onClick={() => { setOpen(false); setError(null); }} disabled={busy} className={btn} style={{ color: "var(--text3)" }}>
                  Cancel
                </button>
              </div>
            </>
          ) : (
            <div className="flex items-center gap-4">
              <div className="min-w-0 flex-1">
                <div className="text-[12.5px]" style={{ color: "var(--text)" }}>Another catalogue</div>
                <div className="text-[11px] t-dim mt-0.5">Somebody else's list, by its URL.</div>
              </div>
              <button onClick={() => setOpen(true)} className={btn}
                style={{ color: "var(--text2)", border: "1px solid color-mix(in srgb, var(--border) 45%, transparent)" }}>
                Add by URL…
              </button>
            </div>
          )}
          {error && <Alert tone="error">{error}</Alert>}
        </div>
      </div>
    </div>
  );
}

export function PluginsPane({ open, focus }: {
  open: boolean;
  /** One plugin's settings, opened inside this page rather than as a page of
   *  its own in the nav. A hundred plugins are a hundred entries there, and a
   *  removed one lingered until Settings was closed — this page already knows
   *  what is installed and redraws when that changes. */
  focus?: string;
}) {
  const [master, setMasterState] = useState<boolean | null>(null);
  const [plugins, setPlugins] = useState<PublicPlugin[]>([]);
  const [busyMaster, setBusyMaster] = useState(false);

  const load = useCallback(() => {
    api.plugins().then((r) => { setMasterState(r.master); setPlugins(r.plugins); }).catch(() => { /* left as last known */ });
  }, []);

  useEffect(() => { if (open) load(); }, [open, load]);
  // A plugin's own state (pid, running) changes on its own — a crash, a
  // restart — so this pane watches rather than only reacting to clicks.
  usePoll(open, load, 3000);

  const toggleMaster = async () => {
    if (master === null || busyMaster) return;
    setBusyMaster(true);
    const r = await api.pluginMaster(!master);
    setBusyMaster(false);
    if (r.ok) setMasterState(r.master ?? !master);
    load();
  };

  /* The board narrows by name, publisher and description at once, because
     "the one that watches the cockpit" is as likely a thing to remember as
     its name — and with a catalogue attached this list is not always short. */
  const [q, setQ] = useState("");
  const [installing, setInstalling] = useState(false);
  /** Which plugin's own settings are open on top of this page. Kept here, so
   *  removing that plugin takes its page with it. */
  const [showing, setShowing] = useState<string | null>(focus ?? null);
  useEffect(() => { setShowing(focus ?? null); }, [focus]);
  /* "Install this plugin", from the web page. The box opens with the URL in
     it and waits: a link may ask, the person answers. */
  const askedFor = useSyncExternalStore(subscribePluginInstall, pluginInstallRequest, () => null);
  const [prefill, setPrefill] = useState("");
  /** What a link from the web asked for, once the list has loaded: either
   *  "here it is, you already have it" or the install box with the URL in it.
   *  The page cannot know which — it cannot reach this app — so the answer is
   *  given here, where it is known. */
  const [already, setAlready] = useState<string | null>(null);
  useEffect(() => {
    if (!askedFor) return;
    const have = installedFrom(askedFor.url, plugins);
    clearPluginInstall();
    if (have) {
      setAlready(have.name);
      setInstalling(false);
      setQ(have.name);
      return;
    }
    setAlready(null);
    setPrefill(askedFor.url);
    setInstalling(true);
  }, [askedFor, plugins]);
  const ql = q.trim().toLowerCase();
  const shown = ql
    ? plugins.filter((p) => `${p.name} ${p.publisher} ${p.description}`.toLowerCase().includes(ql))
    : plugins;

  /* A plugin removed while its own page is open takes the page with it, which
     is the bug that started this: a page for something that is gone used to
     sit in the nav until Settings was closed and opened again. */
  const here = showing ? plugins.find((p) => p.name === showing) : undefined;
  useEffect(() => {
    if (showing && plugins.length && !plugins.some((p) => p.name === showing)) setShowing(null);
  }, [plugins, showing]);

  if (showing && here) {
    return (
      <div className="pb-5">
        <button onClick={() => setShowing(null)}
          className="mb-3 inline-flex items-center gap-1.5 text-[12px] hover:opacity-80"
          style={{ color: "var(--text3)", background: "transparent", border: 0 }}>
          ← All plugins
        </button>
        <div className="flex items-center gap-2.5 mb-3">
          <PluginMark name={here.name} icon={here.icon} color={here.color} size={ICON.lg} stamp={here.contentHash} />
          <div className="min-w-0">
            <div className="text-[14px]" style={{ color: "var(--text)" }}>{here.name}</div>
            <div className="text-[11.5px] t-dim truncate">by {here.publisher}</div>
          </div>
        </div>
        <PluginSettingsPane key={here.name} name={here.name} open={open} />
      </div>
    );
  }

  return (
    <div className="pb-5">
      {/* The one thing on this page that IS a setting keeps the settings
          idiom — a titled card with a row and a switch — so that everything
          below, which is not a setting, is free to stop looking like one. */}
      <div className="agx-settings-section">
          <div className="agx-settings-head">
            <div className="agx-settings-head-t">Plugin system</div>
            <div className="agx-settings-head-d">Nothing runs until you have read what it declares and switched it on.</div>
          </div>
          <div className="agx-settings-rows">
            <SettingRow
              onClick={busyMaster ? undefined : toggleMaster}
              role="switch"
              ariaChecked={!!master}
              label={master ? "Plugins are switched on" : "Plugins are switched off"}
              hint={master
                ? "Enabled plugins may run. Turning this off stops every one of them immediately."
                : "Nothing installed runs, no matter what it is enabled to do. Install and review still work."}
              control={<Switch on={!!master} busy={busyMaster || master === null} />}
            />
          </div>
      </div>

      {/* THE BOARD, and it used to be a shelf: a tinted, bordered zone with
          every card stacked one-per-row inside it. That zone was doing the
          job the cards should do — one box holding boxes reads as a single
          object with a wall of text in it, which is what "so blended with
          settings that it confuses" was describing. The cards are the shape
          now; there is nothing behind them but the page. */}
      <div className="flex items-center gap-2.5 pb-3 flex-wrap">
        <span className="text-[13.5px] font-semibold" style={{ color: "var(--text)" }}>Installed</span>
        <span className="chip tabular-nums t-dim">{plugins.length}</span>
        <div className="ml-auto flex items-center gap-2">
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search plugins"
            className="w-[190px] px-2.5 py-1.5 rounded-lg text-[12.5px] outline-none"
            style={{ background: "var(--bg)", border: "1px solid var(--surface-line)", color: "var(--text)" }} />
          <button onClick={load}
            className="text-[12px] px-2.5 py-1.5 rounded-lg whitespace-nowrap hover:opacity-80"
            style={{ color: "var(--text2)", border: "1px solid var(--surface-line)" }}>
            Refresh
          </button>
          {/* In the header, with the other things you do to this list. It was
              a dashed half-width tile at the end of the grid, which on an
              empty list was the only thing there and read as a stray box. */}
          <button onClick={() => setInstalling(true)} disabled={installing}
            className="text-[12px] px-2.5 py-1.5 rounded-lg whitespace-nowrap hover:opacity-80 disabled:opacity-50"
            style={{ color: "var(--primary)", border: "1px solid color-mix(in srgb, var(--primary) 45%, transparent)" }}>
            Install a plugin
          </button>
        </div>
      </div>

      {/* auto-fill, not a fixed column count: one plugin on a narrow window
          should be one full-width card rather than a half-width card with a
          hole beside it, and the same grid has to survive the sidebar being
          open on a laptop. 360 is the floor a card of this density needs —
          below it the description wraps to five lines and the footer buttons
          stack, which is the letterbox again. */}
      {already && (
        <Alert tone="ok">
          <span>
            <b>{already}</b> is already installed — the link you followed asked for this one. It is in the list below;
            <span className="t-dim"> Update re-clones it at the source it came from.</span>
          </span>
        </Alert>
      )}
      <AddPluginCard onInstalled={load} open={installing} setOpen={setInstalling} prefill={prefill} />
      {plugins.length === 0 ? (
        <div className="rounded-xl px-4 py-5 text-[12px] t-dim" style={{ border: "1px dashed var(--surface-line)" }}>
          Nothing installed yet. Install one from a folder or a git URL, or pick one from a catalogue below.
        </div>
      ) : (
        <div className="grid gap-3" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(360px, 1fr))" }}>
          {shown.map((p) => (
            <PluginCard key={p.name} plugin={p} masterOn={!!master} onChanged={load} onSettings={() => setShowing(p.name)} />
          ))}
        </div>
      )}
      {plugins.length > 0 && shown.length === 0 && (
        <div className="pt-3 text-[12px] t-dim">Nothing installed matches “{q.trim()}”.</div>
      )}

      {/* The same 24px every settings card keeps from the next one. The grid
          sat directly on the Catalogues card, with nothing between them. */}
      <div className="h-6" aria-hidden />
      <CataloguesSection plugins={plugins} onInstalled={load} />
    </div>
  );
}

function PluginCard({ plugin, masterOn, onChanged, onSettings }: {
  plugin: PublicPlugin; masterOn: boolean; onChanged: () => void;
  /** Opens this plugin's own settings inside the Plugins page. */
  onSettings: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [updating, setUpdating] = useState(false);
  const [updateError, setUpdateError] = useState<string | null>(null);
  const [confirmRemove, setConfirmRemove] = useState(false);

  // The one fact the whole trust model rests on: is what is on disk right
  // now the thing a human last looked at, or has it started asking for
  // something else since. `hadApproval` is what tells "never reviewed" (a
  // fresh install) apart from "reviewed once, then changed" — see
  // server/src/plugins.ts, PluginRecord.hadApproval.
  // fingerprint, not manifestHash — enablePlugin gates on the fingerprint,
  // which also catches an update that rewrites the entrypoint's code
  // without touching the manifest at all. See consentFingerprint.
  const needsReview = plugin.approvedFingerprint !== plugin.fingerprint;
  const reconsent = needsReview && plugin.hadApproval;
  // A switch reading "on" while nothing runs is the exact failure this page
  // exists to catch, so the toggle reflects the PROCESS, not the intent —
  // `enabled` can be true with `running` false for one tick after a crash.
  const running = plugin.running;
  // Only a git-backed source has an upstream to re-fetch — see
  // server/src/plugins.ts, updatePlugin.
  const updatable = plugin.source.kind !== "local-path";

  const { ask, dialog } = useDialogs();
  const setEnabled = async (next: boolean) => {
    // Switching it on IS the approval (enablePlugin records it), so the
    // switch cannot be locked until something is approved — it was, and a
    // plugin nobody had approved could never be turned on. It asks once,
    // with what is being approved in front of it.
    if (next && needsReview) {
      const ok = await ask({
        title: `Switch on ${plugin.name}?`,
        body: [SCOPE_SENTENCE[plugin.scope], `Runs: ${plugin.entrypoint}`, ...drawsWhere(plugin)].join("\n\n"),
        confirmLabel: "Approve and switch on",
      });
      if (!ok) return;
    }
    setBusy(true);
    if (next) await api.pluginEnable(plugin.name);
    else await api.pluginDisable(plugin.name);
    setBusy(false);
    onChanged();
  };

  const update = async () => {
    setUpdating(true);
    setUpdateError(null);
    const r = await api.pluginUpdate(plugin.name);
    setUpdating(false);
    if (r.ok) onChanged();
    else setUpdateError(r.error);
  };

  const remove = async () => {
    setBusy(true);
    await api.pluginRemove(plugin.name);
    setBusy(false);
    setConfirmRemove(false);
    onChanged();
  };

  const tint = plugin.color ?? "var(--primary)";
  const hasPanel = (plugin.contributes?.panels?.length ?? 0) > 0;
  const hasSettings = (plugin.contributes?.settings?.length ?? 0) > 0;
  return (
    <>
    {/* Outside the card: the card clips what spills over its rounded edge,
        and a dialog drawn inside it was clipped away entirely. */}
    {dialog}
    <div className="rounded-xl p-4 flex flex-col relative overflow-hidden" style={{
      ...CARD_STYLE,
      // The plugin's own colour, as a wash in the corner its mark sits in:
      // enough to tell two cards apart at a glance, never enough to fight the
      // text. No colour declared, the app's accent.
      backgroundImage: `radial-gradient(120% 90% at 0% 0%, color-mix(in srgb, ${tint} 13%, transparent), transparent 55%)`,
    }}>
      {/* Name and publisher stack against the mark rather than running along
          one line with the description under all three. A card is scanned in
          a grid, and what gets scanned is the top-left corner: a shape, then
          a name, then who wrote it. */}
      <div className="flex items-start gap-3">
        <PluginMark name={plugin.name} icon={plugin.icon} color={plugin.color} stamp={plugin.contentHash} />
        <div className="min-w-0 flex-1 pt-0.5">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-[15px] font-semibold tracking-tight" style={{ color: "var(--text)" }}>{plugin.name}</span>
            <StatePill enabled={plugin.enabled} running={running} reconsent={reconsent} needsReview={needsReview} pid={plugin.pid} />
          </div>
          <div className="text-[11.5px] t-dim mt-0.5">by {plugin.publisher}</div>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <button onClick={() => setEnabled(!plugin.enabled)}
            disabled={busy || (!plugin.enabled && !masterOn)}
            title={!plugin.enabled && needsReview ? "Switching it on approves what it declares below" : !plugin.enabled && !masterOn ? "Plugins are switched off" : undefined}
            className="disabled:cursor-not-allowed">
            <Switch on={plugin.enabled} busy={busy} />
          </button>
        </div>
      </div>

      <div className="text-[12.5px] leading-relaxed mt-3" style={{ color: "var(--text2)" }}>{plugin.description}</div>

      {/* Chips, because a card in a grid is read by its badges before its
          prose — the scope is the one fact worth knowing before installing
          anything, and buried mid-sentence it was not being read. */}
      <div className="flex items-center gap-1.5 flex-wrap mt-2">
        <span className="chip text-[10px]" style={{
          color: "var(--text2)",
          background: "color-mix(in srgb, var(--border) 20%, transparent)",
          borderColor: "color-mix(in srgb, var(--border) 45%, transparent)",
        }}>
          {SCOPE_WORD[plugin.scope]}
        </span>
        {/* Where it shows up, before any prose: a panel, a settings page, notes
            in pull requests. The same facts the review below spells out. */}
        {(plugin.contributes?.panels ?? []).map((p) => (
          <DrawChip key={p.id} tint={tint} label={`panel · ${p.title}`} />
        ))}
        {hasSettings && <DrawChip tint={tint} label="settings" />}
        {plugin.contributes?.prNotes && <DrawChip tint={tint} label="notes in PRs" />}
      </div>
      <div className="text-[11px] t-dim mt-1.5 truncate" title={formatSource(plugin.source)}>
        From <span className="t-mono">{formatSource(plugin.source)}</span>
      </div>

      {/* The re-consent case, drawn so it cannot be mistaken for an ordinary
          disabled card: its own colour, its own sentence, above the fold that
          holds the scope explanation everyone else gets. */}
      {reconsent && (
        <Alert tone="warning">
          <strong>This plugin is asking for something different now.</strong> What is installed no
          longer matches what you last approved — the manifest changed since then. It was turned off
          automatically and stays off until you review the current declaration below and enable it again.
        </Alert>
      )}
      {!plugin.hadApproval && needsReview && (
        <div className="text-[11.5px] mt-1.5" style={{ color: "var(--text2)" }}>
          Not reviewed yet. Read what it declares before enabling it.
        </div>
      )}

      <div className="mt-1.5">
        {/* Open by default only while there is a decision to make — the fold
            defaults open for a fresh install or a changed manifest, closed
            once it has been approved. The sentence has to be legible at the
            moment somebody is approving it; once approved, showing it every
            visit is the noise a four-line paragraph on every card would be. */}
        <Fold label="What it can do" hint={SCOPE_WORD[plugin.scope]} defaultOpen={needsReview}>
          <p className="m-0">{SCOPE_SENTENCE[plugin.scope]}</p>
          <p className="m-0 mt-1.5 t-mono text-[11px]" style={{ color: "var(--text3)" }}>
            runs: {plugin.entrypoint}
          </p>
          {/* Where it draws is part of what is being approved: a plugin that
              starts drawing somewhere new has a new manifest hash, and is
              asked about again. Drawn by this app, never run in it. */}
          {drawsWhere(plugin).length > 0 && (
            <ul className="m-0 mt-2 pl-4 text-[11.5px] flex flex-col gap-0.5" style={{ color: "var(--text2)" }}>
              {drawsWhere(plugin).map((w) => <li key={w}>{w}</li>)}
            </ul>
          )}
        </Fold>
      </div>

      {updateError && <Alert tone="error">{updateError}</Alert>}

      <div className="mt-auto pt-1.5 flex items-center justify-between">
        <span className="text-[10.5px] t-dim">installed {fmtAgo(plugin.installedAt)}</span>
        {confirmRemove ? (
          <span className="flex items-center gap-1.5">
            <button onClick={remove} disabled={busy}
              className="text-[12px] px-2.5 py-1 rounded-lg whitespace-nowrap font-medium"
              style={{ color: "var(--error)", background: "color-mix(in srgb, var(--error) 16%, transparent)", border: "1px solid color-mix(in srgb, var(--error) 44%, transparent)", opacity: busy ? 0.5 : 1 }}>
              {busy ? "Removing…" : "Remove"}
            </button>
            <button onClick={() => setConfirmRemove(false)} disabled={busy}
              className="text-[12px] px-2.5 py-1 rounded-lg whitespace-nowrap hover:opacity-80"
              style={{ color: "var(--text2)", border: "1px solid color-mix(in srgb, var(--border) 45%, transparent)" }}>
              Keep it
            </button>
          </span>
        ) : (
          <span className="flex items-center gap-1.5">
            {/* A re-fetch that changes the declaration lands on the same
                re-consent path as a fresh install — see updatePlugin on the
                server — so this never claims to have "updated" anything
                itself, only to have gone and looked. */}
            {/* Straight to where it shows up — the answer to "I switched it on,
                now what". */}
            {hasPanel && plugin.enabled && (
              <button onClick={() => { emitControl({ cmd: "view", to: "plugins" }); emitControl({ cmd: "esc" }); }}
                className="text-[12px] px-2.5 py-1 rounded-lg whitespace-nowrap hover:opacity-80"
                style={{ color: tint, border: `1px solid color-mix(in srgb, ${tint} 45%, transparent)`, background: `color-mix(in srgb, ${tint} 10%, transparent)` }}>
                Open
              </button>
            )}
            {hasSettings && (
              <button onClick={onSettings}
                className="text-[12px] px-2.5 py-1 rounded-lg whitespace-nowrap hover:opacity-80"
                style={{ color: "var(--text)", border: "1px solid color-mix(in srgb, var(--border) 45%, transparent)" }}>
                Settings
              </button>
            )}
            {updatable && (
              <button onClick={update} disabled={busy || updating}
                title="Re-fetch this plugin at its recorded source. A changed declaration will need review again before it can run."
                className="text-[12px] px-2.5 py-1 rounded-lg whitespace-nowrap hover:opacity-80 disabled:opacity-50"
                style={{ color: "var(--text2)", border: "1px solid color-mix(in srgb, var(--border) 45%, transparent)" }}>
                {updating ? "Updating…" : "Update"}
              </button>
            )}
            <button onClick={() => setConfirmRemove(true)} disabled={busy}
              className="text-[12px] px-2.5 py-1 rounded-lg whitespace-nowrap hover:opacity-80"
              style={{ color: "var(--error)", border: "1px solid color-mix(in srgb, var(--error) 32%, transparent)", opacity: busy ? 0.5 : 1 }}>
              Remove
            </button>
          </span>
        )}
      </div>
    </div>
    </>
  );
}

function Alert({ tone, children }: { tone: "warning" | "error" | "ok"; children: React.ReactNode }) {
  const c = tone === "error" ? "var(--error)" : tone === "ok" ? "var(--success)" : "var(--warning)";
  return (
    <div className="mt-1.5 px-3 py-2 rounded-lg text-[12px] leading-relaxed" style={{
      color: "var(--text2)",
      background: `color-mix(in srgb, ${c} 9%, transparent)`,
      border: `1px solid color-mix(in srgb, ${c} 32%, transparent)`,
    }}>
      {children}
    </div>
  );
}

/** What a plugin declared it draws, as the sentences a reviewer reads. */
function drawsWhere(p: PublicPlugin): string[] {
  const c = p.contributes ?? {};
  const out: string[] = [];
  for (const panel of c.panels ?? []) out.push(`Adds a panel, "${panel.title}", to the Plugins view`);
  if (c.settings?.length) out.push(`Adds a settings page with ${c.settings.length} ${c.settings.length === 1 ? "field" : "fields"}`);
  if (c.prNotes) out.push("Writes notes on pull requests, shown only in this app and never sent to GitHub");
  for (const a of c.prActions ?? []) out.push(`Adds a button, "${a.label}", to every pull request`);
  return out;
}

/** Running, off, or waiting on you — a word, not only a dot, because the dot
 *  alone had to be learned and it is the first thing asked of a card. */
function StatePill({ enabled, running, reconsent, needsReview, pid }: { enabled: boolean; running: boolean; reconsent: boolean; needsReview: boolean; pid: number | null }) {
  const [label, tint] = reconsent ? ["asks again", "var(--warning)"]
    : needsReview && !enabled ? ["not approved", "var(--warning)"]
    : enabled && running ? ["running", "var(--success)"]
    // Switched on and nothing running: the failure a plugin screen exists to
    // show, and the one an `enabled` flag alone cannot.
    : enabled ? ["enabled, not running", "var(--warning)"]
    : ["off", "var(--text3)"];
  return (
    <span className="inline-flex items-center gap-1.5 text-[10px] uppercase tracking-wide px-1.5 py-px rounded-full"
      title={running && pid ? `pid ${pid}` : undefined}
      style={{ color: tint, background: `color-mix(in srgb, ${tint} 12%, transparent)` }}>
      <span className="w-1.5 h-1.5 rounded-full" style={{ background: tint, boxShadow: enabled && running ? `0 0 6px ${tint}` : undefined }} />
      {label}
    </span>
  );
}

function DrawChip({ tint, label }: { tint: string; label: string }) {
  return (
    <span className="chip text-[10px]" style={{
      color: `color-mix(in srgb, ${tint} 75%, var(--text))`,
      background: `color-mix(in srgb, ${tint} 10%, transparent)`,
      borderColor: `color-mix(in srgb, ${tint} 35%, transparent)`,
    }}>{label}</span>
  );
}
