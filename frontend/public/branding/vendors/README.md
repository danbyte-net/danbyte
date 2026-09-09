# Vendor marks

Danbyte ships no vendor artwork. Naming a product to say what Danbyte
connects to is referential use and needs no permission; redistributing
someone's logo to every install is a different question, and not one Danbyte
answers on an operator's behalf.

Drop a file here and the matching integration card shows it. The name must
match the `logo` path in `frontend/src/lib/vendors.ts`:

    proxmox.svg     Proxmox® Virtual Environment
    vcenter.svg     VMware vCenter
    windows.svg     Windows Server®
    netbox.svg      NetBox

Get the file from the vendor's own media kit and follow their guideline -
most set a minimum size and a clear-space rule, and forbid recolouring or
redrawing. Proxmox publishes a brandmark for small square placements with a
20px floor; the card gives it 36px with padding.

Everything in this directory except this README is ignored by git.
