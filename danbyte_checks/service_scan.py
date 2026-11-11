"""Service scan: which TCP ports answer, and what answers there (#451 B3).

Django-free, so an Outpost can run the same code. Our own code on the
standard library: TCP connect only (no raw packets, no root), one
connection per probe, bounded in bytes and time.

What is sent to a host - nothing else:

* a TCP connect to each port of the list (:data:`DEFAULT_PORTS`, or the
  profile's own), at most :data:`PORT_CONCURRENCY` at once per host, each
  connect paced by the run's :class:`RateLimiter`;
* on an open port, by its number:

  - TLS ports (:data:`TLS_PORTS`): a TLS handshake that reads the
    certificate the server presents (not verified - the scan records it, the
    certificate inventory judges it), then close;
  - HTTP and HTTPS ports (:data:`HTTP_PORTS`, :data:`HTTPS_PORTS`): one
    ``GET / HTTP/1.1`` with :data:`USER_AGENT`, ``Host`` = the address,
    ``Connection: close``; the status line, ``Server``, ``X-Powered-By`` and
    the ``<title>`` are read from at most :data:`HTTP_READ_MAX` bytes.
    A redirect is recorded, never followed;
  - every other port: nothing - the greeting the server sends by itself is
    read for up to :data:`GREETING_SECONDS` (the "NULL probe");
  - an SSH greeting: the server's host key, read with a key exchange only
    (the caller's ``observe_key``; no login).

No logins, no protocol commands, no payloads beyond the above. Every read is
capped (:data:`BANNER_READ_MAX`, :data:`HTTP_READ_MAX`) and has a deadline,
so a slow or flooding peer costs at most the deadline and the cap. Text kept
is stripped of control characters and capped at :data:`BANNER_KEEP`.
"""
from __future__ import annotations

import asyncio
import ipaddress
import re
import ssl
import time
from dataclasses import dataclass, field

from . import fingerprints, netguard

USER_AGENT = "Danbyte-Discovery/1.0 (service scan)"
#: The default port list: (port, service name). Editable per profile.
DEFAULT_PORTS: tuple[tuple[int, str], ...] = (
    (21, "ftp"), (22, "ssh"), (23, "telnet"), (25, "smtp"), (53, "domain"),
    (80, "http"), (88, "kerberos"), (110, "pop3"), (111, "rpcbind"), (135, "msrpc"),
    (139, "netbios-ssn"), (143, "imap"), (389, "ldap"), (443, "https"),
    (445, "microsoft-ds"), (465, "smtps"), (514, "shell"), (587, "submission"),
    (636, "ldaps"), (873, "rsync"), (993, "imaps"), (995, "pop3s"), (1433, "ms-sql"),
    (1521, "oracle"), (2049, "nfs"), (2375, "docker"), (3000, "http-alt"),
    (3306, "mysql"), (3389, "rdp"), (5432, "postgresql"), (5672, "amqp"),
    (5900, "vnc"), (5985, "winrm"), (5986, "winrm-https"), (6379, "redis"),
    (6443, "kubernetes-api"), (8000, "http-alt"), (8080, "http-proxy"),
    (8443, "https-alt"), (9090, "http-alt"), (9200, "elasticsearch"),
    (11211, "memcached"), (27017, "mongodb"),
)
PORT_NAMES = dict(DEFAULT_PORTS)
TLS_PORTS = frozenset({443, 465, 636, 993, 995, 5986, 6443, 8443, 9443})
HTTPS_PORTS = frozenset({443, 5986, 6443, 8443, 9443})
HTTP_PORTS = frozenset({80, 3000, 5985, 8000, 8008, 8080, 8081, 8888, 9090, 9200})
FTP_PORTS = frozenset({21})
SMTP_PORTS = frozenset({25, 465, 587})
MAX_PORTS = 1024
PORT_CONCURRENCY = 8
CONNECT_TIMEOUT = 1.5
GREETING_SECONDS = 2.0
HTTP_SECONDS = 5.0
BANNER_READ_MAX = 2048
HTTP_READ_MAX = 64 * 1024
BANNER_KEEP = 512
TITLE_KEEP = 200

_CONTROL = re.compile(r"[\x00-\x08\x0b-\x1f\x7f-\x9f]")
_SPACE = re.compile(r"[ \t\r\n]+")
_TITLE = re.compile(rb"<title[^>]{0,200}>(.{0,2048}?)</title", re.IGNORECASE | re.DOTALL)


