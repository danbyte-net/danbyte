"""Bulk edit and safe bulk delete on the certificate lists: certificates,
certificate requests and issuers. The dry run deletes nothing and says what
goes along, the delete logs each row, the edit takes only the fields the spec
names (never a key), another tenant's rows fall out, and each action needs its
own grant. Export of the selection never carries a key."""
from __future__ import annotations

import datetime as dt
import hashlib
import json
from unittest import mock

from django.contrib.auth.models import User
from django.utils import timezone
from rest_framework.test import APITestCase

from api.models import IPAddress, Prefix
from audit.models import ChangeAction, ChangeLogEntry
from auth_api.models import ObjectPermission, UserProfile
from core.models import Organization, Tenant
from monitoring.models import (
    AcmeOrder,
    Certificate,
    CertificateBinding,
    CertificateRequest,
    Issuer,
)

CERTS = "/api/monitoring/certificates/"
REQUESTS = "/api/monitoring/certificate-requests/"
ISSUERS = "/api/monitoring/issuers/"
KEY = "-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----"


class _Base(APITestCase):
    def setUp(self):
        org = Organization.objects.create(name="Acme", slug="acme")
        self.tenant = Tenant.objects.create(org=org, name="Acme", slug="acme")
        other_org = Organization.objects.create(name="Other", slug="other")
        self.other = Tenant.objects.create(org=other_org, name="Other", slug="other")
        self.login(User.objects.create_superuser("root", "r@a.c", "pw"))

    def login(self, user):
        self.client.force_login(user)
        s = self.client.session
        s["current_tenant_id"] = str(self.tenant.id)
        s.save()

    def member(self, slug, actions):
        user = User.objects.create_user("member", password="x")
        UserProfile.objects.create(user=user, role="custom").tenants.add(self.tenant)
        perm = ObjectPermission.objects.create(name="p", object_types=[slug],
                                               actions=list(actions))
        perm.users.add(user)
        perm.tenants.add(self.tenant)
        self.login(user)

    def delete(self, url, ids, dry_run=False):
        return self.client.post(f"{url}bulk-delete/",
                                {"ids": [str(i) for i in ids], "dry_run": dry_run},
                                format="json")

    def update(self, url, ids, fields):
        return self.client.post(f"{url}bulk-update/",
                                {"ids": [str(i) for i in ids], "fields": fields},
                                format="json")

    def export(self, slug, ids):
        r = self.client.post(f"/api/io/{slug}/export/",
                             {"fmt": "json", "ids": [str(i) for i in ids]}, format="json")
        self.assertEqual(r.status_code, 200)
        return json.loads(b"".join(r.streaming_content))

    def fields(self, url):
        r = self.client.get(f"{url}bulk-edit-fields/")
        self.assertEqual(r.status_code, 200, r.content)
        return [f["key"] for f in r.json()["fields"]]

    def logged(self, action, obj):
        return ChangeLogEntry.objects.filter(action=action, object_id=str(obj.pk)).exists()


def _cert(tenant, seed, cn):
    now = timezone.now()
    return Certificate.objects.create(
        tenant=tenant, fingerprint_sha256=hashlib.sha256(seed.encode()).hexdigest(),
        subject_cn=cn, not_before=now - dt.timedelta(days=1),
        not_after=now + dt.timedelta(days=90), uploaded=True,
    )


