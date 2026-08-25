#!/usr/bin/env python3
"""
Geometry and reconstruction arithmetic for auto-memory index cap probes.

    python3 capgeom.py --verify      # re-derive every published figure, assert, print counts
    python3 capgeom.py --arms        # the arm registry as a table
    python3 capgeom.py --span 170 147            # where does line 170 sit at 147 units/line?
    python3 capgeom.py --span 163 153 --header 34

WHY THIS FILE EXISTS
--------------------
Every party measuring this cap -- including this repository -- has re-derived the same two
primitives by hand and got them wrong at least once:

  * a probe reporting `size-bound` for every file exceeding both caps, because the line test
    sat after a `break`;
  * a probe counting a trailing empty split element as a 201st line;
  * a published boundary column computed as `ceil(cap/units-per-line)` where whole-line
    truncation gives the floor -- wrong in the unsafe direction, on three rows;
  * a needle placed at the START of its line, so the arm proved a bound 94 units weaker than
    claimed while looking exactly like a result;
  * this repository attributing both ends of a bracket to one arm when the floor came from a
    different party's fixture on a different build;
  * this repository publishing "fourteen of fifteen" against fourteen rows, having counted a
    markdown table by eye -- in a document whose own argument is that a figure quoted without
    naming its denominator is unfalsifiable.

The last two are why the ARMS registry below is the single source of truth and every count is
computed from it. A number nobody can re-derive is a number nobody can check.

CONVENTIONS
-----------
Lines are 1-indexed. `units_per_line` INCLUDES the line terminator, so 146 content characters
plus LF is 147, and a CRLF fixture at the same visible width is 148. `header` is any fixed
prefix before line 1 of the numbered body.

Units are UTF-16 code units throughout -- measured, not assumed; see RESULT.md verdict 1 and
its 2026-08-25 addendum for what that verdict does and does not now rest on.
"""

import sys

LINE_CAP = 200          # documented, and measured to bite independently of the size cap
DOCUMENTED_CAP = 25000  # documented and ROUND -- never treat it as measured


# ── primitives ────────────────────────────────────────────────────────────────

def line_span(n, units_per_line, header=0):
    """Unit positions of line `n`. Returns (content_start, content_end, lf_unit), 1-indexed.

    The whole point of returning three numbers rather than one: a content needle proves a bound
    at `content_end` (or earlier, if it is not flush), while `lf_unit` is only reachable by
    assuming whole-line truncation. Conflating them is how a bound drifts by two units.
    """
    if n < 1:
        raise ValueError('lines are 1-indexed')
    if units_per_line != int(units_per_line):
        # A fractional width is a fixture AVERAGE (total units / line count), fine for the
        # ruler's floor division but meaningless for locating a specific line. Refuse rather
        # than return a position that is off by a fraction of a character.
        raise ValueError(f'line_span needs an exact units_per_line, got {units_per_line}')
    units_per_line = int(units_per_line)
    header = int(header)
    width = units_per_line - 1
    start = header + (n - 1) * units_per_line + 1
    return start, start + width - 1, header + n * units_per_line


