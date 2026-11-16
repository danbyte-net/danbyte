"""The list query parameters the web app sends (``frontend/src``) and the
docs show (``docs/``), for api.tests_frontend_query_params.

A static pass over the TypeScript sources for tests: every string or template
literal that names an ``/api/...`` URL, the parameters written into it
(``?a=1&b=${x}``, ``&c=`` fragments added next to it, ``new
URLSearchParams({...})`` keys and ``<name>.set("k", ...)`` calls on the
params it interpolates), and the filters of each ObjectPicker spec. It is a
heuristic, not a parser: it finds what is written literally and leaves out
what is computed (a key built at run time). The shared list machinery that
computes keys (``useServerList``'s ``f_<facet>``, a host-kind key) is listed
in the test (``DYNAMIC_CALLS``). Not imported at run time.
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field
from pathlib import Path

FRONTEND_SRC = Path(__file__).resolve().parent.parent / "frontend" / "src"

_PARAM = re.compile(r"[?&]([A-Za-z_][\w.]*)=(?!=)")
_KEY_VALUE = re.compile(r"[?&]([A-Za-z_][\w.]*)=([\w.,:-]*)(?=[&\"'`$]|$)")
_FRAGMENT = re.compile(r"^&([A-Za-z_][\w.]*)=")
_OBJ_KEY = re.compile(r"(?:^|[{,])\s*(?:([A-Za-z_]\w*)|\"([\w.]+)\"|'([\w.]+)')\s*(?=[:,}])")


@dataclass
class Call:
    file: str
    line: int
    path: str  # ``${...}`` path segments become ``{}``
    params: dict[str, str] = field(default_factory=dict)  # name -> literal value or ""
    unresolved: list[str] = field(default_factory=list)


def _lex(text: str):
    """Yield ``(start, end, quote, raw)`` for each string/template literal at
    any depth, skipping comments and regex-free code. ``raw`` is the text
    between the quotes; a template keeps its ``${...}`` expressions."""
    out = []

    def scan_code(i, stop_at_brace):
        depth = 0
        n = len(text)
        while i < n:
            c = text[i]
            if c == "/" and text.startswith("//", i):
                j = text.find("\n", i)
                i = n if j < 0 else j
                continue
            if c == "/" and text.startswith("/*", i):
                j = text.find("*/", i + 2)
                i = n if j < 0 else j + 2
                continue
            if c in "\"'":
                j = i + 1
                while j < n and text[j] != c and text[j] != "\n":
                    j += 2 if text[j] == "\\" else 1
                out.append((i, j + 1, c, text[i + 1:j]))
                i = j + 1
                continue
            if c == "`":
                i = scan_template(i)
                continue
            if c == "{":
                depth += 1
            elif c == "}":
                if stop_at_brace and depth == 0:
                    return i + 1
                depth -= 1
            i += 1
        return i

    def scan_template(start):
        i = start + 1
        n = len(text)
        while i < n:
            c = text[i]
            if c == "\\":
                i += 2
                continue
            if c == "`":
                out.append((start, i + 1, "`", text[start + 1:i]))
                return i + 1
            if c == "$" and text.startswith("${", i):
                i = scan_code(i + 2, True)
                continue
            i += 1
        return i

    scan_code(0, False)
    return out


def _split_query(raw: str) -> tuple[str, str]:
    """Path and query of a template, split at the first ``?`` outside
    ``${...}``."""
    depth = 0
    i = 0
    while i < len(raw):
        if raw.startswith("${", i):
            depth += 1
            i += 2
            continue
        if raw[i] == "}" and depth:
            depth -= 1
        elif raw[i] == "?" and depth == 0:
            return raw[:i], raw[i:]
        i += 1
    return raw, ""


def _top_exprs(raw: str) -> list[str]:
    """The ``${...}`` expressions at a parameter position (right after
    ``?`` or ``&``) of a template, at its top level."""
    out, i = [], 0
    while True:
        i = raw.find("${", i)
        if i < 0:
            return out
        depth, j = 1, i + 2
        while j < len(raw) and depth:
            if raw[j] == "{":
                depth += 1
            elif raw[j] == "}":
                depth -= 1
            j += 1
        if i == 0 or raw[i - 1] in "?&":
            out.append(raw[i + 2:j - 1].strip())
        i = j


def _object_keys(text: str) -> tuple[list[str], list[str]]:
    """Keys of the first ``{...}`` object literal in ``text`` (top level of
    it only), and its spreads."""
    i = text.find("{")
    if i < 0:
        return [], []
    depth, j = 0, i
    while j < len(text):
        if text[j] in "{[(":
            depth += 1
        elif text[j] in "}])":
            depth -= 1
            if depth == 0:
                break
        j += 1
    body = text[i + 1:j]
    # Flatten nested brackets so only top-level keys remain.
    flat, depth = [], 0
    for ch in body:
        if ch in "{[(":
            depth += 1
        if depth == 0:
            flat.append(ch)
        if ch in "}])":
            depth -= 1
    flat_text = "{" + "".join(flat) + "}"
    keys = [a or b or c for a, b, c in _OBJ_KEY.findall(flat_text)]
    spreads = re.findall(r"\.\.\.\s*([\w.]+)", "".join(flat))
    return keys, spreads


def _ident_params(text: str, pos: int, ident: str, seen=None) -> tuple[list[str], list[str]]:
    """Params written into the URLSearchParams called ``ident`` in the 120
    lines before ``pos``."""
    seen = seen or set()
    if ident in seen:
        return [], []
    seen.add(ident)
    start = text.rfind("\n", 0, max(0, pos - 6000))
    window = text[max(0, start):pos]
    keys: list[str] = []
    unresolved: list[str] = []
    for m in re.finditer(rf"\b{re.escape(ident)}\.(?:set|append)\(\s*[\"'`]([\w.]+)[\"'`]", window):
        keys.append(m.group(1))
    for m in re.finditer(rf"\b{re.escape(ident)}\.(?:set|append)\(\s*`([^`]*\$\{{[^`]*)`", window):
        unresolved.append(f"{ident}.set(`{m.group(1)}`)")
    for m in re.finditer(
        rf"\b(?:const|let|var)\s+{re.escape(ident)}\s*(?::[^=]+)?=\s*", window
    ):
        rhs = window[m.end():m.end() + 800]
        if rhs.startswith("new URLSearchParams("):
            arg = rhs[len("new URLSearchParams("):]
            if arg.lstrip().startswith("{"):
                k, s = _object_keys(arg)
                keys += k
                unresolved += [f"...{x}" for x in s]
            elif not arg.lstrip().startswith(")"):
                inner = re.match(r"\s*([\w.]+)", arg)
                if inner:
                    k, u = _ident_params(text, pos, inner.group(1).split(".")[0], seen)
                    keys += k
                    unresolved += u
        else:
            other = re.match(r"([A-Za-z_]\w*)\.toString\(\)", rhs)
            if other:
                k, u = _ident_params(text, pos, other.group(1), seen)
                keys += k
                unresolved += u
            else:
                unresolved.append(f"{ident} = {rhs[:60].splitlines()[0]}")
    return keys, unresolved


def _expr_params(text: str, pos: int, expr: str) -> tuple[list[str], list[str]]:
    keys: list[str] = []
    unresolved: list[str] = []
    for m in re.finditer(r"new URLSearchParams\(", expr):
        arg = expr[m.end():]
        if arg.lstrip().startswith("{"):
            k, s = _object_keys(arg)
            keys += k
            unresolved += [f"...{x}" for x in s]
        else:
            inner = re.match(r"\s*([A-Za-z_]\w*)", arg)
            if inner:
                k, u = _ident_params(text, pos, inner.group(1))
                keys += k
                unresolved += u
    if "URLSearchParams" not in expr:
        ident = re.fullmatch(r"([A-Za-z_]\w*)(?:\.toString\(\))?", expr)
        if ident:
            k, u = _ident_params(text, pos, ident.group(1))
            if k or u:
                keys += k
                unresolved += u
            else:
                unresolved.append(expr)
    return keys, unresolved


def _line(text: str, pos: int) -> int:
    return text.count("\n", 0, pos) + 1


def extract_calls(root: Path = FRONTEND_SRC) -> list[Call]:
    calls: list[Call] = []
    files = sorted(
        p for p in root.rglob("*.ts*")
        if p.suffix in (".ts", ".tsx")
        and ".test." not in p.name
        and p.name != "routeTree.gen.ts"
    )
    for path in files:
        text = path.read_text(encoding="utf-8")
        rel = str(path.relative_to(root))
        # In source order: a literal nested in a template comes after it.
        literals = sorted(_lex(text))
        last: Call | None = None
        last_end = -1
        for start, end, quote, raw in literals:
            if start < last_end:
                continue  # inside the URL literal just read, params and all
            line = _line(text, start)
            frag = _FRAGMENT.match(raw)
            if frag and last is not None and "/api/" not in raw:
                # ``"/api/x/?a=1" + (s ? `&site=${s}` : "")``: only joined
                # onto the URL by ``+`` within the same expression.
                between = text[last_end:start]
                if "+" in between and not re.search(r"[;{},]|=>", between):
                    for m in _KEY_VALUE.finditer(raw):
                        last.params.setdefault(m.group(1), m.group(2))
                    for m in _PARAM.finditer(raw):
                        last.params.setdefault(m.group(1), "")
                    last_end = end
                continue
            if not raw.startswith("/api/"):
                continue
            head, query = _split_query(raw)
            path_t = re.sub(r"\$\{[^}]*\}", "{}", head)
            call = Call(rel, line, path_t)
            if query:
                for m in _PARAM.finditer(query):
                    call.params.setdefault(m.group(1), "")
                for m in _KEY_VALUE.finditer(query):
                    call.params[m.group(1)] = m.group(2)
                if quote == "`":
                    for expr in _top_exprs(query):
                        if re.search(r"[?&]\w+=", expr) and "URLSearchParams" not in expr:
                            continue  # a conditional fragment, read above
                        k, u = _expr_params(text, start, expr)
                        for key in k:
                            call.params.setdefault(key, "")
                        call.unresolved += u
            calls.append(call)
            last, last_end = call, end
        calls += _picker_calls(rel, text)
    return calls


def _picker_calls(rel: str, text: str) -> list[Call]:
    """An ObjectPicker spec's dialog sends its ``filters`` keys, ``search``
    and paging (and ``custom_field`` when the spec sets
    ``customFieldScope``) to its ``listEndpoint``."""
    out = []
    for m in re.finditer(r"listEndpoint:\s*(\"[^\"]+\"|[A-Z_]+)", text):
        ep = m.group(1)
        if ep.startswith('"'):
            ep = ep.strip('"')
        else:
            const = re.search(rf"\bconst {ep}\s*=\s*\"([^\"]+)\"", text)
            if not const:
                continue
            ep = const.group(1)
        if not ep.startswith("/api/"):
            continue
        rest = text[m.end():m.end() + 3000]
        fm = re.search(r"\bfilters:\s*(\[|[A-Z_]+)", rest)
        keys: list[str] = []
        if fm:
            if fm.group(1) == "[":
                body = rest[fm.end():]
                keys = re.findall(r"\bkey:\s*\"(\w+)\"", body[:body.find("]") + 1])
            else:
                decl = re.search(rf"\b{fm.group(1)}\s*(?::[^=]+)?=\s*\[", text)
                if decl:
                    body = text[decl.end():]
                    keys = re.findall(r"\bkey:\s*\"(\w+)\"", body[:body.find("\n]") + 1])
        head, query = _split_query(ep)
        call = Call(rel, _line(text, m.start()), head)
        for q in _PARAM.finditer(query):
            call.params[q.group(1)] = ""
        # ``custom_field`` only goes to a spec that says it takes it.
        scoped = re.search(r"customFieldScope:\s*true", text[max(0, m.start() - 300):m.end()])
        for key in [*keys, "search", *(["custom_field"] if scoped else []), "page", "page_size"]:
            call.params.setdefault(key, "")
        out.append(call)
    return out


DOCS = FRONTEND_SRC.parent.parent / "docs"
_DOC_URL = re.compile(r"/api/[A-Za-z0-9_/{}<>.$-]+/\?[^\s\"'`)|\]]+")


def extract_doc_calls(root: Path = DOCS) -> list[Call]:
    """The list URLs with query parameters the docs show (``curl`` lines,
    inline examples). A placeholder value (``<id>``, ``$SITE``, ``{{…}}``)
    is sent empty."""
    calls = []
    for path in sorted(root.rglob("*.md")):
        text = path.read_text(encoding="utf-8")
        rel = f"docs/{path.relative_to(root)}"
        for m in _DOC_URL.finditer(text):
            head, _, query = m.group(0).partition("?")
            path_t = re.sub(r"<[^>]*>|\{[^}]*\}", "{}", head)
            call = Call(rel, _line(text, m.start()), path_t)
            for part in query.split("&"):
                name, _, value = part.partition("=")
                if re.fullmatch(r"[A-Za-z_][\w.]*", name):
                    plain = re.fullmatch(r"[\w.,:-]*", value)
                    call.params.setdefault(name, value if plain else "")
            if call.params:
                calls.append(call)
    return calls
