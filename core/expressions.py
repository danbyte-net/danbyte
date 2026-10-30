"""Filter expressions on the server: validate an AST, compile it to a ``Q``.

The AST is the advanced filter's own shape (``frontend/src/lib/filter-expr.ts``)
with two additions for compliance rules (``compliance.fields``)::

    group { kind: "group", op: "and" | "or", terms: [...] }
    cmp   { kind: "cmp", field, cmp: "=" | "!=" | "~" | "!~" | ">" | "<" | ">=" | "<=", value }
    cmp   { kind: "cmp", field, cmp: "in" | "not_in", values: [...] }
    cmp   { kind: "cmp", field, cmp: "matches" | "not_matches", value }
    empty { kind: "empty", field, negated }

Fields are not model attributes. A caller hands in a lookup from a logical
key to a :class:`FieldDef` (its kind, its ORM path, and how a many-valued
field finds its holders), so nothing outside that allow-list can be named.

Semantics follow the client evaluator: strings compare case-insensitively,
a field with no value matches no positive comparison and every negative one,
and a many-valued field (tags, profiles) matches ``in`` when it holds any of
the values and ``not_in`` when it holds none. A field the object's type does
not have reads as empty on that type.

Every leaf compiles to a lookup on the row or to ``pk__in`` a subquery, so a
compiled ``Q`` has no join fan-out and works inside ``ExpressionWrapper``.
"""
from __future__ import annotations

import json
from collections.abc import Callable
from dataclasses import dataclass
from datetime import date
from decimal import Decimal, InvalidOperation

from django.db.models import Q

#: Nesting depth, the root included: a leaf at depth 4 sits under three groups.
MAX_DEPTH = 4
MAX_LEAVES = 50
MAX_VALUES = 200
MAX_STRING = 255
MAX_JSON = 16 * 1024

SCALAR_CMPS = ("=", "!=", "~", "!~", ">", "<", ">=", "<=")
LIST_CMPS = ("in", "not_in")
REGEX_CMPS = ("matches", "not_matches")
CMPS = SCALAR_CMPS + LIST_CMPS + REGEX_CMPS

#: The operators each kind takes. ``empty`` / ``not_empty`` stand for the
#: ``empty`` node; the rest are ``cmp`` values.
OPS: dict[str, tuple[str, ...]] = {
    "string": ("=", "!=", "~", "!~", "matches", "not_matches", "empty", "not_empty"),
    "number": ("=", "!=", ">", "<", ">=", "<=", "empty", "not_empty"),
    "date": ("=", "!=", ">", "<", ">=", "<=", "empty", "not_empty"),
    "bool": ("=", "!=", "empty", "not_empty"),
    "choice": ("in", "not_in", "empty", "not_empty"),
    "ref": ("in", "not_in", "empty", "not_empty"),
    "tags": ("in", "not_in", "empty", "not_empty"),
    "type": ("in", "not_in"),
}

#: Always true / always false, as plain conditions on the primary key: they
#: negate and nest like any other leaf and need no special SQL.
TRUE = Q(pk__isnull=False)
FALSE = Q(pk__isnull=True)


@dataclass(frozen=True)
class FieldDef:
    """One logical field on one object type."""

    key: str
    label: str
    kind: str
    #: ORM path on the row (single-valued fields and custom fields).
    path: str = ""
    #: Ref model key (``compliance.fields.REF_MODELS``) for ref/tags fields.
    ref: str = ""
    #: ``(value, label)`` pairs for choice fields.
    choices: tuple[tuple[str, str], ...] = ()
    #: Narrower operator list than the kind's (a presence-only field).
    ops: tuple[str, ...] | None = None
    #: Many-valued: ``holders(values)`` is a ``values("<pk>")`` queryset of
    #: the rows holding any of ``values`` (any value at all for ``None``).
    holders: Callable | None = None
    #: The path is a key inside the ``custom_fields`` JSON document.
    json: bool = False
    #: A JSON list (multiselect custom field).
    json_list: bool = False
    #: A text column: "" counts as empty. False for an inet or a number.
    text: bool = True

    @property
    def allowed_ops(self) -> tuple[str, ...]:
        return self.ops or OPS.get(self.kind, ())

    def shape(self) -> tuple:
        """What has to agree for one key to be one field across types."""
        return (self.kind, self.ref, self.choices, self.allowed_ops)


class ExpressionError(Exception):
    def __init__(self, errors: list[dict]):
        super().__init__("; ".join(f"{e['path']}: {e['detail']}" for e in errors))
        self.errors = errors


def _join(path: str, part) -> str:
    return f"{path}.{part}" if path else str(part)


def _op_of(node: dict) -> str:
    if node.get("kind") == "empty":
        return "not_empty" if node.get("negated") else "empty"
    return node.get("cmp", "")


