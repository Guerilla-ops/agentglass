#!/usr/bin/env python3
"""A deterministic look at a plugin's source, for a catalogue submission.

What this is: a scan for a short list of patterns that have a specific reason
to be in the list, run over the text of a plugin's own files. It reads. It
never runs a line of what it is looking at — the whole point of checking a
stranger's plugin in CI is that nothing of theirs executes there.

What this is NOT, and the listing says so out loud: a security audit, a
certification, or any kind of endorsement. It detects the patterns written
below and nothing else, and anybody who wants past it can walk past it. The
thing that actually protects a person is the approval they give at install —
the declared scope, the declared places it draws — and reading the code.

    python3 scripts/plugin-baseline.py <folder>

Prints one JSON object: {"outcome": "passed"|"findings", "findings": [...],
"capabilities": [...]}. Exit code is 0 either way — a finding is something for
a person to weigh, not a build failure — and 2 when the folder cannot be read.
"""
import json
import os
import re
import sys

# Each pattern is here because of what it would mean in a plugin, not because
# it is suspicious in general. A plugin is a process on somebody's machine
# with a token of its own; these are the lines that reach past its own job.
PATTERNS = [
    ("reads-ssh-keys", r"\.ssh/(id_[a-z0-9]+|authorized_keys|config)\b",
     "reads SSH keys or the SSH config"),
    ("reads-cloud-credentials", r"\.(aws/credentials|config/gcloud|azure)\b",
     "reads cloud provider credentials"),
    ("reads-browser-profile", r"(Cookies|Login Data|key4\.db|logins\.json)\b",
     "reads a browser's cookie or password store"),
    ("reads-agent-credentials", r"\.(claude|codex|cursor)/[^\s\"']*(credential|token|auth)",
     "reads another agent's stored credentials"),
    ("pipes-the-internet-into-a-shell", r"(curl|wget)[^\n|]{0,120}\|\s*(ba|z|k|)sh\b",
     "downloads something and runs it as a shell script"),
    ("escalates", r"\b(sudo|pkexec|doas)\b",
     "asks for root"),
    ("writes-outside-itself", r"\b(rm\s+-rf\s+[~/]|>\s*~/\.(bashrc|zshrc|profile|config/))",
     "writes or deletes outside its own folder"),
    # agentglass's own config directory used to be exempt here. It is the one
    # that should have been flagged hardest: it holds the machine token, the
    # blocklist that refuses a plugin by name, and every other plugin's copy
    # on disk. A plugin has nothing to write there — the app hands it its own
    # settings through `/plugin/self/settings`.
    ("edits-your-configuration",
     # The directory alone, not directory-and-file: a path in Python is built
     # a component at a time (`Path.home() / ".claude" / "settings.json"`),
     # so a pattern that wants `.claude/settings` contiguous matches the shell
     # form and misses the one that actually ships. A plugin has no business
     # naming these at all, so naming one is the finding.
     r"['\"/]\.(claude|codex|cursor|gemini)\b"
     r"|['\"/]\.config/(agentglass|fish|systemd|autostart|environment\.d)"
     r"|\.(bashrc|zshrc|profile|bash_profile|gitconfig)\b"
     r"|\bcrontab\s+-|\bgit\s+config\s+--global|\bsystemctl\s+--user\s+(enable|link)",
     "reaches into configuration that is the person's, not its own — an agent's settings, "
     "the shell, the login session or what starts at boot"),
    ("runs-generated-code", r"\b(eval|exec)\s*\(\s*(base64|atob|codecs|bytes\.fromhex)",
     "decodes something and runs it"),
    # The allowlist ENDS the host, except for `docs.` which is a prefix on
    # purpose. Without that boundary the lookahead only had to match the start
    # of the host, so `github.com.example.net` — a host the attacker owns,
    # reading as GitHub to anybody skimming — passed the check that exists to
    # catch exactly that.
    ("hardcoded-endpoint", r"https?://(?!(?:(?:localhost|127\.0\.0\.1|\[::1\]|github\.com|api\.github\.com|raw\.githubusercontent\.com|api\.anthropic\.com|anthropic\.com|plugins\.omarchy\.org)(?![a-z0-9.-])|docs\.))[a-z0-9.-]+\.[a-z]{2,}",
     "talks to a host that is not GitHub, the model's API or this machine"),
    # Three classes an agentglass plugin can carry as easily as any other
    # package, and that ten regexes about shell commands cannot see. Taken
    # from a larger marketplace's scanner after reading it side by side with
    # this one — not its 1,470 lines, the three rules of its that apply here.
    ("fetches-code-that-can-move",
     # A ref that is not a commit is a ref somebody else can rewrite between
     # the review and the install: the thing audited is not the thing run.
     r"\bgit\s+clone\b(?![^\n]*--branch\s+[0-9a-f]{40})[^\n]*\|\s*(?:bash|sh)\b"
     # Tempered: the whole token has to lack an `@<40 hex>`, and a plain
     # negative lookahead after a greedy run only has to fail in one place.
     r"|\b(?:pip|pipx|uv pip)\s+install\s+(?:-e\s+)?git\+(?:(?!@[0-9a-f]{40}\b)\S)+(?=\s|$)"
     r"|\bcargo\s+install\s+--git\b(?![^\n]*--rev\s+[0-9a-f]{7,})"
     r"|\bnpm\s+(?:i|install)\s+\S*github:(?:(?!#[0-9a-f]{40}\b)\S)+(?=\s|$)",
     "fetches code at install or run time from a reference that can move"),
    ("installs-a-service",
     # A plugin that writes a unit or a login item starts without anybody
     # switching it on, which is the opposite of what enabling a plugin means
     # here.
     r"\bsystemctl\s+--user\b|\bsystemd-run\b|\.config/systemd/user\b"
     r"|\bcrontab\s+-|\bLaunchAgents\b|\blaunchctl\s+(?:load|bootstrap)\b",
     "installs something that starts on its own, outside this app"),
    ("kills-by-pattern", r"\bpkill\s+-f\b|\bkillall\b",
     "kills processes by name, which can hit the person's own"),
]

