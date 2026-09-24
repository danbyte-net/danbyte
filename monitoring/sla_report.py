"""SLA period reports - PDF (WeasyPrint, like labels) and CSV - and the
overview across a tenant's agreements for one period.

Built from a stored SlaPeriodResult, so a frozen period's report reads the
same whenever it is produced. ``units`` / ``incidents`` / ``days`` may be
narrowed first for a scoped viewer (the API passes a filtered copy).
"""
from __future__ import annotations

import csv
import io
from collections import defaultdict
from datetime import datetime

from django.utils import timezone
from django.utils.html import escape

STATE_LABEL = {
    "ok": "On target", "at_risk": "At risk", "breached": "Breached",
    "no_data": "No data", "not_started": "Not started",
}


def _pct(p) -> str:
    return "-" if p is None else f"{p:.3f}%" if p >= 99.95 else f"{p:.2f}%"


def _span(seconds) -> str:
    s = int(abs(seconds or 0))
    sign = "-" if (seconds or 0) < 0 else ""
    if s < 90:
        return f"{sign}{s}s"
    if s < 90 * 60:
        return f"{sign}{round(s / 60)}m"
    if s < 36 * 3600:
        return f"{sign}{s / 3600:.1f}h"
    return f"{sign}{s / 86400:.1f}d"


def _when(iso) -> str:
    try:
        return datetime.fromisoformat(iso).strftime("%Y-%m-%d %H:%M")
    except (TypeError, ValueError):
        return str(iso or "-")


def _parts(result, view=None):
    """figures, members, incidents, days - from the result or a viewer's copy."""
    if view is None:
        units = result.units or []
        return (result.figures or {}, [u for u in units if u.get("member")],
                result.incidents or [], result.days or [], None)
    return (view["figures"], view.get("members", []), view.get("incidents", []),
            view.get("days", []), view.get("limited"))


# ─── CSV ────────────────────────────────────────────────────────────────────


def report_csv(agreement, result, view=None) -> str:
    f, members, incidents, _days, limited = _parts(result, view)
    out = io.StringIO()
    w = csv.writer(out)
    w.writerow(["agreement", agreement.name, "for", agreement.for_label])
    w.writerow(["period", result.period_key, result.state])
    w.writerow(["availability_pct", f.get("availability"), "target_pct", f.get("target")])
    w.writerow(["coverage_pct", f.get("coverage"), "state", f.get("state")])
    w.writerow(["budget_s", f.get("budget_s"), "down_s", f.get("down_s"),
                "budget_left_s", f.get("budget_left_s")])
    if f.get("credit"):
        c = f["credit"]
        w.writerow(["service_credit_pct", c["pct"], "service_credit_amount", c["amount"],
                    "currency", c["currency"]])
    if limited:
        w.writerow(["limited_view_hidden_members", limited.get("hidden_members")])
    for o in f.get("objectives") or []:
        w.writerow(["objective", o["kind"], "within_ms", o["threshold_ms"], "pct", o["pct"],
                    "target_pct", o["target_pct"], "probes", o["probes"], "state", o["state"]])
    w.writerow([])
    w.writerow(["member", "type", "group", "redundancy_group", "availability_pct",
                "coverage_pct", "down_s", "incidents", "worst_check"])
    for m in members:
        w.writerow([m["name"], m["object_type"].split(".")[-1], m["group"],
                    m.get("redundancy_group", ""), m.get("availability"), m.get("coverage"),
                    m.get("down_s"), m.get("incidents"), m.get("worst_item") or ""])
    w.writerow([])
    w.writerow(["incident_start", "incident_end", "seconds", "unit", "members_down"])
    for i in incidents:
        w.writerow([i["start"], i["end"], i["seconds"], i["label"], "; ".join(i["members"])])
    return out.getvalue()


# ─── PDF ────────────────────────────────────────────────────────────────────

