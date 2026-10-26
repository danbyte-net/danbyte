"""Test a PRTG connection and record what it said."""
from __future__ import annotations

from django.utils import timezone

from .client import PrtgClient, PrtgError, PrtgUnauthorized, PrtgUnreachable
from .models import PrtgConnection

#: ``table.json`` content name for probes. Unfiltered it lists every object
#: (188 rows on a fresh 26.3), so counts filter on ``type=probenode`` too.
PROBES = "probenode"


def test_connection(conn: PrtgConnection, *, client: PrtgClient | None = None) -> dict:
    """Reach PRTG, read its version and count what the key can see.

    Status first: it carries the version, and a refused key fails here rather
    than half way through. Then the probe and sensor counts, then whether API
    v2 answers. The version, the v2 answer and the error are stored on the
    connection whether or not the test passed.
    """
    client = client or PrtgClient.for_connection(conn)
    result = {
        "ok": False, "detail": "", "version": "", "probes": None, "sensors": None,
        "v2_available": None, "v2_detail": "", "write_mode": "", "write_detail": "",
    }
    if not conn.api_key_set:
        result["detail"] = "No API key is set."
    else:
        try:
            version = client.version()
            result["version"] = version
            conn.version = version[:32]
            if not conn.supported:
                floor = ".".join(str(p) for p in PrtgConnection.MIN_VERSION)
                result["detail"] = (
                    f"PRTG {version or '(no version)'} is below the supported "
                    f"floor ({floor})."
                )
            else:
                result["probes"] = client.count(PROBES, {"type": PROBES})
                result["sensors"] = client.count("sensors")
                result["ok"] = True
                result["detail"] = (
                    f"Connected to PRTG {version} - {result['probes']} probe"
                    f"{'' if result['probes'] == 1 else 's'}, {result['sensors']} sensor"
                    f"{'' if result['sensors'] == 1 else 's'}."
                )
            available, v2_detail = client.probe_v2()
            result["v2_available"] = available
            result["v2_detail"] = v2_detail
            conn.v2_available = available
            if result["ok"]:
                # What it can create, for the queue's Apply buttons.
                from .writer import check_writes

                writes = check_writes(conn)
                result["write_mode"] = writes["mode"]
                result["write_detail"] = writes["detail"]
        except PrtgUnauthorized as exc:
            result["detail"] = str(exc)
        except PrtgUnreachable as exc:
            result["detail"] = f"Could not reach {conn.url}: {exc}"
        except PrtgError as exc:
            result["detail"] = str(exc)
    conn.last_checked_at = timezone.now()
    conn.last_error = "" if result["ok"] else result["detail"][:500]
    conn.save(update_fields=[
        "version", "v2_available", "last_checked_at", "last_error", "updated_at",
    ])
    return result