# Not findings: things a person should simply be told, because they change
# what installing costs.
CAPABILITIES = [
    ("spends-money", r"\b(anthropic|openai|api[_-]?key|usd|cost_usd)\b", "may spend money on a model"),
    # An agent NAMED is not an agent STARTED. The bare word followed by a
    # space matched every line of prose that says "Claude" — and a plugin for
    # this app says it in its README, in its manifest and in every file it
    # ships for an agent to read. Reported on a plugin that makes HTTP calls
    # and starts nothing: a costs list that overstates is one a reader learns
    # to skip, which is worse than not having one. So: the ways a process is
    # actually started, and an agent's name only where it reads as a command —
    # at the start of one, carrying a flag or a subcommand.
    ("runs-an-agent",
     r"\b(subprocess|Popen|os\.system|child_process|execFile|spawnSync?|execSync)\b"
     r"|(?:^|[;&|(`\"'\s])(claude|codex|cursor-agent|gemini)\s+(?:-{1,2}[A-Za-z]|mcp\b|chat\b|run\b|exec\b)",
     "starts an agent or another process"),
    ("keeps-state", r"\.local/share/|state\.json|\.cache/", "keeps files of its own between runs"),
    ("uses-a-sandbox", r"\bbwrap\b|\bfirejail\b|--unshare", "runs what it starts inside a sandbox"),
]

# Text files only, and only the plugin's own: a vendored dependency tree is
# somebody else's code and scanning it says nothing about this plugin.
READ = (".py", ".js", ".ts", ".mjs", ".sh", ".bash", ".rb", ".pl", ".json", ".toml", ".yaml", ".yml", ".md")
SKIP_DIRS = {".git", "node_modules", "vendor", "dist", "build", "__pycache__", ".venv", "venv"}
MAX_BYTES = 2 * 1024 * 1024


def files(root):
    """The repository's own text files, and nothing a link points at.

    `os.walk` skips symlinked directories and does NOT skip symlinked files.
    A submitted repository holding `notes.json -> /proc/self/environ` would
    therefore have that file read here and, on a match, the first line of it
    quoted into a public comment. The submission is a stranger's repository
    by definition: what is read is what the repository contains, resolved,
    inside its own folder.
    """
    real_root = os.path.realpath(root)
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = [d for d in dirnames if d not in SKIP_DIRS and not os.path.islink(os.path.join(dirpath, d))]
        for name in filenames:
            if not name.endswith(READ):
                continue
            p = os.path.join(dirpath, name)
            if os.path.islink(p):
                continue
            real = os.path.realpath(p)
            if not (real == real_root or real.startswith(real_root + os.sep)):
                continue
            try:
                if os.path.getsize(p) <= MAX_BYTES:
                    yield p
            except OSError:
                continue


