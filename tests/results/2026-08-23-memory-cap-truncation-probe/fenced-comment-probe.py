#!/usr/bin/env python3
"""
F2: is a block-level HTML comment INSIDE a fenced code block stripped from MEMORY.md before the
load caps are applied?

Documented: "Only the content that loads counts toward the limits. YAML frontmatter and block-level
HTML comments are stripped before the index is loaded, so they're excluded from the measurement."
Not documented: whether a comment inside a fence survives that strip. The nearest documented
behaviour — for CLAUDE.md, not MEMORY.md — says comments inside code blocks ARE preserved.

Three arms, identical canary bodies, differing only in whether a ~1.9k-unit comment is present and
whether it sits inside a fence.

Line geometry is chosen so the LINE cap can never bind in any arm (167 lines max, cap is 200), so
the only thing that can move the cut is the size cap. That matters: a taller fixture would let the
line cap fire in the comment-counted case and produce the same shift for the wrong reason.

  canary line   = 200 code points -> 201 UTF-16 units incl. newline
  150 canaries  = 30,150 units    -> over the 25,000 cap in every arm
  cut, stripped -> first dropped line 125  (last visible CANARY-124)
  cut, counted  -> ~1,915 units of comment eaten first, so ~10 lines earlier
"""
import os
import pathlib
import subprocess
import sys

CANARY_W = 200
N_CANARY = 150
N_COMMENT_LINES = 15
HOME = pathlib.Path.home()

u16 = lambda s: sum(2 if ord(c) > 0xFFFF else 1 for c in s)


def canaries():
    return [f"CANARY-{i:03d} " + "x" * (CANARY_W - 11) for i in range(1, N_CANARY + 1)]


def comment_lines():
    body = ["m" * CANARY_W for _ in range(N_COMMENT_LINES)]
    return ["<!--"] + body + ["-->"]


ARMS = {
    # anchor: no comment at all
    "ctrl": lambda: canaries(),
    # a block comment at the top, not inside any fence
    "bare": lambda: comment_lines() + canaries(),
    # byte-identical comment, wrapped in a fence
    "fenced": lambda: ["```text"] + comment_lines() + ["```"] + canaries(),
}

slug = lambda p: p.replace("/", "-").replace("_", "-")
Q = ("Reply with only the highest-numbered CANARY-NNN token present in your memory index, "
     "and nothing else.")


def main():
    root = os.path.abspath(sys.argv[1])
    runs = int(sys.argv[2]) if len(sys.argv) > 2 else 2
    made = []

    for name, build in ARMS.items():
        text = "\n".join(build())          # no trailing EOL, matching the committed generator
        proj = os.path.join(root, name)
        os.makedirs(proj, exist_ok=True)
        memdir = HOME / ".claude" / "projects" / slug(proj) / "memory"
        memdir.mkdir(parents=True, exist_ok=True)
        (memdir / "MEMORY.md").write_bytes(text.encode("utf-8"))
        made.append(memdir.parent)
        print(f"{name:8} lines={text.count(chr(10)) + 1:4d}  units={u16(text):6d}  "
              f"bytes={len(text.encode('utf-8')):6d}  slug={slug(proj)}", flush=True)

    print("\n--- probing (serial, tools disabled) ---", flush=True)
    for name in ARMS:
        for r in range(1, runs + 1):
            proc = subprocess.run(
                ["claude", "-p", "--tools", ""],
                cwd=os.path.join(root, name), input=Q,
                capture_output=True, text=True, timeout=300,
            )
            answer = " ".join(proc.stdout.split())[:120] or f"<empty, rc={proc.returncode}>"
            print(f"{name:8} run{r}  {answer}", flush=True)

    print("\n--- cleanup ---", flush=True)
    for d in made:
        for f in (d / "memory").glob("*"):
            f.unlink()
        (d / "memory").rmdir()
        d.rmdir()
        print(f"removed {d}", flush=True)
    left = list((HOME / ".claude" / "projects").glob("*f2probe*"))
    print(f"fixture dirs remaining: {len(left)}")


if __name__ == "__main__":
    main()
