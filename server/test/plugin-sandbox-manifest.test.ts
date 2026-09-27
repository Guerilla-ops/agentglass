/*
 * The manifest's `sandbox` block: what it may declare, and what a declaration
 * does to the approval.
 *
 * The box itself (bwrap, argv, the real filesystem) is server/src/plugin-sandbox.ts
 * and its own test file; this one is the contract that stands upstream of it —
 * a grant that could reach the machine's credentials, a live socket
 * directory, or a place a shell reads at login is refused when the manifest
 * is READ, before any of it is resolved against a real disk. A change to a
 * grant changes the hash the reviewer approved, and a manifest with no block
 * reads and hashes exactly as it did before the block existed.
 */
import { describe, expect, test } from "bun:test";
import { manifestHash, validateManifest, type PluginManifest } from "../src/plugins.ts";
import {
  NEVER_MOUNTABLE, NEVER_MOUNTABLE_ROOTS, describeSandbox, secretGrant, validateSandbox,
} from "../../shared/pluginSandbox.ts";

const OK = {
  name: "orbit-reviewer",
  publisher: "acme",
  description: "Reviews pull requests.",
  entrypoint: "python3 -u reviewer.py",
  scope: "read",
};

const sb = (raw: unknown) => {
  const r = validateSandbox(raw);
  if (!r.ok) throw new Error(r.error);
  return r.value;
};
const read = (sandbox: unknown) => validateManifest({ ...OK, sandbox });
const ok = (sandbox: unknown) => {
  const m = read(sandbox);
  if (typeof m === "string") throw new Error(m);
  return m;
};

describe("a manifest with no sandbox block", () => {
  test("reads without one as the default box, and so no longer keeps the hash it had before boxes were the default", () => {
    const m = validateManifest(OK) as PluginManifest;
    expect(m.sandbox).toEqual({ network: "agentglass", read: [], write: [], programs: [] });
    // The approval taken before this change no longer matches: it is asked for again, with the box's grants shown.
    expect(manifestHash(m)).not.toBe("9231e5eae8e211e8a81afa12672213cfb50e8b3f8b34f6ac78e5967f8059ba0a");
  });
});

describe("what a sandbox block may say", () => {
  test("an empty block is the defaults: agentglass only, nothing extra", () => {
    expect(ok({}).sandbox).toEqual({ network: "agentglass", read: [], write: [], programs: [] });
  });

  test("a full block is kept, sorted and without repeats", () => {
    const m = ok({ network: "internet", read: ["~/.config/mise", "~/.config/gh", "~/.config/gh"], write: ["~/.local/share/orbit"], programs: ["gh", "claude", "gh"] });
    expect(m.sandbox).toEqual({ network: "internet", read: ["~/.config/gh", "~/.config/mise"], write: ["~/.local/share/orbit"], programs: ["claude", "gh"] });
  });

  test("absolute paths are fine", () => {
    expect(ok({ read: ["/opt/orbit/data"] }).sandbox?.read).toEqual(["/opt/orbit/data"]);
  });

  const REFUSED: [string, unknown][] = [
    ["a list", []],
    ["a string", "internet"],
    ["null", null],
    ["a network nobody offers", { network: "everything" }],
    ["a key it does not know (a typo would grant nothing and say so nowhere)", { reads: ["~/x"] }],
    ["read as a string", { read: "~/x" }],
    ["a path that is not text", { read: [7] }],
    ["seventeen read paths", { read: Array.from({ length: 17 }, (_, i) => `~/d${i}`) }],
    ["a relative path", { read: ["notes/x"] }],
    ["a path that walks up", { read: ["~/code/../.ssh"] }],
    ["the home folder itself", { read: ["~"] }],
    ["the whole disk", { read: ["/"] }],
    ["a control character in a path", { read: ["~/a\nb"] }],
    ["a path of 201 characters", { read: ["~/" + "x".repeat(199)] }],
    ["an empty path", { write: [""] }],
    ["a program with a slash", { programs: ["bin/gh"] }],
    ["a program that is a dot-dot", { programs: [".."] }],
    ["an empty program", { programs: [""] }],
    ["seventeen programs", { programs: Array.from({ length: 17 }, (_, i) => `p${i}`) }],
  ];
  for (const [what, block] of REFUSED) {
    test(`refuses ${what}`, () => { expect(typeof read(block)).toBe("string"); });
  }
});

describe("what no manifest may ask for", () => {
  const NEVER_ASKED = [
    "~/.ssh", "~/.ssh/id_orbit", "~/.gnupg", "~/.config/agentglass", "~/.config/agentglass/credentials.json",
    "~/.local/share/keyrings", "/run/user/1000", "/run/user/1000/bus", "/run/user",
    // The parent of a never-mountable folder is a way to it.
    "~/.config", "~/.local", "~/.local/share", "/run",
  ];
  for (const p of NEVER_ASKED) {
    for (const key of ["read", "write"]) {
      test(`${key} ${p} is refused`, () => { expect(typeof read({ [key]: [p] })).toBe("string"); });
    }
  }

  test("a sibling that only shares a prefix is not the folder", () => {
    expect(ok({ read: ["~/.config/agentglass-local-review", "~/.sshfs-mounts"] }).sandbox?.read.length).toBe(2);
  });

  test("the list is the one the plan names", () => {
    expect([...NEVER_MOUNTABLE].sort()).toEqual(["/run/user", "~/.config/agentglass", "~/.gnupg", "~/.local/share/keyrings", "~/.ssh"]);
  });
});

