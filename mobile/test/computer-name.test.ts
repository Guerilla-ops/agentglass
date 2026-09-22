/*
 * What the phone calls the computer it is paired to.
 *
 * The label a phone carries is the name the desk gave the PHONE, and it was
 * drawn as the computer's name on four screens ("Connected to My phone"). The
 * server says its own name now; these are the fallbacks for when it has not.
 */
import { describe, expect, it } from "bun:test";
import { addressName, computerName } from "../src/state/use-computer.ts";

const src = await Bun.file(new URL("../src/state/use-computer.ts", import.meta.url)).text();
const settings = await Bun.file(new URL("../app/(tabs)/settings.tsx", import.meta.url)).text();
const troubleshoot = await Bun.file(new URL("../app/troubleshoot.tsx", import.meta.url)).text();

describe("the computer's name", () => {
  it("is what the server said", () => {
    expect(computerName("orbit-desk", "http://192.168.1.20:4000")).toBe("orbit-desk");
  });

  it("drops the .local macOS adds on the LAN", () => {
    expect(computerName("orbit-desk.local", "http://192.168.1.20:4000")).toBe("orbit-desk");
  });

  it("is the address until the server says, never the phone's own label", () => {
    expect(computerName(undefined, "http://192.168.1.20:4000")).toBe("192.168.1.20");
    expect(computerName("  ", "https://studio.example.ts.net")).toBe("studio.example.ts.net");
  });

  it("keeps an IPv6 address whole", () => {
    expect(addressName("http://[fd7a:115c::1]:4000")).toBe("[fd7a:115c::1]");
  });

  it("is asked of the route that needs a credential, not the one anybody can read", () => {
    expect(src).toContain('"/pair/whoami"');
    expect(src).not.toContain('"/health"');
  });
});

describe("where it is drawn", () => {
  it("never draws the phone's label as the computer", () => {
    for (const screen of [settings, troubleshoot]) {
      expect(screen).toContain("useComputer(host)");
      expect(screen).not.toMatch(/name="Computer" value=\{host\.label\}/);
    }
  });
});
