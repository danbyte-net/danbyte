"""The certificate Danbyte itself is served on (Settings → Updates → Site
certificate, issue #126).

The app never touches nginx and never holds root. It writes a pair into
``deploy/nginx/certs/`` - a folder it owns, the same one the installer
stages the self-signed pair in - then a stamp file as its last write. The
root ``danbyte-tls.path`` unit the installer sets up (``make
install-tls-unit``) notices the stamp, and ``scripts/danbyte-tls-apply.sh``
verifies the pair, keeps the live one aside, installs, runs ``nginx -t``,
reloads, or rolls back - and writes ``danbyte.applied`` for this module to
read back. Four ways in, one way out: an uploaded pair, a self-signed one
(regenerated on the expiry beat when it runs short), an ACME order through
the issuers the certificate inventory already has, and - later - a CSR.

Private keys pass through here in memory and land in one 0600 file; they
are never stored on a row (``monitoring.Certificate`` refuses key material
by design) and never returned by the API.
"""
from __future__ import annotations

import hashlib
import ipaddress
import json
import logging
import os
import socket
import ssl
from datetime import UTC, datetime, timedelta
from pathlib import Path

from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec, rsa
from django.conf import settings
from django.utils import timezone

log = logging.getLogger("core.site_tls")

DROP_DIR = Path(settings.BASE_DIR) / "deploy" / "nginx" / "certs"
STAMP, APPLIED = "danbyte.apply", "danbyte.applied"
CERT_NAME, KEY_NAME = "danbyte.crt", "danbyte.key"
UNIT_FILE = Path("/etc/systemd/system/danbyte-tls.path")
#: A self-signed pair is regenerated once it has fewer days than this.
SELF_SIGNED_RENEW_DAYS = 30
SELF_SIGNED_DAYS = 825


class SiteTlsError(ValueError):
    """What is wrong with the pair or the request - operator-facing."""


def drop_dir() -> Path:
    return Path(getattr(settings, "SITE_TLS_DROP_DIR", "") or DROP_DIR)


# ─── the public host ────────────────────────────────────────────────────────

def public_host() -> str:
    """The name the site is reached as: the public base URL's host, else the
    first concrete ALLOWED_HOSTS entry, else this machine's name."""
    from urllib.parse import urlsplit

    from .models import DeploymentSettings

    url = DeploymentSettings.load().public_base_url or ""
    host = urlsplit(url if "://" in url else f"https://{url}").hostname if url else ""
    if host:
        return host
    for h in getattr(settings, "ALLOWED_HOSTS", []) or []:
        if h and not h.startswith(("*", ".")) and h not in {"localhost", "127.0.0.1", "::1"}:
            return h
    return socket.gethostname()


def _san_entry(name: str) -> str:
    try:
        ipaddress.ip_address(name)
        return f"IP:{name}"
    except ValueError:
        return f"DNS:{name}"


# ─── reading certificates ────────────────────────────────────────────────────

def cert_facts(cert: x509.Certificate) -> dict:
    """What an operator asks about a certificate."""
    names: list[str] = []
    try:
        san = cert.extensions.get_extension_for_class(x509.SubjectAlternativeName).value
        names += [f"DNS:{n}" for n in san.get_values_for_type(x509.DNSName)]
        names += [f"IP:{n}" for n in san.get_values_for_type(x509.IPAddress)]
    except x509.ExtensionNotFound:
        pass
    cn = next((a.value for a in cert.subject if a.oid == x509.NameOID.COMMON_NAME), "")
    not_after = cert.not_valid_after_utc
    pub = cert.public_key()
    if isinstance(pub, rsa.RSAPublicKey):
        key = f"RSA {pub.key_size}"
    elif isinstance(pub, ec.EllipticCurvePublicKey):
        key = f"EC {pub.curve.name}"
    else:
        key = type(pub).__name__.replace("PublicKey", "")
    digest = cert.fingerprint(hashes.SHA256()).hex().upper()
    return {
        "subject": cert.subject.rfc4514_string(),
        "cn": str(cn),
        "issuer": cert.issuer.rfc4514_string(),
        "names": names,
        "not_before": cert.not_valid_before_utc,
        "not_after": not_after,
        "days_left": (not_after - datetime.now(UTC)).days,
        "self_signed": cert.subject == cert.issuer,
        "key": key,
        "fingerprint": ":".join(digest[i:i + 2] for i in range(0, len(digest), 2)),
    }


