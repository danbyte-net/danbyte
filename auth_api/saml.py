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
import time
import zlib
from datetime import UTC, datetime, timedelta
from urllib.parse import urlencode

import requests
from lxml import etree

NS = {
    "samlp": "urn:oasis:names:tc:SAML:2.0:protocol",
    "saml": "urn:oasis:names:tc:SAML:2.0:assertion",
    "ds": "http://www.w3.org/2000/09/xmldsig#",
    "md": "urn:oasis:names:tc:SAML:2.0:metadata",
}
# Clock skew we tolerate on Conditions / SubjectConfirmation time bounds.
SKEW = timedelta(minutes=3)
HTTP_TIMEOUT = 10
_METADATA_TTL = 3600  # cache fetched IdP metadata for an hour
_metadata_cache: dict[str, tuple[float, dict]] = {}
_REDIRECT_BINDING = "urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect"


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

def parse_and_validate(provider, saml_response_b64, acs_url, base_url, *,
                       consume_request_id):
    """Verify the signed SAML Response and return a claims dict, or raise
    :class:`SamlError`. Reads only the signxml-verified subtree.

    ``consume_request_id`` is a callable ``(in_response_to: str) -> None`` that
    must raise :class:`SamlError` unless the value names an AuthnRequest we
    issued and have not already consumed. This is what makes the response
    *solicited* and *single-use* (replay protection); it also means unsolicited
    IdP-initiated responses (no ``InResponseTo``) are rejected."""
    from signxml import XMLVerifier

    certs = _trusted_certs(provider)
    if not certs:
        raise SamlError("This SAML provider has no IdP certificate configured.")
    try:
        raw = base64.b64decode(saml_response_b64)
        doc = etree.fromstring(raw, parser=_parser())
    except Exception as exc:  # noqa: BLE001
        raise SamlError(f"Malformed SAML response: {exc}") from exc

    # Try each trusted cert (metadata may list current + next signing certs, and
    # an operator may also have pasted one). Accept the first that verifies.
    verified = None
    last_exc = None
    for cert in certs:
        try:
            verified = XMLVerifier().verify(doc, x509_cert=cert).signed_xml
            break
        except Exception as exc:  # noqa: BLE001 — try the next trusted cert
            last_exc = exc
    if verified is None:
        raise SamlError(f"SAML signature verification failed: {last_exc}")

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
    in_response_to = _check_subject(assertion, acs_url)
    consume_request_id(in_response_to)
    return _claims_from_assertion(assertion)


def _normalise_cert(pem_or_b64: str) -> str:
    s = pem_or_b64.strip()
    if "BEGIN CERTIFICATE" in s:
        return s
    body = "".join(s.split())
    lines = "\n".join(body[i:i + 64] for i in range(0, len(body), 64))
    return f"-----BEGIN CERTIFICATE-----\n{lines}\n-----END CERTIFICATE-----\n"


def _split_certs(field: str) -> list[str]:
    """The x509 field may hold one or more concatenated PEM blocks (or a single
    bare base64 blob). Return a list of normalised PEM strings."""
    s = (field or "").strip()
    if not s:
        return []
    if "BEGIN CERTIFICATE" not in s:
        return [_normalise_cert(s)]
    out = []
    marker = "-----END CERTIFICATE-----"
    for chunk in s.split(marker):
        if "BEGIN CERTIFICATE" in chunk:
            out.append((chunk + marker).strip() + "\n")
    return out


def _trusted_certs(provider) -> list[str]:
    """Every signing cert we'll accept for this provider: the ones published in
    the IdP metadata (if a metadata URL is set — kept fresh so cert rotation just
    works) plus any manually pasted into the x509 field. De-duplicated."""
    certs: list[str] = []
    url = getattr(provider, "saml_idp_metadata_url", "") or ""
    if url:
        try:
            certs.extend(fetch_idp_metadata(url).get("certs", []))
        except SamlError:
            pass  # fall back to whatever is pasted; login still works offline
    certs.extend(_split_certs(provider.saml_idp_x509))
    seen, unique = set(), []
    for c in certs:
        key = "".join(c.split())
        if key and key not in seen:
            seen.add(key)
            unique.append(c)
    return unique


