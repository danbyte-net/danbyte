"""Cells for the spreadsheets Danbyte writes.

A text cell that starts with ``=``, ``+``, ``-`` or ``@`` is a formula to a
spreadsheet program, so an object named ``=HYPERLINK(...)`` would run in the
file of whoever exports it. Exported text is always text:

* CSV cells get a leading apostrophe, which spreadsheets read as "text";
  :func:`csv_unescape` takes it off again on import, so a round trip keeps
  the name as it was.
* XLSX cells are stored as strings (:func:`xlsx_text_row`), which needs no
  marker at all.
"""
from __future__ import annotations

FORMULA_START = ("=", "+", "-", "@", "\t", "\r")


def csv_cell(value):
    if isinstance(value, str) and value[:1] in FORMULA_START:
        return "'" + value
    return value


def csv_row(values) -> list:
    return [csv_cell(v) for v in values]


def csv_unescape(value):
    if isinstance(value, str) and len(value) > 1 and value[0] == "'" \
            and value[1] in FORMULA_START:
        return value[1:]
    return value


def xlsx_text_row(ws) -> None:
    """Keep the worksheet's last appended row's text as text: openpyxl turns a
    string that starts with ``=`` into a formula."""
    for cell in ws[ws.max_row]:
        if cell.data_type == "f":
            cell.data_type = "s"