def load_chain(pem: str) -> list[x509.Certificate]:
    raw = (pem or "").encode("utf-8", "replace")
    loader = getattr(x509, "load_pem_x509_certificates", None)
    try:
        if loader:
            return list(loader(raw))
        return [x509.load_pem_x509_certificate(raw)]
    except ValueError as exc:
        raise SiteTlsError(f"not a PEM certificate: {exc}") from exc


def load_key(pem: str):
    raw = (pem or "").encode("utf-8", "replace")
    if b"ENCRYPTED" in raw:
        raise SiteTlsError("the private key is encrypted - decrypt it first (openssl pkey)")
    try:
        return serialization.load_pem_private_key(raw, password=None)
    except (ValueError, TypeError) as exc:
        raise SiteTlsError(f"not a PEM private key: {exc}") from exc


def served(host: str = "", port: int = 443, timeout: float = 2.0) -> dict | None:
    """What ``:443`` presents right now for the site's name - the truth the
    card shows beside what was dropped. None when nothing answers."""
    ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
    ctx.check_hostname = False
    ctx.verify_mode = ssl.CERT_NONE
    sni = host or public_host()
    try:
        ipaddress.ip_address(sni)
        sni_arg = None
    except ValueError:
        sni_arg = sni
    try:
        with socket.create_connection(("127.0.0.1", port), timeout=timeout) as raw, \
                ctx.wrap_socket(raw, server_hostname=sni_arg) as s:
            der = s.getpeercert(binary_form=True)
            version = s.version() or ""
    except (OSError, ssl.SSLError):
        return None
    if not der:
        return None
    facts = cert_facts(x509.load_der_x509_certificate(der))
    facts["tls_version"] = version
    return facts


# ─── validating and dropping a pair ───────────────────────────────────────────

def validate_pair(cert_pem: str, key_pem: str, chain_pem: str = "") -> tuple[str, str, dict]:
    """The full chain to install (leaf first), the key PEM as given, and the
    leaf's facts - or :class:`SiteTlsError` with what is wrong."""
    certs = load_chain(cert_pem)
    if chain_pem and chain_pem.strip():
        certs += load_chain(chain_pem)
    if not certs:
        raise SiteTlsError("no certificate in the PEM")
    key = load_key(key_pem)
    pub = key.public_key().public_bytes(
        serialization.Encoding.DER, serialization.PublicFormat.SubjectPublicKeyInfo)
    leaf_idx = next((i for i, c in enumerate(certs) if c.public_key().public_bytes(
        serialization.Encoding.DER, serialization.PublicFormat.SubjectPublicKeyInfo) == pub), None)
    if leaf_idx is None:
        raise SiteTlsError("the private key does not match any certificate in the PEM")
    leaf = certs.pop(leaf_idx)
    facts = cert_facts(leaf)
    now = datetime.now(UTC)
    if leaf.not_valid_after_utc <= now:
        raise SiteTlsError(f"the certificate expired on {leaf.not_valid_after_utc:%Y-%m-%d}")
    if leaf.not_valid_before_utc > now + timedelta(minutes=5):
        raise SiteTlsError(f"the certificate is not valid before {leaf.not_valid_before_utc:%Y-%m-%d %H:%M}")
    full = "".join(c.public_bytes(serialization.Encoding.PEM).decode("ascii") for c in [leaf] + certs)
    return full, key_pem.strip() + "\n", facts