class CertificateBulkTests(_Base):
    def setUp(self):
        super().setUp()
        self.a = _cert(self.tenant, "a", "a.example.net")
        self.b = _cert(self.tenant, "b", "b.example.net")
        self.theirs = _cert(self.other, "c", "theirs.example.net")
        prefix = Prefix.objects.create(tenant=self.tenant, cidr="10.0.0.0/24")
        ip = IPAddress.objects.create(tenant=self.tenant, ip_address="10.0.0.5", prefix=prefix)
        now = timezone.now()
        CertificateBinding.objects.create(
            tenant=self.tenant, certificate=self.a, target_ip=ip, port=443,
            server_name="a.example.net", endpoint_key="k", chain_depth=0,
            chain_verified=True, first_seen=now, last_seen=now,
        )

    def test_dry_run_counts_the_bindings_and_deletes_nothing(self):
        r = self.delete(CERTS, [self.a.id, self.b.id], dry_run=True)
        self.assertEqual(r.status_code, 200, r.content)
        body = r.json()
        self.assertEqual(sorted(body["deleted_ids"]), sorted([str(self.a.id), str(self.b.id)]))
        self.assertEqual(body["impact"], [{"label": "certificate bindings", "count": 1}])
        self.assertEqual(Certificate.objects.filter(tenant=self.tenant).count(), 2)

    def test_delete_logs_each_row_and_leaves_other_tenants(self):
        r = self.delete(CERTS, [self.a.id, self.b.id, self.theirs.id])
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(r.json()["deleted"], 2)
        self.assertFalse(Certificate.objects.filter(tenant=self.tenant).exists())
        self.assertTrue(Certificate.objects.filter(pk=self.theirs.pk).exists())
        self.assertTrue(self.logged(ChangeAction.DELETE, self.a))

    def test_edit_offers_notes_and_writes_them(self):
        self.assertEqual(self.fields(CERTS), ["notes"])
        r = self.update(CERTS, [self.a.id, self.b.id, self.theirs.id], {"notes": "edge"})
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(r.json()["updated"], 2)
        self.a.refresh_from_db()
        self.theirs.refresh_from_db()
        self.assertEqual((self.a.notes, self.theirs.notes), ("edge", ""))
        self.assertTrue(self.logged(ChangeAction.UPDATE, self.a))

    def test_edit_refuses_key_material_and_facts(self):
        r = self.update(CERTS, [self.a.id], {"notes": KEY})
        self.assertEqual(r.status_code, 400, r.content)
        self.assertEqual(self.update(CERTS, [self.a.id], {"subject_cn": "x"}).status_code, 400)
        self.a.refresh_from_db()
        self.assertEqual((self.a.notes, self.a.subject_cn), ("", "a.example.net"))

    def test_each_action_needs_its_grant(self):
        self.member("certificate", ["view", "change"])
        self.assertEqual(self.delete(CERTS, [self.b.id]).status_code, 403)
        self.assertEqual(self.update(CERTS, [self.b.id], {"notes": "x"}).status_code, 200)
        self.client.logout()
        User.objects.filter(username="member").delete()
        self.member("certificate", ["view", "delete"])
        self.assertEqual(self.update(CERTS, [self.b.id], {"notes": "y"}).status_code, 403)
        self.assertEqual(self.delete(CERTS, [self.b.id]).status_code, 200)
        self.assertFalse(Certificate.objects.filter(pk=self.b.pk).exists())

    def test_export_of_the_selection(self):
        rows = self.export("certificate", [self.a.id, self.theirs.id])
        self.assertEqual([row["id"] for row in rows], [str(self.a.id)])


