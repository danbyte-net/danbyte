"""SSO — SAML 2.0 service provider (SP).

Pure-Python: builds the AuthnRequest (HTTP-Redirect binding), and validates the
IdP's signed Response (HTTP-POST binding) with :mod:`signxml` (which rides
``lxml`` + ``cryptography`` — no ``xmlsec1`` system dependency, so it drops
straight into the offline wheel bundle). The extracted NameID + attributes are
turned into the same claims dict the OIDC path produces, then handed to the
shared :func:`auth_api.sso.resolve_user` for provisioning.

Signature handling is XSW-safe: we verify the whole document and then read
**only** the verified subtree returned by signxml — never the raw parse.
"""
from __future__ import annotations

import base64
import secrets as pysecrets
import zlib
from datetime import UTC, datetime, timedelta
from urllib.parse import urlencode

from lxml import etree

NS = {
    "samlp": "urn:oasis:names:tc:SAML:2.0:protocol",
    "saml": "urn:oasis:names:tc:SAML:2.0:assertion",
    "ds": "http://www.w3.org/2000/09/xmldsig#",
}
# Clock skew we tolerate on Conditions / SubjectConfirmation time bounds.
SKEW = timedelta(minutes=3)


class SamlError(RuntimeError):
    """A SAML login could not be completed (config or validation failure)."""


def _now():
    return datetime.now(UTC)


def _parser():
    # No network, no DTD, no entity expansion — closes XXE / billion-laughs.
    return etree.XMLParser(
        resolve_entities=False, no_network=True, dtd_validation=False,
        load_dtd=False, huge_tree=False,
    )


# ── SP metadata + AuthnRequest ───────────────────────────────────────────────

def sp_entity_id(base_url: str, slug: str) -> str:
    return f"{base_url}/api/auth/sso/{slug}/metadata/"


def sp_metadata_xml(provider, base_url: str, acs_url: str) -> bytes:
    entity = sp_entity_id(base_url, provider.slug)
    md = etree.Element(
        "{urn:oasis:names:tc:SAML:2.0:metadata}EntityDescriptor",
        nsmap={"md": "urn:oasis:names:tc:SAML:2.0:metadata"},
        entityID=entity,
    )
    spsso = etree.SubElement(
        md, "{urn:oasis:names:tc:SAML:2.0:metadata}SPSSODescriptor",
        protocolSupportEnumeration="urn:oasis:names:tc:SAML:2.0:protocol",
        AuthnRequestsSigned="false", WantAssertionsSigned="true",
    )
    etree.SubElement(
        spsso, "{urn:oasis:names:tc:SAML:2.0:metadata}AssertionConsumerService",
        Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST",
        Location=acs_url, index="0", isDefault="true",
    )
    return etree.tostring(md, xml_declaration=True, encoding="UTF-8")


def build_authn_request_redirect(provider, acs_url, base_url, relay_state) -> tuple[str, str]:
    """Return ``(redirect_url, request_id)``. The AuthnRequest is deflated,
    base64'd, and query-encoded per the HTTP-Redirect binding; ``request_id`` is
    stashed in the session so the response's InResponseTo can be checked."""
    if not provider.saml_idp_sso_url:
        raise SamlError("This SAML provider has no IdP SSO URL configured.")
    request_id = "_" + pysecrets.token_hex(20)
    issue_instant = _now().strftime("%Y-%m-%dT%H:%M:%SZ")
    req = etree.Element(
        "{urn:oasis:names:tc:SAML:2.0:protocol}AuthnRequest", nsmap=NS,
        ID=request_id, Version="2.0", IssueInstant=issue_instant,
        Destination=provider.saml_idp_sso_url,
        AssertionConsumerServiceURL=acs_url,
        ProtocolBinding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST",
    )
    issuer = etree.SubElement(req, "{urn:oasis:names:tc:SAML:2.0:assertion}Issuer")
    issuer.text = sp_entity_id(base_url, provider.slug)
    xml = etree.tostring(req)
    # HTTP-Redirect binding: raw DEFLATE (no zlib header) → base64 → urlencode.
    deflated = zlib.compress(xml)[2:-4]
    params = {"SAMLRequest": base64.b64encode(deflated).decode()}
    if relay_state:
        params["RelayState"] = relay_state
    sep = "&" if "?" in provider.saml_idp_sso_url else "?"
    return f"{provider.saml_idp_sso_url}{sep}{urlencode(params)}", request_id


# ── Response validation ──────────────────────────────────────────────────────