def drop_pair(cert_pem: str, key_pem: str, *, source: str, reason: str, user=None,
              chain_pem: str = "", request=None, issuer=None) -> dict:
    """Write the pair and the stamp; the root unit takes it from there.
    Returns the leaf's facts."""
    from .models import SiteCertificate

    full, key, facts = validate_pair(cert_pem, key_pem, chain_pem)
    d = drop_dir()
    d.mkdir(parents=True, exist_ok=True)
    cert_path, key_path = d / CERT_NAME, d / KEY_NAME
    # The key first, 0600 from the first byte; the stamp last, so the unit
    # never sees a half-written pair.
    tmp_key = d / (KEY_NAME + ".tmp")
    with open(os.open(tmp_key, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600), "w") as fd:
        fd.write(key)
    tmp_key.replace(key_path)
    key_path.chmod(0o600)
    tmp_cert = d / (CERT_NAME + ".tmp")
    tmp_cert.write_text(full)
    tmp_cert.replace(cert_path)
    cert_path.chmod(0o644)
    sha = hashlib.sha256(full.encode("ascii")).hexdigest()
    (d / STAMP).write_text(json.dumps({"sha256": sha, "reason": reason,
                                       "at": timezone.now().isoformat()}) + "\n")
    row = SiteCertificate.load()
    row.source = source
    row.names = facts["names"] or [_san_entry(facts["cn"])] if facts["cn"] else facts["names"]
    row.dropped_sha256 = sha
    row.dropped_at = timezone.now()
    row.dropped_reason = reason[:200]
    if user is not None and getattr(user, "pk", None):
        row.updated_by = user
    if request is not None or source != SiteCertificate.Source.ACME:
        row.request = request
    if issuer is not None or source != SiteCertificate.Source.ACME:
        row.issuer = issuer
    row.save()
    log.info("site certificate dropped: %s (%s)", facts["subject"], reason)
    return facts


def apply_state() -> dict:
    """What the root unit did with the last drop, whether the unit exists,
    and whether the app can write the drop folder at all (an installer's
    umask can leave it root-only - then nothing can be dropped)."""
    d = drop_dir()
    applied: dict = {}
    try:
        applied = json.loads((d / APPLIED).read_text())
    except (OSError, ValueError):
        applied = {}
    try:
        pending = (d / STAMP).exists()
    except OSError:
        pending = False
    writable = os.access(d, os.W_OK | os.X_OK) if os.path.isdir(d) else os.access(d.parent, os.W_OK)
    return {
        "unit_installed": UNIT_FILE.exists(),
        "pending": pending,
        "applied": applied or None,
        "writable": writable,
        "drop_dir": str(d),
    }


# ─── self-signed ──────────────────────────────────────────────────────────────

def make_self_signed(names: list[str], days: int = SELF_SIGNED_DAYS) -> tuple[str, str]:
    """A fresh RSA-2048 pair for ``names`` (``DNS:``/``IP:`` entries or bare
    names). The first name is the CN, like the installer's."""
    entries = [n if ":" in n and n.split(":", 1)[0] in {"DNS", "IP"} else _san_entry(n)
               for n in names if n.strip()]
    if not entries:
        raise SiteTlsError("at least one name is needed")
    if "DNS:localhost" not in entries:
        entries.append("DNS:localhost")
    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    cn = entries[0].split(":", 1)[1]
    subject = x509.Name([x509.NameAttribute(x509.NameOID.COMMON_NAME, cn)])
    san = []
    for e in entries:
        kind, value = e.split(":", 1)
        san.append(x509.IPAddress(ipaddress.ip_address(value)) if kind == "IP" else x509.DNSName(value))
    now = datetime.now(UTC)
    cert = (
        x509.CertificateBuilder()
        .subject_name(subject).issuer_name(subject)
        .public_key(key.public_key())
        .serial_number(x509.random_serial_number())
        .not_valid_before(now - timedelta(minutes=5))
        .not_valid_after(now + timedelta(days=days))
        .add_extension(x509.SubjectAlternativeName(san), critical=False)
        .add_extension(x509.BasicConstraints(ca=False, path_length=None), critical=True)
        .sign(key, hashes.SHA256())
    )
    cert_pem = cert.public_bytes(serialization.Encoding.PEM).decode("ascii")
    key_pem = key.private_bytes(
        serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8,
        serialization.NoEncryption()).decode("ascii")
    return cert_pem, key_pem


def current_names() -> list[str]:
    """The names to keep answering for: what is served now plus the public
    host, so a regeneration never costs the site a way of being reached."""
    facts = served()
    names = list(facts["names"]) if facts else []
    host = public_host()
    if host and _san_entry(host) not in names:
        names.append(_san_entry(host))
    return names


