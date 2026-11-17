#!/usr/bin/env python3
"""Prompt history for a Herdr agent terminal.

  prompts.py list <terminal> [known_size]   -> {"agent", "file", "size", "prompts": [{"text", "ts"}]}
                                               or {"unchanged": true} when the transcript's size is known_size
  prompts.py locate <terminal> <index>      -> {"lines_up": n}: how far to scroll up from the bottom so
                                               prompt <index> sits at the top of the view; or {"error"}

Finds the agent's transcript from its foreground process:
  Claude Code: ~/.claude/sessions/<pid>.json -> sessionId -> ~/.claude/projects/*/<sessionId>.jsonl
  omp:         the pid's tty -> ~/.omp/agent/terminal-sessions/<tty> (2nd line) -> session .jsonl
Only prompts you typed are listed (no tool results, injected or meta messages).
"""
import glob
import json
import os
import re
import subprocess
import sys

HOME = os.path.expanduser("~")


def out(obj):
    print(json.dumps(obj))
    sys.exit(0)


def run(args):
    return subprocess.run(args, capture_output=True, text=True, timeout=10)


def terminal_info(address):
    r = run(["hc", "get", address, "--json"])
    if r.returncode != 0:
        out({"error": f"Can't read terminal {address}"})
    return json.loads(r.stdout)


def transcript(info):
    fg = info.get("foreground") or {}
    pid = fg.get("pid")
    app = ((info.get("status") or {}).get("app") or fg.get("name") or "").lower()
    if not pid:
        return None, app
    # Claude Code
    sess = os.path.join(HOME, ".claude", "sessions", f"{pid}.json")
    if os.path.exists(sess):
        try:
            sid = json.load(open(sess)).get("sessionId")
        except Exception:
            sid = None
        if sid:
            hits = glob.glob(os.path.join(HOME, ".claude", "projects", "*", f"{sid}.jsonl"))
            if hits:
                return ("claude", max(hits, key=os.path.getmtime)), app
    # omp: keyed by the terminal's tty
    tty = run(["ps", "-o", "tty=", "-p", str(pid)]).stdout.strip()
    if tty and tty != "??":
        f = os.path.join(HOME, ".omp", "agent", "terminal-sessions", tty)
        if os.path.exists(f):
            lines = open(f).read().splitlines()
            if len(lines) > 1 and os.path.exists(lines[1]):
                return ("omp", lines[1]), app
    return None, app


def text_of(content):
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        if any(isinstance(p, dict) and p.get("type") == "tool_result" for p in content):
            return None
        return "\n".join(p.get("text", "") for p in content if isinstance(p, dict) and p.get("type") == "text")
    return None


CMD_TAGS = re.compile(r"<(command-[a-z]+|local-command-[a-z]+|system-reminder)>.*?</\1>", re.S)


def prompts(kind, path):
    res = []
    with open(path, encoding="utf-8", errors="replace") as fh:
        for line in fh:
            try:
                d = json.loads(line)
            except Exception:
                continue
            m = d.get("message") or {}
            if kind == "claude":
                if d.get("type") != "user" or d.get("isMeta") or (d.get("origin") or {}).get("kind") != "human":
                    continue
            else:
                if d.get("type") != "message" or m.get("role") != "user" or m.get("attribution", "user") != "user":
                    continue
            t = text_of(m.get("content"))
            if not t:
                continue
            t = CMD_TAGS.sub("", t).strip()
            if t:
                res.append({"text": t, "ts": d.get("timestamp")})
    return res


def norm(s):
    return re.sub(r"\s+", " ", s).strip()


def locate(address, index):
    info = terminal_info(address)
    found, _ = transcript(info)
    if not found:
        out({"error": "No transcript for this agent"})
    kind, path = found
    ps = prompts(kind, path)
    if not 0 <= index < len(ps):
        out({"error": "No such prompt"})
    r = run(["hc", "read", address, "--json", "--lines", "1000000"])
    if r.returncode != 0:
        out({"error": "Can't read the terminal"})
    lines = json.loads(r.stdout).get("text", "").split("\n")
    if lines and lines[-1] == "":
        lines.pop()

    # Pasted images: the transcript says "[Image #1, 200x1568]", omp draws "📷 #1".
    img_tag = re.compile(r"\[Image #\d+[^\]]*\]")
    img_drawn = re.compile(r"^(?:📷\s*#\d+\s*)+")

    def head(p):
        text = img_tag.sub("", p["text"])
        first = next((l for l in text.splitlines() if l.strip()), "")
        return norm(first)[:40]

    marks = ("❯ ", "> ") if kind == "claude" else None

    def matches(line, needle):
        s = line.strip()
        if marks:
            m = next((m for m in marks if s.startswith(m)), None)
            if not m:
                return False
            s = s[len(m):]
        s = norm(img_drawn.sub("", s))
        if not s or not needle:
            return False
        # The prompt's first line may wrap: compare as much as the row holds.
        n = min(len(needle), len(s))
        return n >= min(12, len(needle)) and s[:n] == needle[:n]

    # Match from the latest prompt backwards, each one above the previous match,
    # so older prompts that have left the scrollback don't throw the others off.
    pos = {}
    upper = len(lines)
    for k in range(len(ps) - 1, index - 1, -1):
        needle = head(ps[k])
        for i in range(upper - 1, -1, -1):
            if matches(lines[i], needle):
                pos[k] = i
                upper = i
                break
    if index not in pos:
        if kind == "claude":
            out({"error": "Claude Code is in fullscreen mode (\"tui\": \"fullscreen\"), so it keeps no scrollback to jump to"})
        out({"error": "That prompt is no longer in this terminal's scrollback"})
    rows = int(info.get("rows") or 0)
    lines_up = len(lines) - rows - pos[index] + 1
    out({"lines_up": max(0, lines_up)})


def main():
    if len(sys.argv) < 3:
        out({"error": "usage: prompts.py list|locate <terminal> [...]"})
    cmd, address = sys.argv[1], sys.argv[2]
    if cmd == "locate":
        locate(address, int(sys.argv[3]))
    info = terminal_info(address)
    found, app = transcript(info)
    if not found:
        out({"agent": app, "error": "No transcript found for this agent (Claude Code and omp are supported)"})
    kind, path = found
    size = os.path.getsize(path)
    if len(sys.argv) > 3 and sys.argv[3] == f"{path}:{size}":
        out({"unchanged": True})
    out({"agent": kind, "file": path, "size": f"{path}:{size}", "prompts": prompts(kind, path)})


if __name__ == "__main__":
    main()
