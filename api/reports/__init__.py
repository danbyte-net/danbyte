"""The report framework: one way to lay out every PDF report.

- ``engine.py``: the document - page size, running header and footer, the
  blocks' CSS, :class:`~api.reports.engine.ReportContext`, render.
- ``blocks.py``: tables, square badges, bars, figures and their CSS.
- ``cover.py``: the cover page in the tenant's look.
- ``divider.py``: chapter dividers, a full page or a compact banner.
- ``toc.py``: the contents page with page numbers, and PDF bookmarks.
- ``marking.py``: the sensitivity label every page can show.
- ``registry.py``: report kinds and their sections, as plug-ins.
- ``kinds/``: one module a kind (the object reports, the topology report).

The object reports (``api/object_report.py``) and the topology report
(``kinds/topology.py``) are built on it. The other PDF renderers (floor
plan report, cable schedule, spec sheets, elevations, SLA, labels) still
have their own page CSS and move onto it one at a time.
"""