def clean(raw: bytes | str, n: int = BANNER_KEEP) -> str:
    """Printable text: decoded leniently, control characters dropped,
    whitespace runs as one space, capped at ``n``."""
    text = raw.decode("utf-8", "replace") if isinstance(raw, bytes) else str(raw or "")
    text = _SPACE.sub(" ", _CONTROL.sub("", text.replace("�", ""))).strip()
    return text[:n]


def parse_ports(value) -> list[int]:
    """A port list from ints and ``"a-b"`` ranges; raises ValueError."""
    if value in (None, "", []):
        return [p for p, _n in DEFAULT_PORTS]
    if not isinstance(value, list):
        raise ValueError("A list of ports or ranges.")
    out: set[int] = set()
    for item in value:
        if isinstance(item, bool):
            raise ValueError("Not a port.")
        if isinstance(item, int):
            lo = hi = item
        elif isinstance(item, str) and re.fullmatch(r"\d{1,5}(-\d{1,5})?", item.strip()):
            a, _, b = item.strip().partition("-")
            lo, hi = int(a), int(b or a)
        else:
            raise ValueError(f"Not a port or range: {str(item)[:20]}")
        if not 1 <= lo <= hi <= 65535:
            raise ValueError(f"Ports run from 1 to 65535: {item}")
        out.update(range(lo, hi + 1))
        if len(out) > MAX_PORTS:
            raise ValueError(f"At most {MAX_PORTS} ports.")
    if not out:
        raise ValueError("At least one port.")
    return sorted(out)


class RateLimiter:
    """At most ``rate`` new connections per second across the whole run."""

    def __init__(self, rate: float):
        self.interval = 1.0 / max(float(rate), 0.1)
        self._next = 0.0
        self._lock = asyncio.Lock()
        self.count = 0

    async def acquire(self) -> None:
        async with self._lock:
            now = time.monotonic()
            wait = self._next - now
            self._next = max(now, self._next) + self.interval
            self.count += 1
        if wait > 0:
            await asyncio.sleep(wait)


@dataclass
class PortResult:
    port: int
    protocol: str = "tcp"
    service: str = ""
    banner: str = ""
    product: str = ""
    vendor: str = ""
    version: str = ""
    cpe: str = ""
    os: str = ""
    source: str = "port"
    rule: str = ""
    confidence: str = "low"
    tls: dict | None = None
    http: dict | None = None
    host_key: dict | None = None

    def as_dict(self) -> dict:
        return {k: getattr(self, k) for k in self.__dataclass_fields__}


@dataclass
class HostResult:
    address: str
    status: str = "ok"           # ok | blocked | unreachable
    message: str = ""
    open: list[PortResult] = field(default_factory=list)
    connects: int = 0


async def _read_capped(reader, limit: int, seconds: float, *, until: bytes = b"") -> bytes:
    """Read at most ``limit`` bytes within ``seconds`` (one deadline for the
    whole read, so a peer trickling bytes cannot hold it open). Stops early
    at EOF, or once ``until`` was seen."""
    deadline = time.monotonic() + seconds
    buf = bytearray()
    while len(buf) < limit:
        left = deadline - time.monotonic()
        if left <= 0:
            break
        try:
            chunk = await asyncio.wait_for(reader.read(min(4096, limit - len(buf))), left)
        except TimeoutError:
            break
        if not chunk:
            break
        buf += chunk
        if until and until in buf:
            break
    return bytes(buf[:limit])


async def _close(writer) -> None:
    if writer is None:
        return
    try:
        writer.close()
        await asyncio.wait_for(writer.wait_closed(), 1.0)
    except (OSError, TimeoutError, ssl.SSLError):
        pass


def _tls_context() -> ssl.SSLContext:
    """Reads the certificate the server presents; verification is left to the
    certificate inventory, so this context checks nothing and is never used
    to send anything but the HTTP request below."""
    ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
    ctx.check_hostname = False
    ctx.verify_mode = ssl.CERT_NONE
    ctx.minimum_version = ssl.TLSVersion.TLSv1_2
    return ctx


def _tls_summary(writer) -> dict | None:
    from .tls_cert import parse_certificate

    obj = writer.get_extra_info("ssl_object")
    if obj is None:
        return None
    der = obj.getpeercert(binary_form=True)
    if not der:
        return None
    try:
        leaf = parse_certificate(der, 0)
    except (ValueError, TypeError):
        return None
    return {
        "fingerprint_sha256": leaf["fingerprint_sha256"],
        "subject_cn": leaf["subject_cn"][:200], "issuer_cn": leaf["issuer_cn"][:200],
        "san_dns": leaf["san_dns"][:20], "not_after": leaf["not_after"],
        "self_signed": leaf["self_signed"], "tls_version": obj.version() or "",
    }