def quotable(line):
    """A line of somebody's file, on its way into a public comment.

    It is quoted so a person can judge the match, and it is a stranger's text:
    a backtick closes the fence it sits in, and `<!--` opens a comment that a
    reader never sees — including the marker comment the workflow writes at
    the end of its own report. Both are defused here rather than downstream,
    because this is where the untrusted text is still one value.
    """
    return (line.strip()[:160]
            .replace("`", "'")
            .replace("<!--", "< !--")
            .replace("-->", "-- >"))


# The first bytes of a compiled thing. A repository somebody is asked to read
# before installing can carry one of these, and no amount of reading its source
# says anything about what is in it.
MAGIC = [
    (b"\x7fELF", "a Linux executable"),
    (b"MZ", "a Windows executable"),
    (b"\xca\xfe\xba\xbe", "a macOS executable"),
    (b"\xcf\xfa\xed\xfe", "a macOS executable"),
    (b"\xce\xfa\xed\xfe", "a macOS executable"),
    (b"\x50\x4b\x03\x04", "an archive"),
]


def binaries(root):
    """Compiled files committed into the repository.

    Walked separately from `files()`, which reads text and only text: a binary
    has no line to quote and no pattern to match, and it is the one thing in a
    submission that cannot be reviewed by reading it at all.
    """
    real_root = os.path.realpath(root)
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = [d for d in dirnames if d not in SKIP_DIRS and not os.path.islink(os.path.join(dirpath, d))]
        for name in filenames:
            path = os.path.join(dirpath, name)
            real = os.path.realpath(path)
            if not real.startswith(real_root + os.sep) or os.path.islink(path):
                continue
            try:
                if os.path.getsize(path) < 4:
                    continue
                with open(path, "rb") as f:
                    head = f.read(4)
            except OSError:
                continue
            for magic, what in MAGIC:
                if head.startswith(magic):
                    yield os.path.relpath(path, root), what
                    break


def scan(root):
    findings, capabilities = [], {}
    for rel, what in binaries(root):
        findings.append({"id": "bundled-binary", "says": f"ships {what} nobody can read",
                         "where": rel, "line": quotable(f"{os.path.basename(rel)} is not source")})
    for path in files(root):
        try:
            text = open(path, encoding="utf-8", errors="replace").read()
        except OSError:
            continue
        rel = os.path.relpath(path, root)
        for key, pattern, says in PATTERNS:
            for m in re.finditer(pattern, text, re.I):
                line = text[:m.start()].count("\n") + 1
                findings.append({"id": key, "says": says, "where": f"{rel}:{line}",
                                 "line": quotable(text.splitlines()[line - 1])})
                break  # one per file per pattern; a list of forty is a list nobody reads
        for key, pattern, says in CAPABILITIES:
            if key not in capabilities and re.search(pattern, text, re.I):
                capabilities[key] = says
    findings.sort(key=lambda f: (f["id"], f["where"]))
    return findings, [{"id": k, "says": v} for k, v in sorted(capabilities.items())]


def main():
    if len(sys.argv) != 2:
        print("usage: plugin-baseline.py <folder>", file=sys.stderr)
        return 2
    root = os.path.abspath(os.path.expanduser(sys.argv[1]))
    if not os.path.isdir(root):
        print(json.dumps({"outcome": "unreadable", "error": f"{root} is not a folder"}))
        return 2
    findings, capabilities = scan(root)
    manifest = {}
    try:
        manifest = json.load(open(os.path.join(root, "plugin.json"), encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        pass
    scope = manifest.get("scope")
    if scope == "full":
        findings.append({"id": "asks-for-full-scope", "says": "asks for the scope that can start and answer agents",
                         "where": "plugin.json", "line": '"scope": "full"'})
    print(json.dumps({
        "outcome": "findings" if findings else "passed",
        "scope": scope,
        "findings": findings,
        "capabilities": capabilities,
    }, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