describe("system roots no manifest may name", () => {
  // A read-only bind of one of these still lets a plugin connect() a live
  // socket inside it — `/tmp/tmux-1000`, `/run/docker.sock` — or hand it
  // every process's cmdline via `/proc`. Refused at the spelling here;
  // `refusalReason` in plugin-sandbox.ts re-checks the RESOLVED path, since a
  // symlink can lead here even when the spelling does not.
  const NEVER_ROOTS = ["/tmp", "/tmp/tmux-1000", "/var/tmp", "/proc", "/proc/1/environ", "/sys", "/dev", "/run", "/var/run", "/var/run/docker.sock"];
  for (const p of NEVER_ROOTS) {
    for (const key of ["read", "write"]) {
      test(`${key} ${p} is refused`, () => { expect(typeof read({ [key]: [p] })).toBe("string"); });
    }
  }

  test("the list is the one the box's own file checks against", () => {
    const expected: string[] = ["/dev", "/proc", "/run", "/sys", "/var/run", "/var/tmp", "/tmp"];
    const actual: string[] = [...NEVER_MOUNTABLE_ROOTS];
    expect(actual.sort()).toEqual(expected.sort());
  });
});

describe("write-only: places a shell or a desktop reads without the plugin running", () => {
  const FILES = ["~/.bashrc", "~/.profile", "~/.bash_profile", "~/.zshrc", "~/.zprofile"];
  const DIRS = ["~/.config/fish", "~/.local/bin", "~/bin", "~/.config/systemd", "~/.config/autostart", "~/.local/share/applications", "~/.config/environment.d"];
  for (const p of [...FILES, ...DIRS]) {
    test(`write ${p} is refused`, () => { expect(typeof read({ write: [p] })).toBe("string"); });
    test(`read ${p} is fine — reading is not what write refuses`, () => { expect(ok({ read: [p] }).sandbox?.read).toEqual([p.replace(/\/$/, "")]); });
  }
});

describe("secret-looking grants", () => {
  for (const p of ["~/.config/gh", "~/.aws", "~/.aws/credentials", "~/.netrc", "~/.git-credentials", "~/.config/gcloud", "~/.kube/config", "~/.docker/config.json", "~/.npmrc", "~/.codex/auth.json", "~/keys/deploy.pem", "~/backup/id_ed25519", "~/.password-store", "/etc/orbit/api-token"]) {
    test(`${p} is flagged`, () => { expect(secretGrant(p)).not.toBeNull(); });
  }
  for (const p of ["~/code/orbit", "~/.local/share/context-diet", "~/.config/mise", "/opt/orbit/data", "~/.cache/orbit"]) {
    test(`${p} is not`, () => { expect(secretGrant(p)).toBeNull(); });
  }
});

describe("the hash the reviewer approved", () => {
  const h = (sandbox?: unknown) => manifestHash(ok(sandbox ?? undefined));
  const base = { network: "internet", read: ["~/.config/gh"], write: [], programs: ["gh"] };

  test("an empty block is the same as no block: both are the default box", () => {
    expect(manifestHash(ok({}))).toBe(manifestHash(validateManifest(OK) as PluginManifest));
  });

  test("moves when the network, a read, a write or a program changes", () => {
    const b = h(base);
    expect(h({ ...base, network: "agentglass" })).not.toBe(b);
    expect(h({ ...base, read: ["~/.config/gh", "~/code/orbit"] })).not.toBe(b);
    expect(h({ ...base, write: ["~/.local/share/orbit"] })).not.toBe(b);
    expect(h({ ...base, programs: ["gh", "claude"] })).not.toBe(b);
  });

  test("does not move for the order of a list or a path written twice", () => {
    const a = h({ ...base, read: ["~/a", "~/b"] });
    expect(h({ ...base, read: ["~/b", "~/a", "~/a"] })).toBe(a);
  });
});

describe("what the approval screen is given", () => {
  test("says the network, and marks a secret-looking path in read and in write", () => {
    const d = describeSandbox(sb({ network: "internet", read: ["~/.config/gh", "~/code/orbit"], write: ["~/.aws"], programs: ["gh"] }));
    expect(d.internet).toBe(true);
    expect(d.reads).toEqual([{ path: "~/.config/gh", secret: expect.any(String) }, { path: "~/code/orbit", secret: null }]);
    expect(d.writes).toEqual([{ path: "~/.aws", secret: expect.any(String) }]);
    expect(d.programs).toEqual(["gh"]);
    expect(d.secretCount).toBe(2);
  });

  test("the default network is the app alone", () => {
    expect(describeSandbox(sb({})).internet).toBe(false);
  });
});