def _host_header(address: str) -> str:
    return f"[{address}]" if ":" in address else address


def parse_http(raw: bytes) -> dict:
    """Status, ``Server``, ``X-Powered-By``, ``Location`` and the title from a
    capped response."""
    head, _sep, body = raw.partition(b"\r\n\r\n")
    lines = head.split(b"\r\n")
    status = 0
    m = re.match(rb"HTTP/\d(?:\.\d)? (\d{3})", lines[0] if lines else b"")
    if m:
        status = int(m.group(1))
    headers: dict[str, str] = {}
    for line in lines[1:100]:
        name, sep, value = line.partition(b":")
        if not sep:
            continue
        key = name.strip().lower().decode("latin-1", "replace")
        if key in ("server", "x-powered-by", "location") and key not in headers:
            headers[key] = clean(value, 200)
    title = ""
    t = _TITLE.search(body[:HTTP_READ_MAX])
    if t:
        title = clean(t.group(1), TITLE_KEEP)
    return {"status": status, "server": headers.get("server", ""),
            "powered_by": headers.get("x-powered-by", ""),
            "location": headers.get("location", ""), "title": title}


def _mysql_greeting(raw: bytes) -> tuple[str, str] | None:
    """(product, version) from a MySQL/MariaDB handshake packet."""
    if len(raw) < 6 or raw[4] != 10:
        return None
    version = raw[5:5 + 64].split(b"\x00", 1)[0]
    if not re.fullmatch(rb"[0-9][0-9A-Za-z.+\-~_]{0,62}", version):
        return None
    text = version.decode("ascii")
    if "mariadb" in text.lower():
        return "MariaDB", text.split("-MariaDB")[0].removeprefix("5.5.5-")
    return "MySQL", text.split("-")[0]


def identify(port: int, banner_raw: bytes, http: dict | None) -> dict:
    """Product, version and CPE from what the port sent."""
    text = clean(banner_raw)
    out: dict = {"service": PORT_NAMES.get(port, ""), "banner": text}
    evidence: list[tuple[str, str]] = []
    if http:
        out["service"] = "https" if port in HTTPS_PORTS else (out["service"] or "http")
        evidence += [("http.server", http.get("server") or ""),
                     ("http.x_powered_by", http.get("powered_by") or ""),
                     ("http.title", http.get("title") or "")]
    elif text.startswith("SSH-"):
        out["service"] = "ssh"
        evidence.append(("ssh.banner", text.split("-", 2)[2] if text.count("-") >= 2 else ""))
    elif (my := _mysql_greeting(banner_raw)) is not None:
        out["service"] = "mysql"
        product, version = my
        vendor, cpe = ("MariaDB", "mariadb:mariadb") if product == "MariaDB" \
            else ("Oracle", "oracle:mysql")
        out.update(product=product, vendor=vendor, version=version, source="danbyte",
                   rule=product, confidence="high" if version else "medium",
                   cpe=fingerprints.cpe23(f"cpe:/a:{cpe}:{version or '-'}"))
        return out
    elif re.match(r"^\d{3}[ -]", text):
        body = text[4:]
        is_ftp = port in FTP_PORTS or "ftp" in text.lower()
        is_smtp = port in SMTP_PORTS or "smtp" in text.lower()
        if is_ftp and not (is_smtp and port in SMTP_PORTS):
            out["service"] = "ftp"
            evidence.append(("ftp.banner", body))
        elif is_smtp:
            out["service"] = "smtp"
            evidence.append(("smtp.banner", body))
    elif text.startswith("+OK"):
        out["service"] = "pop3"
        evidence.append(("pop.banner", text[3:].strip()))
    elif text.startswith("* OK"):
        out["service"] = "imap"
        evidence.append(("imap.banner", text[4:].strip()))
    elif port == 23 and text:
        evidence.append(("telnet.banner", text))
    for kind, value in evidence:
        if not value:
            continue
        hit = fingerprints.match(kind, value)
        if hit:
            out.update(product=hit["product"], vendor=hit["vendor"], version=hit["version"],
                       cpe=hit["cpe"], os=hit["os"], source=hit["source"], rule=hit["rule"],
                       confidence="high" if hit["version"] else "medium")
            return out
    if evidence and any(v for _k, v in evidence):
        out["confidence"] = "medium"
        out["source"] = "banner"
    return out


