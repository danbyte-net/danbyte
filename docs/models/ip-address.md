---
icon: lucide/circle
---

# IP address

A single IP address. Lives inside exactly one `Prefix`, inherits its VRF.

## Fields

| Field | Type | Default | Notes |
|---|---|---|---|
| `id` | UUID | `uuid4()` | PK |
| `tenant` | FK → `Tenant` | required | Denormalised from `prefix.tenant` |
| `prefix` | FK → `Prefix` | required | The containing prefix |
| `vrf` | FK → `VRF` | NULL | Mirrors `prefix.vrf`; denormalised for the unique constraint |
| `ip_address` | inet | required | |
| `status` | choice | `assigned` | `available` · `assigned` · `reserved` · `dhcp_pool` · `floating` |
| `role` | choice | `""` | `""` · `gateway` · `loopback` · `vip` · `hsrp` · `vrrp` · `anycast` · `secondary` |
| `description` | text | `""` | |
| `mac_address` | char(17) | `""` | Hardware address paired with this IP (e.g. a DHCP reservation) |
| `dns_name` | char(255) | `""` | Hostname / DNS name (PTR). Auto-filled by reverse-DNS monitoring when enabled |
| `last_seen` | datetime | NULL | Last time the check engine saw this IP reachable. Engine-set, read-only |
| `custom_fields` | JSONB | `{}` | Anything org-specific lives here, not as a hardcoded column |
| `tags` | M2M Tag | empty | |

## Uniqueness

```python
UniqueConstraint(
    fields=["tenant", "vrf", "ip_address"],
    nulls_distinct=False,
    name="uniq_ip_tenant_vrf_addr",
)
```

Same IP in two VRFs is fine.

## Status vs role

| Concept | What it means | Examples |
|---|---|---|
| **Status** | Lifecycle | available, assigned, reserved, DHCP-pool, floating |
| **Role** | Functional purpose | gateway, VIP, HSRP, VRRP, loopback, anycast, secondary |

These are orthogonal. An assigned IP can also be a VIP. A reserved IP can have
no role (just a hold).

## Gateway role

Setting an IP's `role = gateway`:

1. Clears `role` on any other IP in the same prefix that was previously gateway
2. Sets `prefix.gateway` to this IP's address

Done via the `_make_gateway(prefix, ip)` helper. Both the auto-spawn flow (on
prefix create) and the "Set as gateway" form-button on the prefix detail page
use it.

## Validation

- Must fall inside its parent prefix's CIDR — enforced in
  `IPAddressSerializer.validate()` (the SPA/API path): rejected with a 400 if the
  address isn't a member of the selected prefix's network, or if its family
  (v4/v6) doesn't match.
- Must not collide with another IP in the same `(tenant, vrf)` — DB-level unique
  constraint (failsafe).

**Host-part prefill** — when adding an IP inside a prefix, the form prefills the
network portion from the prefix CIDR (the fully-fixed leading octets, e.g.
`10.0.10.0/24` → `10.0.10.`) so the operator types only the host part. See
`networkPrefill()` in `frontend/src/components/ip-form.tsx`.

## Related

- [Prefix](prefix.md) — parent model
- [Gateway autospawn](../features/gateway-autospawn.md) — how role=gateway happens automatically