def _typed(kind: str, raw) -> tuple[str | None, str | None]:
    """``(normalised value, error)`` for one scalar of ``kind``."""
    if isinstance(raw, bool):
        raw = "true" if raw else "false"
    if isinstance(raw, (int, float)) and not isinstance(raw, bool):
        raw = str(raw)
    if not isinstance(raw, str):
        return None, "Must be a text value."
    if len(raw) > MAX_STRING:
        return None, f"At most {MAX_STRING} characters."
    if kind == "number":
        try:
            n = Decimal(raw.strip())
        except InvalidOperation:
            return None, "Must be a number."
        if not n.is_finite():
            return None, "Must be a number."
        return str(n), None
    if kind == "date":
        try:
            return date.fromisoformat(raw.strip()).isoformat(), None
        except ValueError:
            return None, "Must be a date (YYYY-MM-DD)."
    if kind == "bool":
        v = raw.strip().lower()
        if v in ("true", "yes", "1"):
            return "true", None
        if v in ("false", "no", "0"):
            return "false", None
        return None, "Must be true or false."
    return raw, None


def validate(ast, field_for: Callable[[str], FieldDef | None],
             value_check: Callable[[FieldDef, str], str | None] | None = None):
    """A clean copy of ``ast``, or :class:`ExpressionError` with one entry per
    problem, each with the dotted ``path`` of the offending node.

    ``field_for(key)`` is the field as the rule's types see it - ``None`` when
    no chosen type has the key. ``value_check(field, value)`` may refuse a
    single list value (a malformed id) with a message."""
    if ast is None:
        return None
    try:
        size = len(json.dumps(ast))
    except (TypeError, ValueError):
        raise ExpressionError([{"path": "", "detail": "Not a valid expression."}]) from None
    if size > MAX_JSON:
        raise ExpressionError(
            [{"path": "", "detail": f"The expression is larger than {MAX_JSON // 1024} KB."}]
        )
    errors: list[dict] = []
    leaves = [0]

    def walk(node, path: str, depth: int):
        if not isinstance(node, dict):
            errors.append({"path": path, "detail": "Not a condition."})
            return None
        if depth > MAX_DEPTH:
            errors.append({"path": path, "detail": f"Groups nest at most {MAX_DEPTH - 1} deep."})
            return None
        kind = node.get("kind")
        if kind == "group":
            op = node.get("op")
            if op not in ("and", "or"):
                errors.append({"path": _join(path, "op"), "detail": "Must be and or or."})
            terms = node.get("terms")
            if not isinstance(terms, list) or not terms:
                errors.append({"path": _join(path, "terms"), "detail": "A group needs a condition."})
                return None
            out = [walk(t, _join(path, f"terms.{i}"), depth + 1) for i, t in enumerate(terms)]
            return {"kind": "group", "op": op, "terms": out}
        if kind not in ("cmp", "empty"):
            errors.append({"path": path, "detail": "Not a condition."})
            return None
        leaves[0] += 1
        if leaves[0] == MAX_LEAVES + 1:
            errors.append({"path": path, "detail": f"At most {MAX_LEAVES} conditions."})
        key = node.get("field")
        if not isinstance(key, str) or not key:
            errors.append({"path": _join(path, "field"), "detail": "Pick a field."})
            return None
        field = field_for(key)
        if field is None:
            errors.append({
                "path": _join(path, "field"),
                "detail": "Not a field of the chosen object types.",
            })
            return None
        op = _op_of(node)
        if op not in field.allowed_ops:
            errors.append({
                "path": _join(path, "cmp"),
                "detail": f"{field.label} does not take this operator.",
            })
            return None
        if kind == "empty":
            return {"kind": "empty", "field": key, "negated": bool(node.get("negated"))}
        if op in LIST_CMPS:
            values = node.get("values")
            if not isinstance(values, list) or not values:
                errors.append({"path": _join(path, "values"), "detail": "Pick at least one value."})
                return None
            if len(values) > MAX_VALUES:
                errors.append({"path": _join(path, "values"),
                               "detail": f"At most {MAX_VALUES} values."})
                return None
            clean = []
            for i, v in enumerate(values):
                vpath = _join(path, f"values.{i}")
                if not isinstance(v, str) or not v or len(v) > MAX_STRING:
                    errors.append({"path": vpath, "detail": "Not a valid value."})
                    continue
                if field.kind in ("choice", "type") and v not in {c for c, _ in field.choices}:
                    errors.append({"path": vpath, "detail": "Not one of the choices."})
                    continue
                problem = value_check(field, v) if value_check else None
                if problem:
                    errors.append({"path": vpath, "detail": problem})
                    continue
                if v not in clean:
                    clean.append(v)
            return {"kind": "cmp", "field": key, "cmp": op, "values": clean}
        value, problem = _typed(
            "string" if op in REGEX_CMPS else field.kind, node.get("value")
        )
        if problem:
            errors.append({"path": _join(path, "value"), "detail": problem})
            return None
        if op in REGEX_CMPS and not value:
            errors.append({"path": _join(path, "value"), "detail": "Enter a pattern."})
            return None
        return {"kind": "cmp", "field": key, "cmp": op, "value": value}

    clean = walk(ast, "", 1)
    if errors:
        raise ExpressionError(errors)
    return clean


