---
icon: lucide/spline
---

# Circuits

Circuits are the **WAN and data links you lease from providers** - internet
transit, MPLS, dark fibre, point-to-point - recorded with their provider,
circuit ID, and the sites at each end.

You build them in three layers: **providers** (who you buy from), **circuit
types** (how you classify links), and the **circuits** themselves.

## Add a provider

A provider is the company you lease a circuit from.

1. Open **Circuits → Providers** in the sidebar and click **Add provider**.
2. Give it a **name**.
3. Optionally fill in the **account number**, **portal URL**, and **NOC email /
   phone** so support details live right next to the circuits.
4. Optionally fill in the **support** details - see below.
5. Save.

### Provider support details

What you need in your hand when you open a ticket, kept on the provider rather
than in somebody's mailbox:

- **Support contract** - the reference you quote when filing a case. Separate
  from the account number above: with the same provider these are routinely
  two different references.
- **Support phone** - the line you call, when it differs from the NOC number.
- **Support hours** - a weekly schedule plus the time zone it is stated in,
  the same control [contacts use](contacts.md#working-hours). The provider page
  shows it as one line with an **Open now** / **Outside hours** badge, so you
  can see whether it's worth calling before you dial.
- **Account manager** - pick an existing **contact** where one exists, so their
  own phone, email and hours come along; type a **name** instead for a vendor
  rep nobody has made a record for.

These appear in their own **Support** card on the provider page, rather than
mixed in with the billing fields.

## Add a circuit type

A circuit type classifies your links - *Internet*, *Transit*, *MPLS*, *Dark
Fibre*, anything that fits your network.

1. Open **Circuits → Circuit types** and click **Add circuit type**.
2. Name it and pick a **color** so it stands out in the circuit list.
3. Save.

!!! note "Nothing is pre-filled"
    Danbyte ships no sample providers or circuit types - you create exactly the
    ones your network uses.

## Add a provider network

A provider network is the **far side of a circuit that isn't one of your own
sites** - the provider's IP-transit cloud, an internet-exchange fabric, another
carrier's network. It exists so a circuit's Z end has something real to land on
when it doesn't terminate at your own facility.

1. Open **Circuits → Provider networks** and click **Add provider network**.
2. Pick the **provider** and give the network a **name** (e.g. "Telia IP
   transit"). Optionally record the provider's **service ID** for it.
3. Save.

## Add a circuit

1. Open **Circuits → Circuits** and click **Add circuit**.
2. Choose the **provider** and enter the **circuit ID** (the provider's
   reference for the link). This pair must be unique.
3. Optionally pick a **circuit type** and set a **status**.
4. Optionally record the **install date**, **termination date**, and **commit
   rate** (in kbps).
5. Save, then open the circuit and add its **terminations** (below).

## Terminate a circuit

Each end of a circuit is a **termination** - side **A** and side **Z**. A
termination lands on exactly one of:

- one of your **sites**, or
- a **provider network** (for transit/IX circuits whose far end is the
  provider's cloud).

Each side carries its own physical details: **port speed** and **upstream
speed** (kbps, for asymmetric links), the **cross-connect ID** at the facility,
and **patch-panel info** - so the data an operator needs at the meet-me room
lives on the side it belongs to.

1. Open the circuit's detail page → **Terminations** tab.
2. Add the **A side** (usually your site) and the **Z side** (the far site or a
   provider network).
3. Fill in speeds / cross-connect / patch-panel details as known.
4. Cable the side that lands in your rack to the port it lands on - see
   [Cabling a circuit](../dcim/cabling.md#cabling-a-circuit). A termination
   takes one cable, and the trace from that port then runs out to the circuit.

### Circuit status

| Status | Meaning |
|---|---|
| **Planned** | Ordered or being designed, not yet live. |
| **Provisioning** | Being turned up by the provider. |
| **Active** | In service. |
| **Offline** | Down or administratively disabled. |
| **Deprovisioning** | Being torn down. |
| **Decommissioned** | Retired. |

!!! warning "Providers and types in use can't be deleted"
    If a provider or circuit type still has circuits attached, Danbyte blocks
    the delete. Reassign or remove those circuits first.

## Provider, provider-network & circuit-type pages

Click a **provider**, **provider network**, or **circuit type** name in its
list to open its detail page - the pencil in the header edits it.

- A **provider** page carries its account and NOC contact details up top, a
  **Circuits** tab listing every circuit you lease from that provider, and a
  **Networks** tab for the provider networks it operates.
- A **provider network** page shows its provider and service ID, with a
  **Circuits** tab listing the circuits that terminate on it.
- A **circuit type** page shows the type's colored badge, slug, color and
  description, with a **Circuits** tab answering "what uses this type" - the
  check to run before you edit or delete a type. It also carries **Journal**
  and **Change log** tabs, so every change ever recorded against the type is
  readable there.

All three circuit lists are the same table the main Circuits page draws. They
are powered by `GET /api/circuits/?provider=<id>`, `?provider_network=<id>`,
and `?type=<id>`.

## Tags & custom fields

Need to track something extra - a contract end date, an SLA tier, an order
number? Add a **custom field** for circuits and it appears on every circuit's
form. See [Tags & custom fields](tags-and-custom-fields.md).
