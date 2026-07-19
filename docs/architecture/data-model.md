---
icon: lucide/network
---

# Data model

The whole shape on one page. Boxes are models, arrows are FKs.

```
Organization                                 [Tag] (global today; per-tenant Phase 5)
  │
  ▼
Tenant ──── hard isolation boundary ──────┐
  ├─ sites    : Site[]                    │
  ├─ vrfs     : VRF[]                     │
  ├─ vlans    : VLAN[]                    │
  ├─ device_types : DeviceType[]          │  every domain model
  ├─ devices  : Device[]                  │  carries  tenant FK
  ├─ prefixes : Prefix[]                  │
  ├─ ip_addresses : IPAddress[]           │
  └─ cables   : Cable[]                   │
                                           │
VRF (tenant-scoped)                        │
  └─ prefixes : Prefix[]                   │
  └─ ip_addresses : IPAddress[]            │
  └─ sites    : Site[]   (M2M, docs only)  │
                                           │
Site (tenant-scoped, location)             │
  ├─ name                                  │
  ├─ gateway_policy : first | last | none  │
  └─ vrfs   : VRF[]   (M2M, docs only)     │
                                           │
Prefix (tenant + vrf scoped)               │
  ├─ cidr                                  │
  ├─ status : container | active | reserved | deprecated
  ├─ site → Site                           │
  ├─ vlan → VLAN                           │
  ├─ vrf  → VRF | NULL (Global)            │
  ├─ gateway : IP string                   │
  ├─ custom_fields : JSONB                 │
  ├─ tags : Tag[]   (via TaggedItem)       │
  └─ ip_addresses : IPAddress[]            │
                                           │
IPAddress (tenant + vrf scoped)            │
  ├─ ip_address                            │
  ├─ status : available | assigned | reserved | dhcp_pool | floating
  ├─ role   : '' | gateway | loopback | vip | hsrp | vrrp | anycast | secondary
  ├─ prefix → Prefix                       │
  └─ vrf    → VRF | NULL                   ┘
```

## Mixins, by which every domain model gets ...

```python
class TimestampedModel(Model):
    created_at = DateTimeField(auto_now_add=True)
    updated_at = DateTimeField(auto_now=True)
    class Meta: abstract = True

class CustomFieldsMixin(Model):
    custom_fields = JSONField(default=dict, blank=True)
    class Meta: abstract = True

class TaggableMixin(Model):
    tags = TaggableManager(blank=True, through=TaggedItem)
    class Meta: abstract = True
```

`Prefix`, `IPAddress`, `Site`, `DeviceType`, `Device`, `VLAN`, `Cable` all
multi-inherit these three.

## Custom Tag with color

`core.Tag` subclasses taggit's `TagBase` to add `color` (hex string). The
`TaggedItem` through-model uses `GenericUUIDTaggedItemBase` because all our
content models have UUID PKs (the default `IntegerField` `object_id` overflows
on UUID values).

## Uniqueness constraints

| Model | Unique on |
|---|---|
| `Tenant` | `(org, slug)` and `(org, name)` |
| `Site` | `(tenant, name)` |
| `VRF` | `(tenant, name)` |
| `VLAN` | `(tenant, vlan_id)` |
| **`Prefix`** | **`(tenant, vrf, cidr)` with `nulls_distinct=False`** ← critical |
| **`IPAddress`** | **`(tenant, vrf, ip_address)` with `nulls_distinct=False`** |
| `DeviceType` | `(tenant, name)` |
| `Device` | `(tenant, name)` |

## Conventional VRF = NULL

We don't seed a "Global" VRF row. `vrf=NULL` *is* the Global VRF — that's why
`nulls_distinct=False` is load-bearing. See [Tenant + VRF](tenant-vrf.md) for
the full reasoning.
