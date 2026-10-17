"""Request body parsing shared by every API view.

Views read ``request.data`` as a mapping: serializers, and the many actions
and function views that call ``request.data.get(...)`` directly. A JSON body
that is a string, list, number or ``null`` used to reach that code and fail
with an ``AttributeError`` - a 500 (#373). ``ObjectJSONParser`` rejects it
at parse time with a 400 instead, so every view, including the next one
written, gets a mapping or a field error.

A view that genuinely takes a top-level array sets ``allow_json_list =
True`` (on the class, or as an ``@action`` keyword).
"""
from __future__ import annotations

from rest_framework.exceptions import ValidationError
from rest_framework.parsers import JSONParser

NOT_AN_OBJECT = "Expected a JSON object."


class ObjectJSONParser(JSONParser):
    def parse(self, stream, media_type=None, parser_context=None):
        data = super().parse(stream, media_type, parser_context)
        if isinstance(data, dict):
            return data
        view = (parser_context or {}).get("view")
        if isinstance(data, list) and getattr(view, "allow_json_list", False):
            return data
        raise ValidationError({"non_field_errors": [NOT_AN_OBJECT]})

