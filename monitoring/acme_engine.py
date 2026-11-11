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
``issuer.account_ref`` (never on the row), exactly like CSR keys.

Outbound: the directory URL may be an internal host (step-ca on a private
address is the intended use), so it is reached directly - the tenant SSRF
guard (``core.ssrf``) deliberately does not apply to issuer endpoints, matching
Vault/Redfish. Only a user with the issuer ``add``/``change`` grant in the
tenant can set that URL; nothing from a request body or a CA's answer is
fetched on its own say-so beyond the URLs the ACME protocol names.

Errors: every exchange with the CA runs inside :func:`_talking_to_ca`, which
turns a transport failure (TLS, DNS, refused, timeout), a non-ACME answer or
the CA's own problem document into an :class:`AcmeError` with an
operator-readable message. ``AcmeError.status`` says how an API action answers
it: 502 for the CA's side (unreachable, untrusted, refused), 400 for what the
caller can fix, with ``field`` naming the issuer field when there is one.
"""
from __future__ import annotations

import datetime as _dt
import errno
import logging
import re
import socket
import ssl
from contextlib import contextmanager
from dataclasses import dataclass
from typing import Protocol
from urllib.parse import urlsplit

import josepy as jose
import requests
from acme import challenges, client, messages
from acme import errors as acme_errors
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import ec
from django.db import transaction

from .models import AcmeOrder, Issuer
from .secret_store import require_secret_store

log = logging.getLogger(__name__)

USER_AGENT = "danbyte-acme"
# How long finalize will poll authorizations + order before giving up. Short
# enough not to wedge a worker; a still-pending order can be finalized again.
_POLL_SECONDS = 90
#: Seconds one HTTP round trip to the CA may take (connect, and each read).
_NETWORK_TIMEOUT = 30


class AcmeError(RuntimeError):
    """An ACME operation failed. Carries an operator-facing message.

    ``status`` is what an API action answers with: 400 for what the caller
    can fix (``field`` names the issuer field when there is one), 502 for the
    CA's side. ``code`` is a stable machine-readable tag.
    """

    status = 400
    code = "acme_error"

    def __init__(self, message: str, *, status: int | None = None,
                 field: str | None = None, code: str | None = None):
        super().__init__(message)
        if status is not None:
            self.status = status
        if code is not None:
            self.code = code
        self.field = field

    @property
    def message(self) -> str:
        return str(self.args[0]) if self.args else ""

    def payload(self) -> dict:
        """The JSON body an API action answers with."""
        if self.field and self.status == 400:
            return {self.field: [self.message]}
        return {"detail": self.message, "code": self.code}


class AcmeUpstreamError(AcmeError):
    """The CA could not be reached, was not trusted, or refused."""

    status = 502
    code = "acme_upstream"


def acme_error_response(exc: AcmeError):
    """The DRF response an API action answers an :class:`AcmeError` with."""
    from rest_framework.response import Response

    return Response(exc.payload(), status=exc.status)


# --------------------------------------------------------------------------- #
# CA and transport failures → operator messages
# --------------------------------------------------------------------------- #
_CONTROL = re.compile(r"[\x00-\x1f\x7f-\x9f]+")
_PROBLEM_PREFIX = "urn:ietf:params:acme:error:"


def clean_remote_text(value, limit: int = 300) -> str:
    """Text that came from a remote CA, safe to store and show as plain text:
    control characters gone, whitespace collapsed, length capped."""
    text = " ".join(_CONTROL.sub(" ", str(value or "")).split())
    if len(text) > limit:
        text = text[: limit - 1].rstrip() + "…"
    return text


def describe_problem(problem) -> str:
    """One line for an ACME problem document: ``type - detail``, the type
    without its URN prefix, then up to five subproblems by identifier."""
    typ = str(getattr(problem, "typ", "") or "")
    if typ.startswith(_PROBLEM_PREFIX):
        typ = typ[len(_PROBLEM_PREFIX):]
    detail = getattr(problem, "detail", None) or getattr(problem, "title", None) or ""
    line = " - ".join(p for p in (clean_remote_text(typ, 80), clean_remote_text(detail)) if p)
    subs = []
    for sub in list(getattr(problem, "subproblems", None) or [])[:5]:
        ident = getattr(getattr(sub, "identifier", None), "value", "") or ""
        text = describe_problem(sub)
        subs.append(f"{clean_remote_text(ident, 120)}: {text}" if ident else text)
    return "; ".join(p for p in [line, *subs] if p) or "no detail given"


def _host_port(url: str) -> tuple[str, int]:
    try:
        parts = urlsplit(url or "")
        return parts.hostname or "", parts.port or (443 if parts.scheme == "https" else 80)
    except ValueError:
        return "", 0


def _chain(exc: BaseException):
    """Every exception reachable from ``exc`` - its args, urllib3's
    ``reason``, ``__cause__`` and ``__context__`` - each once, bounded."""
    seen: set[int] = set()
    todo = [exc]
    while todo and len(seen) < 40:
        cur = todo.pop(0)
        if id(cur) in seen:
            continue
        seen.add(id(cur))
        yield cur
        nxt = [getattr(cur, "reason", None), cur.__cause__, cur.__context__]
        nxt += [a for a in getattr(cur, "args", ()) if isinstance(a, BaseException)]
        todo.extend(e for e in nxt if isinstance(e, BaseException))


def _find(exc: BaseException, kind):
    return next((e for e in _chain(exc) if isinstance(e, kind)), None)


def _chain_text(exc: BaseException) -> str:
    return " ".join(str(e) for e in _chain(exc)).lower()


#: OpenSSL verify codes that get their own message.
_X509_NOT_YET_VALID, _X509_EXPIRED = 9, 10
_X509_HOSTNAME_MISMATCH, _X509_IP_MISMATCH = 62, 64
#: What fixes a CA certificate this server does not trust.
TRUST_HINT = ("Paste the CA's root certificate into the issuer's CA certificate field, "
              "or add it to this server's trust store.")
TRUST_HINT_WITH_CA = ("The issuer's CA certificate does not cover it: paste the root that "
                      "signed the CA's TLS certificate.")


def _tls_error(exc: BaseException, issuer: Issuer, host: str) -> AcmeError:
    verr = _find(exc, ssl.SSLCertVerificationError)
    code = getattr(verr, "verify_code", None)
    why = clean_remote_text(getattr(verr, "verify_message", "") or "", 160)
    text = _chain_text(exc)
    if code in (_X509_HOSTNAME_MISMATCH, _X509_IP_MISMATCH) or "mismatch" in text:
        return AcmeUpstreamError(
            f"The CA's TLS certificate is not valid for {host}. Use the name the "
            "certificate was issued for in the directory URL, or reissue the CA's "
            "certificate with this name.",
            code="acme_tls_hostname",
        )
    if code == _X509_EXPIRED or "certificate has expired" in text:
        return AcmeUpstreamError(
            f"The CA's TLS certificate at {host} has expired. Renew it on the CA, or "
            "check this server's clock.",
            code="acme_tls_expired",
        )
    if code == _X509_NOT_YET_VALID or "not yet valid" in text:
        return AcmeUpstreamError(
            f"The CA's TLS certificate at {host} is not valid yet. Check this "
            "server's clock and the CA's.",
            code="acme_tls_expired",
        )
    if verr is not None or "certificate verify failed" in text:
        hint = TRUST_HINT_WITH_CA if (issuer.ca_certificate or "").strip() else TRUST_HINT
        return AcmeUpstreamError(
            f"The ACME directory's certificate at {host} is not trusted"
            + (f" ({why})" if why else "") + f". {hint}",
            code="acme_tls_untrusted",
        )
    reason = clean_remote_text(getattr(_find(exc, ssl.SSLError), "reason", "") or "", 120)
    return AcmeUpstreamError(
        f"The TLS handshake with {host} failed" + (f" ({reason})" if reason else "")
        + ". Check that the directory URL is the CA's HTTPS address.",
        code="acme_tls_handshake",
    )


def _errnos(exc: BaseException) -> set:
    return {getattr(e, "errno", None) for e in _chain(exc)}


def _connection_error(exc: BaseException, host: str, port: int, step: str) -> AcmeError:
    text = _chain_text(exc)
    if _find(exc, socket.gaierror) is not None or any(s in text for s in (
        "name or service not known", "nodename nor servname", "failed to resolve",
        "temporary failure in name resolution", "no address associated",
    )):
        return AcmeUpstreamError(
            f"The CA's host name {host} does not resolve. Check the directory URL and "
            "this server's DNS.",
            code="acme_dns",
        )
    if _find(exc, ConnectionRefusedError) is not None or errno.ECONNREFUSED in _errnos(exc) \
            or "connection refused" in text:
        return AcmeUpstreamError(
            f"Nothing answers at {host}:{port} - the connection was refused. Check the "
            "directory URL and that the CA is running.",
            code="acme_refused",
        )
    if _find(exc, (TimeoutError, socket.timeout)) is not None or "timed out" in text:
        return AcmeUpstreamError(
            f"The CA at {host} did not answer the {step} request within "
            f"{_NETWORK_TIMEOUT} seconds.",
            code="acme_timeout",
        )
    if {errno.EHOSTUNREACH, errno.ENETUNREACH} & _errnos(exc) or "unreachable" in text:
        return AcmeUpstreamError(f"{host} is unreachable from this server.",
                                 code="acme_unreachable")
    return AcmeUpstreamError(f"Could not connect to the CA at {host}:{port}.",
                             code="acme_unreachable")


def _response_of(exc) -> requests.Response | None:
    for arg in getattr(exc, "args", ()):
        for a in (arg if isinstance(arg, tuple) else (arg,)):
            if isinstance(a, requests.Response):
                return a
    return None


def _not_a_directory(issuer: Issuer, answered: str = "") -> AcmeError:
    return AcmeError(
        f"{issuer.directory_url[:200]} is not an ACME directory"
        + (f" - it answered {answered}" if answered else "")
        + ". Check the directory URL; for step-ca it ends in "
        "/acme/<provisioner>/directory.",
        field="directory_url", code="acme_not_directory",
    )


def _explain(exc: BaseException, issuer: Issuer, step: str) -> AcmeError | None:
    """The :class:`AcmeError` for a failure talking to the CA, or None when
    ``exc`` is not one (a programming error keeps its traceback)."""
    host, port = _host_port(issuer.directory_url)
    directory = step == "directory"
    if isinstance(exc, requests.exceptions.SSLError):
        return _tls_error(exc, issuer, host)
    if isinstance(exc, requests.exceptions.ConnectTimeout):
        return AcmeUpstreamError(
            f"Could not connect to the CA at {host}:{port} within {_NETWORK_TIMEOUT} "
            "seconds.",
            code="acme_timeout",
        )
    if isinstance(exc, requests.exceptions.Timeout):
        return AcmeUpstreamError(
            f"The CA at {host} did not answer the {step} request within "
            f"{_NETWORK_TIMEOUT} seconds.",
            code="acme_timeout",
        )
    if isinstance(exc, requests.exceptions.ConnectionError):
        if _find(exc, ssl.SSLError) is not None:
            return _tls_error(exc, issuer, host)
        return _connection_error(exc, host, port, step)
    if isinstance(exc, requests.exceptions.RequestException):
        return AcmeUpstreamError(
            f"The {step} request to {host} failed ({type(exc).__name__}).",
            code="acme_unreachable",
        )
    if isinstance(exc, messages.Error):
        if directory:
            return _not_a_directory(issuer, f"with an error: {describe_problem(exc)}")
        return AcmeUpstreamError(f"The CA refused the {step}: {describe_problem(exc)}",
                                 code="acme_ca_refused")
    if isinstance(exc, acme_errors.ClientError) and not isinstance(exc, acme_errors.PollError):
        status = getattr(_response_of(exc), "status_code", None)
        if status is not None and status >= 500:
            return AcmeUpstreamError(
                f"The CA at {host} answered the {step} request with HTTP {status}.",
                code="acme_ca_error",
            )
        if directory:
            return _not_a_directory(issuer, f"HTTP {status}" if status else "")
        return AcmeUpstreamError(
            f"The CA at {host} answered the {step} request with something that is not "
            "ACME" + (f" (HTTP {status})" if status else "") + ".",
            code="acme_not_acme",
        )
    if directory and isinstance(exc, (jose.DeserializationError, ValueError, KeyError,
                                      TypeError)):
        return _not_a_directory(issuer)
    if isinstance(exc, (jose.DeserializationError, ValueError)):
        return AcmeUpstreamError(
            f"The CA at {host} answered the {step} request with something that is not "
            "ACME.",
            code="acme_not_acme",
        )
    return None


@contextmanager
def _talking_to_ca(issuer: Issuer, step: str):
    """One exchange with the CA; its failures leave as :class:`AcmeError`."""
    try:
        yield
    except AcmeError:
        raise
    except Exception as exc:  # noqa: BLE001 - narrowed by _explain
        err = _explain(exc, issuer, step)
        if err is None:
            raise
        log.warning("ACME %s for issuer %s failed: %s", step, issuer.pk, err.message)
        raise err from exc


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
    - a static HMAC key for :class:`Rfc2136Publisher`, a negotiated GSS context
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
        except Exception:  # noqa: BLE001 - cleanup is best-effort
            return
        for rec in records:
            if rec.type != AcmeOrder.Challenge.DNS01:
                continue
            try:
                upd = dns.update.Update(self.zone, keyring=keyring, keyalgorithm=alg)
                upd.delete(self._rel(rec.record_name), "TXT", rec.record_value)
                self._send(upd)
            except Exception:  # noqa: BLE001 - cleanup is best-effort
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
                except Exception:  # noqa: BLE001 - treat as not-yet-visible
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
    against a live DC - it needs a real keytab + KDC to confirm end to end.
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


def _verify(issuer: Issuer):
    """What ``requests`` checks the CA's TLS certificate against: False with
    *Verify TLS* off, else a CA bundle path - the server's trust store plus
    the issuer's own CA certificate (:mod:`monitoring.acme_trust`)."""
    from .acme_trust import CaCertificateError, verify_for

    try:
        return verify_for(issuer)
    except CaCertificateError as exc:
        raise AcmeError(str(exc), field="ca_certificate", code="acme_ca_certificate") from exc
    except OSError as exc:
        log.warning("ACME trust bundle for issuer %s could not be written: %s", issuer.pk, exc)
        raise AcmeError(
            "The CA bundle for this issuer could not be written to the server's "
            f"temporary directory ({exc.strerror or type(exc).__name__}).",
            status=503, code="acme_trust_store",
        ) from exc


