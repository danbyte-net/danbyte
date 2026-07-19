---
icon: lucide/route
---

# Gateway autospawn

Gateway autospawn saves you a step: when you create a prefix and leave the
**gateway** field blank, Danbyte can create the gateway IP for you and link it to
the prefix automatically — as long as the prefix's site has a gateway policy.

## Set it up

A site's **gateway policy** decides which address in each new prefix becomes the
gateway. Set it on the site, then never think about it again:

| Policy | Gateway picked |
|---|---|
| **None** (default) | No automatic gateway — you set it yourself, or leave it blank. |
| **First** | The first usable host in the prefix (e.g. `10.0.10.1` in a `/24`). |
| **Last** | The last usable host in the prefix (e.g. `10.0.10.254` in a `/24`). |

You also need a **gateway role** defined in your IP-role catalog so Danbyte knows
which role to mark the new address with. See
[IP statuses & roles](catalogs-and-settings.md).

## What happens when you save

When you create a prefix and leave the gateway blank, Danbyte:

1. Checks the prefix's site for a gateway policy. No site, or policy set to
   **None** → nothing happens.
2. Works out the gateway address from the policy (first or last host).
3. Creates an IP at that address, marked **assigned** with the **gateway** role,
   and notes it was auto-created by the site policy. If an IP already exists at
   that address, Danbyte reuses it and promotes it to the gateway role instead of
   creating a duplicate.
4. Sets the prefix's **gateway** to that address.

The new gateway is scoped to the prefix's **VRF**, so the same block in two
different VRFs gets its own gateway, one per VRF.

## When autospawn is skipped

| Situation | Why it's skipped |
|---|---|
| The prefix has no site | There's no policy to look up. |
| The site's policy is **None** | You've opted out for that site. |
| You filled in the gateway yourself | Your value wins — no automatic address. |
| The prefix is IPv6 | An IPv6 `/64` has no obvious "first host" to use as a default gateway. |

## Setting or changing the gateway by hand

You're never locked in. On a prefix's detail page, each IP row has a
**Set as gateway** action. Using it:

1. Removes the gateway role from whichever IP held it before.
2. Marks this IP as the gateway.
3. Updates the prefix's gateway to this address.

If you later clear the role from the IP that was acting as gateway, the prefix's
gateway field is cleared too, so it never points at a stale address.
