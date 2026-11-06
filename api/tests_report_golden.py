"""Golden pages of the object reports: the HTML a device, prefix and IP
report hands WeasyPrint, kept in ``api/tests_golden/``. The report
framework (``api/reports/``) must lay them out exactly as before.

The pages are normalised before they are compared: the font files' paths,
``data:`` URIs (the cover's JPEG and logo), ids, the Danbyte version and
the time on a journal row.
``DANBYTE_UPDATE_GOLDEN=1`` writes the files again.
"""

from __future__ import annotations

import datetime as dt
import os
import re
from pathlib import Path
from unittest import mock

from . import object_report as rep
from .tests_object_report import _Report

GOLDEN = Path(__file__).resolve().parent / "tests_golden"
FIXED = dt.datetime(2026, 11, 2, 9, 30, tzinfo=dt.UTC)

_UUID = re.compile(r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}")
_FILE = re.compile(r"file://[^\"')]+")
_DATA = re.compile(r"data:([a-z/+.-]+);base64,[A-Za-z0-9+/=]+")
_VERSION = re.compile(r"Danbyte \d+\.\d+\.\d+[^\s'\"<·]*")
#: A row's own time (a journal entry's), which the fixture stamps with
#: the clock; the report's own time is fixed.
_ROW_TIME = re.compile(r"<td(?: class=b)?>\d{4}-\d\d-\d\d \d\d:\d\d</td>")


def normalise(html: str) -> str:
    html = _FILE.sub("file://FONT", html)
    html = _DATA.sub(lambda m: f"data:{m.group(1)};base64,DATA", html)
    html = _UUID.sub("UUID", html)
    html = _VERSION.sub("Danbyte VERSION", html)
    # One rule a line, so a difference is readable.
    return html.replace("}", "}\n").replace("</section>", "</section>\n")


class GoldenTests(_Report):
    def page(self, path, body):
        seen = {}

        def fake(**kwargs):
            seen["html"] = kwargs["html"]
            return b"%PDF-1.7 fake"

        with (
            mock.patch("django.utils.timezone.now", return_value=FIXED),
            mock.patch.object(rep, "render_with_deadline", side_effect=fake),
        ):
            r = self.client.post(f"/api/{path}/report/", body, format="json")
        self.assertEqual(r.status_code, 200, r.content[:300])
        return normalise(seen["html"])

    def check(self, name, html):
        path = GOLDEN / f"{name}.html"
        if os.environ.get("DANBYTE_UPDATE_GOLDEN") == "1":
            path.parent.mkdir(exist_ok=True)
            path.write_text(html)
        row_time = lambda t: _ROW_TIME.sub("<td>TIME</td>", t)  # noqa: E731
        self.assertEqual(
            row_time(html), row_time(path.read_text()), f"{name} differs from its golden page"
        )

    def test_one_device_with_sections(self):
        html = self.page(
            "devices",
            {
                "ids": [str(self.dev_a.pk)],
                "sections": ["overview", "interfaces", "ip_addresses", "cables", "journal"],
            },
        )
        self.check("device-one", html)

    def test_device_list_with_summary_details_and_cover(self):
        html = self.page(
            "devices",
            {
                "filters": {},
                "sections": ["overview", "interfaces"],
                "options": {
                    "include_summary": True,
                    "group_by": "site",
                    "per_object": True,
                    "paper": "letter",
                    "orientation": "landscape",
                    "cover": True,
                    "cover_project": "Northwind",
                },
            },
        )
        self.check("device-list-cover", html)

    def test_prefix_list_with_ips(self):
        html = self.page(
            "prefixes",
            {
                "filters": {},
                "options": {"show_ips": True, "list_table": True, "paper": "a3"},
            },
        )
        self.check("prefix-list", html)

    def test_one_prefix(self):
        html = self.page(
            "prefixes",
            {
                "ids": [str(self.net.pk)],
                "sections": [
                    "overview",
                    "utilisation",
                    "child_prefixes",
                    "ip_addresses",
                    "ranges",
                ],
                "options": {"orientation": "portrait"},
            },
        )
        self.check("prefix-one", html)

    def test_one_ip_with_cover(self):
        html = self.page(
            "ips",
            {
                "ids": [str(self.ip.pk)],
                "sections": ["overview", "assignment", "nat"],
                "options": {"cover": True, "cover_background": "plain"},
            },
        )
        self.check("ip-one-cover", html)
