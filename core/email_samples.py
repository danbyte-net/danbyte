"""Sample renders of every Danbyte email — the "send a test of this template"
source.

The operator-facing goal is simple: *let me see what each email actually looks
like* without waiting for a real alert to fire or a digest to run. So each
builder here calls the **real** renderer (``monitoring.digest.render_html``,
``monitoring.cert_digest.render_html``, the alert HTML in ``monitoring.notify``,
the auth emails) with representative synthetic data. Previews therefore drift
with the templates automatically — there is no second copy of the layout to keep
in sync.

Nothing here touches the database: the sample data is built in-memory, so the
preview works on a brand-new install with no monitoring data yet.
"""
from __future__ import annotations

from datetime import timedelta
from types import SimpleNamespace

from django.utils import timezone

# key → human label; also the order shown in the settings UI.
TEMPLATES = [
    ("signin_code", "Sign-in code"),
    ("invite", "Invitation"),
    ("monitoring_digest", "Monitoring digest"),
    ("cert_digest", "Certificate digest"),
    ("alert", "Alert notification"),
    ("alert_group", "Grouped alerts"),
    ("status_change", "Status-change notice"),
]
TEMPLATE_KEYS = [k for k, _ in TEMPLATES]


def _name() -> str:
    from core.models import DeploymentSettings

    return DeploymentSettings.load().deployment_name or "Danbyte"


def _fake_ip(addr, dns=""):
    return SimpleNamespace(ip_address=addr, dns_name=dns, prefix_id=None, prefix=None)


def _fake_alert(**kw):
    base = dict(
        severity="critical", check_status="down", kind="tls_cert",
        template_id=None, template=None, opened_at=timezone.now(),
        target_ip=_fake_ip("203.0.113.10", "web01.example.net"), detail={},
    )
    base.update(kw)
    return SimpleNamespace(**base)


def _sample_digest_data():
    now = timezone.now()
    since = now - timedelta(days=7)
    tenant = SimpleNamespace(name="Example Tenant")
    return {
        "tenant": tenant,
        "since": since,
        "now": now,
        "by_status": {"up": 128, "down": 3, "degraded": 2, "unknown": 1},
        "total": 134,
        "reachable_pct": 96,
        "down": 4,
        "by_severity": {"critical": 2, "warning": 3},
        "firing_total": 5,
        "top_alerts": [
            _fake_alert(severity="critical",
                        target_ip=_fake_ip("203.0.113.10"),
                        template=SimpleNamespace(name="HTTPS")),
            _fake_alert(severity="warning", check_status="degraded",
                        target_ip=_fake_ip("203.0.113.22"),
                        template=SimpleNamespace(name="ICMP")),
        ],
        "transitions": [],
        "went_down": 3,
        "came_up": 5,
        "went_stale": 1,
        "chains": [
            ("203.0.113.0/24", [
                {"label": "203.0.113.10 (web01)", "segments": [
                    {"status": "up", "at": None},
                    {"status": "down", "at": now - timedelta(hours=6)},
                    {"status": "up", "at": now - timedelta(hours=2)},
                ]},
            ]),
        ],
        "changes": 12,
        "certs": _sample_cert_summary(),
    }


def _sample_cert_summary():
    now = timezone.now()
    return {
        "expired": 1,
        "expiring_critical": 1,
        "expiring_warning": 2,
        "declared_expiring": 1,
        "changes": 1,
        "buckets": {
            "expired": [{
                "endpoint": "web01.example.net:443", "subject_cn": "example.net",
                "fingerprint": "ab" * 16, "not_after": now - timedelta(days=2),
                "days": -2.0,
            }],
            "expiring_critical": [{
                "endpoint": "api.example.net:443", "subject_cn": "api.example.net",
                "fingerprint": "cd" * 16, "not_after": now + timedelta(days=4),
                "days": 4.0,
            }],
            "expiring_warning": [
                {"endpoint": "vpn.example.net:443", "subject_cn": "vpn.example.net",
                 "fingerprint": "ef" * 16, "not_after": now + timedelta(days=21),
                 "days": 21.0},
                {"endpoint": "mail.example.net:993", "subject_cn": "mail.example.net",
                 "fingerprint": "12" * 16, "not_after": now + timedelta(days=28),
                 "days": 28.0},
            ],
        },
        "declared": [{
            "subject_cn": "internal-ca.example.net", "fingerprint": "34" * 16,
            "not_after": now + timedelta(days=6), "days": 6.0,
            "object_type": "api.device",
        }],
        "recent_changes": [{
            "endpoint": "web01.example.net:443", "subject_cn": "example.net",
            "fingerprint": "ab" * 16, "at": now - timedelta(days=1),
        }],
        "since": now - timedelta(days=7),
        "now": now,
    }


