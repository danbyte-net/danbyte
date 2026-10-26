import { Link } from "@tanstack/react-router"

type Ref = { id: string; name: string } | null

/** The device or VM a PRTG row belongs to, linked; a VM says so. */
export function PrtgParentLink({
  device,
  virtual_machine,
}: {
  device: Ref
  virtual_machine?: Ref
}) {
  if (device)
    return (
      <Link
        to="/devices/$id"
        params={{ id: device.id }}
        className="link font-medium"
      >
        {device.name}
      </Link>
    )
  if (virtual_machine)
    return (
      <Link
        to="/virtual-machines/$id"
        params={{ id: virtual_machine.id }}
        className="link font-medium"
      >
        <span className="mr-1 text-xs font-normal text-muted-foreground">
          VM
        </span>
        {virtual_machine.name}
      </Link>
    )
  return <span className="text-muted-foreground">-</span>
}

/** Sort and search key for the same cell. */
export function prtgParentName(r: {
  device: Ref
  virtual_machine?: Ref
}): string {
  return r.device?.name ?? r.virtual_machine?.name ?? ""
}
