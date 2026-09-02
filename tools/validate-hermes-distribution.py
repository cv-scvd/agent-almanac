#!/usr/bin/env python3
"""validate-hermes-distribution.py — install a distribution with Hermes's OWN code, in a sandbox.

The generator's build-gates (`scripts/build-hermes-distribution.js`) are this repository's
reading of what Hermes does on install. This tool is the other half of the evidence: it runs the
real `hermes_cli/profile_distribution.py` — `plan_install` and then `_copy_dist_payload`, the two
functions `hermes profile install` calls — against a generated distribution, into a temporary
profile root, and checks what actually landed. Companion issue #78's validation plan, verbatim:
"execute the pin's own plan_install / _copy_dist_payload against a candidate repo in a local temp
dir. No install on the VPS."

Nothing here touches `~/.hermes`. The module's imports of `hermes_cli.profiles`,
`hermes_cli.__version__`, `hermes_cli._subprocess_compat` and `agent.skill_utils` are satisfied by
stubs written into a temp dir and put first on `sys.path`; the profile root they resolve to is a
temp dir. The stubs carry Hermes's REAL name rule (`_PROFILE_ID_RE`, `_RESERVED_NAMES`) and its
REAL skill-path exclusions (`EXCLUDED_SKILL_DIRS`, `SKILL_SUPPORT_DIRS`), copied from upstream
main on 2026-09-02 — a permissive stub would prove nothing about the name.

The Hermes module itself is NOT in this repository (it is upstream code, and the operator's copy
came off the VPS). Point `--module` at one:

    gh api repos/NousResearch/hermes-agent/contents/hermes_cli/profile_distribution.py \\
        --jq .content | base64 -d > /tmp/profile_distribution.py          # upstream main
    # or: the deployed pin, copied read-only from the host that runs it (scp; never executed there)

Usage:

    python3 tools/validate-hermes-distribution.py --module /tmp/profile_distribution.py \\
        --dist /path/to/generated-dir-or-git-url --almanac /path/to/agent-almanac
    python3 tools/validate-hermes-distribution.py --module /tmp/profile_distribution.py --verify

`--almanac ROOT` derives the expectations (version from package.json, skill count from
skills/_registry.yml, SOUL.md bytes); `--expect-version`, `--expect-skills` and `--expect-soul`
set or override them one by one. `--hermes-version` (default 0.13.0, the operator's pin) is what
the stubbed `hermes_cli.__version__` reports, so `hermes_requires` is checked against it.

Checks, numbered as in the companion's done-criteria for #78:

  (a) manifest parses through the module's own DistributionManifest; `version` == expected;
      `env_requires` empty; `distribution_owned` empty; `hermes_requires` accepted for the
      stubbed Hermes version (plan_install raises otherwise); resolved `name` is the expected one.
  (b) the module's `_count_skills(staged)` == expected, AND the SKILL.md files that actually
      arrived in the profile == expected — two counts, because the pin's rglob and upstream's
      excluded-path count are different rulers.
  (c) the installed SOUL.md is byte-identical to the expected one.
  (d) nothing at the profile root that is not distribution content (no cli/, docs/, viz/, tests/,
      package.json), zero directories at any depth named in the module's USER_OWNED_EXCLUDE,
      zero symlinks in the staged tree or the profile.
  (e) every regular file under the staged tree reached the profile with equal bytes — i.e. the
      install's ignore filter dropped nothing — and the installed manifest carries `source` and
      `installed_at`, which is how `hermes profile update` finds its way back.

`--verify` runs the checks against a synthetic distribution that must pass, then plants one
defect per check that must fail (a nested `cache/` file, a preserved `references/SKILL.md`, a
symlink, an edited SOUL.md, a wrong version, a `distribution_owned:` block) — proving each check
can go red with the module you supplied. A module version whose behaviour differs (symlinks are
rejected outright from v0.15.0, for instance) still fails the planted case; the report says how.

Exit codes: 0 every check passed; 1 at least one failed; 2 usage, unreadable module, or the
install itself raised before any check could run.
"""

from __future__ import annotations

import argparse
import importlib.util
import json
import os
import shutil
import sys
import tempfile
import textwrap
from pathlib import Path

