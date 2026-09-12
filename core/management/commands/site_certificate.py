"""The site's own certificate from the terminal - what the console's tls tab
and scripts drive. Same module as the settings card, same drop folder.

    manage.py site_certificate status
    manage.py site_certificate issuers
    manage.py site_certificate self-signed [--name db.example.com ...]
    manage.py site_certificate upload --cert fullchain.pem --key privkey.pem [--chain ca.pem]
    manage.py site_certificate acme --issuer <name or id> [--challenge http-01|dns-01] [--name ...]

Output is JSON on stdout, one object, so a caller can read it back.
"""
from __future__ import annotations

import json
from pathlib import Path

from django.core.management.base import BaseCommand, CommandError
from django.core.serializers.json import DjangoJSONEncoder

from core import site_tls
from core.models import SiteCertificate


class Command(BaseCommand):
    help = "Show, regenerate, upload or order the certificate Danbyte itself is served on."

    def add_arguments(self, parser):
        parser.add_argument("action", choices=["status", "issuers", "self-signed", "upload", "acme"])
        parser.add_argument("--name", action="append", default=[], help="a name to answer for (repeatable)")
        parser.add_argument("--cert")
        parser.add_argument("--key")
        parser.add_argument("--chain")
        parser.add_argument("--issuer", help="an ACME issuer's name or id")
        parser.add_argument("--challenge", choices=["http-01", "dns-01"], default="http-01")

    def emit(self, obj) -> None:
        self.stdout.write(json.dumps(obj, cls=DjangoJSONEncoder))

    def handle(self, *args, **o):
        action = o["action"]
        if action == "status":
            return self.emit(site_tls.status())
        if action == "issuers":
            from monitoring.models import Issuer

            return self.emit([{
                "id": str(i.id), "name": i.name, "tenant": i.tenant.slug,
                "directory_url": i.directory_url, "dns_provider": i.dns_provider or "",
            } for i in Issuer.objects.filter(enabled=True).select_related("tenant").order_by("name")])
        try:
            if action == "self-signed":
                cert_pem, key_pem = site_tls.make_self_signed(o["name"] or site_tls.current_names())
                facts = site_tls.drop_pair(cert_pem, key_pem, source=SiteCertificate.Source.SELF_SIGNED,
                                           reason="regenerated from the terminal")
                return self.emit({"dropped": True, **facts})
            if action == "upload":
                if not (o["cert"] and o["key"]):
                    raise CommandError("upload needs --cert and --key")
                facts = site_tls.drop_pair(
                    Path(o["cert"]).read_text(), Path(o["key"]).read_text(),
                    chain_pem=Path(o["chain"]).read_text() if o["chain"] else "",
                    source=SiteCertificate.Source.UPLOAD, reason="uploaded from the terminal")
                return self.emit({"dropped": True, **facts})
            if action == "acme":
                from monitoring.models import Issuer

                if not o["issuer"]:
                    raise CommandError("acme needs --issuer")
                qs = Issuer.objects.filter(enabled=True).select_related("tenant")
                issuer = qs.filter(id=o["issuer"]).first() if _is_uuid(o["issuer"]) else None
                if issuer is None:
                    named = list(qs.filter(name=o["issuer"]))
                    if len(named) != 1:
                        raise CommandError(f"issuer {o['issuer']!r}: {'not found' if not named else 'ambiguous - use the id'}")
                    issuer = named[0]
                order = site_tls.start_acme(issuer.tenant, None, issuer, o["challenge"],
                                            o["name"] or [site_tls.public_host()])
                return self.emit({"order": str(order.id), "status": order.status,
                                  "issuer": issuer.name, "challenge": o["challenge"]})
        except (site_tls.SiteTlsError, OSError) as exc:
            raise CommandError(str(exc)) from exc


def _is_uuid(value: str) -> bool:
    import uuid

    try:
        uuid.UUID(str(value))
        return True
    except ValueError:
        return False
