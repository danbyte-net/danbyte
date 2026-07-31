"""ACME issuance engine (RFC 8555) built on certbot's ``acme`` library.

Danbyte already generates the key pair and CSR (:mod:`monitoring.csr`); this
module drives an :class:`~monitoring.models.Issuer` (a public CA like Let's
Encrypt or an internal one like step-ca) to turn that CSR into a signed
certificate:

    register_account(issuer)        # one-time: create/store the ACME account
    order = create_order(order)     # newOrder → persist the challenges to solve
    # operator (or a DNS/HTTP publisher) satisfies the challenges …
    finalize_order(order)           # answer challenges → finalize → import cert

``issue(order, publisher)`` chains create → publish → finalize in one call for
the automated path (e.g. DNS-01 auto-publish).

Secrets: the ACME **account private key** lives in the secret store at
``issuer.account_ref`` (never on the row), exactly like CSR keys. The directory
URL may be an internal host, so it is reached directly — the tenant SSRF guard
does not apply to admin-configured issuer endpoints, matching Vault/Redfish.
"""
from __future__ import annotations

import datetime as _dt
from dataclasses import dataclass
from typing import Protocol

import josepy as jose
from acme import challenges, client, messages
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import ec

from .models import AcmeOrder, Issuer
from .secret_store import require_secret_store

USER_AGENT = "danbyte-acme"
# How long finalize will poll authorizations + order before giving up. Short
# enough not to wedge a worker; a still-pending order can be finalized again.
_POLL_SECONDS = 90


class AcmeError(RuntimeError):
    """An ACME operation failed. Carries an operator-facing message."""


# --------------------------------------------------------------------------- #
# Challenge publishers
# --------------------------------------------------------------------------- #
@dataclass
class ChallengeRecord:
    """One thing that must be published for a domain to pass validation."""

    identifier: str
    type: str  # "dns-01" | "http-01"
    # DNS-01
    record_name: str = ""
    record_value: str = ""
    # HTTP-01
    token: str = ""
    path: str = ""
    content: str = ""

    def as_dict(self, status: str = "pending") -> dict:
        d = {"identifier": self.identifier, "type": self.type, "status": status}
        if self.type == AcmeOrder.Challenge.DNS01:
            d.update(record_name=self.record_name, record_value=self.record_value)
        else:
            d.update(token=self.token, path=self.path, content=self.content)
        return d


class ChallengePublisher(Protocol):
    """Satisfies ACME challenges by publishing the required records, and cleans
    them up afterwards. The DNS-01 auto-publisher and any HTTP-01 web-root
    publisher implement this; :class:`ManualPublisher` is the no-op default the
    operator satisfies by hand."""

    def publish(self, records: list[ChallengeRecord]) -> None: ...

    def cleanup(self, records: list[ChallengeRecord]) -> None: ...


class ManualPublisher:
    """No-op publisher: the operator publishes the records themselves (the
    :class:`AcmeOrder` surfaces exactly what to publish)."""

    def publish(self, records: list[ChallengeRecord]) -> None:  # noqa: D401
        return None

    def cleanup(self, records: list[ChallengeRecord]) -> None:
        return None


# --------------------------------------------------------------------------- #
# Account + client
# --------------------------------------------------------------------------- #
def _account_ref(issuer: Issuer) -> str:
    return issuer.account_ref or f"issuer/{issuer.id}/account"


def _jwk_and_alg(key):
    """Wrap a cryptography private key as a josepy JWK + its JWS alg."""
    if isinstance(key, ec.EllipticCurvePrivateKey):
        return jose.JWKEC(key=key), jose.ES256
    return jose.JWKRSA(key=key), jose.RS256


def _network(issuer: Issuer, jwk, alg, account=None) -> client.ClientNetwork:
    return client.ClientNetwork(
        jwk,
        account=account,
        alg=alg,
        user_agent=USER_AGENT,
        verify_ssl=issuer.verify_tls,
    )