def renew_self_signed_if_due(now=None) -> bool:
    """On the expiry beat: a self-signed site with auto-renew on and under
    thirty days left gets a fresh pair for the same names."""
    from .models import SiteCertificate

    row = SiteCertificate.load()
    if row.source != SiteCertificate.Source.SELF_SIGNED or not row.auto_renew:
        return False
    facts = served()
    if facts is None or not facts["self_signed"] or facts["days_left"] >= SELF_SIGNED_RENEW_DAYS:
        return False
    cert_pem, key_pem = make_self_signed(current_names())
    drop_pair(cert_pem, key_pem, source=SiteCertificate.Source.SELF_SIGNED,
              reason=f"auto-renewed with {facts['days_left']} days left")
    return True


# ─── ACME ──────────────────────────────────────────────────────────────────────

LETSENCRYPT_DIRECTORY = "https://acme-v02.api.letsencrypt.org/directory"
LETSENCRYPT_NAME = "Let's Encrypt"


def secret_store_ready() -> bool:
    """ACME needs somewhere to keep the site's private key between renewals."""
    from monitoring.secret_store import active_secret_store

    try:
        return active_secret_store() is not None
    except Exception:  # noqa: BLE001
        return False


def letsencrypt_issuer(tenant, user, email: str):
    """The tenant's Let's Encrypt issuer, made on first use - so getting a
    public certificate is one step, not "add an issuer first"."""
    from monitoring.models import Issuer

    issuer = Issuer.objects.filter(tenant=tenant, directory_url=LETSENCRYPT_DIRECTORY).first()
    if issuer is None:
        if not email or "@" not in email:
            raise SiteTlsError("Let's Encrypt wants a contact email for the account")
        issuer = Issuer.objects.create(
            tenant=tenant, name=LETSENCRYPT_NAME, kind=Issuer.Kind.ACME, enabled=True,
            directory_url=LETSENCRYPT_DIRECTORY, contact_email=email,
            created_by=user if getattr(user, "pk", None) else None,
        )
    elif not issuer.enabled:
        issuer.enabled = True
        issuer.save(update_fields=["enabled", "updated_at"])
    return issuer

class SelfServedHttpPublisher:
    """HTTP-01 answered by Danbyte itself: the challenge is on the order row
    the moment it is opened and ``/.well-known/acme-challenge/<token>`` serves
    it, so publishing is nothing and cleaning up is nothing."""

    def publish(self, records) -> None:
        return None

    def cleanup(self, records) -> None:
        return None


def start_acme(tenant, user, issuer, challenge_type: str, names: list[str]):
    """A certificate request for the site's names and an order against
    ``issuer``, issued in the background. DNS-01 needs the issuer's
    auto-publisher; HTTP-01 is served by Danbyte itself (nginx has to hand
    ``/.well-known/acme-challenge/`` to it, which the shipped site does)."""
    import django_rq

    from monitoring import csr as csr_mod
    from monitoring.acme_engine import publisher_for
    from monitoring.models import AcmeOrder

    from .models import SiteCertificate

    entries = [n if ":" in n else _san_entry(n) for n in names if n.strip()]
    if not entries:
        raise SiteTlsError("at least one name is needed")
    dns = [e.split(":", 1)[1] for e in entries if e.startswith("DNS:")]
    ips = [e.split(":", 1)[1] for e in entries if e.startswith("IP:")]
    if not dns:
        raise SiteTlsError("an ACME certificate needs at least one DNS name")
    if challenge_type == AcmeOrder.Challenge.DNS01 and publisher_for(issuer) is None:
        raise SiteTlsError("this issuer has no DNS-01 auto-publisher - pick HTTP-01, or add one")
    if not secret_store_ready():
        raise SiteTlsError("no secret store is enabled - turn one on under Settings → Security "
                           "→ Secret store first; the site's private key lives there between renewals")
    req, _ = csr_mod.generate(
        tenant=tenant, user=user, common_name=dns[0], san_dns=dns, san_ip=ips,
        key_spec="ec-p256", notes="The certificate Danbyte itself is served on.",
    )
    order = AcmeOrder.objects.create(
        tenant=tenant, issuer=issuer, request=req, challenge_type=challenge_type,
        created_by=user if getattr(user, "pk", None) else None,
    )
    row = SiteCertificate.load()
    row.source = SiteCertificate.Source.ACME
    row.request = req
    row.issuer = issuer
    row.names = entries
    if getattr(user, "pk", None):
        row.updated_by = user
    row.save()
    django_rq.get_queue("default").enqueue("core.site_tls.issue_site_order_job", str(order.id))
    return order


