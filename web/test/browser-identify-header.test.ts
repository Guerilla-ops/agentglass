/*
 * S9: the honest identity header, `electron/identify-header.js`.
 *
 * `shouldIdentify` is what decides whether a request is going to a dev
 * origin at all; a substring check on "localhost" would have handed the
 * header to `evil-localhost.com` and `localhost.evil.com`, so those two are
 * the probes that matter here, not window dressing.
 */
import { describe, expect, test } from "bun:test";
import { createRequire } from "node:module";

const load = createRequire(import.meta.url);
const mod: {
  IDENTIFY_HEADER: string;
  shouldIdentify: (url: string) => boolean;
  sanitizeAgentName: (name: unknown) => string | null;
} = load("../../electron/identify-header.js");
const { IDENTIFY_HEADER, shouldIdentify, sanitizeAgentName } = mod;

describe("shouldIdentify", () => {
  test("loopback, in every spelling it has", () => {
    for (const url of [
      "http://localhost:4000/",
      "http://LOCALHOST:4000/",
      "http://sub.localhost:4000/",
      "http://127.0.0.1:4000/",
      "http://127.255.255.255:4000/",
      "http://[::1]:4000/",
      "http://foo.test/",
      "http://test/",
    ]) expect(shouldIdentify(url), url).toBe(true);
  });

  test("a name that only contains the word, not the address", () => {
    // The exact substring bug this function exists to not have: a host that
    // is not localhost, and never was, wearing it as a name.
    for (const url of ["http://evil-localhost.com/", "http://localhost.evil.com/"]) {
      expect(shouldIdentify(url), url).toBe(false);
    }
  });

  test("a public host does not", () => {
    for (const url of ["https://example.com/", "https://api.stripe.com/v1/charges", "http://192.168.1.1/"]) {
      expect(shouldIdentify(url), url).toBe(false);
    }
  });

  test("nothing that is not a URL at all", () => {
    for (const url of ["", "not a url", "javascript:1"]) {
      expect(shouldIdentify(url), url).toBe(false);
    }
  });
});

describe("sanitizeAgentName", () => {
  test("a plain slug passes through", () => {
    expect(sanitizeAgentName("aglab3")).toBe("aglab3");
    expect(sanitizeAgentName("agx-browser-s9")).toBe("agx-browser-s9");
    expect(sanitizeAgentName("owner.aaa_1")).toBe("owner.aaa_1");
  });

  test("nothing that could inject a second header or escape the value", () => {
    for (const bad of ["evil\r\nX-Injected: 1", "has space", "semi;colon", "", "a".repeat(65), null, undefined, 42]) {
      expect(sanitizeAgentName(bad), String(bad)).toBeNull();
    }
  });
});

describe("main.js actually uses it", () => {
  const main = load("node:fs").readFileSync(
    new URL("../../electron/main.js", import.meta.url), "utf8",
  ) as string;

  test("one onBeforeSendHeaders dispatcher per session, not a second listener", () => {
    const hits = main.split(".onBeforeSendHeaders(").length - 1;
    expect(hits).toBe(1);
  });

  test("the switch is read from a map, so an untouched session stays off", () => {
    expect(main).toContain("identifyEnabled.get(");
  });

  test("the header carries a name looked up from the guest that sent the request", () => {
    expect(main).toContain("guestOwner.get(details.webContentsId)");
  });
});