def register_account(issuer: Issuer) -> str:
    """Create (or re-register) the ACME account for an issuer and store its key.

    Idempotent against the CA: ACME ``newAccount`` returns the existing account
    for a known key. Returns the account URI. Fail-closed if no secret store.
    """
    store = require_secret_store()
    key = ec.generate_private_key(ec.SECP256R1())
    jwk, alg = _jwk_and_alg(key)
    net = _network(issuer, jwk, alg)
    directory = client.ClientV2.get_directory(issuer.directory_url, net)
    acme = client.ClientV2(directory, net)

    eab = None
    if issuer.eab_kid:
        hmac_key = (issuer.secrets or {}).get("eab_hmac_key", "")
        if not hmac_key:
            raise AcmeError("This issuer requires an EAB HMAC key, but none is stored.")
        eab = messages.ExternalAccountBinding.from_data(
            account_public_key=jwk,
            kid=issuer.eab_kid,
            hmac_key=hmac_key,
            directory=directory,
        )

    reg = messages.NewRegistration.from_data(
        email=issuer.contact_email or None,
        external_account_binding=eab,
        terms_of_service_agreed=True,
    )
    try:
        regr = acme.new_account(reg)
    except messages.Error as exc:
        raise AcmeError(f"ACME account registration failed: {exc}") from exc

    ref = _account_ref(issuer)
    pem = key.private_bytes(
        serialization.Encoding.PEM,
        serialization.PrivateFormat.PKCS8,
        serialization.NoEncryption(),
    ).decode("ascii")
    store.put(issuer.tenant_id, ref, {"account_key": pem})
    issuer.account_uri = regr.uri or ""
    issuer.account_ref = ref
    issuer.save(update_fields=["account_uri", "account_ref", "updated_at"])
    return issuer.account_uri


def _client(issuer: Issuer):
    """Rebuild an authenticated ClientV2 from the stored account key.

    Returns ``(acme_client, jwk)``. Raises if the account isn't registered.
    """
    if not issuer.account_uri:
        raise AcmeError("This issuer has no ACME account yet — register it first.")
    store = require_secret_store()
    data = store.get(issuer.tenant_id, _account_ref(issuer)) or {}
    pem = data.get("account_key")
    if not pem:
        raise AcmeError("The issuer's ACME account key is missing from the secret store.")
    key = serialization.load_pem_private_key(pem.encode("ascii"), password=None)
    jwk, alg = _jwk_and_alg(key)
    regr = messages.RegistrationResource(
        uri=issuer.account_uri, body=messages.Registration()
    )
    net = _network(issuer, jwk, alg, account=regr)
    directory = client.ClientV2.get_directory(issuer.directory_url, net)
    return client.ClientV2(directory, net), jwk


# --------------------------------------------------------------------------- #
# Challenge extraction
# --------------------------------------------------------------------------- #
def _challenge_body(authz, kind: str):
    """The ChallengeBody of the requested type in an authorization, or None."""
    want = challenges.DNS01 if kind == AcmeOrder.Challenge.DNS01 else challenges.HTTP01
    for challb in authz.body.challenges:
        if isinstance(challb.chall, want):
            return challb
    return None


def _records_for(orderr, jwk, kind: str) -> list[tuple]:
    """Return ``[(authz, challb, ChallengeRecord), …]`` for every authorization.

    Raises if the CA didn't offer the requested challenge type for a domain.
    """
    out = []
    for authz in orderr.authorizations:
        domain = authz.body.identifier.value
        challb = _challenge_body(authz, kind)
        if challb is None:
            raise AcmeError(
                f"The CA does not offer a {kind} challenge for {domain!r}."
            )
        chall = challb.chall
        if kind == AcmeOrder.Challenge.DNS01:
            rec = ChallengeRecord(
                identifier=domain,
                type=kind,
                record_name=chall.validation_domain_name(domain),
                record_value=chall.validation(jwk),
            )
        else:
            rec = ChallengeRecord(
                identifier=domain,
                type=kind,
                token=chall.encode("token"),
                path=chall.path,
                content=chall.validation(jwk),
            )
        out.append((authz, challb, rec))
    return out


def _map_status(order_status) -> str:
    # acme Status stringifies as "Status(pending)"; the bare name is on `.name`.
    name = getattr(order_status, "name", None) or str(order_status)
    valid = {s.value for s in AcmeOrder.Status}
    return name if name in valid else AcmeOrder.Status.PENDING


# --------------------------------------------------------------------------- #
# Order lifecycle
# --------------------------------------------------------------------------- #
def create_order(order: AcmeOrder) -> AcmeOrder:
    """Open an ACME order for the request's CSR and persist the challenges.

    Leaves the order ``pending`` with :attr:`AcmeOrder.challenges` describing
    exactly what to publish. Does not attempt to satisfy them — that is
    :func:`finalize_order` (after the operator or a publisher acts) or
    :func:`issue` (automated).
    """
    if not order.request or not order.request.csr_pem:
        raise AcmeError("This order has no certificate request / CSR.")
    acme, jwk = _client(order.issuer)
    try:
        orderr = acme.new_order(order.request.csr_pem.encode("ascii"))
    except messages.Error as exc:
        raise AcmeError(f"ACME newOrder failed: {exc}") from exc

    records = _records_for(orderr, jwk, order.challenge_type)
    order.order_url = orderr.uri or ""
    order.identifiers = [a.body.identifier.value for a in orderr.authorizations]
    order.challenges = [rec.as_dict() for _, _, rec in records]
    order.status = _map_status(orderr.body.status)
    order.error = ""
    order.save(
        update_fields=[
            "order_url",
            "identifiers",
            "challenges",
            "status",
            "error",
            "updated_at",
        ]
    )
    return order