_CSS = """
@page { size: A4; margin: 16mm 14mm; @bottom-right { content: counter(page) " / " counter(pages);
  font-size: 8pt; color: #71717a; } }
body { font-family: "DejaVu Sans", Arial, sans-serif; font-size: 9.5pt; color: #18181b; }
h1 { font-size: 17pt; margin: 0 0 2mm; }
h2 { break-after: avoid; font-size: 11pt; margin: 7mm 0 2mm; border-bottom: 0.3mm solid #e4e4e7; padding-bottom: 1mm; }
.muted { color: #71717a; }
.kv { display: grid; grid-template-columns: repeat(4, 1fr); gap: 2.5mm; margin-top: 4mm; }
.cell { border: 0.3mm solid #e4e4e7; border-radius: 1.5mm; padding: 2mm 3mm; }
.cell .l { font-size: 7.5pt; color: #71717a; text-transform: uppercase; letter-spacing: 0.04em; }
.cell .v { font-size: 13pt; font-weight: bold; margin-top: 1mm; }
.ok { color: #047857; } .at_risk { color: #b45309; } .breached { color: #b91c1c; }
table { width: 100%; border-collapse: collapse; font-size: 8.5pt; }
th, td { vertical-align: top; }
th { text-align: left; color: #52525b; font-weight: 600; border-bottom: 0.3mm solid #d4d4d8; padding: 1.2mm; }
tr { break-inside: avoid; }
td { border-bottom: 0.2mm solid #f4f4f5; padding: 1.2mm; }
th.n, td.n { text-align: right; font-variant-numeric: tabular-nums; }
.bar { height: 2.2mm; background: #f4f4f5; border-radius: 0.6mm; }
.bar i { display: block; height: 100%; border-radius: 0.6mm; }
.credit { margin-top: 3mm; padding: 2mm 3mm; border: 0.3mm solid #e4e4e7;
  border-radius: 1.5mm; font-weight: bold; }
.note { background: #fafafa; border: 0.3mm solid #e4e4e7; padding: 2mm 3mm; margin-top: 3mm; }
"""


def _tone(av, target) -> str:
    if av is None:
        return ""
    return "ok" if av >= target else "breached"


