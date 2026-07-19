import { createFileRoute, useNavigate } from "@tanstack/react-router"

import { IpForm } from "@/components/ip-form"
import { EditPageShell } from "@/components/edit-page-shell"
import { Spinner } from "@/components/ui/spinner"
import type { IPAddress } from "@/lib/api"
import { useCloneSeed } from "@/lib/use-clone"

export const Route = createFileRoute("/ips/new")({
  // Keys are optional so partial callers (the prefix flow passes only
  // address/prefix; the interface flow passes only device/interface) stay valid.
  validateSearch: (
    s: Record<string, unknown>
  ): {
    address?: string
    prefix?: string
    device?: string
    interface?: string
    clone?: string
  } => ({
    address: typeof s.address === "string" ? s.address : undefined,
    prefix: typeof s.prefix === "string" ? s.prefix : undefined,
    // Prefill the assignment when adding an IP from a device's interface.
    device: typeof s.device === "string" ? s.device : undefined,
    interface: typeof s.interface === "string" ? s.interface : undefined,
    clone: typeof s.clone === "string" ? s.clone : undefined,
  }),
  component: NewIpPage,
})

function NewIpPage() {
  const {
    address,
    prefix,
    device,
    interface: interfaceId,
    clone,
  } = Route.useSearch()
  const nav = useNavigate()
  const cloneQ = useCloneSeed<Partial<IPAddress>>("ips", clone)
  const cloning = !!clone
  // When launched from a device's interface, send the user back there; the
  // prefix flow keeps returning to the prefix it came from.
  const back = () =>
    device
      ? nav({ to: "/devices/$id", params: { id: device } })
      : prefix
        ? nav({ to: "/prefixes/$id", params: { id: prefix } })
        : nav({ to: "/prefixes" })
  return (
    <EditPageShell
      crumbs={[
        { label: "Prefixes", to: "/prefixes" },
        { label: cloning ? "Clone IP" : "Add IP" },
      ]}
      title={cloning ? "Clone IP address" : "Add IP address"}
      subtitle={
        cloning
          ? "Pre-filled from an existing IP — enter the new address."
          : "Register a new IP in the active tenant."
      }
    >
      {cloning && cloneQ.isLoading ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Spinner className="size-4" /> Loading source IP…
        </div>
      ) : (
        <IpForm
          initial={{ address, prefixId: prefix, deviceId: device, interfaceId }}
          clone={cloning ? cloneQ.data?.initial : undefined}
          onSaved={(ip) => nav({ to: "/ips/$id", params: { id: ip.id } })}
          onCancel={back}
        />
      )}
    </EditPageShell>
  )
}