def _network(issuer: Issuer, jwk, alg, account=None) -> client.ClientNetwork:
    # Reached directly, not through core.ssrf - see the module docstring.
    return client.ClientNetwork(
        jwk,
        account=account,
        alg=alg,
        user_agent=USER_AGENT,
        verify_ssl=_verify(issuer),
        timeout=_NETWORK_TIMEOUT,
    )


def _directory(issuer: Issuer, net) -> messages.Directory:
    """Fetch the issuer's ACME directory and check it is one."""
    with _talking_to_ca(issuer, "directory"):
        directory = client.ClientV2.get_directory(issuer.directory_url, net)
        for key in ("newNonce", "newAccount", "newOrder"):
            directory[key]  # KeyError: not an ACME directory
    return directory


def register_account(issuer: Issuer) -> str:
    """Create (or re-register) the ACME account for an issuer and store its key.

    Idempotent against the CA: ACME ``newAccount`` returns the existing account
    for a known key. Returns the account URI. Fail-closed if no secret store.
    """
    store = require_secret_store()
    key = ec.generate_private_key(ec.SECP256R1())
    jwk, alg = _jwk_and_alg(key)
    net = _network(issuer, jwk, alg)
    directory = _directory(issuer, net)
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
    with _talking_to_ca(issuer, "account registration"):
        regr = acme.new_account(reg)

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