def report_html(agreement, result, view=None) -> str:
    f, members, incidents, days, limited = _parts(result, view)
    target = f.get("target") or float(agreement.target_pct)
    customer = agreement.for_label
    state = f.get("state", "no_data")
    head = (
        f"<h1>{escape(agreement.name)}</h1>"
        f"<div class='muted'>{escape(customer) + ' · ' if customer else ''}"
        f"Service level report {escape(result.period_key)} · "
        f"{_when(f.get('since'))} to {_when(f.get('period_end'))} · "
        f"generated {timezone.now():%Y-%m-%d %H:%M} UTC</div>"
    )
    cells = [
        ("Availability", f"<span class='{state}'>{_pct(f.get('availability'))}</span>"),
        ("Target", _pct(target)),
        ("State", f"<span class='{state}'>{STATE_LABEL.get(state, state)}</span>"),
        ("Coverage", "-" if f.get("coverage") is None else f"{f['coverage']}%"),
        ("Budget", _span(f.get("budget_s"))),
        ("Budget left", _span(f.get("budget_left_s"))),
        ("Incidents", str(f.get("incidents", 0))),
        ("Members", str(len(members))),
    ]
    kv = "<div class='kv'>" + "".join(
        f"<div class='cell'><div class='l'>{label}</div><div class='v'>{value}</div></div>"
        for label, value in cells
    ) + "</div>"
    notes = []
    if result.state != "frozen":
        notes.append(
            "This period is still open; the figure may change." if result.state in ("open", "rolling")
            else "This period is closed but not yet frozen: exclusions can still be added."
        )
    if result.revision != agreement.revision:
        notes.append(f"Computed under revision {result.revision} of the agreement's rules.")
    if limited:
        notes.append(f"Limited view: {limited['hidden_members']} member(s) outside the "
                     "viewer's permissions are left out of this report.")
    note_html = "".join(f"<div class='note'>{escape(n)}</div>" for n in notes)
    if f.get("credit"):
        note_html = (f"<div class='credit'>Service credit: {_credit_text(f['credit'])}</div>"
                     + note_html)

    rules = (
        f"Service hours: {'around the clock' if not agreement.service_hours else 'set per weekday'}"
        f" · degraded counts as {agreement.count_degraded_as}"
        f" · stale counts as {'not measured' if agreement.count_stale_as == 'unmeasured' else 'down'}"
        f" · outages under {agreement.min_outage_seconds}s ignored"
        f" · planned maintenance {'excluded' if agreement.exclude_maintenance else 'counted'}"
    )

    day_rows = "".join(
        f"<tr><td>{d['date']}</td><td class='n {_tone(d['availability'], target)}'>"
        f"{_pct(d['availability'])}</td><td class='n'>{_span(d['down_s']) if d['down_s'] else '-'}"
        f"</td><td style='width:45%'><div class='bar'><i style='width:"
        f"{max(0, min(100, d['availability'] or 0))}%;background:"
        f"{'#10b981' if (d['availability'] or 0) >= target else '#ef4444'}'></i></div></td></tr>"
        for d in days
    )
    member_rows = "".join(
        f"<tr><td>{escape(m['name'])}</td><td>{escape(m['group'])}</td>"
        f"<td>{escape(m.get('redundancy_group') or '')}</td>"
        f"<td class='n {_tone(m.get('availability'), target)}'>{_pct(m.get('availability'))}</td>"
        f"<td class='n'>{'-' if m.get('coverage') is None else str(m['coverage']) + '%'}</td>"
        f"<td class='n'>{_span(m.get('down_s')) if m.get('down_s') else '-'}</td>"
        f"<td>{escape(m.get('worst_item') or '')}</td></tr>"
        for m in sorted(members, key=lambda m: (m.get("availability") is None, m.get("availability") or 0))
    )
    incident_rows = "".join(
        f"<tr><td>{_when(i['start'])}</td><td class='n'>{_span(i['seconds'])}</td>"
        f"<td>{escape(i['label'])}</td><td>{escape(', '.join(i['members']))}</td></tr>"
        for i in incidents[:200]
    )
    body = (
        head + kv + note_html
        + f"<p class='muted'>{escape(rules)}</p>"
        + (f"<h2>Per day</h2><table><thead><tr><th>Day</th><th class='n'>Availability</th>"
           f"<th class='n'>Down</th><th></th></tr></thead>"
           f"{day_rows}</table>" if day_rows else "")
        + _objectives_html(f.get("objectives"))
        + f"<h2>Members</h2><table><thead><tr><th>Member</th><th>Group</th><th>Redundancy</th>"
          f"<th class='n'>Availability</th><th class='n'>Coverage</th><th class='n'>Down</th>"
          f"<th>Worst check</th></tr></thead>"
          f"{member_rows or '<tr><td colspan=7 class=muted>No members.</td></tr>'}</table>"
        + f"<h2>Incidents</h2><table><thead><tr><th>Started</th><th class='n'>Lasted</th><th>Unit</th>"
          f"<th>Down at the start</th></tr></thead>"
          f"{incident_rows or '<tr><td colspan=4 class=muted>None.</td></tr>'}</table>"
    )
    return (f"<!doctype html><html><head><meta charset='utf-8'><style>{_CSS}</style>"
            f"</head><body>{body}</body></html>")


def report_pdf(agreement, result, view=None) -> bytes:
    import weasyprint

    return weasyprint.HTML(string=report_html(agreement, result, view)).write_pdf()


# ─── overview across agreements ─────────────────────────────────────────────


def overview_rows(rows) -> list[dict]:
    """``rows``: ``[(agreement, result-or-None, figures-or-None)]``."""
    out = []
    for a, res, f in rows:
        f = f or {}
        out.append({
            "agreement": a.name,
            "customer": a.for_label,
            "period": res.period_key if res else "",
            "state_of_period": res.state if res else "",
            "availability": f.get("availability"), "target": float(a.target_pct),
            "state": f.get("state", "no_data"), "coverage": f.get("coverage"),
            "budget_left_s": f.get("budget_left_s"), "incidents": f.get("incidents", 0),
            "members": f.get("members", 0), "credit": f.get("credit"),
        })
    return out


