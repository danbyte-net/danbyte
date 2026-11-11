"""Unknown query parameters on list endpoints.

A list that does not understand a parameter used to ignore it and answer the
whole list: ``GET /api/ips/?device_id=<uuid>`` returned every address in the
tenant because the filter is called ``device``. A client that trusted the
narrowed list could act on the wrong object.

Every list endpoint now says which parameters it ignored:

* ``X-Danbyte-Unknown-Params: device_id, foo`` and
  ``Warning: 299 - "Unknown query parameters ignored: device_id, foo"``.
* Strict mode (``?strict=1``, the ``X-Danbyte-Strict: 1`` header, or the
  ``API_STRICT_QUERY_PARAMS`` setting) answers 400 instead, with a "did you
  mean" hint per parameter.

What a list understands is learned while it runs: the request's
``query_params`` records every name the view, its filters, its paginator and
its serializer read. Filtering here is hand-written in each viewset's
``get_queryset`` (there are no filtersets), so a static list per view would
drift; the record cannot. On top of that a view may declare:

* ``extra_query_params`` - names it honours without reading them on every
  request (rare: a read through a bulk copy, or one done outside the view).
* ``query_param_aliases`` - ``{"device_id": "device"}``: the alias is
  rewritten to the canonical name before the view runs. Only unambiguous
  aliases (both names take the same id).
* ``query_param_check = False`` - opt the view out.

Only successful (2xx) GET/HEAD list responses are checked: an error answer
may have stopped before the view read everything it understands.
"""
from __future__ import annotations

import difflib
from urllib.parse import quote

from django.conf import settings
from django.http import JsonResponse, QueryDict

# Understood by every list, read or not: paging (an unpaginated list takes
# them harmlessly), DRF's format override, this module's own switch and the
# conventional cache-buster.
GLOBAL_QUERY_PARAMS = frozenset({"page", "page_size", "format", "strict", "_"})

UNKNOWN_HEADER = "X-Danbyte-Unknown-Params"
STRICT_HEADER = "HTTP_X_DANBYTE_STRICT"
_MAX_HEADER_NAMES = 20
# Bytes, after encoding: one name, and the whole value of either header (the
# Warning adds its wrapper). Two large headers outgrew nginx's default
# proxy_buffer_size and the request became a 502 (#503).
_MAX_NAME_BYTES = 64
_MAX_HEADER_BYTES = 512
_SAFE = "-_.~[]:"
_CUT = quote("…")  # a cut name ends in an encoded "…"
_WARNING = '299 - "Unknown query parameters ignored: {}"'
_TRUE = ("1", "true", "yes", "on")
_FALSE = ("0", "false", "no", "off")


class TrackedQueryDict(QueryDict):
    """An immutable QueryDict that remembers which names were read. Copies
    share the record, so a view that copies the params and reads the copy
    still counts as having read them. Iterating the names alone does not
    count; reading a value (``get``, ``[]``, ``getlist``, ``in``,
    ``items()``, ``dict()``) does."""

    def __init__(self, *args, seen=None, **kwargs):
        super().__init__(*args, **kwargs)
        self._seen = seen if seen is not None else set()

    @classmethod
    def wrap(cls, source: QueryDict, seen: set | None = None) -> TrackedQueryDict:
        out = cls(mutable=True, encoding=source.encoding, seen=seen)
        for key, values in source.lists():
            out.setlist(key, list(values))
        out._mutable = False
        return out

    def _mark(self, key):
        self._seen.add(key)

    def __getitem__(self, key):
        self._mark(key)
        return super().__getitem__(key)

    def __contains__(self, key):
        self._mark(key)
        return super().__contains__(key)

    def _getlist(self, key, *args, **kwargs):
        self._mark(key)
        return super()._getlist(key, *args, **kwargs)

    def pop(self, key, *args):
        self._mark(key)
        return super().pop(key, *args)

    def setdefault(self, key, default=None):
        self._mark(key)
        return super().setdefault(key, default)

    def setlistdefault(self, key, default_list=None):
        self._mark(key)
        return super().setlistdefault(key, default_list)

    def __copy__(self):
        result = super().__copy__()
        result._seen = self._seen
        return result

    def __deepcopy__(self, memo):
        result = super().__deepcopy__(memo)
        result._seen = self._seen
        return result