def _reload_order(acme, order: AcmeOrder):
    """Rebuild an OrderResource from a persisted order URL (POST-as-GET)."""
    resp = acme._post_as_get(order.order_url)
    body = messages.Order.from_json(resp.json())
    authzrs = []
    for authz_url in body.authorizations:
        ar = acme._post_as_get(authz_url)
        authzrs.append(
            messages.AuthorizationResource(
                body=messages.Authorization.from_json(ar.json()), uri=authz_url
            )
        )
    return messages.OrderResource(
        body=body,
        uri=order.order_url,
        authorizations=authzrs,
        csr_pem=order.request.csr_pem.encode("ascii"),
    )


def finalize_order(order: AcmeOrder):
    """Answer the order's challenges, finalize, and import the issued cert.

    Assumes the challenge records are already published (by the operator or a
    publisher). Answers each pending challenge, polls to ``valid``, downloads the
    chain, and imports it via :func:`monitoring.csr.import_issued`, linking the
    resulting :class:`Certificate`. Returns that Certificate.
    """
    from . import csr as csr_mod

    if not order.order_url:
        raise AcmeError("This order was never opened — create it first.")
    acme, jwk = _client(order.issuer)
    orderr = _reload_order(acme, order)

    # Tell the CA to validate each still-pending challenge of our type.
    for authz in orderr.authorizations:
        if str(authz.body.status) != str(messages.STATUS_PENDING):
            continue
        challb = _challenge_body(authz, order.challenge_type)
        if challb is None:
            continue
        response, _ = challb.chall.response_and_validation(jwk)
        acme.answer_challenge(challb, response)

    deadline = _dt.datetime.now() + _dt.timedelta(seconds=_POLL_SECONDS)
    try:
        finalized = acme.poll_and_finalize(orderr, deadline)
    except messages.Error as exc:
        order.status = AcmeOrder.Status.INVALID
        order.error = str(exc)
        order.save(update_fields=["status", "error", "updated_at"])
        raise AcmeError(f"ACME finalize failed: {exc}") from exc
    except Exception as exc:  # noqa: BLE001 — surface poll timeouts cleanly
        order.error = str(exc)
        order.save(update_fields=["error", "updated_at"])
        raise AcmeError(f"ACME order did not complete: {exc}") from exc

    fullchain = finalized.fullchain_pem
    cert_row = csr_mod.import_issued(order.request, fullchain)
    order.issued_certificate = cert_row
    order.status = AcmeOrder.Status.VALID
    order.error = ""
    order.save(
        update_fields=["issued_certificate", "status", "error", "updated_at"]
    )
    return cert_row


def issue(order: AcmeOrder, publisher: ChallengePublisher | None = None):
    """Create → publish → finalize in one call (the automated path).

    ``publisher`` publishes the challenge records (e.g. DNS-01 auto-publish) and
    is cleaned up afterwards. With no publisher, the challenges are created and
    persisted but not solved — use :func:`finalize_order` after publishing by
    hand.
    """
    create_order(order)
    if publisher is None:
        return None
    records = [ChallengeRecord(**_rec_kwargs(c)) for c in order.challenges]
    publisher.publish(records)
    try:
        return finalize_order(order)
    finally:
        publisher.cleanup(records)


def _rec_kwargs(c: dict) -> dict:
    """Rebuild ChallengeRecord kwargs from a persisted challenge dict."""
    kind = c.get("type", AcmeOrder.Challenge.DNS01)
    base = {"identifier": c.get("identifier", ""), "type": kind}
    if kind == AcmeOrder.Challenge.DNS01:
        base.update(
            record_name=c.get("record_name", ""),
            record_value=c.get("record_value", ""),
        )
    else:
        base.update(
            token=c.get("token", ""),
            path=c.get("path", ""),
            content=c.get("content", ""),
        )
    return base


# --------------------------------------------------------------------------- #
# RQ job wrapper
# --------------------------------------------------------------------------- #
def finalize_order_job(order_id) -> None:
    """RQ entry point: finalize a persisted order (polls, so it runs async).

    Re-loads the order by id — never trusts an enqueue-time object — and lets
    :func:`finalize_order` record any failure on the row (it sets ``error`` /
    ``status`` itself), so a raised :class:`AcmeError` is swallowed here.
    """
    order = (
        AcmeOrder.objects.select_related("issuer", "request")
        .filter(id=order_id)
        .first()
    )
    if order is None:
        return
    try:
        finalize_order(order)
    except AcmeError:
        pass  # already recorded on the order row
