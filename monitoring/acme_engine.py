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


class _DynamicDnsPublisher:
    """Shared RFC2136-style dynamic-update sender for DNS-01 auto-publish.

    Subclasses provide the TSIG keyring + algorithm via :meth:`_keyring_and_alg`
    — a static HMAC key for :class:`Rfc2136Publisher`, a negotiated GSS context
    for :class:`GssTsigPublisher`. The DNS server is admin-configured, so it is
    reached directly (like the ACME directory / Vault), not via the tenant SSRF
    guard.
    """

    def __init__(self, issuer: Issuer):
        s = issuer.dns_settings or {}
        self.server = (s.get("server") or "").strip()
        self.port = int(s.get("port") or 53)
        self.zone = (s.get("zone") or "").strip().rstrip(".") + "."
        self.ttl = int(s.get("ttl") or 60)
        if not (self.server and self.zone.strip(".")):
            raise AcmeError("DNS-01 auto-publish needs a server and zone configured.")

    def _keyring_and_alg(self):  # -> (keyring, algorithm)
        raise NotImplementedError

    def _rel(self, fqdn: str):
        import dns.name

        return dns.name.from_text(fqdn).relativize(dns.name.from_text(self.zone))

    def _send(self, update) -> None:
        import dns.query
        import dns.rcode

        resp = dns.query.tcp(update, self.server, port=self.port, timeout=15)
        if resp.rcode() != dns.rcode.NOERROR:
            raise AcmeError(
                f"DNS update to {self.server} was refused: "
                f"{dns.rcode.to_text(resp.rcode())}."
            )

    def publish(self, records: list[ChallengeRecord]) -> None:
        import dns.update

        keyring, alg = self._keyring_and_alg()
        for rec in records:
            if rec.type != AcmeOrder.Challenge.DNS01:
                continue
            upd = dns.update.Update(self.zone, keyring=keyring, keyalgorithm=alg)
            # `add` (not `replace`): a multi-SAN order may need two TXT values on
            # the same _acme-challenge name at once.
            upd.add(self._rel(rec.record_name), self.ttl, "TXT", rec.record_value)
            self._send(upd)
        self._wait_visible(records)

    def cleanup(self, records: list[ChallengeRecord]) -> None:
        import dns.update

        try:
            keyring, alg = self._keyring_and_alg()
        except Exception:  # noqa: BLE001 — cleanup is best-effort
            return
        for rec in records:
            if rec.type != AcmeOrder.Challenge.DNS01:
                continue
            try:
                upd = dns.update.Update(self.zone, keyring=keyring, keyalgorithm=alg)
                upd.delete(self._rel(rec.record_name), "TXT", rec.record_value)
                self._send(upd)
            except Exception:  # noqa: BLE001 — cleanup is best-effort
                pass

    def _wait_visible(self, records: list[ChallengeRecord]) -> None:
        """Poll the authoritative server until each TXT resolves (bounded).

        We write to the authoritative server, so this is usually instant, but a
        brief confirm avoids answering the challenge before the record is live.
        """
        import time

        import dns.message
        import dns.query
        import dns.rdatatype

        pending = [r for r in records if r.type == AcmeOrder.Challenge.DNS01]
        deadline = 20
        waited = 0.0
        while pending and waited < deadline:
            still = []
            for rec in pending:
                q = dns.message.make_query(rec.record_name, dns.rdatatype.TXT)
                try:
                    resp = dns.query.tcp(q, self.server, port=self.port, timeout=5)
                    values = " ".join(
                        s.decode() if isinstance(s, bytes) else str(s)
                        for rr in resp.answer
                        for item in rr.items
                        for s in getattr(item, "strings", [])
                    )
                    if rec.record_value in values:
                        continue
                except Exception:  # noqa: BLE001 — treat as not-yet-visible
                    pass
                still.append(rec)
            pending = still
            if pending:
                time.sleep(2)
                waited += 2


class Rfc2136Publisher(_DynamicDnsPublisher):
    """DNS-01 via RFC 2136 dynamic update with a static TSIG key.

    The one dynamic-update standard that spans BIND, Samba AD, PowerDNS, Knot,
    etc. Config: ``dns_settings`` server/port/zone/key_name/key_algorithm/ttl;
    the TSIG secret is a credential in ``issuer.secrets['tsig_secret']``.
    """

    def __init__(self, issuer: Issuer):
        super().__init__(issuer)
        s = issuer.dns_settings or {}
        self.key_name = (s.get("key_name") or "").strip()
        self.key_algorithm = s.get("key_algorithm") or "hmac-sha256"
        secret = (issuer.secrets or {}).get("tsig_secret") or ""
        if not (self.key_name and secret):
            raise AcmeError(
                "RFC2136 DNS-01 needs a TSIG key name and secret on the issuer."
            )
        import dns.tsigkeyring

        self._keyring = dns.tsigkeyring.from_text({self.key_name: secret})

    def _keyring_and_alg(self):
        return self._keyring, self.key_algorithm


