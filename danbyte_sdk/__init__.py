"""danbyte-sdk - what a Danbyte script imports.

One surface, two runtimes. A **sandboxed** script gets ``db`` talking HTTP
to the Danbyte API with a short-lived run token, so it sees exactly what
the person it runs as sees. A **trusted** script gets the same ``db`` plus
``orm``, which reaches the database directly through Django. Promoting a
script is a flag, not a rewrite: the code that used ``db`` keeps working.

    from danbyte_sdk import db, run

    missing = [d for d in db.list("devices", role="core")
               if not d["custom_fields"].get("CF_OSPF_AREA_X")]
    run.log(f"{len(missing)} router(s) without an OSPF area")
    run.output_csv("missing.csv", missing, fields=["name", "site_name"])

The package is Django-free and depends only on the standard library, so it
also installs next to a script run outside Danbyte.
"""
from __future__ import annotations

from .client import ApiError, Client, db
from .run import Run, run

__all__ = ["ApiError", "Client", "Run", "db", "run"]
__version__ = "0.1.0"
