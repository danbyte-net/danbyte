/**
 * How Danbyte names other people's products.
 *
 * Two rules, both from the owners' own brand guidelines:
 *
 * 1. **The mark goes on the most prominent mention.** Proxmox asks for ® on
 *    the first or most prominent use of the word; Microsoft asks the same for
 *    Windows. So `display` carries the mark and is used for the card title,
 *    the picker option and the page heading - not for every passing sentence,
 *    where `short` is right.
 * 2. **Never as a bare noun, never abbreviated in prose.** It is "Proxmox
 *    Virtual Environment", not "Proxmox"; "Proxmox VE" is the sanctioned
 *    short form.
 *
 * Referring to a product by name to say what Danbyte connects to is
 * referential use and needs no permission. Shipping a vendor's logo is a
 * different question, which is why `logo` is an upload slot rather than a
 * bundled asset - see docs/features/external-sync.md.
 */
export interface Vendor {
  key: string
  /** Most-prominent-mention form, with the trademark symbol. */
  display: string
  /** Running-text form, no symbol - the mark is not repeated. */
  short: string
  /** Where this install keeps the vendor's own mark, if it has it. Nothing
   * ships here: the file is operator-supplied under
   * `frontend/public/branding/vendors/`, which git ignores. Leave unset and
   * the card simply shows no logo. */
  logo?: string
  /** Owner, for the attribution line. Empty when none is claimed. */
  owner?: string
}

/** Keyed by the same string the backend stores as a source `kind`, so an
 * unknown key is possible and the lookup is optional. */
export const VENDORS: Record<string, Vendor | undefined> = {
  proxmox: {
    key: "proxmox",
    display: "Proxmox® Virtual Environment",
    short: "Proxmox VE",
    logo: "/branding/vendors/proxmox.svg",
    owner: "Proxmox Server Solutions GmbH",
  },
  vcenter: {
    key: "vcenter",
    display: "VMware vCenter",
    short: "vCenter",
    owner: "Broadcom Inc.",
  },
  windows: {
    key: "windows",
    display: "Windows Server®",
    short: "Windows",
    owner: "Microsoft Corporation",
  },
  netbox: {
    key: "netbox",
    display: "NetBox",
    short: "NetBox",
    owner: "NetBox Labs",
  },
}

/** The attribution line shown once, under whatever named these vendors.
 *
 * One sentence covering every owner beats a footnote per card: the marks are
 * theirs, and saying so once is what a guideline asks for. */
export function trademarkNotice(keys: string[]): string {
  const owners = [
    ...new Set(
      keys.map((k) => VENDORS[k]?.owner).filter((o): o is string => Boolean(o))
    ),
  ]
  if (owners.length === 0) return ""
  return (
    `Proxmox® is a registered trademark of Proxmox Server Solutions GmbH. ` +
    `Other product names and marks are the property of their respective ` +
    `owners (${owners.filter((o) => !o.startsWith("Proxmox")).join(", ")}). ` +
    `Danbyte is not affiliated with or endorsed by any of them.`
  )
}