def issue_site_order_job(order_id) -> None:
    """RQ: issue an order for the site - HTTP-01 through the self-served
    publisher, DNS-01 through the issuer's own."""
    from monitoring.acme_engine import AcmeError, issue, publisher_for, register_account
    from monitoring.models import AcmeOrder

    order = AcmeOrder.objects.select_related("issuer", "request").filter(id=order_id).first()
    if order is None:
        return
    publisher = SelfServedHttpPublisher() if order.challenge_type == AcmeOrder.Challenge.HTTP01 \
        else publisher_for(order.issuer)
    try:
        # One click means the account too: an issuer added a moment ago (or
        # Let's Encrypt made on first use) has none yet.
        if not order.issuer.account_uri:
            register_account(order.issuer)
            order.issuer.refresh_from_db()
        issue(order, publisher)
    except AcmeError as exc:
        order.refresh_from_db()
        if order.status not in (AcmeOrder.Status.INVALID, AcmeOrder.Status.VALID):
            order.status = AcmeOrder.Status.ERRORED
            order.error = str(exc)
            order.save(update_fields=["status", "error", "updated_at"])


def on_issued(order, fullchain_pem: str) -> None:
    """Called by the engine after any order is finalised: when the order
    belongs to the site's request, the new pair goes to the drop folder.
    Renewals come through here too, so the site stays current on its own."""
    from monitoring import csr as csr_mod

    from .models import SiteCertificate

    row = SiteCertificate.objects.filter(pk=1).first()
    if row is None or row.source != SiteCertificate.Source.ACME or row.request_id != order.request_id:
        return
    try:
        key_pem = csr_mod.get_private_key(order.request)
        drop_pair(fullchain_pem, key_pem, source=SiteCertificate.Source.ACME,
                  reason=f"issued by {order.issuer.name}", request=order.request,
                  issuer=order.issuer)
    except Exception:  # noqa: BLE001 - the order is fine; the drop is what failed
        log.exception("site certificate: issued but could not drop the pair")


def challenge_content(token: str) -> str | None:
    """The key authorisation for a pending HTTP-01 token, from any open
    order - what ``/.well-known/acme-challenge/<token>`` answers."""
    from monitoring.models import AcmeOrder

    if not token or len(token) > 200 or not all(c.isalnum() or c in "-_" for c in token):
        return None
    for order in AcmeOrder.objects.filter(
            challenge_type=AcmeOrder.Challenge.HTTP01,
            status__in=[AcmeOrder.Status.PENDING, AcmeOrder.Status.PROCESSING, "ready"]):
        for ch in order.challenges or []:
            if ch.get("token") == token:
                return ch.get("content") or None
    return None


# ─── the card ───────────────────────────────────────────────────────────────────

def status() -> dict:
    from monitoring.models import AcmeOrder

    from .models import SiteCertificate

    row = SiteCertificate.load()
    host = public_host()
    s = served(host)
    if s:
        s = {**s, "not_before": s["not_before"].isoformat(), "not_after": s["not_after"].isoformat()}
    out = {
        "host": host,
        "served": s,
        "secret_store": secret_store_ready(),
        "source": row.source,
        "auto_renew": row.auto_renew,
        "names": row.names,
        "dropped_sha256": row.dropped_sha256,
        "dropped_at": row.dropped_at,
        "dropped_reason": row.dropped_reason,
        "apply": apply_state(),
        "acme": None,
    }
    if row.source == SiteCertificate.Source.ACME and row.request_id:
        order = (AcmeOrder.objects.filter(request_id=row.request_id)
                 .select_related("issuer").order_by("-created_at").first())
        out["acme"] = {
            "issuer": {"id": str(row.issuer_id), "name": row.issuer.name} if row.issuer_id else None,
            "request_id": str(row.request_id),
            "order": {"id": str(order.id), "status": order.status, "error": order.error,
                      "challenge_type": order.challenge_type, "created_at": order.created_at,
                      "identifiers": order.identifiers} if order else None,
        }
    return out
