"""CVSS 3.0 / 3.1 base score from a vector string (#451).

The FIRST specification formulas, base metrics only. Used to check the score a
record carries against its own vector: a score Danbyte cannot reproduce is not
stored. Severity is always derived from the score here, never taken from a
record's ``baseSeverity``.

Pure Python, no Django.
"""
from __future__ import annotations

import math
from decimal import Decimal

#: Largest difference between a record's score and the recomputed one that
#: still counts as the same score.
TOLERANCE = 0.05

_AV = {"N": 0.85, "A": 0.62, "L": 0.55, "P": 0.2}
_AC = {"L": 0.77, "H": 0.44}
_PR_U = {"N": 0.85, "L": 0.62, "H": 0.27}
_PR_C = {"N": 0.85, "L": 0.68, "H": 0.5}
_UI = {"N": 0.85, "R": 0.62}
_CIA = {"H": 0.56, "L": 0.22, "N": 0.0}
_S = {"U", "C"}

BASE_METRICS = ("AV", "AC", "PR", "UI", "S", "C", "I", "A")
#: Temporal and environmental metrics a vector may carry; they do not change
#: the base score and are accepted but ignored.
_OTHER_METRICS = {
    "E", "RL", "RC", "CR", "IR", "AR",
    "MAV", "MAC", "MPR", "MUI", "MS", "MC", "MI", "MA",
}

ATTACK_VECTORS = {"N": "network", "A": "adjacent", "L": "local", "P": "physical"}


class CvssError(ValueError):
    """The vector is not a valid CVSS 3.x vector."""


def parse_vector(vector: str) -> tuple[str, dict[str, str]]:
    """``(version, {metric: value})`` for a ``CVSS:3.x/...`` vector."""
    if not isinstance(vector, str) or len(vector) > 200:
        raise CvssError("Not a CVSS vector.")
    parts = vector.strip().split("/")
    head = parts[0]
    if head not in ("CVSS:3.0", "CVSS:3.1"):
        raise CvssError("Only CVSS 3.0 and 3.1 vectors are computed.")
    metrics: dict[str, str] = {}
    for part in parts[1:]:
        key, sep, value = part.partition(":")
        if not sep or not value:
            raise CvssError(f"Malformed metric '{part}'.")
        if key in metrics:
            raise CvssError(f"Metric {key} appears twice.")
        if key not in BASE_METRICS and key not in _OTHER_METRICS:
            raise CvssError(f"Unknown metric {key}.")
        metrics[key] = value
    missing = [m for m in BASE_METRICS if m not in metrics]
    if missing:
        raise CvssError(f"Missing base metrics: {', '.join(missing)}.")
    return head[5:], metrics


def _roundup_31(value: float) -> float:
    # CVSS 3.1 Appendix A: avoids floating point surprises such as
    # 4.000000000000001 rounding up to 4.1.
    as_int = round(value * 100000)
    if as_int % 10000 == 0:
        return as_int / 100000.0
    return (math.floor(as_int / 10000) + 1) / 10.0


def _roundup_30(value: float) -> float:
    return math.ceil(value * 10) / 10.0


def base_score(vector: str) -> Decimal:
    """The base score of a CVSS 3.0/3.1 vector, as a one-decimal Decimal."""
    version, m = parse_vector(vector)
    try:
        av, ac, ui = _AV[m["AV"]], _AC[m["AC"]], _UI[m["UI"]]
        scope = m["S"]
        if scope not in _S:
            raise KeyError("S")
        pr = (_PR_C if scope == "C" else _PR_U)[m["PR"]]
        c, i, a = _CIA[m["C"]], _CIA[m["I"]], _CIA[m["A"]]
    except KeyError as exc:
        raise CvssError(f"Invalid value for {exc.args[0]}.") from None
    roundup = _roundup_31 if version == "3.1" else _roundup_30
    iss = 1 - (1 - c) * (1 - i) * (1 - a)
    if scope == "U":
        impact = 6.42 * iss
    else:
        impact = 7.52 * (iss - 0.029) - 3.25 * (iss - 0.02) ** 15
    exploitability = 8.22 * av * ac * pr * ui
    if impact <= 0:
        score = 0.0
    elif scope == "U":
        score = roundup(min(impact + exploitability, 10))
    else:
        score = roundup(min(1.08 * (impact + exploitability), 10))
    return Decimal(f"{score:.1f}")


def matches(vector: str, claimed) -> tuple[bool, Decimal | None]:
    """``(ok, recomputed)``: does ``claimed`` agree with the vector?"""
    try:
        recomputed = base_score(vector)
        claimed_f = float(claimed)
    except (CvssError, TypeError, ValueError):
        return False, None
    return abs(float(recomputed) - claimed_f) <= TOLERANCE, recomputed


def severity(score, version: str) -> str:
    """Severity for a score under its CVSS version's rating scale."""
    if score is None:
        return ""
    s = float(score)
    if version == "2.0":
        if s < 4.0:
            return "low"
        return "medium" if s < 7.0 else "high"
    if s == 0:
        return "none"
    if s < 4.0:
        return "low"
    if s < 7.0:
        return "medium"
    if s < 9.0:
        return "high"
    return "critical"


def attack_vector(vector: str) -> str:
    """``network``/``adjacent``/``local``/``physical`` from any CVSS
    version's vector (``AV:N``), blank when it has none."""
    for part in (vector or "").split("/"):
        key, _, value = part.partition(":")
        if key == "AV":
            return ATTACK_VECTORS.get(value, "")
    return ""
