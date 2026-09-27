// The release pipeline and the self-updater run code nobody reviews at the
// moment it runs: a third-party action resolved from a moving tag, a token left
// on disk for the next step, an update built from whatever a tag points at
// today. These assert the source, because there is no runner here to ask.
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..", "..");
const WF = join(ROOT, ".github", "workflows");
const files = readdirSync(WF).filter((f) => f.endsWith(".yml")).sort();
const wf: Record<string, string> = {};
for (const f of files) wf[f] = await Bun.file(join(WF, f)).text();
const updater = await Bun.file(join(ROOT, "electron", "self-update.sh")).text();
const updaterTs = await Bun.file(join(ROOT, "server", "src", "selfupdate.ts")).text();

const code = (s: string) => s.split("\n").filter((l) => !/^\s*#/.test(l));

describe("workflows", () => {
  test("the directory is not empty, so the loops below assert something", () => {
    expect(files.length).toBeGreaterThan(5);
  });

  test("every third-party action is pinned to a full commit sha and names its release", () => {
    const loose: string[] = [];
    for (const f of files)
      for (const l of code(wf[f])) {
        const m = l.match(/\buses:\s*([^\s#]+)/);
        if (!m || m[1].startsWith("./")) continue;
        if (!/@[0-9a-f]{40}$/.test(m[1]) || !/#\s*v\d/.test(l)) loose.push(`${f}: ${m[1]}`);
      }
    expect(loose).toEqual([]);
  });

  test("no workflow grants a write permission at the top level", () => {
    const wide: string[] = [];
    for (const f of files) {
      const top = code(wf[f]).join("\n").match(/^permissions:\s*\n((?:[ ]{2}\S.*\n?)+)/m);
      if (top && /:\s*write\b/.test(top[1])) wide.push(f);
    }
    expect(wide).toEqual([]);
  });

  test("every workflow states its permissions somewhere above its jobs", () => {
    const silent = files.filter((f) => !/^permissions:/m.test(wf[f]));
    expect(silent).toEqual([]);
  });

  // GitHub refuses a workflow with a repeated key, and the text checks around
  // this one read straight past it: a step with two `with:` blocks, or the same
  // input twice, looks pinned and hardened and never loads.
  test("no mapping repeats a key", () => {
    const dup: string[] = [];
    for (const f of files) {
      const seen = new Map<number, Set<string>>();
      let block = -1; // indent of a `key: |` whose lines are text, not keys
      wf[f].split("\n").forEach((line, n) => {
        const ind = line.length - line.trimStart().length;
        if (block >= 0) { if (!line.trim() || ind > block) return; block = -1; }
        if (!line.trim() || line.trimStart().startsWith("#")) return;
        const m = line.match(/^(\s*)(- )?([A-Za-z_][\w-]*):(\s|$)/);
        if (!m) return;
        const col = m[1].length + (m[2] ? 2 : 0);
        for (const k of [...seen.keys()]) if (k > col || (m[2] && k >= col)) seen.delete(k);
        const keys = seen.get(col) ?? new Set<string>();
        if (keys.has(m[3])) dup.push(`${f}:${n + 1} ${m[3]}`);
        keys.add(m[3]); seen.set(col, keys);
        if (/:\s*[|>][+-]?\s*$/.test(line)) block = m[1].length;
      });
    }
    expect(dup).toEqual([]);
  });

  test("a checkout leaves no token on disk unless the job pushes with it", () => {
    // traffic.yml clones with its own credential and never needs the ambient one.
    const kept: string[] = [];
    for (const f of files) {
      const lines = code(wf[f]);
      lines.forEach((l, i) => {
        if (!/uses:\s*actions\/checkout@/.test(l)) return;
        const step = lines.slice(i, i + 12).join("\n").split(/\n\s*-\s/)[0];
        if (!/persist-credentials:\s*false/.test(step)) kept.push(`${f}:${i + 1}`);
      });
    }
    expect(kept).toEqual([]);
  });
});

describe("self-update", () => {
  test("the log is not at a fixed path in /tmp", () => {
    expect(code(updater).join("\n")).not.toMatch(/\/tmp\//);
    expect(code(updaterTs).join("\n")).not.toMatch(/tmpdir\(\)/);
  });

  test("dependencies install from the lockfile, never re-resolved", () => {
    const installs = code(updater).filter((l) => /\bbun install\b/.test(l));
    expect(installs.length).toBeGreaterThan(0);
    for (const l of installs) expect(l).toContain("--frozen-lockfile");
  });

  test("the tag must be an annotated tag whose commit is the one built", () => {
    const c = code(updater).join("\n");
    expect(c).toMatch(/objecttype/);
    expect(c).toMatch(/verify-tag/);
    expect(c).toMatch(/\^\{commit\}/);
  });

  // R6: an unsigned tag used to be accepted (`if` around verify-tag). Now the
  // signature is mandatory, and it has to verify against a key pinned beside
  // this script — never the local machine's own gpg/ssh trust store, which a
  // stray configured key answers just as well as the real signer.
  test("a signature is mandatory, and verified against a pinned allowed-signers file, not the local trust store", () => {
    const c = code(updater).join("\n");
    expect(c).toMatch(/gpg\.ssh\.allowedSignersFile/);
    expect(c).not.toMatch(/if git .* cat-file tag/); // no longer conditional
  });

  // H1: `gpg.format=ssh` alone does not stop `verify-tag` from picking a
  // verifier by sniffing the signature's OWN format — it still shells out to
  // gpg for a real PGP block regardless of that setting, and a grep for the
  // marker text anywhere in the tag object was fooled by the same string
  // sitting in the free-text message. Every non-SSH verifier program must be
  // disabled outright so no format switch is left for an attacker to take.
  test("every non-SSH verifier program is disabled, so PGP/x509 cannot be the format that verifies", () => {
    const c = code(updater).join("\n");
    expect(c).toMatch(/gpg\.program=false/);
    expect(c).toMatch(/gpg\.openpgp\.program=false/);
    expect(c).toMatch(/gpg\.x509\.program=false/);
  });

  // M3: the signed OBJECT's own name must match the ref it was fetched
  // under, or an old signed release can be replayed under a new tag name.
  test("the signed tag object's own name must match the ref it was fetched under", () => {
    const c = code(updater).join("\n");
    expect(c).toMatch(/GOT_NAME/);
    expect(c).toMatch(/tag \$TAG/);
  });

  test("the pinned allowed-signers file ships beside the script, committed", () => {
    expect(readFileSync(join(ROOT, "electron", "release-allowed-signers"), "utf8")).toMatch(/^release ssh-ed25519 /);
  });
});

// The script itself, against a throwaway origin. It stops at the tag check, well
// before any install, so nothing here touches the developer's app or clone.
describe("self-update.sh on a fixture origin", () => {
  /**
   * `files` go into the tagged commit; `bin` holds executables put first on
   * PATH. `sign` defaults to the real signer for an annotated tag — every
   * test below that expects the tag check to PASS relies on that default,
   * since the check is now mandatory rather than conditional; the two tests
   * that exist to prove the check itself pass `sign: false` or `"wrong-key"`.
   */
  const run = (tagKind: "lightweight" | "annotated",
    { files = {}, bin = {}, env = {}, sign = true }:
      { files?: Record<string, string>; bin?: Record<string, string>; env?: Record<string, string>; sign?: boolean | "wrong-key" | "pgp-with-fake-marker" } = {}) => {
    const dir = mkdtempSync(join(tmpdir(), "agx-upd-"));
    // Declared outside `try` so `finally` — a sibling block, not nested
    // inside it — can still see them for cleanup.
    let gnupgHome = "";
    const origin = join(dir, "origin");
    const home = join(dir, "home");
    const binDir = join(dir, "bin");
    const env0 = { PATH: `${binDir}:${process.env.PATH!}`, HOME: home };
    try {
      const sh = (cwd: string, ...a: string[]) =>
        Bun.spawnSync(["git", "-C", cwd, "-c", "user.name=t", "-c", "user.email=t@example.com", ...a], { env: env0 });
      for (const d of [origin, home, binDir]) mkdirSync(d, { recursive: true });
      for (const [name, body] of Object.entries(bin)) writeFileSync(join(binDir, name), body, { mode: 0o755 });
      for (const [path, body] of Object.entries(files)) {
        mkdirSync(join(origin, path, ".."), { recursive: true });
        writeFileSync(join(origin, path), body);
      }
      sh(origin, "init", "-q");
      sh(origin, "add", "-A");
      sh(origin, "commit", "-q", "--allow-empty", "-m", "one");

      // A throwaway keypair per run — the "real" key (which lets the signer
      // and the trusted list ever match) and, for the "wrong-key" case, a
      // second one that signs while a DIFFERENT key is the one pinned.
      const genKey = (name: string) => {
        const priv = join(dir, name);
        Bun.spawnSync(["ssh-keygen", "-t", "ed25519", "-N", "", "-C", name, "-f", priv], { env: env0 });
        return { priv, pub: readFileSync(`${priv}.pub`, "utf8").trim() };
      };
      const signer = genKey("signer");
      const allowedSigners = join(dir, "allowed-signers");
      writeFileSync(allowedSigners, `release ${sign === "wrong-key" ? genKey("other").pub : signer.pub}\n`);

      // H1's actual shape: a real signature of a DIFFERENT format (PGP), with
      // the SSH marker text sitting harmlessly in the free-text message —
      // this is what defeated a grep-for-the-marker-then-verify sequence.
      if (tagKind === "annotated") {
        if (sign === "pgp-with-fake-marker") {
          gnupgHome = join(dir, "gnupg");
          mkdirSync(gnupgHome, { recursive: true, mode: 0o700 });
          const gpgEnv = { ...env0, GNUPGHOME: gnupgHome };
          Bun.spawnSync(
            ["gpg", "--batch", "--passphrase", "", "--quick-generate-key", "attacker@example.com", "default", "default", "0"],
            { env: gpgEnv }
          );
          const listing = Bun.spawnSync(["gpg", "--list-secret-keys", "--with-colons"], { env: gpgEnv }).stdout.toString();
          const fpr = /^fpr:+([0-9A-F]+):/m.exec(listing)?.[1];
          const msg = "notes\n-----BEGIN SSH SIGNATURE-----\nnot a real signature — marker text living in the message body\n-----END SSH SIGNATURE-----\n";
          Bun.spawnSync(
            ["git", "-C", origin, "-c", "user.name=t", "-c", "user.email=t@example.com",
              "-c", "gpg.program=gpg", "-c", `user.signingkey=${fpr}`,
              "tag", "-s", "-a", "v9.9.9", "-m", msg],
            { env: gpgEnv }
          );
        } else if (sign) {
          Bun.spawnSync(
            ["git", "-C", origin, "-c", "user.name=t", "-c", "user.email=t@example.com",
              "-c", "gpg.format=ssh", "-c", `user.signingkey=${signer.priv}`,
              "tag", "-s", "-a", "v9.9.9", "-m", "notes"],
            { env: env0 }
          );
        } else {
          sh(origin, "tag", "-a", "v9.9.9", "-m", "notes");
        }
      } else {
        sh(origin, "tag", "v9.9.9");
      }
      const r = Bun.spawnSync(["bash", join(ROOT, "electron", "self-update.sh")], {
        cwd: home,
        env: {
          ...env0,
          AGENTGLASS_UPDATE_TAG: "v9.9.9", AGENTGLASS_UPDATE_ORIGIN: origin,
          // With no files, the fixture has no web/ directory, so an accepted tag
          // fails at the install step instead of building anything.
          AGENTGLASS_UPDATE_SRC: join(home, "src"),
          AGENTGLASS_UPDATE_ALLOWED_SIGNERS: allowedSigners,
          ...env,
        },
      });
      const log = join(home, ".cache", "agentglass", "update.log");
      return { status: r.exitCode, text: readFileSync(log, "utf8"), mode: statSync(log).mode & 0o777 };
    } finally {
      if (gnupgHome) Bun.spawnSync(["gpgconf", "--kill", "gpg-agent"], { env: { ...env0, GNUPGHOME: gnupgHome } });
      rmSync(dir, { recursive: true, force: true });
    }
  };

  test("a lightweight tag is refused before anything is built", () => {
    const r = run("lightweight");
    expect(r.status).toBe(1);
    expect(r.text).toContain("not an annotated release tag");
    expect(r.text).not.toContain("installing dependencies");
  });

  test("the build does not inherit the output or temp dir of whoever started the app", () => {
    // A real update wrote electron-builder's output into another session's
    // scratchpad: the app had been reopened from a shell that exported
    // AGENTGLASS_DIST_DIR and TMPDIR, and the update script inherits the app's
    // environment. A stub install-local.sh reports what it was handed.
    const r = run("annotated", {
      files: {
        "web/.keep": "",
        "electron/install-local.sh":
          'echo "handed dist=${AGENTGLASS_DIST_DIR-unset} tmp=${TMPDIR-unset} cc=${CLAUDE_CODE_TMPDIR-unset}"\nexit 1\n',
      },
      bin: { bun: "#!/bin/sh\nexit 0\n" },
      env: {
        AGENTGLASS_DIST_DIR: "/home/someone/.cache/scratch/dist-app",
        TMPDIR: "/home/someone/.cache/scratch", CLAUDE_CODE_TMPDIR: "/home/someone/.cache/scratch",
      },
    });
    expect(r.text).toContain("handed dist=unset tmp=unset cc=unset");
  });

  test("a signed annotated tag passes the check and reaches the install, in a private log", () => {
    const r = run("annotated");
    expect(r.text).toContain("now at ");
    expect(r.text).toContain("installing dependencies");
    expect(r.mode).toBe(0o600);
  });

  test("an unsigned annotated tag is refused before anything is built", () => {
    const r = run("annotated", { sign: false });
    expect(r.status).toBe(1);
    expect(r.text).toContain("no valid SSH signature");
    expect(r.text).not.toContain("installing dependencies");
  });

  test("a tag signed by a key that is not the pinned one is refused before anything is built", () => {
    const r = run("annotated", { sign: "wrong-key" });
    expect(r.status).toBe(1);
    expect(r.text).toContain("no valid SSH signature");
    expect(r.text).not.toContain("installing dependencies");
  });

  // H1, reproduced: a real PGP signature used to verify fine (git picks the
  // verifier from the signature's own format, not from `gpg.format=ssh`),
  // regardless of a matching-looking SSH marker string sitting in the
  // message. Disabling gpg/x509 as verifier programs closes this.
  test("a real PGP signature is refused even with an SSH marker string in the tag message", () => {
    const r = run("annotated", { sign: "pgp-with-fake-marker" });
    expect(r.status).toBe(1);
    expect(r.text).toContain("no valid SSH signature");
    expect(r.text).not.toContain("installing dependencies");
  }, 15000);

  // M3, reproduced: the ref name alone was trusted; the signed object could
  // have been cut for a different tag entirely.
  test("a signed tag object republished under a different ref name is refused", () => {
    const dir = mkdtempSync(join(tmpdir(), "agx-upd-replay-"));
    try {
      const origin = join(dir, "origin");
      const home = join(dir, "home");
      const binDir = join(dir, "bin");
      const env0 = { PATH: `${binDir}:${process.env.PATH!}`, HOME: home };
      const sh = (cwd: string, ...a: string[]) =>
        Bun.spawnSync(["git", "-C", cwd, "-c", "user.name=t", "-c", "user.email=t@example.com", ...a], { env: env0 });
      for (const d of [origin, home, binDir]) mkdirSync(d, { recursive: true });
      sh(origin, "init", "-q");
      sh(origin, "add", "-A");
      sh(origin, "commit", "-q", "--allow-empty", "-m", "one");
      const priv = join(dir, "signer");
      Bun.spawnSync(["ssh-keygen", "-t", "ed25519", "-N", "", "-C", "signer", "-f", priv], { env: env0 });
      const pub = readFileSync(`${priv}.pub`, "utf8").trim();
      const allowedSigners = join(dir, "allowed-signers");
      writeFileSync(allowedSigners, `release ${pub}\n`);
      // The real, legitimately-signed tag — for v9.0.0, an OLDER release.
      Bun.spawnSync(
        ["git", "-C", origin, "-c", "user.name=t", "-c", "user.email=t@example.com",
          "-c", "gpg.format=ssh", "-c", `user.signingkey=${priv}`,
          "tag", "-s", "-a", "v9.0.0", "-m", "the real v9.0.0"],
        { env: env0 }
      );
      // Republished under a newer name, no new signature: same object, new ref.
      const commit = Bun.spawnSync(["git", "-C", origin, "rev-parse", "refs/tags/v9.0.0"], { env: env0 }).stdout.toString().trim();
      sh(origin, "update-ref", "refs/tags/v9.9.9", commit);
      const r = Bun.spawnSync(["bash", join(ROOT, "electron", "self-update.sh")], {
        cwd: home,
        env: {
          ...env0,
          AGENTGLASS_UPDATE_TAG: "v9.9.9", AGENTGLASS_UPDATE_ORIGIN: origin,
          AGENTGLASS_UPDATE_SRC: join(home, "src"),
          AGENTGLASS_UPDATE_ALLOWED_SIGNERS: allowedSigners,
        },
      });
      const log = join(home, ".cache", "agentglass", "update.log");
      const text = readFileSync(log, "utf8");
      expect(r.exitCode).toBe(1);
      expect(text).toContain("names \"v9.0.0\", not v9.9.9");
      expect(text).not.toContain("installing dependencies");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