def leaves(ast):
    """Every leaf of ``ast`` with its dotted path, in order."""
    out = []

    def walk(node, path):
        if not isinstance(node, dict):
            return
        if node.get("kind") == "group":
            for i, t in enumerate(node.get("terms") or []):
                walk(t, _join(path, f"terms.{i}"))
        else:
            out.append((path, node))

    walk(ast, "")
    return out


def depth(ast) -> int:
    if not isinstance(ast, dict):
        return 0
    if ast.get("kind") == "group":
        return 1 + max((depth(t) for t in ast.get("terms") or []), default=0)
    return 1


def regex_error(pattern: str) -> str | None:
    """PostgreSQL's complaint about ``pattern``, or None when it compiles.
    Run in a savepoint, so a refused pattern leaves the transaction usable."""
    from django.db import DataError, connection, transaction

    try:
        with transaction.atomic(), connection.cursor() as cur:
            cur.execute("SELECT '' ~ %s", [pattern])
    except DataError as exc:
        msg = str(exc).strip().splitlines()[0] if str(exc).strip() else "Invalid pattern."
        return msg[:1].upper() + msg[1:]
    return None


# ─── Compilation ────────────────────────────────────────────────────────


def _number(v: str):
    n = Decimal(v)
    return int(n) if n == n.to_integral_value() else n


def _scalar(field: FieldDef, v: str):
    if field.kind == "number":
        return _number(v)
    if field.kind == "date":
        return v if field.json else date.fromisoformat(v)
    if field.kind == "bool":
        return v == "true"
    return v


def _empty_q(field: FieldDef) -> Q:
    if field.holders is not None:
        return ~Q(pk__in=field.holders(None))
    p = field.path
    if field.json:
        return (
            Q(**{f"{p}__isnull": True}) | Q(**{f"{p}__exact": None})
            | Q(**{f"{p}__exact": ""}) | Q(**{f"{p}__exact": []})
        )
    if field.text and field.kind == "string":
        return Q(**{f"{p}__isnull": True}) | Q(**{p: ""})
    return Q(**{f"{p}__isnull": True})


_LOOKUP = {"=": "iexact", "~": "icontains", "matches": "regex",
           ">": "gt", "<": "lt", ">=": "gte", "<=": "lte"}
_NEGATED = {"!=": "=", "!~": "~", "not_matches": "matches"}


def _leaf_q(field: FieldDef, node: dict, expand) -> Q:
    if node["kind"] == "empty":
        q = _empty_q(field)
        return ~q if node["negated"] else q
    op = node["cmp"]
    if op in LIST_CMPS:
        values = list(node["values"])
        if field.ref and expand is not None:
            values = expand(field.ref, values)
        if field.holders is not None:
            q = Q(pk__in=field.holders(values))
        elif field.json_list:
            q = FALSE
            for v in values:
                q |= Q(**{f"{field.path}__contains": [v]})
        else:
            q = Q(**{f"{field.path}__in": values})
        return ~q if op == "not_in" else q
    if op in _NEGATED:
        return ~_leaf_q(field, {**node, "cmp": _NEGATED[op]}, expand)
    value = _scalar(field, node["value"])
    if field.kind in ("string",) or op in REGEX_CMPS:
        lookup = _LOOKUP[op]
    elif op == "=":
        lookup = "exact"
    else:
        lookup = _LOOKUP[op]
    return Q(**{f"{field.path}__{lookup}": value})


def _missing_q(node: dict) -> Q:
    """A leaf on a field the row's type does not have: the field reads as
    empty, so positive comparisons fail and negative ones hold."""
    if node["kind"] == "empty":
        return FALSE if node["negated"] else TRUE
    return TRUE if node["cmp"] in ("!=", "!~", "not_in", "not_matches") else FALSE


def compile_q(ast, field_on_type: Callable[[str], FieldDef | None], object_type: str,
              expand: Callable[[str, list], list] | None = None) -> Q:
    """``ast`` as a ``Q`` on ``object_type``'s model. ``field_on_type(key)`` is
    the type's own field (None when the type lacks it); ``expand(ref, ids)``
    widens a ref list (a profile to its children)."""
    if ast is None:
        return TRUE
    if ast["kind"] == "group":
        parts = [compile_q(t, field_on_type, object_type, expand) for t in ast["terms"]]
        q = parts[0]
        for p in parts[1:]:
            q = (q & p) if ast["op"] == "and" else (q | p)
        return q
    key = ast["field"]
    if key == "type":
        hit = object_type in ast["values"]
        if ast["cmp"] == "not_in":
            hit = not hit
        return TRUE if hit else FALSE
    field = field_on_type(key)
    if field is None:
        return _missing_q(ast)
    return _leaf_q(field, ast, expand)
