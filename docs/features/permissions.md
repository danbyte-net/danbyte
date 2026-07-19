---
icon: lucide/shield
---

# Permissions & access

Permissions control who can see and change what in Danbyte. Access is
**grant-based**: you give people permission to do things — there are no "deny"
rules. A person's access is the sum of everything granted to them directly and
through the groups they belong to.

!!! note "Administrators see everything"
    A full administrator account bypasses all permission checks. Use the
    built-in roles and groups below to give everyone else exactly the access
    they need.

## How access is built

Three pieces work together:

| Piece | What it is |
|---|---|
| **Users** | The people who sign in. |
| **Groups** | Named buckets of people. A group carries permissions, tenant access, and built-in role. Put a user in a group and they inherit all of it. |
| **Permissions** | The actual grants — "may view devices", "may edit prefixes", and so on. You attach them to groups (or directly to users). |

The four things a permission can allow on a type of object are **view**, **add**,
**change**, and **delete**.

## Built-in roles

Danbyte ships three ready-made groups so you don't have to build common roles by
hand. They can't be deleted.

| Group | What members can do |
|---|---|
| **Administrator** | View, add, change, and delete everything — including managing users, groups, and permissions. |
| **Operator** | View, add, and change every object — but not delete. |
| **Read-only** | View everything; change nothing. |

!!! tip "Upgrades don't lock anyone out"
    When permissions were introduced, every existing user was placed into a
    sensible role automatically (admins → Administrator, read-only accounts →
    Read-only, everyone else → Operator). Tighten access from there as needed.

## Managing access

These pages live under **Admin → Access** in the sidebar and are only visible to
people who can manage users.

### Users

