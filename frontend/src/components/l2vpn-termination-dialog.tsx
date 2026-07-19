import { useEffect, useState } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { toast } from "sonner"

import {
  api,
  type InterfaceOption,
  type L2VPNTermination,
  type L2VPNTerminationWritePayload,
  type Paginated,
  type VLANOption,
  type VMInterface,
} from "@/lib/api"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import {
  Field,
  FormCombobox,
  FormSelect,
  useFieldErrors,
} from "@/components/forms"
import { DevicePicker } from "@/components/device-picker"
import { cn } from "@/lib/utils"

type EndpointKind = "vlan" | "device" | "vm"

/**
 * Add or edit an L2VPN termination: pick the endpoint kind (VLAN, device
 * interface, or VM interface), then the endpoint itself — device/VM use
 * cascading pickers. POSTs to `/api/l2vpn-terminations/` (or PATCHes the row
 * when `termination` is set) and invalidates the L2VPN detail query.
 */
export function L2vpnTerminationDialog({
  l2vpnId,
  termination,
  open,
  onOpenChange,
}: {
  l2vpnId: string
  /** When set, the dialog edits this termination instead of creating one. */
  termination?: L2VPNTermination | null
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const qc = useQueryClient()
  const { handleApiError, reset } = useFieldErrors()

  const [kind, setKind] = useState<EndpointKind>("vlan")
  const [vlanId, setVlanId] = useState<string | null>(null)
  const [deviceId, setDeviceId] = useState<string | null>(null)
  const [interfaceId, setInterfaceId] = useState<string | null>(null)
  const [vmId, setVmId] = useState<string | null>(null)
  const [vmInterfaceId, setVmInterfaceId] = useState<string | null>(null)

  // Reset the form every time the dialog opens — blank for create, prefilled
  // from the row being edited.
  useEffect(() => {
    if (!open) return
    const t = termination ?? null
    setKind(t?.interface ? "device" : t?.vm_interface ? "vm" : "vlan")
    setVlanId(t?.vlan?.id ?? null)
    setDeviceId(t?.interface?.device.id ?? null)
    setInterfaceId(t?.interface?.id ?? null)
    setVmId(t?.vm_interface?.vm.id ?? null)
    setVmInterfaceId(t?.vm_interface?.id ?? null)
    reset()
  }, [open, termination, reset])

  const vlans = useQuery({
    queryKey: ["vlans-picker"],
    queryFn: () => api<Paginated<VLANOption>>("/api/vlans/"),
    enabled: open && kind === "vlan",
    staleTime: 10 * 60_000,
  })
  const interfaces = useQuery({
    queryKey: ["interfaces-picker", deviceId],
    queryFn: () =>
      api<Paginated<InterfaceOption>>(
        `/api/interfaces/?device=${deviceId}&page_size=500`
      ),
    enabled: open && kind === "device" && !!deviceId,
  })
  const vms = useQuery({
    queryKey: ["vms-picker"],
    queryFn: () =>
      api<Paginated<{ id: string; name: string }>>(
        "/api/virtual-machines/?picker=1"
      ),
    enabled: open && kind === "vm",
    staleTime: 10 * 60_000,
  })
  const vmInterfaces = useQuery({
    queryKey: ["vm-interfaces-picker", vmId],
    queryFn: () =>
      api<Paginated<VMInterface>>(
        `/api/vm-interfaces/?vm=${vmId}&page_size=500`
      ),
    enabled: open && kind === "vm" && !!vmId,
  })

  const canSubmit =
    kind === "vlan"
      ? !!vlanId
      : kind === "device"
        ? !!interfaceId
        : !!vmInterfaceId

  const m = useMutation({
    mutationFn: () => {
      const payload: L2VPNTerminationWritePayload = {
        l2vpn_id: l2vpnId,
        vlan_id: kind === "vlan" ? vlanId : null,
        interface_id: kind === "device" ? interfaceId : null,
        vm_interface_id: kind === "vm" ? vmInterfaceId : null,
      }
      return termination
        ? api<L2VPNTermination>(`/api/l2vpn-terminations/${termination.id}/`, {
            method: "PATCH",
            body: JSON.stringify(payload),
          })
        : api<L2VPNTermination>("/api/l2vpn-terminations/", {
            method: "POST",
            body: JSON.stringify(payload),
          })
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["l2vpn", l2vpnId] })
      qc.invalidateQueries({ queryKey: ["l2vpns"] })
      toast.success(termination ? "Termination updated" : "Termination added")
      onOpenChange(false)
    },
    onError: (err) => {
      const msg = handleApiError(err)
      if (msg) toast.error(msg)
    },
  })

  function switchKind(next: EndpointKind) {
    if (next === kind) return
    setKind(next)
    setVlanId(null)
    setDeviceId(null)
    setInterfaceId(null)
    setVmId(null)
    setVmInterfaceId(null)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>
            {termination ? "Edit termination" : "Add termination"}
          </DialogTitle>
          <DialogDescription>
            Attach a VLAN, device interface, or VM interface to this L2VPN.
          </DialogDescription>
        </DialogHeader>
        <form
          onSubmit={(e) => {
            e.preventDefault()
            if (canSubmit) m.mutate()
          }}
          className="grid gap-4"
        >
          <Field label="Endpoint type">
            <div className="flex h-9 items-center gap-1 rounded-md border border-border p-0.5">
              {(
                [
                  ["vlan", "VLAN"],
                  ["device", "Device interface"],
                  ["vm", "VM interface"],
                ] as const
              ).map(([value, label]) => (
                <button
                  key={value}
                  type="button"
                  onClick={() => switchKind(value)}
                  className={cn(
                    "inline-flex h-full flex-1 items-center justify-center rounded-[5px] px-2 text-xs font-medium transition-colors",
                    kind === value
                      ? "bg-muted text-foreground"
                      : "text-muted-foreground hover:text-foreground"
                  )}
                >
                  {label}
                </button>
              ))}
            </div>
          </Field>

          {kind === "vlan" && (
            <FormCombobox
              label="VLAN"
              value={vlanId}
              onChange={setVlanId}
              placeholder="Pick VLAN"
              searchPlaceholder="Search VLANs…"
              emptyText="No VLANs."
              options={(vlans.data?.results ?? []).map((v) => ({
                value: v.id,
                label: `${v.vlan_id} · ${v.name}`,
              }))}
            />
          )}

          {kind === "device" && (
            <div className="grid grid-cols-2 gap-3">
              <DevicePicker
                value={deviceId}
                onChange={(v) => {
                  setDeviceId(v)
                  setInterfaceId(null)
                }}
              />
              <FormSelect
                label="Interface"
                value={interfaceId}
                onChange={setInterfaceId}
                placeholder={deviceId ? "Pick interface" : "Pick device first"}
                options={(interfaces.data?.results ?? []).map((i) => ({
                  value: i.id,
                  label: i.name,
                }))}
              />
            </div>
          )}

          {kind === "vm" && (
            <div className="grid grid-cols-2 gap-3">
              <FormCombobox
                label="Virtual machine"
                value={vmId}
                onChange={(v) => {
                  setVmId(v)
                  setVmInterfaceId(null)
                }}
                placeholder="Pick VM"
                searchPlaceholder="Search VMs…"
                emptyText="No virtual machines."
                options={(vms.data?.results ?? []).map((v) => ({
                  value: v.id,
                  label: v.name,
                }))}
              />
              <FormSelect
                label="VM interface"
                value={vmInterfaceId}
                onChange={setVmInterfaceId}
                placeholder={vmId ? "Pick interface" : "Pick VM first"}
                options={(vmInterfaces.data?.results ?? []).map((i) => ({
                  value: i.id,
                  label: i.name,
                }))}
              />
            </div>
          )}

          <div className="mt-2 flex items-center justify-end gap-2">
            <Button
              type="button"
              variant="ghost"
              onClick={() => onOpenChange(false)}
              disabled={m.isPending}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={!canSubmit || m.isPending}>
              {m.isPending
                ? termination
                  ? "Saving…"
                  : "Adding…"
                : termination
                  ? "Save changes"
                  : "Add termination"}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  )
}
