"""Admin-set passwords meet AUTH_PASSWORD_VALIDATORS (#489).

The set-password link always validated; the Users API, the legacy user form,
``bootstrap``'s env superuser and the Django admin must refuse the same
passwords.
"""
from __future__ import annotations

import json
import os
from io import StringIO
from unittest.mock import patch

from django.contrib import admin
from django.contrib.auth.models import User
from django.core.management import CommandError, call_command
from django.test import Client, TestCase

from auth_api.models import UserProfile

STRONG = "Str0ngPazz99"


class UsersApiPasswordTests(TestCase):
    def setUp(self):
        self.admin = User.objects.create_user("admin1", password=STRONG, is_superuser=True)
        UserProfile.objects.create(user=self.admin)
        self.api = Client()
        self.api.force_login(self.admin)

    def _post(self, body):
        return self.api.post(
            "/api/users/", data=json.dumps(body), content_type="application/json"
        )

    def _patch(self, user, body):
        return self.api.patch(
            f"/api/users/{user.id}/", data=json.dumps(body), content_type="application/json"
        )

    def test_create_refuses_weak_passwords(self):
        for pw in ("1", "password", "12345678901"):
            r = self._post({"username": "bob", "password": pw})
            self.assertEqual(r.status_code, 400, pw)
            self.assertIn("password", r.json())
        self.assertFalse(User.objects.filter(username="bob").exists())

    def test_create_refuses_password_like_the_username(self):
        r = self._post({"username": "marjoriesimpson", "password": "marjoriesimpson1"})
        self.assertEqual(r.status_code, 400, r.content)
        self.assertIn("password", r.json())

    def test_create_accepts_a_strong_password(self):
        r = self._post({"username": "bob", "password": STRONG})
        self.assertEqual(r.status_code, 201, r.content)
        self.assertTrue(User.objects.get(username="bob").check_password(STRONG))

    def test_update_refuses_weak_password_and_keeps_the_old_one(self):
        user = User.objects.create_user("carol", password=STRONG)
        r = self._patch(user, {"password": "1"})
        self.assertEqual(r.status_code, 400, r.content)
        self.assertIn("password", r.json())
        user.refresh_from_db()
        self.assertTrue(user.check_password(STRONG))

    def test_update_checks_similarity_against_the_new_name(self):
        user = User.objects.create_user("dave", password=STRONG)
        r = self._patch(user, {"first_name": "Bartholomew", "password": "Bartholomew"})
        self.assertEqual(r.status_code, 400, r.content)

    def test_update_without_password_still_works(self):
        user = User.objects.create_user("erin", password=STRONG)
        r = self._patch(user, {"first_name": "Erin", "password": ""})
        self.assertEqual(r.status_code, 200, r.content)
        user.refresh_from_db()
        self.assertTrue(user.check_password(STRONG))

    def test_update_accepts_a_strong_password(self):
        user = User.objects.create_user("frank", password=STRONG)
        r = self._patch(user, {"password": "An0ther-Good-One"})
        self.assertEqual(r.status_code, 200, r.content)
        user.refresh_from_db()
        self.assertTrue(user.check_password("An0ther-Good-One"))

    def test_bulk_update_cannot_set_a_password(self):
        user = User.objects.create_user("gina", password=STRONG)
        r = self.api.post(
            "/api/users/bulk-update/",
            data=json.dumps({"ids": [user.id], "fields": {"password": "1"}}),
            content_type="application/json",
        )
        self.assertEqual(r.status_code, 400, r.content)
        user.refresh_from_db()
        self.assertTrue(user.check_password(STRONG))


class UserFormPasswordTests(TestCase):
    def _form(self, password, instance=None):
        from auth_api.forms import UserForm

        return UserForm(
            data={"username": "hank", "password": password, "role": "reader",
                  "is_active": True},
            instance=instance,
        )

    def test_form_refuses_a_weak_password(self):
        form = self._form("password")
        self.assertFalse(form.is_valid())
        self.assertIn("password", form.errors)

    def test_form_accepts_a_strong_password(self):
        form = self._form(STRONG)
        self.assertTrue(form.is_valid(), form.errors)


class BootstrapSuperuserPasswordTests(TestCase):
    def _run(self, password):
        env = {"DJANGO_SUPERUSER_USERNAME": "root1", "DJANGO_SUPERUSER_PASSWORD": password}
        with patch.dict(os.environ, env):
            call_command("bootstrap", stdout=StringIO())

    def test_weak_env_password_is_refused(self):
        with self.assertRaises(CommandError):
            self._run("password")
        self.assertFalse(User.objects.filter(username="root1").exists())

    def test_strong_env_password_creates_the_superuser(self):
        self._run(STRONG)
        self.assertTrue(User.objects.get(username="root1").is_superuser)


class DjangoAdminPasswordTests(TestCase):
    """The admin's User forms are Django's own, which already validate; this
    pins that they stay registered that way."""

    def test_admin_add_form_refuses_a_weak_password(self):
        model_admin = admin.site._registry[User]
        form = model_admin.add_form(
            data={"username": "ivan", "password1": "password", "password2": "password",
                  "usable_password": "true"}
        )
        self.assertFalse(form.is_valid())
        self.assertIn("password2", form.errors)

    def test_admin_change_password_form_refuses_a_weak_password(self):
        user = User.objects.create_user("judy", password=STRONG)
        model_admin = admin.site._registry[User]
        form = model_admin.change_password_form(
            user, data={"password1": "1", "password2": "1", "usable_password": "true"}
        )
        self.assertFalse(form.is_valid())