DEFAULT_NAME = "agent-almanac"
DEFAULT_HERMES_VERSION = "0.13.0"
NOT_DISTRIBUTION_ROOT_ENTRIES = ("cli", "docs", "viz", "tests", "package.json", "scripts", "workflows")

# hermes_cli/profiles.py, upstream main 2026-09-02. Copied so the stub validates like Hermes does.
STUB_PROFILES = r'''
import re
from pathlib import Path
import os

_PROFILE_ID_RE = re.compile(r"^[a-z0-9][a-z0-9_-]{0,63}$")
_RESERVED_NAMES = frozenset({"hermes", "default", "test", "tmp", "root", "sudo"})
PROFILES_ROOT = Path(os.environ["VALIDATE_HERMES_PROFILES_ROOT"])


def normalize_profile_name(name):
    if not isinstance(name, str):
        name = str(name)
    stripped = name.strip()
    if not stripped:
        raise ValueError("profile name cannot be empty")
    if stripped.casefold() == "default":
        return "default"
    return stripped.lower()


def validate_profile_name(name):
    if name == "default":
        return
    if not _PROFILE_ID_RE.match(name):
        raise ValueError(f"Invalid profile name {name!r}. Must match [a-z0-9][a-z0-9_-]{{0,63}}")
    if name in _RESERVED_NAMES:
        raise ValueError(f"Profile name {name!r} is reserved")


def get_profile_dir(name):
    canon = normalize_profile_name(name)
    if canon == "default":
        raise RuntimeError("stub: the default profile is never a target here")
    return PROFILES_ROOT / canon


def check_alias_collision(name):
    return "stub: aliases are not created by this harness"


def create_wrapper_script(name):
    raise RuntimeError("stub: create_wrapper_script must not be reached")
'''

# agent/skill_utils.py, upstream main 2026-09-02 — only the pieces profile_distribution imports.
STUB_SKILL_UTILS = r'''
from pathlib import Path, PurePath

EXCLUDED_SKILL_DIRS = frozenset((
    ".git", ".github", ".hub", ".archive", ".venv", "venv", "node_modules", "site-packages",
    "__pycache__", ".tox", ".nox", ".pytest_cache", ".mypy_cache", ".ruff_cache",
))
SKILL_SUPPORT_DIRS = frozenset(("references", "templates", "assets", "scripts"))


def is_skill_support_path(path, *, root=None):
    path_obj = path if isinstance(path, Path) else Path(str(path))
    parts = path_obj.parts
    for idx, part in enumerate(parts[:-1]):
        if part not in SKILL_SUPPORT_DIRS or idx == 0:
            continue
        skill_root = Path(*parts[:idx])
        if root is not None and not path_obj.is_absolute():
            skill_root = root / skill_root
        if (skill_root / "SKILL.md").exists():
            return True
    return False


def is_excluded_skill_path(path, *, root=None):
    try:
        parts = path.parts
    except AttributeError:
        parts = PurePath(str(path)).parts
    return any(part in EXCLUDED_SKILL_DIRS for part in parts) or is_skill_support_path(path, root=root)
'''

STUB_SUBPROCESS_COMPAT = r'''
import os


def noninteractive_git_env():
    env = dict(os.environ)
    env["GIT_TERMINAL_PROMPT"] = "0"
    return env
'''

# utils.atomic_yaml_write, imported lazily by upstream's write_manifest since the pin. The real
# one writes via a temp file and rename; a plain write is equivalent for a check that only reads
# the result back.
STUB_UTILS = r'''
import os
import yaml


def atomic_yaml_write(path, data, sort_keys=False, default_flow_style=False, create_mode=None, **_ignored):
    text = yaml.safe_dump(data, sort_keys=sort_keys, default_flow_style=default_flow_style)
    existed = os.path.exists(path)
    with open(path, "w", encoding="utf-8") as fh:
        fh.write(text)
    if create_mode is not None and not existed:
        os.chmod(path, create_mode)
'''


class Usage(Exception):
    """Exit 2."""


