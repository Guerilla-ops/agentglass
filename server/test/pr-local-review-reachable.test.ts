/**
 * A local review has to be reachable from the pull request it is about.
 *
 * It was not. A review was started from the plugin's own panel by typing
 * `acme/orbit#42` into a box; what it found appeared in a lane inside the
 * pull request, on another tab, in whichever project happened to hold that
 * repository; and a row in the plugin's list that named a pull request in
 * another project opened nothing at all — the panel searched for the number
 * in the repository it was already showing, which finds either nothing or
 * somebody else's pull request with the same number.
 *
 * Three things are asserted here, and each one is a way in that was missing:
 * the button in the pull request's own header, the strip on its Overview, and
 * a row anywhere in the app that opens the pull request it names, whatever
 * project is open. There is no renderer in this project, so the rule is
 * asserted against the source that draws them.
 */
import { test, expect, describe } from "bun:test";

const SRC = (p: string) => Bun.file(new URL(`../../web/src/${p}`, import.meta.url)).text();
const PANEL = await SRC("components/PrPanel.tsx");
const ACTIONS = await SRC("components/plugins/PluginPrActions.tsx");
const TREE = await SRC("components/plugins/PluginTree.tsx");

/** From one landmark to the next one after it. Never a fixed window: a window
 *  silently stops covering what it was written to cover the moment somebody
 *  adds a line above it. */
function between(src: string, from: string, to: string): string {
  const at = src.indexOf(from);
  expect(at, `${from} moved`).toBeGreaterThan(-1);
  const end = src.indexOf(to, at + from.length);
  expect(end, `${to} no longer follows ${from}`).toBeGreaterThan(at);
  return src.slice(at, end);
}

describe("the button a plugin puts in a pull request's header", () => {
  test("says what that plugin's work on THIS pull request has got to, rather than spinning", () => {
    // The states come from the runs the plugin published, not from what was
    // pressed here: a review started by a label, or from another window, has
    // to light this button too.
    expect(ACTIONS).toContain("local.runs");
    for (const state of ["queued", "running", "failed"]) expect(ACTIONS).toContain(`"${state}"`);
    expect(ACTIONS, "a finished review must offer its findings, not another review").toContain("onShowLocal");
  });

  test("is given the notes and the way to the findings by both headers that draw it", () => {
    const calls = PANEL.match(/<PluginPrActions[^/]*\/>/g) ?? [];
    expect(calls.length, "the masthead and the overview both carry the row").toBe(2);
    for (const c of calls) {
      expect(c).toContain("local={local}");
      expect(c).toContain("onShowLocal={onShowLocal}");
    }
  });
});

describe("the Overview", () => {
  test("says whether anything has reviewed this pull request, above the description", () => {
    const overview = between(PANEL, "function Overview({", "\nfunction ");
    expect(overview, "the local strip is part of the answer to 'can this land'").toContain("<LocalStrip");
    expect(overview.indexOf("<LocalStrip")).toBeLessThan(overview.indexOf("<Description"));
  });
});

describe("a link to a pull request in another project", () => {
  test("looks for the checkout that holds it instead of searching the wrong repository", () => {
    const jump = between(PANEL, "const jump = useSyncExternalStore", "const [busy, setBusy]");
    expect(jump).toContain("api.prLocate");
    // The loan is visible and reversible: a panel quietly showing a
    // repository nobody selected is the kind of wrong that takes a minute to
    // notice.
    expect(PANEL).toContain("Back to ");
    expect(jump, "the request is left pending so the second pass opens it").toContain("setRoot(r.root)");
  });

  test("lands on the findings when the link asked for them", () => {
    expect(PANEL).toContain('jump.focus === "local"');
    const serve = between(PANEL, "const want = wantLocal.current;", "}, [detail]);");
    expect(serve).toContain('setConvWho("local")');
  });

  test("is what a plugin's row does, without the plugin being asked anything", () => {
    const click = between(TREE, "function rowClick(", "\nexport function PluginTree");
    expect(click).toContain("openPr(it.open.repo, it.open.number");
    expect(click, "the app's errand must not wait for the plugin's").toMatch(/openPr\([^)]*\);[\s\S]*ctx\.onAction/);
  });
});

describe("a catalogue with a thousand plugins in it", () => {
  test("is searched and read a page at a time, rather than drawn all at once", async () => {
    const pane = await Bun.file(new URL("../../web/src/components/PluginsPane.tsx", import.meta.url)).text();
    const shelf = between(pane, "function CatalogueShelf(", "\n/** One catalogue");
    expect(shelf, "a page, not the whole document").toContain("PAGE");
    expect(shelf).toContain("slice(here * PAGE");
    expect(shelf, "and a way to narrow it before paging through it").toContain("toLowerCase().includes(needle)");
    // What the server kept back has to be said, or a catalogue past the cap
    // quietly becomes a shorter catalogue.
    expect(shelf).toContain("catalogue.total");
  });
});

describe("a plugin's own settings", () => {
  test("live inside the Plugins page, not as a page each in the nav", async () => {
    /* Two things somebody hit within a minute of each other: removing a plugin
       left its page in the sidebar until Settings was closed and opened again,
       because the nav reads the list once; and a person with a hundred plugins
       would have a hundred entries in a nav that has nineteen of its own. */
    const modal = await Bun.file(new URL("../../web/src/components/SettingsModal.tsx", import.meta.url)).text();
    expect(modal, "no run-time pages added to the nav").not.toContain("setPluginTabs");
    expect(modal).toContain("const allTabs = TABS;");
    // A link that named one still lands on it.
    expect(modal).toContain('<PluginsPane open={open} focus={pane.slice("plugin:".length)} />');

    const pane = await Bun.file(new URL("../../web/src/components/PluginsPane.tsx", import.meta.url)).text();
    expect(pane).toContain("<PluginSettingsPane");
    // And the page goes when the plugin does, without waiting for a reopen.
    expect(pane).toContain("!plugins.some((p) => p.name === showing)) setShowing(null)");
  });
});