def fetch_idp_metadata(url: str, *, use_cache: bool = True) -> dict:
    """Fetch and parse a SAML 2.0 IdP metadata document. Returns
    ``{"entity_id", "sso_url", "certs": [pem, ...]}``. Cached for an hour.

    Reached directly with TLS verification — the metadata URL is operator-set
    (same trust tier as the OIDC issuer / LDAP / Vault address), not
    attacker-controlled, so it does not go through the tenant SSRF guard."""
    url = (url or "").strip()
    if not url:
        raise SamlError("No IdP metadata URL configured.")
    now = time.time()
    hit = _metadata_cache.get(url)
    if use_cache and hit and hit[0] > now:
        return hit[1]
    try:
        r = requests.get(url, timeout=HTTP_TIMEOUT)
        r.raise_for_status()
    except requests.RequestException as exc:
        raise SamlError(f"Could not fetch IdP metadata: {exc}") from exc
    try:
        md = etree.fromstring(r.content, parser=_parser())
    except Exception as exc:  # noqa: BLE001
        raise SamlError(f"Malformed IdP metadata: {exc}") from exc

    idp = md.find(".//md:IDPSSODescriptor", NS)
    if idp is None and md.tag.endswith("}IDPSSODescriptor"):
        idp = md
    if idp is None:
        raise SamlError("Metadata has no IDPSSODescriptor (not an IdP document).")

    # entityID lives on the EntityDescriptor (the IDPSSODescriptor's parent, or
    # the root when metadata is a bare EntityDescriptor).
    entity_id = ""
    node = idp
    while node is not None:
        if node.tag.endswith("}EntityDescriptor"):
            entity_id = node.get("entityID", "")
            break
        node = node.getparent()

    sso_url = ""
    for sso in idp.findall("md:SingleSignOnService", NS):
        if sso.get("Binding") == _REDIRECT_BINDING:
            sso_url = sso.get("Location", "")
            break
    if not sso_url:
        first = idp.find("md:SingleSignOnService", NS)
        sso_url = first.get("Location", "") if first is not None else ""

    certs = []
    for kd in idp.findall("md:KeyDescriptor", NS):
        if kd.get("use") not in (None, "", "signing"):
            continue  # skip encryption-only keys
        for x in kd.findall(".//ds:X509Certificate", NS):
            if x.text and x.text.strip():
                certs.append(_normalise_cert(x.text))
    if not certs:
        raise SamlError("IdP metadata has no signing certificate.")

    result = {"entity_id": entity_id, "sso_url": sso_url, "certs": certs}
    _metadata_cache[url] = (now + _METADATA_TTL, result)
    return result


def _check_issuer(assertion, provider) -> None:
    issuer = (assertion.findtext("saml:Issuer", namespaces=NS) or "").strip()
    if not issuer:
        raise SamlError("SAML assertion has no issuer.")
    want = (provider.saml_idp_entity_id or "").strip()
    if want and issuer != want:
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
        raise SamlError("SAML assertion has no Conditions.")
    now = _now()
    nb = _parse_dt(cond.get("NotBefore"))
    na = _parse_dt(cond.get("NotOnOrAfter"))
    if nb and now + SKEW < nb:
        raise SamlError("SAML assertion not yet valid.")
    if na and now - SKEW >= na:
        raise SamlError("SAML assertion has expired.")
    # Audience is mandatory and must be our SP entity id — otherwise an assertion
    # minted for a different SP could be replayed against us.
    audiences = [a.text.strip() for a in cond.findall(".//saml:Audience", NS) if a.text]
    if not audiences:
        raise SamlError("SAML assertion has no audience restriction.")
    if sp_entity_id(base_url, provider.slug) not in audiences:
        raise SamlError("SAML audience mismatch.")


def _check_subject(assertion, acs_url) -> str:
    """Validate the bearer SubjectConfirmationData and return its InResponseTo.
    All fields are mandatory: a bearer assertion without a recipient/expiry/
    InResponseTo can't be safely accepted."""
    scd = assertion.find(".//saml:SubjectConfirmationData", NS)
    if scd is None:
        raise SamlError("SAML assertion has no SubjectConfirmationData.")
    na = _parse_dt(scd.get("NotOnOrAfter"))
    if na is None:
        raise SamlError("SAML subject confirmation has no expiry.")
    if _now() - SKEW >= na:
        raise SamlError("SAML subject confirmation has expired.")
    recipient = (scd.get("Recipient") or "").strip()
    if recipient != acs_url:
        raise SamlError("SAML recipient mismatch.")
    in_response_to = (scd.get("InResponseTo") or "").strip()
    if not in_response_to:
        raise SamlError(
            "SAML response is unsolicited (no InResponseTo). Start login from "
            "Danbyte's sign-in page."
        )
    return in_response_to


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
