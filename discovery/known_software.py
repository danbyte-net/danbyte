"""Well-known server software and the packages that are it (#451).

Data only. The review queue reads it to propose "create application nginx
and link its packages" when an inventory finds them, or "link the package
names" on an application the tenant already has under that name. Nothing
here is created on its own - it is not seeded.

``packages`` are ``api.package_names`` entries (exact names or a ``*``
glob, per package type). Only names the distributions really ship are
listed: Debian/Ubuntu (deb), RHEL-likes and Fedora (rpm), Alpine (apk).
Earlier entries rank first when several packages of one host match (the
version of ``nginx`` over ``nginx-common``); among equal ranks the shortest
name wins (``postgresql-16`` over ``postgresql-16-postgis-3``).

``eol`` lists the endoflife.date product names to try, in order; the first
one the cached catalog holds becomes the application's end-of-life product,
so each install's version picks its cycle. None when the source has no
product for it (or it is not certain).
"""
from __future__ import annotations

from dataclasses import dataclass, field


@dataclass(frozen=True)
class Known:
    key: str
    name: str
    packages: tuple[str, ...]
    aliases: tuple[str, ...] = ()
    eol: tuple[str, ...] = field(default=())


KNOWN: tuple[Known, ...] = (
    Known("nginx", "nginx",
          ("deb:nginx", "deb:nginx-core", "deb:nginx-full", "deb:nginx-light",
           "deb:nginx-extras", "rpm:nginx", "apk:nginx"),
          eol=("nginx",)),
    Known("apache-httpd", "Apache HTTP Server",
          ("deb:apache2", "rpm:httpd", "apk:apache2"),
          aliases=("apache", "apache2", "httpd", "apache httpd"),
          eol=("apache-http-server",)),
    Known("postgresql", "PostgreSQL",
          ("deb:postgresql-1*", "deb:postgresql-9.*", "rpm:postgresql-server",
           "rpm:postgresql1*-server", "apk:postgresql1*"),
          aliases=("postgres",), eol=("postgresql",)),
    Known("mysql", "MySQL",
          ("deb:mysql-server-core-*", "deb:mysql-server", "rpm:mysql-community-server",
           "rpm:mysql-server"),
          eol=("mysql",)),
    Known("mariadb", "MariaDB",
          ("deb:mariadb-server-core", "deb:mariadb-server", "rpm:mariadb-server",
           "apk:mariadb"),
          eol=("mariadb",)),
    Known("redis", "Redis", ("deb:redis-server", "rpm:redis", "apk:redis"), eol=("redis",)),
    Known("memcached", "Memcached",
          ("deb:memcached", "rpm:memcached", "apk:memcached")),
    Known("mongodb", "MongoDB",
          ("deb:mongodb-org-server", "rpm:mongodb-org-server"), eol=("mongodb",)),
    Known("docker", "Docker Engine",
          ("deb:docker-ce", "deb:docker.io", "rpm:docker-ce", "apk:docker"),
          aliases=("docker", "docker ce"), eol=("docker-engine",)),
    Known("containerd", "containerd",
          ("deb:containerd.io", "deb:containerd", "rpm:containerd.io", "apk:containerd")),
    Known("haproxy", "HAProxy", ("deb:haproxy", "rpm:haproxy", "apk:haproxy"),
          eol=("haproxy",)),
    Known("openssh-server", "OpenSSH server",
          ("deb:openssh-server", "rpm:openssh-server", "apk:openssh-server"),
          aliases=("openssh", "sshd")),
    Known("bind", "BIND", ("deb:bind9", "rpm:bind", "apk:bind"),
          aliases=("bind9", "named"), eol=("bind",)),
    Known("samba", "Samba", ("deb:samba", "rpm:samba", "apk:samba"), eol=("samba",)),
    Known("php", "PHP",
          ("deb:php8*-cli", "deb:php7*-cli", "rpm:php-cli", "apk:php8*"),
          eol=("php",)),
    Known("nodejs", "Node.js", ("deb:nodejs", "rpm:nodejs", "apk:nodejs"),
          aliases=("node", "nodejs"), eol=("nodejs",)),
    Known("python3", "Python", ("deb:python3", "rpm:python3", "apk:python3"),
          aliases=("python3",), eol=("python",)),
    Known("openjdk", "OpenJDK",
          ("deb:openjdk-*-jre-headless", "rpm:java-*-openjdk-headless",
           "apk:openjdk*-jre-headless"),
          aliases=("java",)),
    Known("tomcat", "Apache Tomcat", ("deb:tomcat1*", "deb:tomcat9", "rpm:tomcat"),
          aliases=("tomcat",), eol=("tomcat",)),
    Known("rabbitmq", "RabbitMQ",
          ("deb:rabbitmq-server", "rpm:rabbitmq-server", "apk:rabbitmq-server"),
          eol=("rabbitmq",)),
    Known("elasticsearch", "Elasticsearch", ("deb:elasticsearch", "rpm:elasticsearch"),
          eol=("elasticsearch",)),
    Known("grafana", "Grafana",
          ("deb:grafana", "deb:grafana-enterprise", "rpm:grafana", "rpm:grafana-enterprise",
           "apk:grafana"),
          eol=("grafana",)),
    Known("prometheus", "Prometheus", ("deb:prometheus", "apk:prometheus"),
          eol=("prometheus",)),
    Known("zabbix-server", "Zabbix server",
          ("deb:zabbix-server-pgsql", "deb:zabbix-server-mysql", "rpm:zabbix-server-pgsql",
           "rpm:zabbix-server-mysql"),
          eol=("zabbix",)),
    Known("zabbix-agent", "Zabbix agent",
          ("deb:zabbix-agent2", "deb:zabbix-agent", "rpm:zabbix-agent2", "rpm:zabbix-agent",
           "apk:zabbix-agent"),
          eol=("zabbix",)),
    Known("keepalived", "Keepalived", ("deb:keepalived", "rpm:keepalived", "apk:keepalived")),
    Known("frr", "FRRouting", ("deb:frr", "rpm:frr", "apk:frr"), aliases=("frr",)),
    Known("openvpn", "OpenVPN", ("deb:openvpn", "rpm:openvpn", "apk:openvpn")),
    Known("wireguard", "WireGuard tools",
          ("deb:wireguard-tools", "rpm:wireguard-tools", "apk:wireguard-tools"),
          aliases=("wireguard",)),
    Known("squid", "Squid", ("deb:squid", "rpm:squid", "apk:squid")),
    Known("postfix", "Postfix", ("deb:postfix", "rpm:postfix", "apk:postfix")),
    Known("dovecot", "Dovecot", ("deb:dovecot-core", "rpm:dovecot", "apk:dovecot")),
)

BY_KEY = {k.key: k for k in KNOWN}


def names_of(k: Known) -> set[str]:
    """Lower-case names and slugs a tenant's application may already use."""
    from django.utils.text import slugify

    out = {k.name.lower(), k.key}
    for a in k.aliases:
        out.add(a.lower())
    out |= {slugify(n) for n in list(out)}
    return out
