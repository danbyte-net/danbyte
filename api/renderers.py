"""The API's JSON renderer (#488).

``FastJSONRenderer`` renders with ``orjson`` when that package is installed and
falls back to DRF's ``JSONRenderer`` when it is not, so the faster encoder is a
packaging decision, not a code change. ``orjson`` is not in requirements.txt:
adding it is pending a dependency review, and until then every response goes
through the standard library exactly as before.

The bytes are meant to match ``JSONRenderer``: values ``orjson`` would format
differently (datetimes, dataclasses) or not at all (Decimal, lazy strings, IP
objects...) go through DRF's own encoder; ``\\u2028``/``\\u2029`` are escaped
the same way; a pretty-printed request (``indent=``) or anything ``orjson``
refuses (an integer past 64 bits, a non-string key it cannot render) is
rendered by ``JSONRenderer`` itself. Two differences remain: floats in
exponent form are spelled ``1e-7`` rather than ``1e-07`` (the same number),
and a NaN or infinite float renders as ``null`` where the strict standard
renderer raised (a 500).
"""
from __future__ import annotations

from rest_framework.renderers import JSONRenderer
from rest_framework.utils.encoders import JSONEncoder

try:  # pragma: no cover - depends on the environment
    import orjson
except ImportError:  # pragma: no cover
    orjson = None

_ENCODER = JSONEncoder()


def _default(obj):
    # DRF's rules, so a Decimal, a datetime or a lazy string come out as the
    # standard renderer writes them.
    return _ENCODER.default(obj)


def orjson_available() -> bool:
    return orjson is not None


class FastJSONRenderer(JSONRenderer):
    def render(self, data, accepted_media_type=None, renderer_context=None):
        if orjson is None or data is None or not self.compact or self.ensure_ascii:
            return super().render(data, accepted_media_type, renderer_context)
        if self.get_indent(accepted_media_type, renderer_context or {}) is not None:
            return super().render(data, accepted_media_type, renderer_context)
        try:
            ret = orjson.dumps(
                data,
                default=_default,
                option=(
                    orjson.OPT_PASSTHROUGH_DATETIME
                    | orjson.OPT_PASSTHROUGH_DATACLASS
                    | orjson.OPT_NON_STR_KEYS
                ),
            )
        except (orjson.JSONEncodeError, TypeError, ValueError):
            return super().render(data, accepted_media_type, renderer_context)
        if b"\xe2\x80\xa8" in ret or b"\xe2\x80\xa9" in ret:
            ret = ret.replace(b"\xe2\x80\xa8", b"\\u2028").replace(b"\xe2\x80\xa9", b"\\u2029")
        return ret