def write_stubs(stub_dir: Path, hermes_version: str) -> None:
    (stub_dir / "hermes_cli").mkdir(parents=True)
    (stub_dir / "hermes_cli" / "__init__.py").write_text(f'__version__ = "{hermes_version}"\n', encoding="utf-8")
    (stub_dir / "hermes_cli" / "profiles.py").write_text(STUB_PROFILES, encoding="utf-8")
    (stub_dir / "hermes_cli" / "_subprocess_compat.py").write_text(STUB_SUBPROCESS_COMPAT, encoding="utf-8")
    (stub_dir / "agent").mkdir()
    (stub_dir / "agent" / "__init__.py").write_text("", encoding="utf-8")
    (stub_dir / "agent" / "skill_utils.py").write_text(STUB_SKILL_UTILS, encoding="utf-8")
    (stub_dir / "utils.py").write_text(STUB_UTILS, encoding="utf-8")


def load_module(module_path: Path, stub_dir: Path):
    if not module_path.is_file():
        raise Usage(f"--module {module_path} is not a file")
    sys.path.insert(0, str(stub_dir))
    for name in [n for n in sys.modules if n in ("hermes_cli", "agent", "utils") or n.startswith(("hermes_cli.", "agent."))]:
        del sys.modules[name]
    spec = importlib.util.spec_from_file_location("hermes_profile_distribution", str(module_path))
    if spec is None or spec.loader is None:
        raise Usage(f"cannot load {module_path} as a Python module")
    mod = importlib.util.module_from_spec(spec)
    # Registered BEFORE execution: with `from __future__ import annotations`, `@dataclass` resolves
    # its field annotations through `sys.modules[cls.__module__].__dict__`, and an unregistered
    # module fails there with "'NoneType' object has no attribute '__dict__'".
    sys.modules[spec.name] = mod
    try:
        spec.loader.exec_module(mod)
    except Exception as exc:  # noqa: BLE001 — report and exit 2, whatever it was
        raise Usage(f"importing {module_path} failed: {type(exc).__name__}: {exc}") from exc
    for required in ("plan_install", "_copy_dist_payload", "_count_skills", "USER_OWNED_EXCLUDE", "read_manifest"):
        if not hasattr(mod, required):
            raise Usage(f"{module_path} has no {required}; is this hermes_cli/profile_distribution.py?")
    return mod


# ── Expectations ───────────────────────────────────────────────────────────────────────────


def expectations_from_almanac(root: Path) -> dict:
    pkg = json.loads((root / "package.json").read_text(encoding="utf-8"))
    registry_text = (root / "skills" / "_registry.yml").read_text(encoding="utf-8")
    total = None
    for line in registry_text.splitlines():
        if line.startswith("total_skills:"):
            total = int(line.split(":", 1)[1].strip())
            break
    if total is None:
        raise Usage(f"{root / 'skills' / '_registry.yml'} has no total_skills line")
    return {
        "version": str(pkg["version"]),
        "skills": total,
        "soul": (root / "SOUL.md").read_bytes(),
    }


# ── The checks ─────────────────────────────────────────────────────────────────────────────


def _walk_files(base: Path):
    for p in sorted(base.rglob("*")):
        if ".git" in p.relative_to(base).parts:
            continue
        yield p


