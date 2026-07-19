---
icon: lucide/tag
---

# Tag

User-defined label, optionally colored. **Tenant-scoped**: a tag belongs
to the tenant that created it, so tenants never see each other's tag
names. Rows with `tenant = NULL` are legacy deployment-globals from
before scoping — visible to every tenant, writable only by superusers.
Under [enhanced site separation](../access/site-separation.md) a tag can
additionally be local to one site (`owning_site`).

## Fields

| Field | Type | Default | Notes |
|---|---|---|---|
| `id` | int | autoincrement | (taggit-managed) |
| `tenant` | FK → `Tenant` | NULL | NULL = legacy global (superuser-managed) |
| `owning_site` | FK → `Site` | NULL | NULL = global to the tenant; set = site-local |
| `name` | char | unique per tenant | The visible label |
| `slug` | slug | unique per tenant | URL-safe |
| `color` | char(7) | `""` | Optional `#xxxxxx` |

## Rendering

| Tag has | Renders as |
|---|---|
| `color = ""` (colorless) | Neutral zinc-100 chip |
| `color = "#10b981"` etc | Solid colored chip with computed black/white text |

Text color is computed from sRGB luminance:

```python
@property
def text_color(self) -> str:
    if not self.color:
        return ""
    h = self.color.lstrip("#")
    r, g, b = int(h[0:2], 16), int(h[2:4], 16), int(h[4:6], 16)
    luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255
    return "#000" if luminance > 0.6 else "#fff"
```

Threshold of 0.6 biases slightly toward black text on light backgrounds (e.g.
amber gets black text, emerald gets white).

## TaggedItem

Custom `core.TaggedItem(GenericUUIDTaggedItemBase)` — needed because all our
content models have UUID PKs and taggit's default `IntegerField` `object_id`
would overflow.

## Scoping history

Tags started as one global taggit table. Tenant scoping landed with the
enhanced-site-separation work: a data migration stamped each tag with the
tenant(s) actually using it, cloning tags shared by several tenants and
re-pointing that tenant's `TaggedItem` rows, so nobody lost a tag and nobody
kept seeing another tenant's.