class CertificateRequestBulkTests(_Base):
    def setUp(self):
        super().setUp()
        self.a = CertificateRequest.objects.create(
            tenant=self.tenant, common_name="a.example.net", key_ref="csr/a",
            csr_pem="-----BEGIN CERTIFICATE REQUEST-----\nx\n-----END CERTIFICATE REQUEST-----",
        )
        self.b = CertificateRequest.objects.create(tenant=self.tenant, common_name="b")
        self.theirs = CertificateRequest.objects.create(tenant=self.other, common_name="c")

    def test_dry_run_deletes_nothing_and_touches_no_key(self):
        with mock.patch("monitoring.csr.delete_key") as delete_key:
            r = self.delete(REQUESTS, [self.a.id, self.b.id], dry_run=True)
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(r.json()["deleted"], 2)
        delete_key.assert_not_called()
        self.assertEqual(CertificateRequest.objects.filter(tenant=self.tenant).count(), 2)

    def test_delete_removes_each_stored_key_as_the_single_delete_does(self):
        with mock.patch("monitoring.csr.delete_key") as delete_key:
            r = self.delete(REQUESTS, [self.a.id, self.b.id, self.theirs.id])
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(r.json()["deleted"], 2)
        self.assertEqual(
            sorted(c.args[0].common_name for c in delete_key.call_args_list),
            ["a.example.net", "b"],
        )
        self.assertTrue(CertificateRequest.objects.filter(pk=self.theirs.pk).exists())
        self.assertTrue(self.logged(ChangeAction.DELETE, self.a))

    def test_edit_offers_notes_only(self):
        self.assertEqual(self.fields(REQUESTS), ["notes"])
        r = self.update(REQUESTS, [self.a.id, self.theirs.id], {"notes": "ticket 12"})
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(r.json()["updated"], 1)
        self.assertEqual(self.update(REQUESTS, [self.a.id], {"key_ref": "csr/b"}).status_code,
                         400)
        self.a.refresh_from_db()
        self.assertEqual((self.a.notes, self.a.key_ref), ("ticket 12", "csr/a"))

    def test_export_never_carries_the_key_reference(self):
        row = self.export("certificaterequest", [self.a.id])[0]
        self.assertNotIn("key_ref", row)
        self.assertEqual(row["common_name"], "a.example.net")

    def test_needs_the_delete_grant(self):
        self.member("certificaterequest", ["view", "change"])
        self.assertEqual(self.delete(REQUESTS, [self.b.id]).status_code, 403)


class IssuerBulkTests(_Base):
    def setUp(self):
        super().setUp()
        self.a = Issuer.objects.create(
            tenant=self.tenant, name="LE", directory_url="https://acme.example/dir",
            secrets={"eab_hmac": "s3cret"}, account_ref="issuer/a/account",
        )
        self.b = Issuer.objects.create(tenant=self.tenant, name="step",
                                       directory_url="https://step.example/dir")
        self.theirs = Issuer.objects.create(tenant=self.other, name="LE",
                                            directory_url="https://acme.example/dir")
        req = CertificateRequest.objects.create(tenant=self.tenant, common_name="x")
        AcmeOrder.objects.create(tenant=self.tenant, issuer=self.a, request=req)

    def test_dry_run_counts_the_orders(self):
        r = self.delete(ISSUERS, [self.a.id, self.b.id], dry_run=True)
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(r.json()["impact"], [{"label": "ACME orders", "count": 1}])
        self.assertEqual(Issuer.objects.filter(tenant=self.tenant).count(), 2)

    def test_delete_keeps_other_tenants(self):
        r = self.delete(ISSUERS, [self.b.id, self.theirs.id])
        self.assertEqual(r.json()["deleted"], 1)
        self.assertFalse(Issuer.objects.filter(pk=self.b.pk).exists())
        self.assertTrue(Issuer.objects.filter(pk=self.theirs.pk).exists())
        self.assertTrue(self.logged(ChangeAction.DELETE, self.b))

    def test_edit_writes_the_plain_settings_and_never_a_secret(self):
        self.assertEqual(self.fields(ISSUERS), ["enabled", "contact_email", "verify_tls"])
        r = self.update(ISSUERS, [self.a.id, self.b.id], {"enabled": False, "verify_tls": False})
        self.assertEqual(r.status_code, 200, r.content)
        self.a.refresh_from_db()
        self.assertEqual((self.a.enabled, self.a.verify_tls), (False, False))
        self.assertEqual(self.a.secrets, {"eab_hmac": "s3cret"})
        for key in ("eab_hmac", "tsig_secret", "directory_url"):
            self.assertEqual(self.update(ISSUERS, [self.a.id], {key: "x"}).status_code, 400)

    def test_export_carries_no_secret_or_account_key(self):
        row = self.export("issuer", [self.a.id])[0]
        self.assertNotIn("secrets", row)
        self.assertNotIn("account_ref", row)
        self.assertNotIn("s3cret", str(row))

    def test_view_only_may_not_edit(self):
        self.member("issuer", ["view"])
        self.assertEqual(self.update(ISSUERS, [self.a.id], {"enabled": False}).status_code, 403)
        self.assertEqual(self.client.get(f"{ISSUERS}bulk-edit-fields/").status_code, 403)
