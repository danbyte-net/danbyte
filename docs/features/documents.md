---
icon: lucide/paperclip
---

# Documents

Attach **documents** to any object - a device, rack, site, location, or any other
record. A document is either an **uploaded file** (a datasheet, a runbook, a
warranty PDF) or an **external link** (a wiki page, a vendor portal). Both live
together on the object's **Documents** tab.

## Adding a document

On an object's detail page, open the **Documents** tab:

- **Add file** - upload a file with a name, an optional description, and a
  category. Files are size-limited and restricted to a safe set of types
  (PDF, text/CSV, images, common office formats, archives). Scriptable types
  (e.g. SVG, executables) are rejected.
- **Add link** - record an external URL instead of a file. The URL is validated
  when you save (it must resolve to a public address - internal/loopback URLs are
  refused), and a background check flags it if it later goes dead.

## Categories

Group documents with your own **categories** (e.g. *Runbook*, *Warranty*,
*Diagram*). Categories are an editable catalog - create them inline from the
add/edit dialog. There are no built-in categories; you define the vocabulary
that fits your organization.

## Versioning

When a document is replaced, add the new version and mark it as **superseding**
the old one. The list shows the current version; older versions fold away behind
a *show older* toggle, so the history stays without cluttering the view.

## Dead-link checking

External links are re-checked on a daily schedule. A link that stops responding
(or starts returning an error) is flagged with a **broken** badge and the time
it was last checked, so stale references surface on their own instead of rotting
silently. The check fetches through Danbyte's outbound guard, so it can't be used
to probe internal addresses.

## Access & safety

- Documents are **tenant-scoped** and follow the object they're attached to:
  you can only attach a document to - or see documents on - an object you're
  allowed to view, and site separation applies.
- Uploaded files are served through an **authenticated download** endpoint, not a
  public media URL, so a file can't be pulled by guessing its address.
- Managing documents needs the **Documents** permission (view / add / change /
  delete), grantable like any other object type.
- Every create, change, and delete is recorded in the [change log](change-log.md).

## Related

- [Journals](journals.md) - free-text notes on an object (documents are files and
  links; journals are prose).
- [Permissions & access](permissions.md) - grant the Documents permission.
