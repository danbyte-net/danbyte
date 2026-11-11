#!/usr/bin/env python3
"""Build danbyte_checks/data/recog.json from pinned Rapid7 Recog XML (#451 B3).

Recog (https://github.com/rapid7/recog, BSD-2-Clause) is fingerprint data:
regular expressions over service banners, with the vendor, product,
version and CPE each one implies. Danbyte vendors the converted data only -
no Recog code - so no XML parser runs in production.

Usage (a developer step, not part of a deployment):

    # download the files named in PINNED from the pinned commit into DIR
    python3 -I scripts/recog_build.py DIR

The script

1. refuses any file whose SHA-256 is not the pinned one;
2. refuses a file with a DOCTYPE or an ENTITY declaration before parsing it
   (the stdlib parser then has nothing to expand or fetch);
3. translates each pattern from Ruby to Python syntax, compiles it, and
   checks it against every example in the XML - a pattern that does not
   compile or does not reproduce its examples is dropped;
4. times every remaining pattern against hostile 512-character inputs in a
   child process and drops any that takes longer than SLOW_MS on one input
   (Python's ``re`` has no timeout, and banners are attacker-controlled);
5. writes the JSON with the provenance (tag, commit, file hashes) and the
   dropped patterns with the reason.

Update procedure: bump TAG/COMMIT, refresh the SHA-256 values from the new
files after reading the upstream diff, run this script, review the dropped
list and the JSON diff, run ``manage.py test discovery``, and record the new
pin in danbyte_checks/data/RECOG-NOTICE and docs/features/service-discovery.md.
"""
from __future__ import annotations

import base64
import hashlib
import json
import multiprocessing as mp
import re
import sys
import time
import xml.etree.ElementTree as ET
from pathlib import Path

TAG = "v3.3.2"
COMMIT = "1714aaed118861b4567bb6754920b4b929f59380"
#: file -> (sha256, the Danbyte database name it becomes)
PINNED = {
    "ssh_banners.xml": ("a3e608cd8a46a177b6407875d7e31a34157c858cc9e3393920a99405e1f4f4b6",
                        "ssh.banner"),
    "ftp_banners.xml": ("c15f0765cda093f7d464c19eac8fcf278b0c65c6abe1f0a4fcd01e78a77d9b85",
                        "ftp.banner"),
    "smtp_banners.xml": ("113d82f9334d259c46bfced27fd0d5973a97ef2db5a1da8cff64a37462f31221",
                         "smtp.banner"),
    "imap_banners.xml": ("21710f2207dd001b3e4a8fccf1adf45f11d7dfcecb18f30c217c91ae720fa199",
                         "imap.banner"),
    "pop_banners.xml": ("7823a1c6783402a8d6081adf996ac73f8331e50b899ec403455a125140921b2a",
                        "pop.banner"),
    "telnet_banners.xml": ("eed262d7cdbd0126e65310ee805c5ac5700c684549f5871c978d3f36bb9e990f",
                           "telnet.banner"),
    "http_servers.xml": ("010af0e05688945f669fd804520acf65b0160f89fc7702cc7faf12989a213302",
                         "http.server"),
    "http_xpoweredby.xml": ("ecb0cfcf854a3d7ea6399db97063acc8d3e3899c2ba51b14f8c24208a73e7017",
                            "http.x_powered_by"),
    "html_title.xml": ("588e64f5358420d95d605d369c5a9ddc623d6b9674bac9f3ef6a1bc7d16969b3",
                       "http.title"),
}
#: The params kept; everything else (host names, times, comments) is dropped.
KEEP = {"service.vendor", "service.product", "service.version", "service.family",
        "service.cpe23", "os.vendor", "os.product", "os.version", "os.family",
        "hw.vendor", "hw.product"}