1. Go to **Admin → Access → Users** and click **Add user**.
2. Fill in the username, email, and name.
3. Choose how they get a password — see [Inviting people](#inviting-people).
4. Set the toggles you need: **active**, **administrator**, **require two-factor
   sign-in**, and the sign-in source (local account or company directory).
5. Assign one or more **groups** and the **tenants** the user may switch between.
6. Save.

### Groups

1. Go to **Admin → Access → Groups** and click **Add group**.
2. Give it a **name** and an optional **description**.
3. Save, then attach permissions to it (below).

Built-in groups can be edited but not deleted.

### Permissions

A permission is where you decide *who* may do *what*, and optionally *to which
rows*.

1. Go to **Admin → Access → Permissions** and click **Add permission**.
2. Give it a clear **name** (e.g. "Edit production prefixes").
3. Choose the **object types** it applies to — pick specific ones, or **All
   object types**.
4. Tick the **actions** you're granting: view, add, change, delete.
5. (Optional) Limit it to certain **tenants**. Leave empty to cover every tenant
   the person can reach.
6. (Optional) Limit it to certain **sites**. This narrows the object types that
   *belong to* a site — devices, prefixes, IPs, VLANs, racks, interfaces, and
   the like — to those sites only. Object types with no site (VRFs, route
   targets, tags, catalog entries) are unaffected. Leave empty for all sites.

    **Shared objects** (a prefix or VLAN with no site — e.g. a supernet the
    whole company allocates from) are *readable* under a site-scoped grant:
    they're context everyone needs. They are never *writable* under one —
    creating or editing site-less objects is reserved for people whose grant
    isn't limited to sites.
7. (Optional) Add **row constraints** to narrow it to matching rows only — for
   example, only prefixes whose status is active. Without a constraint, the
   permission covers every row of the chosen types.
8. Assign the permission to **groups** and/or **users**.
9. Save.

### Site roles (local IT, in one click)

A common need is *local IT who runs their own site but shouldn't touch others*.
Rather than hand-build the grants, open **Admin → Access → Permissions** and
click **Site role**:

- **Site editor** — can add, edit, and delete everything **in the chosen
  site(s)**, and can **read everything elsewhere**. This is the local-IT recipe:
  full control of their own site, look-but-don't-touch everywhere else.
- **Site viewer** — read-only access to the chosen site(s), and **nothing
  outside them**. Use this when someone should only see their own site.

Pick the role, the site(s), and the users or groups to grant it to. Danbyte
assembles the underlying permissions for you (a site-scoped edit grant plus an
unscoped read grant for the editor; a single site-scoped read grant for the
viewer). You can fine-tune or delete those permissions afterwards like any other.

An editor **reads everything** by default (the "see all, edit only mine" model,
good for cross-site troubleshooting). Tick **"Can only see their own sites"**
for a strict silo — the read-all grant is dropped and they see nothing outside
their sites.

### Set it up when you create the user

You don't have to make the user first and wire permissions second. The
**Create user** (and **Create group**) form has a **Site-scoped access** section:
tick it, choose Editor or Viewer, and pick the sites — the same grants are
assembled in one step as the account is created. In a tenant with
[enhanced site separation](../access/site-separation.md) on, the box is ticked
by default (most new accounts there are local IT).

!!! tip "See what a user can actually do"
    The user's edit page shows an **Access** banner in plain language —
    *"edits their sites · reads everything · Site 1"* — so you don't have to
    read the raw permission rows to answer "what can this person touch?".

!!! tip "Manage it from the site itself"
    Every site has an **Access** tab (open the site, then **Access**) that lists
    who's an editor or viewer there and offers **Assign people** — the same
    template, pre-scoped to that site. It's the natural place to answer "who runs
    this site?" without leaving the site.

### Letting site editors invite their own viewers

By default only an administrator can grant site access. If you turn on
**Settings → General → Let site editors invite their own viewers**, a local site
editor gains an **Invite viewer** button on the **Access** tab of the site(s)
they edit. They can grant **read-only** access to **their own site only** —
nothing wider:

- they can't create new *editors* (that stays an admin job),
- they can't reach any site they don't already edit.

This is enforced on the server, not just hidden in the UI, so it's safe to hand
to local IT in a big multi-site deployment. The toggle is off by default.

!!! note "What 'edit own site' protects"
    A site-scoped editor can't create, move, or edit an object into a site
    outside their scope — the server re-checks the saved object and rolls back if
    it lands out of bounds. That includes the **bulk** actions: a bulk edit that
    would move rows to a foreign site is rejected and rolled back, bulk delete
    requires the *delete* action (not just *change*), and bulk-creating
    interfaces on another site's device is refused. Prefixes are also held to
    the site's address space: a site editor can only carve child prefixes inside
    a prefix that already belongs to one of their sites.

!!! note "Tags and tenants are enforced server-side too"
    Creating, editing, or deleting **tags** requires a `tag` grant, and any
    write to a **tenant** (including deleting one) requires a `tenant` grant —
    both checked by the API itself, not just hidden in the UI. Listing tenants
    and switching between them stays open to every member.

## What people see

The interface mirrors these grants so nobody is offered a button that would only
fail:

- **Sidebar links hide** for sections a person can't view. If a whole section
  becomes empty, its heading disappears too.
- **Add / Edit / Delete buttons hide** on list and detail pages when the person
  lacks the matching grant.
- When a permission is limited by **row constraints**, Edit and Delete hide on
  the specific rows that fall outside it.

!!! warning "The interface hides buttons; the server enforces the rule"
    Hidden buttons are a convenience. Even if someone reaches a restricted action
    another way (an old browser tab, a saved link), the server still refuses it.

## Inviting people

When you create a user, choose how they get their password:

- **Email an invite** (recommended) — the person receives a one-time link to set
  their own password. You never see or handle their password.
- **Set a password** — you type an initial password yourself.

Editing an existing user, the same option lets you **email a password-reset
link**.

!!! note
    Inviting requires an email address on the account and working email settings
    for your deployment. People who sign in through your company directory don't
    need a Danbyte password at all.

## Two-factor sign-in (MFA)

You can require a second step at sign-in for any account.

- Turn it on per user with **require two-factor sign-in**.
- People set up their second factor under their own **Preferences → Two-factor
  authentication**, using either an authenticator app (scan a QR code) or a
  6-digit code sent to their email.

!!! note
    If an account is marked to require two-factor but hasn't set one up yet, it
    can still sign in normally — so nobody gets locked out before they've
    enrolled.

## Company directory (LDAP / Active Directory)

Optional and off by default. When an administrator connects your directory under
**Settings → Directory (LDAP)**, people can sign in with their existing company
credentials. Their Danbyte group membership is kept in sync from their directory
groups every time they sign in, so the directory decides *who's in what* and
Danbyte groups decide *what that means*. Only directory groups you've explicitly
mapped grant anything.

## Related

- [Change log](change-log.md) — who changed what, when.
- [Tags & custom fields](tags-and-custom-fields.md) — extend any object.