def forget_account(issuer: Issuer) -> None:
    """Remove a deleted issuer's ACME account key from the secret store.
    Call it after the row's delete: the key goes when that commits, so a
    delete rolled back keeps it. Best effort: a store that is disabled or
    unreachable leaves the key behind, logged."""
    if not issuer.account_uri and not issuer.account_ref:
        return
    tenant_id, ref = issuer.tenant_id, _account_ref(issuer)

    def drop():
        try:
            require_secret_store().delete(tenant_id, ref)
        except Exception:  # noqa: BLE001 - store disabled/unreachable
            log.warning("could not remove the ACME account key %s", ref)

    transaction.on_commit(drop)


def _client(issuer: Issuer):
    """Rebuild an authenticated ClientV2 from the stored account key.

    Returns ``(acme_client, jwk)``. Raises if the account isn't registered.
    """
    if not issuer.account_uri:
        raise AcmeError("This issuer has no ACME account yet - register it first.")
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
    directory = _directory(issuer, net)
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
    with _talking_to_ca(order.issuer, "new order"):
        orderr = acme.new_order(order.request.csr_pem.encode("ascii"))

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
    exactly what to publish. Does not attempt to satisfy them - that is
    :func:`finalize_order` (after the operator or a publisher acts) or
    :func:`issue` (automated).
    """
    _open_order(order)
    return order


def _reload_order(acme, order: AcmeOrder):
    """Rebuild an OrderResource from a persisted order URL (POST-as-GET)."""
    with _talking_to_ca(order.issuer, "order lookup"):
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

    try:
        with _talking_to_ca(order.issuer, "challenge answer"):
            for authz in orderr.authorizations:
                if str(authz.body.status) != str(messages.STATUS_PENDING):
                    continue
                challb = _challenge_body(authz, order.challenge_type)
                if challb is None:
                    continue
                response, _ = challb.chall.response_and_validation(jwk)
                acme.answer_challenge(challb, response)
    except AcmeError as exc:
        _record_failure(order, exc.message)
        raise

    deadline = _dt.datetime.now() + _dt.timedelta(seconds=_POLL_SECONDS)
    try:
        # Polls the authorizations and the order, finalizes, downloads.
        finalized = acme.poll_and_finalize(orderr, deadline)
    except messages.Error as exc:
        message = f"The CA refused the finalize: {describe_problem(exc)}"
        order.status = AcmeOrder.Status.INVALID
        order.error = message
        order.save(update_fields=["status", "error", "updated_at"])
        raise AcmeUpstreamError(message, code="acme_ca_refused") from exc
    except Exception as exc:  # noqa: BLE001 - narrowed below
        if isinstance(exc, acme_errors.Error) and (
            isinstance(exc, acme_errors.PollError)
            or not isinstance(exc, acme_errors.ClientError)
        ):
            # Validation failed, a poll timed out, or the CA would not issue.
            # It must land in a terminal state with the CA's reasons, not stay
            # PROCESSING - otherwise the UI polls it forever with no retry.
            status, message = _order_failure(acme, orderr, exc)
            message = message[:_MAX_REASON_CHARS]
            order.status = status
            order.error = message
            order.save(update_fields=["status", "error", "updated_at"])
            log.info("ACME order %s did not complete: %s", order.pk, message)
            raise AcmeUpstreamError(message, code="acme_order_failed") from exc
        err = _explain(exc, order.issuer, "finalize")
        if err is None:
            raise
        log.warning("ACME finalize for order %s failed: %s", order.pk, err.message)
        _record_failure(order, err.message)
        raise err from exc

    try:
        cert_row = csr_mod.import_issued(order.request, finalized.fullchain_pem)
    except csr_mod.CsrError as exc:
        _record_failure(order, f"The CA's certificate could not be imported: {exc}")
        raise AcmeUpstreamError(
            f"The CA's certificate could not be imported: {exc}", code="acme_bad_certificate"
        ) from exc
    order.issued_certificate = cert_row
    order.status = AcmeOrder.Status.VALID
    order.error = ""
    order.save(
        update_fields=["issued_certificate", "status", "error", "updated_at"]
    )
    # The site's own certificate rides the same orders and renewals: when
    # this request backs the site, the fresh pair goes to the drop folder.
    from core.site_tls import on_issued

    on_issued(order, finalized.fullchain_pem)
    return cert_row


#: At most this many identifiers (and characters) go into an order's error.
_MAX_REASON_LINES = 20
_MAX_REASON_CHARS = 4000


def _identifier(authzr) -> str:
    return clean_remote_text(getattr(authzr.body.identifier, "value", "") or "?", 255)


def _status_name(status) -> str:
    return str(getattr(status, "name", None) or status or "")


def _authz_reasons(authzrs) -> list[str]:
    """One line per failed identifier: ``name: http-01 - <the CA's problem>``.
    The text comes from the CA: cleaned, capped, plain."""
    lines = []
    for authzr in list(authzrs)[:_MAX_REASON_LINES]:
        ident = _identifier(authzr)
        errs = [
            f"{clean_remote_text(getattr(c.chall, 'typ', '') or '?', 20)} - "
            f"{describe_problem(c.error)}"
            for c in getattr(authzr.body, "challenges", None) or []
            if getattr(c, "error", None) is not None
        ]
        if errs:
            lines += [f"{ident}: {e}" for e in errs[:3]]
        elif _status_name(authzr.body.status) not in ("valid", "pending"):
            lines.append(f"{ident}: {_status_name(authzr.body.status) or 'failed'} - "
                         "the CA gave no reason")
    return lines


def _fresh_authorizations(acme, orderr) -> list | None:
    """The order's authorizations as the CA sees them now, or None when they
    cannot be fetched (the reason then rests on what is known)."""
    try:
        out = []
        for authzr in list(orderr.authorizations)[:_MAX_REASON_LINES]:
            resp = acme._post_as_get(authzr.uri)
            out.append(messages.AuthorizationResource(
                body=messages.Authorization.from_json(resp.json()), uri=authzr.uri))
        return out
    except Exception:  # noqa: BLE001 - best effort, the main error stands
        return None


def _names(n: int) -> str:
    return "1 name" if n == 1 else f"{n} names"


def _order_failure(acme, orderr, exc) -> tuple[str, str]:
    """``(status, message)`` for an order that stopped: which identifiers
    failed and the CA's reason for each, or what was still pending at a
    timeout. Never an empty message."""
    if isinstance(exc, acme_errors.ValidationError):
        lines = _authz_reasons(exc.failed_authzrs)
        head = f"The CA could not validate {_names(len(exc.failed_authzrs))}:"
        return AcmeOrder.Status.INVALID, "\n".join([head, *lines])
    current = _fresh_authorizations(acme, orderr)
    failed = _authz_reasons(current) if current else []
    if isinstance(exc, (acme_errors.TimeoutError, acme_errors.PollError)):
        pending = [
            _identifier(a) for a in current or []
            if _status_name(a.body.status) == "pending"
        ]
        if failed:
            head = f"The CA could not validate {_names(len(failed))}:"
            return AcmeOrder.Status.INVALID, "\n".join([head, *failed])
        if pending:
            return AcmeOrder.Status.ERRORED, (
                f"The CA had not validated every name after {_POLL_SECONDS} seconds. "
                f"Still pending: {', '.join(pending)}. Check that the challenge is "
                "published and reachable from the CA, then finalize again."
            )
        if current is None:
            return AcmeOrder.Status.ERRORED, (
                f"The CA did not finish the order within {_POLL_SECONDS} seconds, and "
                "its authorizations could not be read back. Finalize again to retry."
            )
        return AcmeOrder.Status.ERRORED, (
            f"The CA validated every name but had not issued the certificate after "
            f"{_POLL_SECONDS} seconds. Finalize again to retry."
        )
    if isinstance(exc, acme_errors.IssuanceError):
        head = f"The CA would not issue the certificate: {describe_problem(exc.error)}"
    else:
        head = clean_remote_text(exc) or "The CA stopped the order without a reason."
    return AcmeOrder.Status.INVALID, "\n".join([head, *failed])


def finalize_order(order: AcmeOrder):
    """Answer the order's challenges, finalize, and import the issued cert.

    For the **operator-published** path: the order was opened earlier
    (:func:`create_order`), so it is reloaded from the CA, its challenges are
    answered, and it is finalized. The automated path uses :func:`issue`, which
    keeps the order in memory and never reloads.
    """
    if not order.order_url:
        raise AcmeError("This order was never opened - create it first.")
    acme, jwk = _client(order.issuer)
    orderr = _reload_order(acme, order)
    return _finalize_with(acme, jwk, orderr, order)


def issue(order: AcmeOrder, publisher: ChallengePublisher | None = None):
    """Open → publish → finalize in one call (the automated path).

    Keeps the freshly opened order in memory and finalizes *that*, so the
    automated flow never re-fetches the order from the CA. ``publisher``
    publishes the challenge records (e.g. DNS-01 auto-publish) and is cleaned up
    afterwards. With no publisher, the challenges are persisted but not solved -
    use :func:`finalize_order` after publishing by hand.
    """
    acme, jwk, orderr, records = _open_order(order)
    if publisher is None:
        return None
    try:
        publisher.publish(records)
    except AcmeError:
        raise
    except Exception as exc:  # noqa: BLE001 - DNS server errors, mostly
        raise AcmeError(
            f"Publishing the {order.challenge_type} records failed: "
            f"{clean_remote_text(exc, 200) or type(exc).__name__}",
            code="acme_publish_failed",
        ) from exc
    try:
        return _finalize_with(acme, jwk, orderr, order)
    finally:
        try:
            publisher.cleanup(records)
        except Exception:  # noqa: BLE001 - cleanup is best-effort
            log.warning("ACME challenge cleanup for order %s failed", order.pk)


# --------------------------------------------------------------------------- #
# RQ job wrappers
# --------------------------------------------------------------------------- #
def _record_failure(order: AcmeOrder, message: str) -> None:
    """Store why an order stopped, unless it already reached a final state
    with its own reason (``invalid`` from the CA, or ``valid``)."""
    order.refresh_from_db(fields=["status", "error"])
    if order.status == AcmeOrder.Status.VALID:
        return
    if order.status == AcmeOrder.Status.INVALID and order.error:
        return
    if order.status != AcmeOrder.Status.INVALID:
        order.status = AcmeOrder.Status.ERRORED
    order.error = message or "The ACME order failed and the CA gave no reason."
    order.save(update_fields=["status", "error", "updated_at"])


def run_order_job(order: AcmeOrder, work) -> None:
    """Run a background ACME step for ``order`` and record any failure on it.

    An :class:`AcmeError` stores its own message; a secret-store failure its
    own; anything else is logged with its traceback and stored as a generic
    line - an order never stays ``processing`` because its worker raised.
    """
    from .secret_store import SecretStoreError

    try:
        work()
    except AcmeError as exc:
        _record_failure(order, exc.message)
    except SecretStoreError as exc:
        _record_failure(order, str(exc) or "The secret store is not available.")
    except Exception:  # noqa: BLE001 - recorded, never left processing
        log.exception("ACME job for order %s failed", order.pk)
        _record_failure(
            order, "The ACME job failed unexpectedly. The details are in the server log."
        )


def finalize_order_job(order_id) -> None:
    """RQ entry point: finalize a persisted order (polls, so it runs async).

    Re-loads the order by id - never trusts an enqueue-time object - and lets
    :func:`run_order_job` record any failure on the row.
    """
    order = (
        AcmeOrder.objects.select_related("issuer", "request")
        .filter(id=order_id)
        .first()
    )
    if order is None:
        return
    run_order_job(order, lambda: finalize_order(order))


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

    def work():
        publisher = publisher_for(order.issuer)
        if publisher is None:
            # No auto-publisher: create the order so its challenges are visible,
            # then leave it for the operator to publish + finalize.
            create_order(order)
            return
        issue(order, publisher)

    run_order_job(order, work)
