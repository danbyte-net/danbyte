# Vendor marks

Naming a product to say what Danbyte connects to is referential use and needs
no permission. Shipping someone's logo does, so this directory holds only
marks whose owner has said yes in writing. Everything else is
operator-supplied and ignored by git.

## Shipped

`proxmox.svg`, `proxmox-dark.svg` — Proxmox Server Solutions GmbH gave
written permission on 9 September 2026 for the brandmark beside "Proxmox
Virtual Environment" in the app, conditional on following their brand
guideline.

The files are their published stacked lockup with the wordmark group removed
and the viewBox tightened around what remains. The four halves come across
untouched, in their own colours — that is the brandmark, the variant their
guideline sanctions for small spaces (20px floor on screen), and not a
redrawn or recoloured mark. Positive and negative variants swap with the
viewer's theme, because a positive mark on a dark card is the commonest way
to get a logo wrong.

Media kit: <https://proxmox.com/en/about/company-details/media-kit>

## Adding another

Name the file to match the `logo` path in `frontend/src/lib/vendors.ts`:

    vcenter.svg     VMware vCenter
    windows.svg     Windows Server
    netbox.svg      NetBox

Take it from the vendor's own media kit and follow their guideline — most set
a minimum size and a clear-space rule, and forbid recolouring or redrawing.
A card gives the mark 40px with padding around it.

Do not commit one without written permission naming this use. Leave it
ignored instead and let each install supply its own; a card with no file
shows no logo and lays out fine without one.