def parse_and_validate(provider, saml_response_b64, acs_url, base_url, request_id):
    """Verify the signed SAML Response and return a claims dict, or raise
    :class:`SamlError`. Reads only the signxml-verified subtree."""
    from signxml import XMLVerifier

    if not provider.saml_idp_x509:
        raise SamlError("This SAML provider has no IdP certificate configured.")
    try:
        raw = base64.b64decode(saml_response_b64)
        doc = etree.fromstring(raw, parser=_parser())
    except Exception as exc:  # noqa: BLE001
        raise SamlError(f"Malformed SAML response: {exc}") from exc

    cert = _normalise_cert(provider.saml_idp_x509)
    try:
        verified = XMLVerifier().verify(doc, x509_cert=cert).signed_xml
    except Exception as exc:  # noqa: BLE001 — any verify failure is a hard no
        raise SamlError(f"SAML signature verification failed: {exc}") from exc
    if verified is None:
        raise SamlError("SAML response was not signed.")

    # The signature may cover the Response or just the Assertion; find the
    # Assertion inside the *verified* element (never the raw doc).
    if verified.tag.endswith("}Assertion"):
        assertion = verified
    else:
        assertion = verified.find(".//saml:Assertion", NS)
    if assertion is None:
        raise SamlError("No signed assertion in the SAML response.")

    _check_issuer(assertion, provider)
    _check_conditions(assertion, provider, base_url)
    _check_subject(assertion, acs_url, request_id)
    return _claims_from_assertion(assertion)


def _normalise_cert(pem_or_b64: str) -> str:
    s = pem_or_b64.strip()
    if "BEGIN CERTIFICATE" in s:
        return s
    body = "".join(s.split())
    lines = "\n".join(body[i:i + 64] for i in range(0, len(body), 64))
    return f"-----BEGIN CERTIFICATE-----\n{lines}\n-----END CERTIFICATE-----\n"


def _check_issuer(assertion, provider) -> None:
    if not provider.saml_idp_entity_id:
        return
    issuer = assertion.findtext("saml:Issuer", namespaces=NS)
    if issuer and issuer.strip() != provider.saml_idp_entity_id.strip():
        raise SamlError("SAML issuer mismatch.")


def _parse_dt(value):
    if not value:
        return None
    v = value.strip().replace("Z", "+00:00")
    try:
        return datetime.fromisoformat(v)
    except ValueError:
        return None


def _check_conditions(assertion, provider, base_url) -> None:
    cond = assertion.find("saml:Conditions", NS)
    if cond is None:
        return
    now = _now()
    nb = _parse_dt(cond.get("NotBefore"))
    na = _parse_dt(cond.get("NotOnOrAfter"))
    if nb and now + SKEW < nb:
        raise SamlError("SAML assertion not yet valid.")
    if na and now - SKEW >= na:
        raise SamlError("SAML assertion has expired.")
    # Audience must be our SP entity id.
    audiences = [a.text.strip() for a in cond.findall(".//saml:Audience", NS) if a.text]
    if audiences:
        want = sp_entity_id(base_url, provider.slug)
        if want not in audiences:
            raise SamlError("SAML audience mismatch.")


def _check_subject(assertion, acs_url, request_id) -> None:
    scd = assertion.find(".//saml:SubjectConfirmationData", NS)
    if scd is None:
        return
    na = _parse_dt(scd.get("NotOnOrAfter"))
    if na and _now() - SKEW >= na:
        raise SamlError("SAML subject confirmation has expired.")
    recipient = (scd.get("Recipient") or "").strip()
    if recipient and recipient != acs_url:
        raise SamlError("SAML recipient mismatch.")
    in_response_to = (scd.get("InResponseTo") or "").strip()
    if request_id and in_response_to and in_response_to != request_id:
        raise SamlError("SAML InResponseTo mismatch — possible replay.")


def _claims_from_assertion(assertion) -> dict:
    """NameID + attribute statements → a flat claims dict. Attributes are keyed
    by both their full Name and (for convenience) the trailing path segment, so a
    provider can map on either. Multi-value attributes become lists."""
    claims: dict = {}
    name_id = assertion.findtext(".//saml:Subject/saml:NameID", namespaces=NS)
    if name_id:
        claims["nameid"] = name_id.strip()
    for attr in assertion.findall(".//saml:AttributeStatement/saml:Attribute", NS):
        name = attr.get("Name") or attr.get("FriendlyName")
        if not name:
            continue
        values = [
            v.text.strip()
            for v in attr.findall("saml:AttributeValue", NS)
            if v.text and v.text.strip()
        ]
        if not values:
            continue
        value = values if len(values) > 1 else values[0]
        claims[name] = value
        # Entra/ADFS use long URI names; expose the last segment too.
        tail = name.rsplit("/", 1)[-1]
        claims.setdefault(tail, value)
    return claims