def run_checks(mod, dist_source: str, expect: dict, hermes_version: str, sandbox: Path, name: str = DEFAULT_NAME) -> dict:
    """Install `dist_source` with the module into `sandbox` and evaluate (a)–(e)."""
    profiles_root = sandbox / "profiles"
    profiles_root.mkdir(parents=True, exist_ok=True)
    os.environ["VALIDATE_HERMES_PROFILES_ROOT"] = str(profiles_root)
    workdir = sandbox / "work"
    workdir.mkdir(parents=True, exist_ok=True)

    results = []

    def record(key, ok, detail):
        results.append({"check": key, "ok": bool(ok), "detail": detail})

    try:
        plan = mod.plan_install(dist_source, workdir)
    except Exception as exc:  # noqa: BLE001 — the install refusing IS a result
        record("install", False, f"plan_install raised {type(exc).__name__}: {exc}")
        return {"hermes_version": hermes_version, "installed": False, "results": results}

    staged = Path(plan.staged_dir)
    target = Path(plan.target_dir)
    manifest = plan.manifest
    try:
        mod._copy_dist_payload(staged, target, manifest, preserve_config=False)
    except Exception as exc:  # noqa: BLE001
        record("install", False, f"_copy_dist_payload raised {type(exc).__name__}: {exc}")
        return {"hermes_version": hermes_version, "installed": False, "results": results}
    record("install", True, f"installed into {target}")

    # (a) manifest
    record("a.version", manifest.version == expect["version"], f"manifest version {manifest.version!r}, expected {expect['version']!r}")
    record("a.env_requires", not manifest.env_requires, f"env_requires has {len(manifest.env_requires)} entries")
    record("a.distribution_owned", not manifest.distribution_owned, f"distribution_owned has {len(manifest.distribution_owned)} entries")
    record("a.name", manifest.name == name, f"resolved name {manifest.name!r}, expected {name!r}")
    record("a.hermes_requires", bool(manifest.hermes_requires), f"hermes_requires {manifest.hermes_requires!r} accepted for Hermes {hermes_version}")

    # (b) counts, two rulers
    module_count = mod._count_skills(staged)
    landed = sum(1 for p in _walk_files(target / "skills") if p.name == "SKILL.md" and p.is_file()) if (target / "skills").is_dir() else 0
    record("b.module_count", module_count == expect["skills"], f"module _count_skills(staged) = {module_count}, expected {expect['skills']}")
    record("b.landed_count", landed == expect["skills"], f"SKILL.md files in the installed profile = {landed}, expected {expect['skills']}")

    # (c) soul bytes
    soul_path = target / "SOUL.md"
    soul_ok = soul_path.is_file() and soul_path.read_bytes() == expect["soul"]
    record("c.soul", soul_ok, "installed SOUL.md is byte-identical to the expected one" if soul_ok else "installed SOUL.md missing or differs")

    # (d) root hygiene, user-owned names, symlinks
    root_entries = sorted(p.name for p in target.iterdir())
    foreign = [n for n in root_entries if n in NOT_DISTRIBUTION_ROOT_ENTRIES]
    record("d.root", not foreign, f"profile root: {root_entries}; repository-only entries present: {foreign or 'none'}")
    user_owned = set(mod.USER_OWNED_EXCLUDE)
    collisions = sorted(str(p.relative_to(target)) for p in _walk_files(target) if p.is_dir() and p.name in user_owned)
    # A user-owned NAME under the profile root is created by Hermes itself on a fresh install
    # (`_bootstrap_user_dirs`), never by this harness, and never inside skills/. Anything deeper is a
    # collision the install would have filtered — which is exactly what (e) then reports as dropped.
    nested = [c for c in collisions if "/" in c]
    record("d.user_owned_nested", not nested, f"nested user-owned directory names: {nested or 'none'}")
    staged_links = sorted(str(p.relative_to(staged)) for p in _walk_files(staged) if p.is_symlink())
    target_links = sorted(str(p.relative_to(target)) for p in _walk_files(target) if p.is_symlink())
    record("d.symlinks", not staged_links and not target_links, f"symlinks staged={staged_links or 'none'} installed={target_links or 'none'}")

    # (e) nothing dropped, manifest stamped
    dropped = []
    differing = []
    for p in _walk_files(staged):
        if not p.is_file() or p.is_symlink():
            continue
        rel = p.relative_to(staged)
        if rel.name == mod.MANIFEST_FILENAME and len(rel.parts) == 1:
            continue  # rewritten by write_manifest, checked below
        q = target / rel
        if not q.is_file():
            dropped.append(str(rel))
        elif q.read_bytes() != p.read_bytes():
            differing.append(str(rel))
    record("e.nothing_dropped", not dropped and not differing, f"dropped={dropped or 'none'} differing={differing or 'none'}")
    installed_manifest = mod.read_manifest(target)
    stamped = installed_manifest is not None and bool(installed_manifest.source) and bool(installed_manifest.installed_at)
    record("e.manifest_stamped", stamped, "installed manifest carries source and installed_at" if stamped else "installed manifest lacks source/installed_at")

    return {"hermes_version": hermes_version, "installed": True, "results": results}


# ── --verify ───────────────────────────────────────────────────────────────────────────────


