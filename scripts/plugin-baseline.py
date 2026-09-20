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
    ("writes-outside-itself", r"\b(rm\s+-rf\s+[~/]|>\s*~/\.(bashrc|zshrc|profile|config/(?!agentglass)))",
     "writes or deletes outside its own folder"),
    ("runs-generated-code", r"\b(eval|exec)\s*\(\s*(base64|atob|codecs|bytes\.fromhex)",
     "decodes something and runs it"),
    ("hardcoded-endpoint", r"https?://(?!(localhost|127\.0\.0\.1|\[::1\]|github\.com|api\.github\.com|raw\.githubusercontent\.com|api\.anthropic\.com|docs\.|plugins\.omarchy\.org))[a-z0-9.-]+\.[a-z]{2,}",
     "talks to a host that is not GitHub, the model's API or this machine"),
    ("kills-by-pattern", r"\bpkill\s+-f\b|\bkillall\b",
     "kills processes by name, which can hit the person's own"),
]

# Not findings: things a person should simply be told, because they change
# what installing costs.
CAPABILITIES = [
    ("spends-money", r"\b(anthropic|openai|api[_-]?key|usd|cost_usd)\b", "may spend money on a model"),
    ("runs-an-agent", r"\b(claude|codex|cursor-agent|gemini)\b\s|\bsubprocess\b", "starts an agent or another process"),
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


def scan(root):
    findings, capabilities = [], {}
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