def _objectives_html(objectives) -> str:
    if not objectives:
        return ""
    rows = "".join(
        f"<tr><td>{escape(o['kind'])} within {o['threshold_ms']} ms</td>"
        f"<td class='n {o['state']}'>{_pct(o['pct'])}</td>"
        f"<td class='n'>{_pct(o['target_pct'])}</td><td class='n'>{o['probes']:,}</td>"
        f"<td class='n'>{o['slow']:,}</td><td class='n'>{o['budget_spent_pct']}%</td>"
        f"<td class='{o['state']}'>{STATE_LABEL.get(o['state'], o['state'])}</td></tr>"
        for o in objectives
    )
    return (
        "<h2>Latency objectives</h2><table><thead><tr><th>Objective</th>"
        "<th class='n'>Answered within</th><th class='n'>Target</th><th class='n'>Probes</th>"
        "<th class='n'>Slower</th><th class='n'>Budget spent</th><th>State</th></tr></thead>"
        f"{rows}</table>"
    )


def _credit_text(c) -> str:
    """"10% of the period fee, 1,200.00 DKK" or "none"."""
    if not c or not c.get("pct"):
        return "none"
    amount = (f", {c['amount']:,.2f} {c['currency']}".rstrip()
              if c.get("amount") is not None else "")
    return f"{c['pct']:g}% of the period fee{amount}"


def overview_csv(rows) -> str:
    data = overview_rows(rows)
    out = io.StringIO()
    w = csv.writer(out)
    w.writerow(["agreement", "for", "period", "period_state", "availability_pct",
                "target_pct", "state", "coverage_pct", "budget_left_s", "incidents", "members",
                "credit_pct", "credit_amount", "currency"])
    for r in data:
        w.writerow([r["agreement"], r["customer"], r["period"], r["state_of_period"],
                    r["availability"], r["target"], r["state"], r["coverage"],
                    r["budget_left_s"], r["incidents"], r["members"],
                    *((r["credit"]["pct"], r["credit"]["amount"], r["credit"]["currency"])
                      if r["credit"] else ("", "", ""))])
    return out.getvalue()


def _credit_cell(c) -> str:
    if not c or not c.get("pct"):
        return "-"
    if c.get("amount") is not None:
        return f"{c['pct']:g}% · {c['amount']:,.2f} {c['currency']}".rstrip()
    return f"{c['pct']:g}%"


def overview_pdf(rows, period_label: str) -> bytes:
    import weasyprint

    data = overview_rows(rows)
    priced = any(r["credit"] for r in data)
    trs = "".join(
        f"<tr><td>{escape(r['agreement'])}</td><td>{escape(r['customer'])}</td>"
        f"<td>{escape(r['period'])}</td>"
        f"<td class='n {r['state']}'>{_pct(r['availability'])}</td><td class='n'>{_pct(r['target'])}</td>"
        f"<td class='{r['state']}'>{STATE_LABEL.get(r['state'], r['state'])}</td>"
        f"<td class='n'>{'-' if r['coverage'] is None else str(r['coverage']) + '%'}</td>"
        f"<td class='n'>{_span(r['budget_left_s']) if r['budget_left_s'] is not None else '-'}</td>"
        f"<td class='n'>{r['incidents']}</td>"
        + (f"<td class='n'>{_credit_cell(r['credit'])}</td>" if priced else "")
        + "</tr>"
        for r in data
    )
    totals = defaultdict(float)
    for r in data:
        c = r["credit"]
        if c and c.get("amount"):
            totals[c["currency"]] += c["amount"]
    total_html = (
        "<p><b>Service credits: "
        + ", ".join(f"{v:,.2f} {k}".rstrip() for k, v in sorted(totals.items()))
        + "</b></p>" if totals else ""
    )
    html = (
        f"<!doctype html><html><head><meta charset='utf-8'><style>{_CSS}</style></head><body>"
        f"<h1>Service levels {escape(period_label)}</h1>"
        f"<div class='muted'>{len(data)} agreement(s) · generated {timezone.now():%Y-%m-%d %H:%M} UTC</div>"
        f"<h2>Agreements</h2><table><thead><tr><th>Agreement</th><th>For</th><th>Period</th>"
        f"<th class='n'>Availability</th><th class='n'>Target</th><th>State</th>"
        f"<th class='n'>Coverage</th><th class='n'>Budget left</th>"
        f"<th class='n'>Incidents</th>{'<th class=n>Credit</th>' if priced else ''}</tr></thead>"
        f"{trs or '<tr><td colspan=9 class=muted>None.</td></tr>'}</table>{total_html}"
        f"</body></html>"
    )
    return weasyprint.HTML(string=html).write_pdf()