def synthetic_distribution(base: Path, *, version="1.2.3", soul=b"# Soul\n", skills=("alpha", "beta"), extra_manifest="") -> Path:
    base.mkdir(parents=True)
    (base / "distribution.yaml").write_text(
        textwrap.dedent(f"""\
        name: {DEFAULT_NAME}
        version: {version}
        description: "synthetic"
        hermes_requires: ">=0.13.0"
        license: MIT
        """) + extra_manifest,
        encoding="utf-8",
    )
    (base / "SOUL.md").write_bytes(soul)
    (base / "README.md").write_text("generated\n", encoding="utf-8")
    for s in skills:
        (base / "skills" / s).mkdir(parents=True)
        (base / "skills" / s / "SKILL.md").write_text(f"# {s}\n", encoding="utf-8")
    (base / "skills" / skills[-1] / "references").mkdir()
    (base / "skills" / skills[-1] / "references" / "notes.md").write_text("notes\n", encoding="utf-8")
    return base


def verify(mod, hermes_version: str, tmp: Path) -> int:
    expect = {"version": "1.2.3", "skills": 2, "soul": b"# Soul\n"}
    failures = 0

    def outcome(label, report, expected_red: tuple[str, ...]):
        """A planted case passes only if one of ITS named checks went red. `install` counts only
        where it is named — a module refusing every install for an unrelated reason (a missing
        stub, say) must not read as seven defects detected."""
        nonlocal failures
        failed = [r["check"] for r in report["results"] if not r["ok"]]
        ok = any(f in expected_red for f in failed)
        print(f"  {'ok' if ok else 'FAIL'}  {label}: red = {failed or 'NONE'}; expected one of {list(expected_red)}")
        if not ok:
            failures += 1

    print(f"verify: module {mod.__file__}, Hermes {hermes_version}")

    clean_report = run_checks(mod, str(synthetic_distribution(tmp / "clean")), expect, hermes_version, tmp / "s0")
    clean_failed = [r for r in clean_report["results"] if not r["ok"]]
    if clean_failed:
        # Without a green baseline the planted cases cannot mean anything — stop here, loudly.
        print("  FAIL  clean synthetic distribution: unexpected red")
        for r in clean_failed:
            print(f"        {r['check']}: {r['detail']}")
        print("verify: baseline is red; planted cases not run")
        return 1
    print("  ok    clean synthetic distribution: all checks passed")

    d = synthetic_distribution(tmp / "cache")
    (d / "skills" / "alpha" / "cache").mkdir()
    (d / "skills" / "alpha" / "cache" / "x.md").write_text("x\n", encoding="utf-8")
    # Before v0.17.0 the install filter drops the nested `cache/` (e goes red); from v0.17.0 it is
    # copied and only the name collision remains (d goes red). Either is the defect detected.
    outcome("planted skills/alpha/cache/x.md (dropped by the install filter)", run_checks(mod, str(d), expect, hermes_version, tmp / "s1"), ("e.nothing_dropped", "d.user_owned_nested"))

    d = synthetic_distribution(tmp / "nested")
    (d / "skills" / "beta" / "references" / "SKILL.md").write_text("# preserved\n", encoding="utf-8")
    outcome("planted skills/beta/references/SKILL.md (inflates a count)", run_checks(mod, str(d), expect, hermes_version, tmp / "s2"), ("b.module_count", "b.landed_count"))

    d = synthetic_distribution(tmp / "symlink")
    os.symlink("SKILL.md", d / "skills" / "alpha" / "link.md")
    # v0.13.0 dereferences symlinks on copy, so the harness's own check must catch it; from
    # v0.15.0 plan_install refuses the tree outright, which is also a detection.
    outcome("planted symlink skills/alpha/link.md", run_checks(mod, str(d), expect, hermes_version, tmp / "s3"), ("d.symlinks", "install"))

    d = synthetic_distribution(tmp / "soul", soul=b"# Other\n")
    outcome("planted differing SOUL.md", run_checks(mod, str(d), expect, hermes_version, tmp / "s4"), ("c.soul",))

    d = synthetic_distribution(tmp / "version", version="0.0.1")
    outcome("planted version 0.0.1", run_checks(mod, str(d), expect, hermes_version, tmp / "s5"), ("a.version",))

    d = synthetic_distribution(tmp / "owned", extra_manifest="distribution_owned:\n  - skills\n")
    outcome("planted distribution_owned block", run_checks(mod, str(d), expect, hermes_version, tmp / "s6"), ("a.distribution_owned",))

    # Five digits, because upstream versions are date-based (2026.8.18 satisfies >=99.0.0) and a
    # plant the module accepts is not a plant.
    d = synthetic_distribution(tmp / "requires")
    text = (d / "distribution.yaml").read_text(encoding="utf-8").replace('">=0.13.0"', '">=99999.0.0"')
    (d / "distribution.yaml").write_text(text, encoding="utf-8")
    outcome("planted hermes_requires >=99999.0.0 (install must refuse)", run_checks(mod, str(d), expect, hermes_version, tmp / "s7"), ("install",))

    print(f"verify: {failures} failure(s)")
    return 1 if failures else 0


