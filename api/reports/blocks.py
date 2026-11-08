"""The blocks every report page is built from, and their CSS: tables
(``table.grid`` with a repeating head and rows that never break, band
rows, key/value and facts tables), square badges for statuses, roles,
tags and VLANs (never a dot), utilisation bars and photo figures.

The HTML builders that read the list catalog (``table_html``, ``cell``…)
live with the object reports in ``api/object_report.py`` and are re-exported
here for the report kinds.
"""

from __future__ import annotations

from ..floor_plan_report import _pill as pill  # noqa: F401 - the square badge

#: Tables: the grid, its bands and nested IP rows, key/value and facts
#: tables, the summary blocks and the small text helpers.
TABLE_CSS = (
    "table{width:100%;border-collapse:collapse;margin-bottom:1.5mm}"
    "thead{display:table-header-group}"
    "tr{break-inside:avoid}"
    "th{text-align:left;font-weight:600;color:#52525b;padding:0.9mm 1.2mm;"
    "vertical-align:bottom}"
    "table.grid{table-layout:fixed}"
    "th,td{box-sizing:border-box;overflow-wrap:anywhere}"
    "table.grid th{border-bottom:0.3mm solid #a1a1aa}"
    "td{padding:0.9mm 1.2mm;vertical-align:top}"
    "table.grid td{border-bottom:0.15mm solid #e4e4e7}"
    "tr.under>td{padding:0 0 1.5mm 5mm}"
    "tr.band{break-after:avoid}"
    "table.grid tr.band>td{background:#f4f4f5;border-bottom:0.15mm solid #d4d4d8;"
    "padding:1mm 1.2mm;color:#71717a}"
    ".band .bl{font-size:5.5pt;letter-spacing:0.3mm;margin-right:1.5mm}"
    ".band .pill{margin:0}"
    ".band .rd{font-family:'DejaVu Sans Mono',monospace;font-size:6pt;margin-left:1.5mm}"
    ".band .cnt{margin-left:2mm;color:#a1a1aa}"
    ".tree{color:#a1a1aa;font-weight:400;margin-right:0.8mm}"
    "table.ips{margin:0;font-size:6.8pt}"
    "table.ips th{border-bottom-width:0.15mm;padding:0.5mm 1.2mm}"
    "table.ips td{padding:0.5mm 1.2mm}"
    "table.kv{table-layout:fixed}"
    "table.kv th{font-weight:500;color:#71717a;border-bottom:0.15mm solid #e4e4e7}"
    "table.kv td{border-bottom:0.15mm solid #e4e4e7}"
    "table.facts{width:auto;min-width:70mm}"
    "table.facts th{font-weight:500;color:#71717a;border-bottom:0.15mm solid #e4e4e7;"
    "padding-right:8mm}"
    "table.facts td{border-bottom:0.15mm solid #e4e4e7}"
    ".sumblock{display:inline-block;vertical-align:top;margin-right:8mm}"
    ".n{text-align:right;white-space:nowrap}"
    ".b{font-weight:600}"
    ".muted{color:#71717a;margin:1mm 0}"
    ".sec{margin-bottom:2mm}"
)

#: Square badges: a status, role, tag or VLAN in its own colour.
BADGE_CSS = (
    ".pill,.tag{display:inline-block;padding:0.15mm 1.4mm;font-size:6.5pt;font-weight:500;"
    "white-space:nowrap;line-height:1.35;border-radius:0.6mm}"
    "td .pill{margin:0 0.6mm 0.4mm 0}"
    ".plain{background:#f4f4f5;color:#3f3f46}"
)

#: Utilisation bars and photo figures.
FIGURE_CSS = (
    ".ubar{height:3mm;width:120mm;background:#f4f4f5;border:0.2mm solid #d4d4d8;"
    "border-radius:0.6mm;overflow:hidden}"
    ".ubar div{height:100%;background:#52525b}"
    ".ulab{margin:1mm 0 2mm;color:#52525b}"
    ".photos figure{display:inline-block;margin:0 6mm 0 0;vertical-align:top}"
    ".photos img{max-width:110mm;max-height:45mm;border:0.2mm solid #d4d4d8}"
    ".photos figcaption{color:#71717a;font-size:6.5pt;margin-top:0.8mm}"
)

BLOCK_CSS = TABLE_CSS + BADGE_CSS + FIGURE_CSS