def render_sample(key: str) -> tuple[str, str, str]:
    """Return ``(subject, html_body, text_body)`` for one template key."""
    name = _name()
    if key == "signin_code":
        from core import email as ek

        code = "482913"
        html = ek.render_layout(
            "Your sign-in code",
            ek.paragraph("Enter this code to finish signing in:")
            + ek.code_line(code)
            + ek.muted("It expires in 10 minutes. If you didn't try to sign in, "
                       "you can safely ignore this email."),
            deployment_name=name, kicker="Sign-in",
            preheader=f"Your {name} verification code",
        )
        return (f"{name} sign-in code: {code}", html,
                f"Your {name} verification code is {code}.\n")

    if key == "invite":
        from core import email as ek

        url = "https://danbyte.example.net/set-password?uid=SAMPLE&token=SAMPLE"
        html = ek.render_layout(
            f"You've been invited to {name}",
            ek.paragraph(f"An administrator created a {name} account for you "
                         f"(jordan). Choose a password to activate it.")
            + ek.email_button(url, "Choose your password")
            + ek.muted("If you weren't expecting this, you can ignore this email."),
            deployment_name=name, kicker="Invitation",
            preheader=f"Activate your {name} account",
        )
        return (f"You've been invited to {name}", html,
                f"Choose your password to activate it:\n{url}\n")

    if key == "monitoring_digest":
        from monitoring.digest import render_html, render_text

        data = _sample_digest_data()
        return (f"{name} monitoring digest — {data['tenant'].name}",
                render_html(data, name), render_text(data))

    if key == "cert_digest":
        from monitoring.cert_digest import render_html, render_text

        summary = _sample_cert_summary()
        return (f"{name} certificate digest — Example Tenant",
                render_html(summary, "Example Tenant", name),
                render_text(summary, "Example Tenant"))

    if key == "alert":
        from monitoring import notify

        alert = _fake_alert(detail={
            "cert_state": "expiring_critical", "subject_cn": "api.example.net",
            "not_after": (timezone.now() + timedelta(days=4)).isoformat(),
            "days_until_expiry": 4, "fingerprint_sha256": "cd" * 32,
        })
        ip = alert.target_ip.ip_address
        url = "https://danbyte.example.net/alerts"
        subject = notify._alert_summary(alert, "firing", ip)
        return (subject, notify._alert_email_html(alert, "firing", ip, url),
                subject + "\n" + url + "\n")

    if key == "alert_group":
        from monitoring import notify

        alerts = [
            _fake_alert(target_ip=_fake_ip("203.0.113.10"), severity="critical"),
            _fake_alert(target_ip=_fake_ip("203.0.113.22"), severity="warning",
                        check_status="degraded", kind="icmp", detail={}),
            _fake_alert(target_ip=_fake_ip("203.0.113.31"), severity="warning",
                        check_status="down", kind="http", detail={}),
        ]
        url = "https://danbyte.example.net/alerts"
        subject = notify._group_summary(alerts, "firing")
        return (subject, notify._alert_group_email_html(alerts, "firing", url),
                subject + "\n" + url + "\n")

    if key == "status_change":
        from core import email as ek

        events = [
            {"target_ip": "203.0.113.10", "template": "HTTPS", "kind": "tls_cert",
             "from_status": "up", "to_status": "down"},
            {"target_ip": "203.0.113.22", "template": "ICMP", "kind": "icmp",
             "from_status": "down", "to_status": "up"},
        ]
        rows = [
            [ek.escape(e["target_ip"]), ek.escape(e["template"]),
             ek.pill(e["from_status"], e["from_status"]) + " &rarr; "
             + ek.pill(e["to_status"], e["to_status"])]
            for e in events
        ]
        html = ek.render_layout(
            f"{len(events)} status change(s)",
            ek.lead("The following monitored targets changed status.")
            + ek.data_table(["Target", "Check", "Change"], rows),
            deployment_name=name, kicker="Monitoring",
            preheader=f"{len(events)} status change(s)",
        )
        return (f"{name} — {len(events)} monitoring status change(s)", html,
                "2 monitoring status change(s)\n")

    raise ValueError(f"unknown email template: {key}")
