"""Export of vulnerability exceptions (#451), auto-discovered by
``ApiConfig.ready``.

Each row names its record by id (``CVE-2023-20198``) and its owner by
username. Export only for now: an exception is written through
``/api/vulnerability-exceptions/``, whose checks (the record must be one the
tenant matched or maps, the scope one the caller may write, the expiry
rules) an import would have to repeat row by row.
"""
from __future__ import annotations

from api.io import ModelIOHandler, register_io

from .models import VulnerabilityException


class VulnerabilityExceptionIOHandler(ModelIOHandler):
    model = VulnerabilityException
    natural_key = ["cve", "device", "virtual_machine", "platform", "application"]
    fk_keys = {"cve": "vuln_id", "owner": "username", "created_by": "username"}

    def importable(self) -> bool:
        return False


register_io(VulnerabilityExceptionIOHandler())
