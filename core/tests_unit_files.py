"""The unit files in the repo carry nothing that belongs to one host."""
from __future__ import annotations

import re
from pathlib import Path

from django.test import SimpleTestCase

REPO = Path(__file__).resolve().parent.parent
UNITS = sorted((REPO / "services").glob("*")) + sorted((REPO / "deploy" / "systemd").glob("*"))

# Loopback and the wildcard are the only addresses a shared unit may name.
ALLOWED_ADDRESSES = {"127.0.0.1", "0.0.0.0"}
SECRET_KEYS = re.compile(r"(?m)^\s*Environment=.*(PASSWORD|SECRET|TOKEN|API_KEY)\w*=")
HOST_KEYS = re.compile(r"(?m)^\s*Environment=.*(ALLOWED_HOSTS|CSRF_TRUSTED_ORIGINS)=")
ADDRESS = re.compile(r"\b\d{1,3}(?:\.\d{1,3}){3}\b")


class UnitFilesTests(SimpleTestCase):
    def test_no_credentials_hosts_or_addresses(self):
        self.assertTrue(UNITS)
        for path in UNITS:
            if not path.is_file():
                continue
            text = path.read_text()
            self.assertIsNone(SECRET_KEYS.search(text), f"{path.name}: a credential in a unit")
            self.assertIsNone(HOST_KEYS.search(text), f"{path.name}: hosts belong in .env")
            extra = set(ADDRESS.findall(text)) - ALLOWED_ADDRESSES
            self.assertEqual(extra, set(), f"{path.name}: an address in a unit")
