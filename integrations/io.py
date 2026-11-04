"""Export of the synced DHCP and DNS rows (auto-discovered by
``ApiConfig.ready``).

A synced scope or zone carries no tenant of its own - it rides its Windows
server connection's - and a reservation or lease reaches its tenant through
its scope. The generic handler starts an export from the ``tenant`` column, so
it would miss every synced row; these handlers start from the rows the list
API shows instead. All four are export-only: their writes push to the Windows
server, which only the API does.
"""
from __future__ import annotations

from django.db.models import Q

from api.io import ExportOnlyIOHandler, register_io

from .models import DhcpLease, DhcpReservation, DhcpScope, DnsZone


class _ConnectionTenantIO(ExportOnlyIOHandler):
    """A scope or zone: synced ones through their connection, local ones by
    their own tenant - as ``DhcpScopeViewSet.get_queryset`` scopes them."""

    def tenant_rows(self, tenant):
        return self.model._default_manager.filter(
            Q(connection__tenant=tenant) | Q(connection__isnull=True, tenant=tenant)
        )


class _ScopeTenantIO(ExportOnlyIOHandler):
    """A reservation or lease, through its scope."""

    def tenant_rows(self, tenant):
        return self.model._default_manager.filter(
            Q(scope__connection__tenant=tenant)
            | Q(scope__connection__isnull=True, scope__tenant=tenant)
        )


class DhcpScopeIO(_ConnectionTenantIO):
    model = DhcpScope
    natural_key = ["connection", "scope_id"]


class DnsZoneIO(_ConnectionTenantIO):
    model = DnsZone
    natural_key = ["connection", "name"]


class DhcpReservationIO(_ScopeTenantIO):
    model = DhcpReservation
    natural_key = ["scope", "ip"]
    fk_keys = {"scope": "scope_id"}


class DhcpLeaseIO(_ScopeTenantIO):
    model = DhcpLease
    natural_key = ["scope", "ip"]
    fk_keys = {"scope": "scope_id"}


for _handler in (DhcpScopeIO, DnsZoneIO, DhcpReservationIO, DhcpLeaseIO):
    register_io(_handler())
