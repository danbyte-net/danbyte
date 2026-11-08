"""Import/export of custom end-of-life products (auto-discovered by
``ApiConfig.ready``).

A row the file creates is a custom product of the tenant, as
``EolCustomProductViewSet.perform_create`` makes one, and a row without a key
gets one made from its name, as the API's create does.
"""
from __future__ import annotations

from api.io import ModelIOHandler, register_io

from .eol_custom import _slug
from .eol_sources import CUSTOM
from .models import EolProduct


class EolProductIOHandler(ModelIOHandler):
    model = EolProduct
    natural_key = ["name"]

    def new_object(self, tenant):
        obj = super().new_object(tenant)
        obj.source = CUSTOM
        return obj

    def apply(self, existing, row, tenant, user=None, request=None):
        if existing is None and not str(row.get("name") or "").strip():
            row = {**row, "name": _slug(str(row.get("label") or ""))}
        return super().apply(existing, row, tenant, user, request)


register_io(EolProductIOHandler())