def reconstructed_cut(units_per_line, cap=DOCUMENTED_CAP, header=0, line_cap=LINE_CAP):
    """The last kept line a pure-arithmetic RECONSTRUCTION predicts, having read nothing.

    This is the ruler. If an arm's measured answer equals this, the arm cannot distinguish a
    subject that reported where the index was cut from one that computed the same number by
    arithmetic -- whatever else it appears to show.

    Note what the reconstruction still requires: the line width in UTF-16 units, which nothing
    but the index carries. So the claim is never "a subject that read nothing produces this"; it
    is "a subject that read the index and never attended to the cut produces this". Enough to
    void the arm, and the stronger phrasing was an overclaim (#717 review).

    The `line_cap` clamp is load-bearing for short-line arms: `lines300` at 21 units/line has a
    raw size cut of 1,190 and is bound by the documented 200-line rule instead. Such a row is
    reconstructible in a WEAKER sense -- its prediction is width-insensitive, so it cannot fail
    this test under any harness behaviour. It says nothing about UTF-16 units or 25,000, and
    should be read as a different claim shape from the size-bound rows.
    """
    return int(min((cap - header) // units_per_line, line_cap))


def bound_from_needle(n, units_per_line, header=0, trailing=0):
    """Bounds provable from a needle on line `n`, by how much you are willing to assume.

    `trailing` is the number of characters after the needle's last informative character (a
    trailing period is 1). Returns a dict keyed by the assumption each bound requires.
    """
    _, content_end, lf = line_span(n, units_per_line, header)
    return {
        'read':       content_end - trailing,  # needle was read: no model assumed
        'flush':      content_end,             # as above with a flush needle
        'whole_line': lf,                      # assumes whole-line truncation
    }


def intersect(*brackets):
    """Intersect half-open [lo, hi) brackets. Returns None if empty."""
    lo = max(b[0] for b in brackets)
    hi = min(b[1] for b in brackets)
    return (lo, hi) if lo < hi else None


def relation(a, b):
    """How two half-open brackets relate. Guards the trap that 'overlapping' reads as 'nested'."""
    if a[0] <= b[0] and a[1] >= b[1]:
        return 'a contains b'
    if b[0] <= a[0] and b[1] >= a[1]:
        return 'b contains a'
    return 'overlap' if intersect(a, b) else 'disjoint'


# ── the arm registry: single source of truth ──────────────────────────────────
# (source, label, units_per_line, header, measured_last_kept, build, instrument)
#   instrument: 'echo'       -- subject reports a canary/line number it can also COMPUTE
#               'behavioural'-- subject acts on an invented token it cannot compute or fake

ARMS = [
    ('pjt222',     'ascii 200x126',        25399 / 200,  0, 196, '2.1.237-241', 'echo'),
    ('pjt222',     'cjk 200x126',          25399 / 200,  0, 196, '2.1.241',     'echo'),
    ('pjt222',     'crlf 200x126',         25598 / 200,  0, 195, '2.1.237-241', 'echo'),
    ('pjt222',     'astral 200x126',       48399 / 200,  0, 103, '2.1.237-241', 'echo'),
    ('pjt222',     'ascii200 200x200',     40199 / 200,  0, 124, '2.1.241',     'echo'),
    ('pjt222',     'wide2000 200x2000',   400199 / 200,  0,  12, '2.1.237-241', 'echo'),
    ('pjt222',     'ctrl 150x200',              201.0,   0, 124, '2.1.241',     'echo'),
    ('pjt222',     'bare 150x200',              201.0,   0, 124, '2.1.241',     'echo'),
    ('pjt222',     'lines300 300x20',            21.0,   0, 200, '2.1.241',     'echo'),
    ('pjt222',     'fenced 150x200',            201.0,   0, 109, '2.1.241',     'echo'),
    ('DanceNitra', 'ASCII 200x125',             126.0,   0, 198, '2.1.241',     'echo'),
    ('DanceNitra', 'CJK 200x125',               126.0,   0, 198, '2.1.241',     'echo'),
    ('DanceNitra', 'CJK 200x60',                 61.0,   0, 200, '2.1.241',     'echo'),
    ('DanceNitra', 'emoji 200x125',             217.0,   0, 115, '2.1.241',     'echo'),
    ('DanceNitra', '147-char x180',             148.0,   0, 168, '2.1.241',     'echo'),
    ('tonydzi',    '153 b/line x?',             153.0,  34, 163, '2.1.201',     'echo'),
]

# Behavioural arms. Each records the boundary needle and whether its exact planted value came
# back, which is the ONLY safe classifier: an absent needle returns no `UNKNOWN` token in two
# of three observed modes, and fabricates a plausible value in ~2% of trials (1 of 51).
# (label, units_per_line, boundary_line, trailing, value_returned, build)
BEHAVIOURAL = [
    ('147 u/l x180',  147, 170, 1, True,  '2.1.245'),
    ('200 u/l x140',  200, 125, 0, True,  '2.1.245'),
    ('200 u/l x140',  200, 126, 0, False, '2.1.245'),
    ('251 u/l x110',  251, 100, 0, False, '2.1.245'),
    ('167 u/l x160',  167, 150, 0, False, '2.1.245'),
    ('136 u/l x195',  136, 184, 0, False, '2.1.245'),
]

# Published brackets and where each END actually comes from. Recorded as provenance because
# getting this wrong is not hypothetical: an earlier draft credited both ends to one arm.
# NOTE, found by this file's own --verify: BOTH ends are `whole_line`, i.e. both additionally
# assume whole-line truncation on top of being echo-derived. tonydzi's "canary 163 ends at
# 24973" is 34 + 163*153, the LF position; its CONTENT ends at 24972. An earlier draft recorded
# that end as `read` and derived 24972, one short of the published floor. The echo bracket is
# therefore weaker than it looks: reconstructible AND model-dependent at each end.
BRACKET_PROVENANCE = {
    'floor 24973':   ('tonydzi',    '153 b/line x?',  163, 'whole_line'),
    'ceiling 25012': ('DanceNitra', '147-char x180',  169, 'whole_line'),
}


# ── verification ──────────────────────────────────────────────────────────────

def verify():
    ok = True
    print('=== ruler: does each echo arm return floor(cap/units-per-line)? ===\n')
    print(f"{'source':11} {'arm':22} {'u/line':>9} {'floor':>6} {'measured':>9}  verdict")
    recon = 0
    for src, label, upl, hdr, measured, _build, _inst in ARMS:
        pred = reconstructed_cut(upl, header=hdr)
        hit = pred == measured
        recon += hit
        print(f'{src:11} {label:22} {upl:9.3f} {pred:6d} {measured:9d}  '
              f"{'reconstructible' if hit else '*** NOT reconstructible ***'}")
    total = len(ARMS)
    print(f'\n  {recon} of {total} reconstructible '
          f'({total - recon} informative) -- counted, not eyeballed')
    size_bound = [a for a in ARMS if reconstructed_cut(a[2], header=a[3]) < LINE_CAP]
    sb_recon = sum(reconstructed_cut(a[2], header=a[3]) == a[4] for a in size_bound)
    print(f'  of which size-bound (the rows that say anything about 25000 or UTF-16): '
          f'{sb_recon} of {len(size_bound)}')
    if recon != total - 1:
        print('  UNEXPECTED: exactly one arm (fenced) should resist width-only reconstruction')
        ok = False

    print('\n=== bracket provenance: which arm sources which END? ===\n')
    for name, (src, label, line, kind) in BRACKET_PROVENANCE.items():
        arm = next(a for a in ARMS if a[0] == src and a[1] == label)
        bounds = bound_from_needle(line, arm[2], header=arm[3])
        claimed = int(name.split()[1])
        got = bounds[kind]
        flag = 'OK' if got == claimed else f'*** MISMATCH: derives {got} ***'
        print(f'  {name:15} <- {src} {label}, line {line} ({kind}) = {got}  {flag}')
        if got != claimed:
            ok = False

    print('\n=== behavioural bounds (no truncation model assumed) ===\n')
    lo, hi = 0, 10 ** 9
    for label, upl, n, trailing, returned, build in BEHAVIOURAL:
        b = bound_from_needle(n, upl, trailing=trailing)
        if returned:
            lo = max(lo, b['read'])
            print(f"  {label:14} line {n:3d}  READ    -> cap >= {b['read']:6d}  [{build}]")
        else:
            hi = min(hi, b['read'])
            print(f"  {label:14} line {n:3d}  UNREAD  -> cap <  {b['read']:6d}  [{build}]")

    sound = (lo, hi)
    echo = (24973, 25012)
    print(f'\n  sound behavioural bracket  [{sound[0]}, {sound[1]})   {sound[1]-sound[0]} units')
    print(f'  echo-derived bracket       [{echo[0]}, {echo[1]})   {echo[1]-echo[0]} units')
    print(f'  relation: {relation(sound, echo)}   intersection: {intersect(sound, echo)}')
    print(f'  is {DOCUMENTED_CAP} inside the sound bracket? '
          f'{sound[0] <= DOCUMENTED_CAP < sound[1]}')
    if relation(sound, echo) != 'overlap':
        print('  UNEXPECTED: these overlap; neither contains the other')
        ok = False

    print('\nOK' if ok else '\nFAILED')
    return 0 if ok else 1


def main():
    a = sys.argv[1:]
    if not a or a[0] == '--verify':
        return verify()
    if a[0] == '--arms':
        for row in ARMS:
            print('\t'.join(str(x) for x in row))
        return 0
    if a[0] == '--span':
        n, upl = int(a[1]), float(a[2])
        hdr = int(a[a.index('--header') + 1]) if '--header' in a else 0
        s, e, lf = line_span(n, upl, hdr)
        print(f'line {n} at {upl} units/line (header {hdr}):')
        print(f'  content {s}..{e}   LF {lf}')
        print(f'  reconstruction predicts last kept line: {reconstructed_cut(upl, header=hdr)}')
        return 0
    print(__doc__)
    return 2


if __name__ == '__main__':
    sys.exit(main())
