"""The Django admin signs in through the app's sign-in, never its own form."""
from __future__ import annotations

from django.contrib.auth import get_user_model
from django.test import TestCase


class AdminLoginHandOffTests(TestCase):
    def setUp(self):
        User = get_user_model()
        self.admin = User.objects.create_superuser("root", "r@e.com", "pw-root-123")
        self.plain = User.objects.create_user("plain", "p@e.com", "pw-plain-123")

    def test_get_hands_off_to_the_app_sign_in(self):
        r = self.client.get("/admin/login/?next=/admin/auth/user/")
        self.assertEqual(r.status_code, 302)
        self.assertEqual(r["Location"], "/login?redirect=%2Fadmin%2Fauth%2Fuser%2F")

    def test_admin_pages_send_anonymous_users_to_the_app(self):
        r = self.client.get("/admin/", follow=True)
        self.assertEqual(r.redirect_chain[-1][0], "/login?redirect=%2Fadmin%2F")

    def test_a_password_post_signs_nobody_in(self):
        r = self.client.post(
            "/admin/login/", {"username": "root", "password": "pw-root-123"}
        )
        self.assertEqual(r.status_code, 302)
        self.assertTrue(r["Location"].startswith("/login?"))
        self.assertNotIn("_auth_user_id", self.client.session)

    def test_next_never_leaves_the_site(self):
        for bad in ("https://evil.example/", "//evil.example/", "/\\evil.example/"):
            r = self.client.get("/admin/login/", {"next": bad})
            self.assertEqual(r["Location"], "/login?redirect=%2Fadmin%2F", bad)

    def test_signed_in_staff_go_straight_on(self):
        self.client.force_login(self.admin)
        r = self.client.get("/admin/login/?next=/admin/auth/")
        self.assertEqual(r.status_code, 302)
        self.assertEqual(r["Location"], "/admin/auth/")

    def test_signed_in_non_staff_are_refused_not_looped(self):
        self.client.force_login(self.plain)
        r = self.client.get("/admin/login/?next=/admin/")
        self.assertEqual(r.status_code, 403)
