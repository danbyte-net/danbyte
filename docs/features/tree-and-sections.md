---
icon: lucide/list-tree
---

# The prefix tree

By default the prefix list groups your prefixes by VRF and draws them as a
**tree**, so a `/16` and the `/24`s carved out of it sit together and indented.
This page explains how that view behaves and when it switches to a flat table.

## Two views, chosen by how you sort

| Sort by | You get | Pages? |
|---|---|---|
| **CIDR** (default) | Sections per VRF, with a tree inside each section | No — sections show in full |
| **Updated, Created, Status, or Site** | A flat, sortable table | Yes — paged (25 per page by default) |

Sort by CIDR when you want the hierarchy. Sort by anything else when you want a
plain ranked list.

## Sections per VRF

In the tree view, prefixes are grouped by VRF first, then nested by containment
within each VRF. What this means in practice:

- **Each VRF is its own section**, with a header showing the VRF name, its route
  distinguisher (if any), and a prefix count. **Global** (no VRF) comes first,
  then named VRFs alphabetically.
- **Nesting resets per VRF.** A `10.0.0.0/16` in *production* doesn't claim a
  `10.0.10.0/24` that lives in *lab* — they're in different sections.
- **IPv4 and IPv6 never mix.** An IPv4 block never parents an IPv6 block, even
  inside the same VRF.

```text
▾ VRF · Global         25 prefixes
   10.0.0.0/16
     └ 10.0.10.0/24
     └ 10.0.20.0/24
   …

▾ VRF · production     3 prefixes        RD 65001:100
   10.0.0.0/16                                ← same CIDR, different VRF — fine
     └ 10.0.10.0/24

▾ VRF · lab            2 prefixes        RD 65001:200
   10.10.0.0/16
     └ 10.10.10.0/24
```

Children carry a faint `└` guide and indent one level per depth, so you can read
the hierarchy at a glance.

## What filters do to the tree

When you apply a filter and a parent prefix is filtered out but its children
match, the children **rise to the top level** of their section rather than
hanging under an invisible parent. Danbyte never draws a "ghost" parent just to
keep the indentation — you only ever see rows that match.

## Edge cases

| Situation | What you see |
|---|---|
| The same CIDR in two VRFs | Two separate rows in two separate sections — no parent/child link between them. |
| A prefix and a smaller block inside it | A tree: the container and its child each get their own row. |
| Both IPv4 and IPv6 in one VRF | One section, with the IPv4 group listed first, then the IPv6 group. |