class GssTsigPublisher(_DynamicDnsPublisher):
    """DNS-01 for Windows AD DNS via GSS-TSIG (Kerberos secure dynamic update).

    Windows AD DNS accepts secure dynamic updates only over GSS-TSIG, so this
    negotiates a Kerberos context (dnspython's :class:`dns.tsig.GSSTSigAdapter`)
    from a service-account **keytab** and signs the update with the negotiated
    key. Config on ``dns_settings``: server (the AD DNS FQDN), zone, plus
    ``client_principal`` (e.g. ``svc-dns@DANBYTE.LAN``), ``keytab`` (path on the
    Danbyte host), and optional ``spn`` (default ``DNS@<server>``). Requires the
    ``gssapi`` package (lazy-imported) and a Kerberos realm config.

    NOTE: the negotiation is validated against dnspython's API but not yet run
    against a live DC — it needs a real keytab + KDC to confirm end to end.
    """

    def __init__(self, issuer: Issuer):
        super().__init__(issuer)
        s = issuer.dns_settings or {}
        self.client_principal = (s.get("client_principal") or "").strip()
        self.keytab = (s.get("keytab") or "").strip()
        self.spn = (s.get("spn") or f"DNS@{self.server}").strip()
        if not self.client_principal:
            raise AcmeError(
                "GSS-TSIG needs a client principal (the DNS service account)."
            )

    def _keyring_and_alg(self):
        return self._negotiate(), "gss-tsig."

    def _negotiate(self):
        """Run the Kerberos TKEY handshake and return a dnspython GSS keyring."""
        import uuid

        try:
            import gssapi
        except ImportError as exc:  # pragma: no cover - environment dependent
            raise AcmeError(
                "GSS-TSIG needs the 'gssapi' package installed (and libkrb5)."
            ) from exc
        import time as _time

        import dns.message
        import dns.name
        import dns.query
        import dns.rdataclass
        import dns.rdatatype
        import dns.rdtypes.ANY.TKEY
        import dns.tsig

        client = gssapi.Name(
            self.client_principal, gssapi.NameType.kerberos_principal
        )
        store = {"client_keytab": self.keytab} if self.keytab else None
        creds = gssapi.Credentials(name=client, usage="initiate", store=store)
        target = gssapi.Name(self.spn, gssapi.NameType.hostbased_service)
        ctx = gssapi.SecurityContext(name=target, creds=creds, usage="initiate")

        keyname = dns.name.from_text(f"{uuid.uuid4().hex}.")
        keyring = {keyname: dns.tsig.Key(keyname, ctx, "gss-tsig.")}
        adapter = dns.tsig.GSSTSigAdapter(keyring)

        token = ctx.step()
        now = int(_time.time())
        while not ctx.complete:
            tkey = dns.rdtypes.ANY.TKEY.TKEY(
                dns.rdataclass.ANY,
                dns.rdatatype.TKEY,
                algorithm=dns.name.from_text("gss-tsig."),
                inception=now,
                expiration=now + 3600,
                mode=dns.rdtypes.ANY.TKEY.TKEY.GSSAPI_NEGOTIATION,
                error=0,
                key=token,
                other=b"",
            )
            query = dns.message.make_query(
                keyname, dns.rdatatype.TKEY, dns.rdataclass.ANY
            )
            query.keyring = adapter
            query.find_rrset(
                query.additional,
                keyname,
                dns.rdataclass.ANY,
                dns.rdatatype.TKEY,
                create=True,
            ).add(tkey)
            resp = dns.query.tcp(query, self.server, port=self.port, timeout=15)
            answer = resp.get_rrset(
                resp.answer, keyname, dns.rdataclass.ANY, dns.rdatatype.TKEY
            )
            if answer is None:
                raise AcmeError(
                    "GSS-TSIG negotiation failed: no TKEY in the DNS response."
                )
            token = ctx.step(answer[0].key)
        return keyring