async def probe_port(address: str, port: int, limiter: RateLimiter, *,
                     connect_timeout: float = CONNECT_TIMEOUT,
                     greeting_seconds: float = GREETING_SECONDS,
                     http_seconds: float = HTTP_SECONDS,
                     observe_key=None) -> PortResult | None:
    """Probe one port; ``None`` when it is not open."""
    await limiter.acquire()
    tls = port in TLS_PORTS
    writer = None
    try:
        reader, writer = await asyncio.wait_for(
            asyncio.open_connection(address, port, ssl=_tls_context() if tls else None,
                                    server_hostname="" if tls else None,
                                    ssl_handshake_timeout=connect_timeout + 3 if tls else None),
            connect_timeout + (3 if tls else 0))
    except (OSError, TimeoutError, ssl.SSLError, ValueError):
        if not tls:
            return None
        # Open but not TLS (or a TLS failure): fall back to a plain greeting.
        await limiter.acquire()
        try:
            reader, writer = await asyncio.wait_for(asyncio.open_connection(address, port),
                                                    connect_timeout)
        except (OSError, TimeoutError):
            return None
        tls = False
    result = PortResult(port=port)
    try:
        if tls:
            result.tls = _tls_summary(writer)
        http = None
        banner = b""
        if port in HTTP_PORTS or port in HTTPS_PORTS:
            request = (f"GET / HTTP/1.1\r\nHost: {_host_header(address)}\r\n"
                       f"User-Agent: {USER_AGENT}\r\nAccept: */*\r\n"
                       "Connection: close\r\n\r\n").encode("ascii")
            writer.write(request)
            await asyncio.wait_for(writer.drain(), http_seconds)
            raw = await _read_capped(reader, HTTP_READ_MAX, http_seconds)
            if raw.startswith(b"HTTP/"):
                http = parse_http(raw)
            else:
                banner = raw[:BANNER_READ_MAX]
        elif not tls:
            banner = await _read_capped(reader, BANNER_READ_MAX, greeting_seconds,
                                        until=b"\n")
        found = identify(port, banner, http)
        for k, v in found.items():
            setattr(result, k, v)
        result.http = http
    except (OSError, TimeoutError, ssl.SSLError):
        result.service = result.service or PORT_NAMES.get(port, "")
    finally:
        await _close(writer)
    if not result.service:
        result.service = PORT_NAMES.get(port, "")
    if result.service == "ssh" and observe_key is not None and result.banner.startswith("SSH-"):
        try:
            result.host_key = await observe_key(address, port=port, timeout=5)
        except Exception:  # noqa: BLE001 - a key read never fails the port
            result.host_key = None
    return result


async def scan_host(address: str, ports: list[int], limiter: RateLimiter, *,
                    port_concurrency: int = PORT_CONCURRENCY, observe_key=None,
                    **timeouts) -> HostResult:
    """Scan one address. Refused (``blocked``) without a connection when it
    is not an IP literal or the target policy refuses it."""
    try:
        ipaddress.ip_address(address)
    except ValueError:
        return HostResult(address, "blocked", "Not an IP address.")
    if netguard.target_blocked(address):
        return HostResult(address, "blocked", "The target policy refuses this address.")
    sem = asyncio.Semaphore(max(1, min(port_concurrency, PORT_CONCURRENCY)))
    before = limiter.count

    async def one(p):
        async with sem:
            return await probe_port(address, p, limiter, observe_key=observe_key, **timeouts)

    found = await asyncio.gather(*(one(p) for p in ports[:MAX_PORTS]))
    out = HostResult(address, open=[r for r in found if r is not None])
    out.connects = limiter.count - before
    return out


async def scan(addresses: list[str], ports: list[int], *, rate: float, hosts_parallel: int,
               observe_key=None, **timeouts) -> list[HostResult]:
    """Scan ``addresses``, ``hosts_parallel`` at a time, every connect of
    the run paced to ``rate`` per second."""
    limiter = RateLimiter(rate)
    sem = asyncio.Semaphore(max(1, hosts_parallel))

    async def one(a):
        async with sem:
            return await scan_host(a, ports, limiter, observe_key=observe_key, **timeouts)

    return list(await asyncio.gather(*(one(a) for a in addresses)))
