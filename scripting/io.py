"""Import/export of scripts (auto-discovered by ``ApiConfig.ready``).

A script is seen by its owner, those it is shared with and - published -
the whole tenant (:mod:`scripting.visibility`). RBAC alone reaches every
script of the tenant, so export and import narrow to the scripts the caller
sees, as ``/api/scripts/`` does: a private script's code never leaves in a
file, and an import never matches it by name.
"""
from __future__ import annotations

from api.io import ModelIOHandler, register_io

from .models import Script
from .visibility import visible_scripts


class ScriptIOHandler(ModelIOHandler):
    model = Script

    def visible_rows(self, qs, user):
        return visible_scripts(qs, user)


register_io(ScriptIOHandler())
