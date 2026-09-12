"""``/ws/monitoring/?ip=<id>`` - the live feed for one address's checks.

Sync consumer like presence: authenticate, resolve the tenant from the
session, check the caller may *view* the address (site-scoped, the same row
filter the API uses), join the address's group, register interest. Every
``monitoring.update`` on the group goes straight to the client; a ``ping``
from the page keeps its interest alive.
"""
from __future__ import annotations

from urllib.parse import parse_qs

from asgiref.sync import async_to_sync
from channels.generic.websocket import JsonWebsocketConsumer

from . import live


class MonitoringLiveConsumer(JsonWebsocketConsumer):
    group = None

    def connect(self):
        user = self.scope.get("user")
        if user is None or not getattr(user, "is_authenticated", False):
            self.close(code=4401)
            return
        session = self.scope.get("session")
        tenant_id = session.get("current_tenant_id") if session else None
        qs = parse_qs(self.scope.get("query_string", b"").decode())
        ip_id = (qs.get("ip", [""])[0]).strip()
        if not (tenant_id and ip_id):
            self.close(code=4400)
            return
        from api.models import IPAddress
        from auth_api import rbac
        from core.models import Tenant

        tenant = Tenant.objects.filter(pk=tenant_id).first()
        if tenant is None:
            self.close(code=4400)
            return
        ip = rbac.restrict_queryset(
            IPAddress.objects.filter(tenant=tenant, id=ip_id), user, tenant, "ipaddress", "view",
        ).first()
        if ip is None:
            self.close(code=4404)
            return
        self.ip_id = str(ip.id)
        self.group = live.group_for(tenant.id, self.ip_id)
        async_to_sync(self.channel_layer.group_add)(self.group, self.channel_name)
        self.accept()
        live.register_interest(self.ip_id)
        self.send_json({"type": "hello", "ip": self.ip_id})

    def receive_json(self, content, **kwargs):
        if content.get("type") == "ping":
            live.register_interest(self.ip_id)

    def disconnect(self, code):
        if self.group:
            async_to_sync(self.channel_layer.group_discard)(self.group, self.channel_name)

    def monitoring_update(self, event):
        self.send_json({"type": "update", "at": event.get("at"), **event["payload"]})