def publisher_for(issuer: Issuer) -> ChallengePublisher | None:
    """The auto-publisher for an issuer, or ``None`` for the manual flow."""
    if issuer.dns_provider == Issuer.DnsProvider.RFC2136:
        return Rfc2136Publisher(issuer)
    if issuer.dns_provider == Issuer.DnsProvider.GSS_TSIG:
        return GssTsigPublisher(issuer)
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
def _open_order(order: AcmeOrder):
    """Open an ACME order for the request's CSR and persist its challenges.

    Returns ``(acme_client, jwk, orderr, records)`` so the caller can finalize
    the **same in-memory** order without re-fetching it from the CA. ``records``
    is the list of :class:`ChallengeRecord` to publish.
    """
    if not order.request or not order.request.csr_pem:
        raise AcmeError("This order has no certificate request / CSR.")
    acme, jwk = _client(order.issuer)
    try:
        orderr = acme.new_order(order.request.csr_pem.encode("ascii"))
    except messages.Error as exc:
        raise AcmeError(f"ACME newOrder failed: {exc}") from exc

    triples = _records_for(orderr, jwk, order.challenge_type)
    records = [rec for _, _, rec in triples]
    order.order_url = orderr.uri or ""
    order.identifiers = [a.body.identifier.value for a in orderr.authorizations]
    order.challenges = [rec.as_dict() for rec in records]
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
    return acme, jwk, orderr, records


def create_order(order: AcmeOrder) -> AcmeOrder:
    """Open an ACME order for the request's CSR and persist the challenges.

    Leaves the order ``pending`` with :attr:`AcmeOrder.challenges` describing
    exactly what to publish. Does not attempt to satisfy them — that is
    :func:`finalize_order` (after the operator or a publisher acts) or
    :func:`issue` (automated).
    """
    _open_order(order)
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


def _finalize_with(acme, jwk, orderr, order: AcmeOrder):
    """Answer pending challenges on ``orderr``, finalize, and import the cert.

    Works from an in-memory OrderResource (whether freshly opened or reloaded),
    so the automated path never has to re-fetch the order from the CA.
    """
    from . import csr as csr_mod

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

    cert_row = csr_mod.import_issued(order.request, finalized.fullchain_pem)
    order.issued_certificate = cert_row
    order.status = AcmeOrder.Status.VALID
    order.error = ""
    order.save(
        update_fields=["issued_certificate", "status", "error", "updated_at"]
    )
    return cert_row


def finalize_order(order: AcmeOrder):
    """Answer the order's challenges, finalize, and import the issued cert.

    For the **operator-published** path: the order was opened earlier
    (:func:`create_order`), so it is reloaded from the CA, its challenges are
    answered, and it is finalized. The automated path uses :func:`issue`, which
    keeps the order in memory and never reloads.
    """
    if not order.order_url:
        raise AcmeError("This order was never opened — create it first.")
    acme, jwk = _client(order.issuer)
    orderr = _reload_order(acme, order)
    return _finalize_with(acme, jwk, orderr, order)


def issue(order: AcmeOrder, publisher: ChallengePublisher | None = None):
    """Open → publish → finalize in one call (the automated path).

    Keeps the freshly opened order in memory and finalizes *that*, so the
    automated flow never re-fetches the order from the CA. ``publisher``
    publishes the challenge records (e.g. DNS-01 auto-publish) and is cleaned up
    afterwards. With no publisher, the challenges are persisted but not solved —
    use :func:`finalize_order` after publishing by hand.
    """
    acme, jwk, orderr, records = _open_order(order)
    if publisher is None:
        return None
    publisher.publish(records)
    try:
        return _finalize_with(acme, jwk, orderr, order)
    finally:
        publisher.cleanup(records)


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


def issue_order_job(order_id) -> None:
    """RQ entry point for fully-automated issuance: create → auto-publish →
    finalize. Records any failure on the order row.
    """
    order = (
        AcmeOrder.objects.select_related("issuer", "request")
        .filter(id=order_id)
        .first()
    )
    if order is None:
        return
    try:
        publisher = publisher_for(order.issuer)
        if publisher is None:
            # No auto-publisher: create the order so its challenges are visible,
            # then leave it for the operator to publish + finalize.
            create_order(order)
            return
        issue(order, publisher)
    except AcmeError as exc:
        order.refresh_from_db()
        if order.status not in (AcmeOrder.Status.INVALID, AcmeOrder.Status.VALID):
            order.status = AcmeOrder.Status.ERRORED
            order.error = str(exc)
            order.save(update_fields=["status", "error", "updated_at"])
