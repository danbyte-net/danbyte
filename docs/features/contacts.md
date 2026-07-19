---
icon: lucide/contact
---

# Contacts

Contacts are the **people and teams responsible for your infrastructure** — and
you can attach them to almost any object (a site, a device, and more) in a
specific role and priority.

You build it in three layers: **contact groups** and **contact roles** (how you
organize and classify contacts), the **contacts** themselves, and then
**attaching** a contact to the objects it's responsible for.

## Add a contact group or role

- A **contact group** bundles related contacts together — for example by team,
  vendor, or department.
- A **contact role** describes the capacity a contact acts in — *technical*,
  *billing*, *on-call*, and so on.

For either, open the matching page under **Organization** in the sidebar
(**Contact groups** or **Contact roles**), click **Add**, give it a **name** and
**slug**, and save.

Contact groups can **nest**: pick a **parent group** on the form to build a tree
(*Vendors → Carriers → Acme NOC*). A group can't be its own ancestor — Danbyte
blocks cycles — and NetBox contact-group trees import losslessly.

!!! note "Nothing is pre-filled"
    Danbyte ships no sample groups or roles — you create exactly the ones your
    organization uses.

## Add a contact

1. Open **Organization → Contacts** and click **Add contact**.
2. Give it a **name** (must be unique).
3. Optionally fill in the **title**, **phone**, **email**, **address**, and a
   **link** (such as a profile or ticket queue), and put it in a **group**.
4. Save.

## Attach a contact to an object

Once a contact exists, attach it to the things it's responsible for. Open the
detail page of a **site** or **device** and go to its **Contacts** tab.

1. Click to attach a contact.
2. Pick the **contact**.
3. Choose the **role** it acts in here (technical, billing, …).
4. Set a **priority** — primary, secondary, tertiary, or inactive.
5. Save.

The same contact can be attached to many objects, each with its own role and
priority. To remove an attachment, detach it from that object's Contacts tab.

!!! tip "See where a contact is used"
    Open any contact to see an **Attached to** list — every object it's currently
    responsible for, with a link to each.

!!! warning "Groups and roles in use can't be deleted"
    If a group or role is still referenced by a contact or an attachment, Danbyte
    blocks the delete. Clear those references first.

## Tags & custom fields

Need to track something extra — a Slack handle, an escalation tier, working
hours? Add a **custom field** for contacts and it appears on every form. See
[Tags & custom fields](tags-and-custom-fields.md).