#: The longest text a pattern is ever applied to (danbyte_checks.fingerprints).
INPUT_CAP = 512
SLOW_MS = 25.0
HOSTILE = [
    "a" * INPUT_CAP, "1" * INPUT_CAP, " " * INPUT_CAP, "a " * (INPUT_CAP // 2),
    "1." * (INPUT_CAP // 2), "A1-_" * (INPUT_CAP // 4), "\t\r\n " * (INPUT_CAP // 4),
    "/" * INPUT_CAP, "(" * INPUT_CAP, "x" * (INPUT_CAP - 1) + "!",
    "SSH-2.0-" + "OpenSSH_" * 63, "220 " + "foo.bar " * 63,
]
OUT = Path(__file__).resolve().parent.parent / "danbyte_checks" / "data" / "recog.json"


def ruby_to_python(pattern: str) -> str:
    """The Ruby constructs Recog uses that Python spells differently."""
    p = re.sub(r"\(\?<(?![=!])", "(?P<", pattern)
    p = p.replace(r"\z", r"\Z").replace(r"\h", "[0-9a-fA-F]")
    return p


def flags_of(text: str) -> int:
    f = 0
    for name in (text or "").split(","):
        name = name.strip()
        if name == "REG_ICASE":
            f |= re.IGNORECASE
        elif name in ("REG_MULTILINE", "REG_DOT_NEWLINE"):
            # Ruby's /m is Python's DOTALL.
            f |= re.DOTALL
    return f


def _example_text(ex) -> str:
    text = ex.text or ""
    if ex.get("_encoding") == "base64":
        text = base64.b64decode(text).decode("utf-8", "replace")
    return text


def interpolate(params: list, m: re.Match) -> dict:
    out = {}
    for pos, name, value in params:
        if pos == 0:
            out[name] = value
        else:
            try:
                got = m.group(pos)
            except IndexError:
                got = None
            if got is not None:
                out[name] = got
    for name, value in list(out.items()):
        if "{" in value:
            out[name] = re.sub(r"\{([a-z0-9_.]+)\}", lambda g: out.get(g.group(1), "-"), value)
    return out


def _time_worker(conn):
    while True:
        job = conn.recv()
        if job is None:
            return
        pattern, flags, examples = job
        rx = re.compile(pattern, flags)
        worst = 0.0
        # Generic hostile inputs, and each example stretched to the cap with
        # a byte at the end that fails the match (the backtracking case).
        own = [((x * (INPUT_CAP // max(len(x), 1) + 1))[:INPUT_CAP - 1] + "\x00")
               for x in examples if x]
        for s in HOSTILE + own:
            t = time.perf_counter()
            rx.search(s)
            worst = max(worst, (time.perf_counter() - t) * 1000)
        conn.send(worst)


def time_patterns(entries: list[dict]) -> dict[int, float | None]:
    """``{index: worst ms}``; ``None`` when the pattern hit the deadline."""
    out: dict[int, float | None] = {}
    i = 0
    while i < len(entries):
        parent, child = mp.Pipe()
        proc = mp.Process(target=_time_worker, args=(child,), daemon=True)
        proc.start()
        try:
            while i < len(entries):
                parent.send((entries[i]["p"], entries[i]["f"], entries[i].get("_x", [])))
                if parent.poll(2.0):
                    out[i] = parent.recv()
                    i += 1
                else:
                    out[i] = None
                    i += 1
                    break
        finally:
            proc.kill()
            proc.join()
    return out


def build(src: Path) -> dict:
    databases: dict[str, list] = {}
    dropped: list[dict] = []
    files = {}
    for name, (sha, db) in PINNED.items():
        raw = (src / name).read_bytes()
        got = hashlib.sha256(raw).hexdigest()
        if got != sha:
            raise SystemExit(f"{name}: SHA-256 {got} is not the pinned {sha}")
        head = raw.decode("utf-8")
        if re.search(r"<!\s*(DOCTYPE|ENTITY)", head, re.IGNORECASE):
            raise SystemExit(f"{name}: has a DOCTYPE or ENTITY declaration; refused")
        files[name] = sha
        root = ET.fromstring(raw)
        rows = []
        for fp in root.iter("fingerprint"):
            ruby = fp.get("pattern") or ""
            desc = (fp.findtext("description") or "").strip()[:200]
            all_params = [[int(prm.get("pos") or 0), prm.get("name") or "",
                           prm.get("value") or ""] for prm in fp.findall("param")]
            # Fixed values may name another param ({hw.model}); resolve them
            # with every param, then keep the ones Danbyte reads.
            params = [p for p in all_params if p[1] in KEEP]
            pattern = ruby_to_python(ruby)
            flags = flags_of(fp.get("flags") or "")
            why = ""
            try:
                rx = re.compile(pattern, flags)
            except re.error as exc:
                why = f"does not compile in Python: {exc}"
            else:
                if "[[:" in ruby:
                    why = "POSIX bracket class"
                for ex in fp.findall("example"):
                    if why:
                        break
                    text = _example_text(ex)
                    m = rx.search(text)
                    if m is None:
                        why = "an example does not match"
                        break
                    got = interpolate(all_params, m)
                    for k, v in ex.attrib.items():
                        if k in KEEP and got.get(k) != v:
                            why = f"example gives {k}={got.get(k)!r}, not {v!r}"
                            break
            if why:
                dropped.append({"db": db, "pattern": ruby, "reason": why})
                continue
            if not params:
                continue
            for p in params:
                if p[0] == 0 and "{" in p[2]:
                    names = re.findall(r"\{([a-z0-9_.]+)\}", p[2])
                    if any(n not in KEEP for n in names):
                        # Pre-resolve a reference to a param Danbyte drops.
                        p[2] = re.sub(r"\{([a-z0-9_.]+)\}",
                                      lambda g: g.group(0) if g.group(1) in KEEP else "-", p[2])
            examples = [_example_text(ex)[:INPUT_CAP] for ex in fp.findall("example")]
            rows.append({"p": pattern, "f": flags, "d": desc, "params": params,
                         "_x": examples})
        databases[db] = rows
    flat = [(db, i, e) for db, rows in databases.items() for i, e in enumerate(rows)]
    timings = time_patterns([e for _db, _i, e in flat])
    slow = set()
    for n, (db, _i, e) in enumerate(flat):
        worst = timings.get(n)
        if worst is None or worst > SLOW_MS:
            slow.add(n)
            dropped.append({"db": db, "pattern": e["p"],
                            "reason": "slow on hostile input" if worst is not None
                            else "did not finish in 2 s on hostile input"})
    kept: dict[str, list] = {}
    for n, (db, _i, e) in enumerate(flat):
        e.pop("_x", None)
        if n not in slow:
            kept.setdefault(db, []).append(e)
    worst_kept = max((t for n, t in timings.items() if n not in slow and t is not None),
                     default=0.0)
    return {
        "meta": {
            "source": "https://github.com/rapid7/recog",
            "license": "BSD-2-Clause",
            "copyright": "Copyright (c) 2014-2015, Rapid7",
            "tag": TAG, "commit": COMMIT, "files": files,
            "input_cap": INPUT_CAP, "slow_ms": SLOW_MS,
            "worst_kept_ms": round(worst_kept, 3),
            "kept": sum(len(v) for v in kept.values()),
            "dropped": len(dropped),
        },
        "databases": kept,
        "dropped": dropped,
    }


def main() -> None:
    if len(sys.argv) != 2:
        raise SystemExit(__doc__)
    data = build(Path(sys.argv[1]))
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(data, indent=0, sort_keys=True, ensure_ascii=False) + "\n")
    print(f"kept {data['meta']['kept']}, dropped {data['meta']['dropped']} -> {OUT}")
    reasons: dict[str, int] = {}
    for d in data["dropped"]:
        key = d["reason"].split(":")[0]
        reasons[key] = reasons.get(key, 0) + 1
    for k, v in sorted(reasons.items(), key=lambda kv: -kv[1]):
        print(f"  {v:4d}  {k}")


if __name__ == "__main__":
    main()
