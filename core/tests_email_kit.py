"""The email kit's identity (#email): one ink, one red, the logo inline."""
from __future__ import annotations

from django.core import mail
from django.test import TestCase, override_settings

from core import email as ek


class EmailKitTests(TestCase):
    def test_trouble_is_red_and_the_rest_is_ink(self):
        red = ek.PALETTE["critical"]
        self.assertIn(red, ek.pill("Down", "down"))
        self.assertIn(red, ek.pill("Expired", "expired"))
        self.assertIn(red, ek.pill("4d left", "expiring_critical"))
        for kind in ("up", "warning", "degraded", "info", "expiring_warning"):
            self.assertNotIn(red, ek.pill("x", kind), kind)
        self.assertEqual(ek.STATUS_BG["warning"], ek.PALETTE["ink"])
        self.assertEqual(ek.STATUS_BG["down"], red)
        # No coloured fills anywhere in the kit.
        for html in (ek.callout("x", "critical"), ek.email_button("https://x", "Go"),
                     ek.stat_grid([(1, "a", red)]), ek.progress_bar(42, "r")):
            for tint in ("#e8f8f1", "#fdf3e3", "#e7f1fb", "#2563c9", "#059669", "#d97706"):
                self.assertNotIn(tint, html)

    def test_layout_heads_with_the_logo_and_a_kicker(self):
        html = ek.render_layout("Hello", "<p>x</p>", kicker="Monitoring digest",
                                deployment_name="Acme")
        self.assertIn('src="cid:logo"', html)
        self.assertIn('alt="Acme"', html)
        self.assertIn("Monitoring digest", html)
        self.assertIn("Sent by", html)
        preview = ek.inline_logo_for_preview(html)
        self.assertNotIn("cid:logo", preview)
        self.assertIn("data:image/png;base64,", preview)

    @override_settings(EMAIL_BACKEND="django.core.mail.backends.locmem.EmailBackend")
    def test_the_logo_rides_along_as_an_inline_part(self):
        html = ek.render_layout("Hello", "<p>x</p>")
        self.assertTrue(ek.send_html_email("s", ["a@example.net"], html_body=html,
                                           text_body="x", fail_silently=False))
        msg = mail.outbox[-1].message()
        self.assertEqual(msg.get_content_subtype(), "related")
        parts = [p for p in msg.walk() if p.get("Content-ID") == "<logo>"]
        self.assertEqual(len(parts), 1)
        self.assertEqual(parts[0].get_content_type(), "image/png")
