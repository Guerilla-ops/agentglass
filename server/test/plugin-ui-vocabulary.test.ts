/*
 * What a plugin may draw is a closed vocabulary checked before it is kept
 * (shared/pluginUi.ts). These are the edges of it: what fits, what is
 * refused, and that a manifest written before drawing existed keeps the
 * approval it already had.
 */
import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  UI_LIMITS, coerceValue, resolveSettings, safeHref, validateContributes, validateNote, validateTree,
} from "../../shared/pluginUi.ts";
import { manifestHash, validateManifest, type PluginManifest } from "../src/plugins.ts";

describe("the tree a plugin sends", () => {
  test("a real review screen fits: split, list, timeline, tabs, form, markdown", () => {
    const tree = {
      type: "split", leftWidth: "narrow",
      left: [{ type: "list", items: [{ id: "acme/orbit#42", title: "Fix the retry", badges: [{ text: "3 high", tone: "danger" }], action: { id: "select", payload: { pr: 42 } }, selected: true }] }],
      right: [{
        type: "tabs", selected: "findings", tabs: [
          { id: "findings", label: "Findings", badge: "5", children: [{ type: "timeline", items: [{ id: "r1", at: 1, title: "Review", body: "**two** findings", tone: "warning" }] }] },
          { id: "config", label: "Run", children: [{ type: "form", id: "run", fields: [{ key: "model", type: "select", label: "Model", options: ["opus", "sonnet"] }], values: { model: "opus" }, submit: { label: "Review now", action: { id: "run" } } }] },
        ],
      }],
    };
    const r = validateTree(tree);
    expect(r.ok).toBe(true);
  });

  test("a node the vocabulary does not have is refused, not skipped", () => {
    const r = validateTree({ type: "stack", children: [{ type: "html", html: "<img onerror=alert(1)>" }] });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("unknown node type");
  });

  test("a link is https or nothing", () => {
    expect(safeHref("javascript:alert(1)")).toBeNull();
    expect(safeHref("http://orbit.example")).toBeNull();
    expect(safeHref("file:///etc/passwd")).toBeNull();
    expect(safeHref("https://orbit.example/pr/42")).toBe("https://orbit.example/pr/42");
    expect(validateTree({ type: "link", text: "x", href: "javascript:alert(1)" }).ok).toBe(false);
  });

  test("too deep, too many nodes or too large a payload is refused", () => {
    let deep: Record<string, unknown> = { type: "divider" };
    for (let i = 0; i <= UI_LIMITS.depth; i++) deep = { type: "stack", children: [deep] };
    expect(validateTree(deep).ok).toBe(false);
    const wide = { type: "stack", children: Array.from({ length: UI_LIMITS.nodes + 1 }, () => ({ type: "divider" })) };
    expect(validateTree(wide).ok).toBe(false);
    const heavy = { type: "button", label: "x", action: { id: "a", payload: "y".repeat(UI_LIMITS.payloadBytes + 1) } };
    expect(validateTree(heavy).ok).toBe(false);
  });

  test("an unknown tone falls back to the default instead of carrying a colour", () => {
    const r = validateTree({ type: "badge", text: "x", tone: "#ff0000" });
    expect(r.ok && r.value).toEqual({ type: "badge", text: "x", tone: undefined });
  });
});

describe("settings", () => {
  test("values are typed by the field, whatever arrives", () => {
    expect(coerceValue({ key: "n", type: "number", label: "n", min: 1, max: 5 }, "9")).toBe(5);
    expect(coerceValue({ key: "b", type: "boolean", label: "b" }, "true")).toBeUndefined();
    expect(coerceValue({ key: "l", type: "list", label: "l" }, " a \n\nb")).toEqual(["a", "b"]);
  });

  test("every declared key is present when the plugin reads them", () => {
    const fields = [
      { key: "repos", type: "list" as const, label: "r" },
      { key: "model", type: "select" as const, label: "m", default: "opus" },
      { key: "dry", type: "boolean" as const, label: "d" },
    ];
    expect(resolveSettings(fields, { repos: ["acme/orbit"] })).toEqual({ repos: ["acme/orbit"], model: "opus", dry: false });
  });
});

describe("the manifest", () => {
  const base = { name: "orbit-lint", publisher: "acme", description: "d", entrypoint: "true", scope: "read" };

  test("a manifest from before drawing existed keeps its hash, and so its approval", () => {
    const m = validateManifest(base) as PluginManifest;
    const before = createHash("sha256").update(JSON.stringify({
      name: m.name, publisher: m.publisher, description: m.description, entrypoint: m.entrypoint, scope: m.scope,
    })).digest("hex");
    expect(manifestHash(m)).toBe(before);
  });

  test("declaring somewhere new to draw changes the hash, so the person is asked again", () => {
    const plain = validateManifest(base) as PluginManifest;
    const draws = validateManifest({ ...base, contributes: { panels: [{ id: "main", title: "Lint" }] } }) as PluginManifest;
    expect(manifestHash(draws)).not.toBe(manifestHash(plain));
  });

  test("a bad contribution loses the plugin rather than being trimmed", () => {
    expect(validateManifest({ ...base, contributes: { panels: [{ id: "Main!", title: "x" }] } })).toContain("panel id");
    expect(validateContributes({ settings: [{ key: "a", type: "list", label: "a" }, { key: "a", type: "list", label: "b" }] }).ok).toBe(false);
  });
});

describe("a note", () => {
  test("anchors only to a relative path in a repository named owner/name", () => {
    const ok = validateNote({ id: "n1", repo: "acme/orbit", number: 42, severity: "high", title: "t", path: "/etc/passwd", line: 3 });
    expect(ok.ok && ok.value.path).toBeUndefined();
    expect(validateNote({ id: "n1", repo: "orbit", number: 42, severity: "high", title: "t" }).ok).toBe(false);
    expect(validateNote({ id: "n1", repo: "acme/orbit", number: 42, severity: "urgent", title: "t" }).ok).toBe(false);
  });
});