# ── CLI ────────────────────────────────────────────────────────────────────────────────────


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0], formatter_class=argparse.RawDescriptionHelpFormatter, epilog=__doc__)
    ap.add_argument("--module", required=True, help="path to Hermes's hermes_cli/profile_distribution.py")
    ap.add_argument("--dist", help="generated distribution: a local directory or a git URL")
    ap.add_argument("--almanac", help="agent-almanac checkout to derive version, skill count and SOUL.md from")
    ap.add_argument("--expect-version")
    ap.add_argument("--expect-skills", type=int)
    ap.add_argument("--expect-soul", help="path to the SOUL.md the install must reproduce byte for byte")
    ap.add_argument("--name", default=DEFAULT_NAME, help=f"expected resolved profile name (default {DEFAULT_NAME})")
    ap.add_argument("--hermes-version", default=DEFAULT_HERMES_VERSION, help=f"what the stubbed hermes_cli reports (default {DEFAULT_HERMES_VERSION})")
    ap.add_argument("--json", action="store_true", help="print the report as JSON")
    ap.add_argument("--verify", action="store_true", help="self-test: a clean synthetic distribution must pass, seven planted defects must each fail")
    args = ap.parse_args(argv)

    try:
        with tempfile.TemporaryDirectory(prefix="validate-hermes-dist-") as tmp_str:
            tmp = Path(tmp_str)
            stub_dir = tmp / "stubs"
            write_stubs(stub_dir, args.hermes_version)
            mod = load_module(Path(args.module).expanduser().resolve(), stub_dir)

            if args.verify:
                if args.dist or args.almanac:
                    raise Usage("--verify takes no --dist or --almanac")
                return verify(mod, args.hermes_version, tmp / "verify")

            if not args.dist:
                raise Usage("--dist is required (or --verify)")
            expect = expectations_from_almanac(Path(args.almanac).expanduser().resolve()) if args.almanac else {}
            if args.expect_version:
                expect["version"] = args.expect_version
            if args.expect_skills is not None:
                expect["skills"] = args.expect_skills
            if args.expect_soul:
                expect["soul"] = Path(args.expect_soul).expanduser().read_bytes()
            missing = [k for k in ("version", "skills", "soul") if k not in expect]
            if missing:
                raise Usage(f"no expectation for {', '.join(missing)}: pass --almanac ROOT or the --expect-* flags")

            report = run_checks(mod, args.dist, expect, args.hermes_version, tmp / "sandbox", name=args.name)
            report["module"] = str(Path(args.module).resolve())
            report["dist"] = args.dist
            failed = [r for r in report["results"] if not r["ok"]]
            if args.json:
                print(json.dumps(report, indent=2))
            else:
                print(f"module {report['module']} as Hermes {args.hermes_version}; dist {args.dist}")
                for r in report["results"]:
                    print(f"  {'ok  ' if r['ok'] else 'FAIL'} {r['check']}: {r['detail']}")
                print("OK: every check passed" if not failed else f"FAIL: {len(failed)} check(s) failed")
            return 1 if failed else 0
    except Usage as exc:
        print(f"validate-hermes-distribution: {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    sys.exit(main())