def list_view_class(view_func, method: str):
    """The view class when ``view_func`` answers a list for ``method``,
    else None. A ViewSet's route maps the method to ``list``; a generic
    view is a list when it mixes in ``ListModelMixin``."""
    cls = getattr(view_func, "cls", None)
    if cls is None or method not in ("GET", "HEAD"):
        return None
    actions = getattr(view_func, "actions", None)
    if actions is not None:
        if actions.get(method.lower()) != "list":
            return None
    else:
        from rest_framework.mixins import ListModelMixin

        if not issubclass(cls, ListModelMixin):
            return None
    if getattr(cls, "query_param_check", True) is False:
        return None
    return cls


def declared_query_params(view_cls) -> set[str]:
    """What the view understands without having to read it."""
    out = set(GLOBAL_QUERY_PARAMS)
    out.update(getattr(view_cls, "extra_query_params", ()) or ())
    out.update((getattr(view_cls, "query_param_aliases", None) or {}).keys())
    return out


def apply_aliases(view_cls, request):
    """Rewrite each alias to its canonical name. Returns an error response
    when the request names both with different values."""
    aliases = getattr(view_cls, "query_param_aliases", None) or {}
    params = request.GET
    present = [(a, c) for a, c in aliases.items() if a in params]
    if not present:
        return None
    out = params.copy()
    for alias, canonical in present:
        values = params.getlist(alias)
        if canonical in params and params.getlist(canonical) != values:
            return JsonResponse(
                {alias: [f"Conflicts with {canonical}; send one of them."]}, status=400
            )
        out.setlist(canonical, values)
    out._mutable = False
    request.GET = out
    return None


def is_strict(request) -> bool:
    raw = request.GET.get("strict") if hasattr(request.GET, "get") else None
    for value in (raw, request.META.get(STRICT_HEADER)):
        if value is None:
            continue
        v = str(value).strip().lower()
        if v in _TRUE:
            return True
        if v in _FALSE:
            return False
    return bool(getattr(settings, "API_STRICT_QUERY_PARAMS", False))


def hint_for(name: str, candidates) -> str | None:
    """The parameter the caller probably meant: ``device_id`` → ``device``
    when the list takes ``device``, else the closest known name."""
    pool = sorted(c for c in candidates if c not in ("_", "strict", "format") and c != name)
    if name.endswith("_id") and name[:-3] in pool:
        return name[:-3]
    match = difflib.get_close_matches(name, pool, n=1, cutoff=0.75)
    return match[0] if match else None


def _quote(text: str) -> str:
    return quote(text, safe=_SAFE, errors="replace")


def _header_name(name: str) -> str:
    """``name`` percent-encoded (ASCII, no CR/LF), at most _MAX_NAME_BYTES;
    a longer one is cut on a character and ends in an encoded "…"."""
    enc = _quote(name)
    if len(enc) <= _MAX_NAME_BYTES:
        return enc
    out, room = [], _MAX_NAME_BYTES - len(_CUT)
    for ch in name:
        piece = _quote(ch)
        if len(piece) > room:
            break
        out.append(piece)
        room -= len(piece)
    return "".join(out) + _CUT


def _header_value(names) -> str:
    """The names for the headers: at most _MAX_HEADER_NAMES of them, and
    short enough that the Warning stays within _MAX_HEADER_BYTES, then
    "+N more" for the rest. The strict-mode 400 lists them all."""
    budget = _MAX_HEADER_BYTES - len(_WARNING.format(""))
    shown: list[str] = []
    for i, name in enumerate(names[:_MAX_HEADER_NAMES]):
        enc = _header_name(name)
        rest = len(names) - i - 1
        tail = len(f", +{rest} more") if rest else 0
        if len(", ".join([*shown, enc])) + tail > budget:
            break
        shown.append(enc)
    if len(shown) < len(names):
        shown.append(f"+{len(names) - len(shown)} more")
    return ", ".join(shown)


def check_response(request, response, view_cls, tracked: TrackedQueryDict, original_keys):
    """Annotate (or in strict mode replace) a list response that ignored
    some of its query parameters."""
    if not 200 <= response.status_code < 300:
        return response
    known = declared_query_params(view_cls) | tracked._seen
    unknown = [k for k in original_keys if k not in known]
    if not unknown:
        return response
    if is_strict(request):
        hints = {}
        for name in unknown:
            h = hint_for(name, known)
            if h:
                hints[name] = h
        return JsonResponse(
            {"detail": "Unknown query parameters", "unknown": unknown, "hint": hints},
            status=400,
        )
    value = _header_value(unknown)
    response[UNKNOWN_HEADER] = value
    response["Warning"] = _WARNING.format(value)
    return response
