"""SAML SP — sign→verify roundtrip + provisioning, with no live IdP.

We mint a throwaway self-signed cert, build a SAML Response + Assertion, sign it
with signxml (as an IdP would), then run it through the SP's
``parse_and_validate`` — proving signature verification, the condition/subject
checks, claim extraction, and (via resolve_user) JIT provisioning all hold. A
tampered assertion must be rejected.
"""
from __future__ import annotations

import base64
from datetime import UTC, datetime, timedelta, timezone

from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from cryptography.x509.oid import NameOID
from django.contrib.auth.models import Group
from django.test import TestCase
from lxml import etree

from core.models import Organization, Tenant

from .models import IdentityProvider, SsoGroupMapping
from .saml import NS, SamlError, parse_and_validate
from .sso import resolve_user

BASE = "https://danbyte.example"
SLUG = "adfs"
ACS = f"{BASE}/api/auth/sso/{SLUG}/acs/"
SP_ENTITY = f"{BASE}/api/auth/sso/{SLUG}/metadata/"
IDP_ENTITY = "https://idp.example/entity"


def _self_signed():
    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, "test-idp")])
    cert = (
        x509.CertificateBuilder()
        .subject_name(name).issuer_name(name)
        .public_key(key.public_key())
        .serial_number(x509.random_serial_number())
        .not_valid_before(datetime.now(UTC) - timedelta(days=1))
        .not_valid_after(datetime.now(UTC) + timedelta(days=1))
        .sign(key, hashes.SHA256())
    )
    key_pem = key.private_bytes(
        serialization.Encoding.PEM,
        serialization.PrivateFormat.TraditionalOpenSSL,
        serialization.NoEncryption(),
    )
    cert_pem = cert.public_bytes(serialization.Encoding.PEM)
    return key_pem, cert_pem


def _signed_response(key_pem, cert_pem, *, email="alice@example.com",
                     groups=("NetAdmins",), request_id="_req123"):
    from signxml import XMLSigner

    now = datetime.now(UTC)
    fmt = "%Y-%m-%dT%H:%M:%SZ"
    later = (now + timedelta(minutes=5)).strftime(fmt)
    now_s = now.strftime(fmt)
    resp = etree.Element(f"{{{NS['samlp']}}}Response", nsmap=NS, ID="_resp1", Version="2.0", IssueInstant=now_s)
    status = etree.SubElement(resp, f"{{{NS['samlp']}}}Status")
    etree.SubElement(status, f"{{{NS['samlp']}}}StatusCode",
                     Value="urn:oasis:names:tc:SAML:2.0:status:Success")
    a = etree.SubElement(resp, f"{{{NS['saml']}}}Assertion", ID="_assert1", Version="2.0", IssueInstant=now_s)
    issuer = etree.SubElement(a, f"{{{NS['saml']}}}Issuer")
    issuer.text = IDP_ENTITY
    subj = etree.SubElement(a, f"{{{NS['saml']}}}Subject")
    nameid = etree.SubElement(subj, f"{{{NS['saml']}}}NameID")
    nameid.text = email
    sc = etree.SubElement(subj, f"{{{NS['saml']}}}SubjectConfirmation",
                          Method="urn:oasis:names:tc:SAML:2.0:cm:bearer")
    etree.SubElement(sc, f"{{{NS['saml']}}}SubjectConfirmationData",
                     Recipient=ACS, NotOnOrAfter=later, InResponseTo=request_id)
    cond = etree.SubElement(a, f"{{{NS['saml']}}}Conditions", NotBefore=now_s, NotOnOrAfter=later)
    ar = etree.SubElement(cond, f"{{{NS['saml']}}}AudienceRestriction")
    aud = etree.SubElement(ar, f"{{{NS['saml']}}}Audience")
    aud.text = SP_ENTITY
    stmt = etree.SubElement(a, f"{{{NS['saml']}}}AttributeStatement")
    ea = etree.SubElement(stmt, f"{{{NS['saml']}}}Attribute", Name="email")
    ev = etree.SubElement(ea, f"{{{NS['saml']}}}AttributeValue")
    ev.text = email
    ga = etree.SubElement(stmt, f"{{{NS['saml']}}}Attribute", Name="groups")
    for g in groups:
        gv = etree.SubElement(ga, f"{{{NS['saml']}}}AttributeValue")
        gv.text = g
    # Sign the Assertion (enveloped), as IdPs commonly do.
    signed = XMLSigner().sign(a, key=key_pem, cert=cert_pem)
    resp.replace(a, signed)
    return base64.b64encode(etree.tostring(resp)).decode()


class SamlRoundtripTests(TestCase):
    def setUp(self):
        self.key_pem, self.cert_pem = _self_signed()
        org = Organization.objects.create(name="O", slug="o")
        self.tenant = Tenant.objects.create(org=org, name="One", slug="one")
        self.provider = IdentityProvider.objects.create(
            name="ADFS", slug=SLUG, protocol="saml", enabled=True,
            saml_idp_entity_id=IDP_ENTITY,
            saml_idp_sso_url="https://idp.example/sso",
            saml_idp_x509=self.cert_pem.decode(),
            claim_email="email", claim_username="email", claim_groups="groups",
            jit_provisioning=True, default_tenant=self.tenant,
        )
        self.group = Group.objects.create(name="Net Admins")
        SsoGroupMapping.objects.create(
            provider=self.provider, idp_group="NetAdmins", group=self.group
        )

    def test_valid_signed_response_yields_claims_and_provisions(self):
        resp = _signed_response(self.key_pem, self.cert_pem)
        claims = parse_and_validate(self.provider, resp, ACS, BASE, "_req123")
        self.assertEqual(claims["email"], "alice@example.com")
        self.assertEqual(claims["groups"], "NetAdmins")
        user = resolve_user(self.provider, claims)
        self.assertEqual(user.email, "alice@example.com")
        self.assertIn(self.group, user.groups.all())

    def test_wrong_cert_is_rejected(self):
        other_key, other_cert = _self_signed()
        resp = _signed_response(other_key, other_cert)
        with self.assertRaises(SamlError):
            parse_and_validate(self.provider, resp, ACS, BASE, "_req123")

    def test_audience_mismatch_is_rejected(self):
        resp = _signed_response(self.key_pem, self.cert_pem)
        with self.assertRaises(SamlError):
            parse_and_validate(
                self.provider, resp, ACS, "https://evil.example", "_req123"
            )

    def test_inresponseto_mismatch_is_rejected(self):
        resp = _signed_response(self.key_pem, self.cert_pem, request_id="_other")
        with self.assertRaises(SamlError):
            parse_and_validate(self.provider, resp, ACS, BASE, "_req123")
