import { useEffect, useState } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { toast } from "sonner"

import {
  api,
  type InterfaceOption,
  type Paginated,
  type TunnelTermination,
  type TunnelTerminationRole,
  type TunnelTerminationWritePayload,
  type VMInterface,
} from "@/lib/api"
import { apiAll } from "@/lib/api-all"
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
  FormSection,
  FormSelect,
  FormText,
  useFieldErrors,
} from "@/components/forms"
import { DevicePicker } from "@/components/device-picker"
import { IpPicker } from "@/components/ip-picker"
import { cn } from "@/lib/utils"
import { useSaveObject } from "@/lib/save-object"

const ROLE_OPTIONS: { value: TunnelTerminationRole; label: string }[] = [
  { value: "peer", label: "Peer" },
  { value: "hub", label: "Hub" },
  { value: "spoke", label: "Spoke" },
]

type EndpointKind = "device" | "vm"

/**
 * Add or edit a tunnel termination: pick a role, then a device interface or
 * a VM interface (cascading pickers), and optionally an outside IP. POSTs to
 * `/api/tunnel-terminations/` (or PATCHes the row when `termination` is set)
 * and invalidates the tunnel detail query.
 */
/** "" ⇄ null for an optional number input. */
function numOrNull(v: string): number | null {
  const n = Number(v)
  return v.trim() === "" || Number.isNaN(n) ? null : n
}

export function TunnelTerminationDialog({
  tunnelId,
  encapsulation,
  termination,
  open,
  onOpenChange,
}: {
  tunnelId: string
  /** The tunnel's encapsulation: WireGuard fields show for `wireguard` only. */
  encapsulation?: string
  /** When set, the dialog edits this termination instead of creating one. */
  termination?: TunnelTermination | null
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const qc = useQueryClient()
  const { fieldErrors, handleApiError, reset } = useFieldErrors()
  const isWireguard = encapsulation === "wireguard"
  const saveObject = useSaveObject()

  const [role, setRole] = useState<TunnelTerminationRole>("peer")
  const [kind, setKind] = useState<EndpointKind>("device")
  const [deviceId, setDeviceId] = useState<string | null>(null)
  const [interfaceId, setInterfaceId] = useState<string | null>(null)
  const [vmId, setVmId] = useState<string | null>(null)
  const [vmInterfaceId, setVmInterfaceId] = useState<string | null>(null)
  const [outsideIpId, setOutsideIpId] = useState<string | null>(null)
  const [listenPort, setListenPort] = useState("")
  const [publicKey, setPublicKey] = useState("")
  const [privateKeyRef, setPrivateKeyRef] = useState("")
  const [allowedIps, setAllowedIps] = useState("")
  const [endpointPort, setEndpointPort] = useState("")
  const [keepalive, setKeepalive] = useState("")

  // Reset the form every time the dialog opens - blank for create, prefilled
  // from the row being edited.
  useEffect(() => {
    if (!open) return
    const t = termination ?? null
    setRole(t?.role ?? "peer")
    setKind(t?.vm_interface ? "vm" : "device")
    setDeviceId(t?.interface?.device.id ?? null)
    setInterfaceId(t?.interface?.id ?? null)
    setVmId(t?.vm_interface?.vm.id ?? null)
    setVmInterfaceId(t?.vm_interface?.id ?? null)
    setOutsideIpId(t?.outside_ip?.id ?? null)
    setListenPort(t?.listen_port != null ? String(t.listen_port) : "")
    setPublicKey(t?.public_key ?? "")
    setPrivateKeyRef(t?.private_key_ref ?? "")
    setAllowedIps((t?.allowed_ips ?? []).join(", "))
    setEndpointPort(t?.endpoint_port != null ? String(t.endpoint_port) : "")
    setKeepalive(
      t?.persistent_keepalive != null ? String(t.persistent_keepalive) : ""
    )
    reset()
  }, [open, termination, reset])

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
      apiAll<{ id: string; name: string }>("/api/virtual-machines/?picker=1"),
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

  const canSubmit = kind === "device" ? !!interfaceId : !!vmInterfaceId

  const m = useMutation({
    mutationFn: () => {
      const payload: TunnelTerminationWritePayload = {
        tunnel_id: tunnelId,
        role,
        interface_id: kind === "device" ? interfaceId : null,
        vm_interface_id: kind === "vm" ? vmInterfaceId : null,
        outside_ip_id: outsideIpId,
        ...(isWireguard
          ? {
              listen_port: numOrNull(listenPort),
              public_key: publicKey.trim(),
              private_key_ref: privateKeyRef.trim(),
              allowed_ips: allowedIps
                .split(/[\s,]+/)
                .map((x) => x.trim())
                .filter(Boolean),
              endpoint_port: numOrNull(endpointPort),
              persistent_keepalive: numOrNull(keepalive),
            }
          : {}),
      }
      return saveObject<TunnelTermination>({
        objectType: "api.tunneltermination",
        endpoint: "/api/tunnel-terminations/",
        id: termination ? termination.id : undefined,
        payload,
      })
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["tunnel", tunnelId] })
      qc.invalidateQueries({ queryKey: ["tunnels"] })
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
    setDeviceId(null)
    setInterfaceId(null)
    setVmId(null)
    setVmInterfaceId(null)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="xl">
        <DialogHeader>
          <DialogTitle>
            {termination ? "Edit termination" : "Add termination"}
          </DialogTitle>
          <DialogDescription>
            Attach a device or VM interface to this tunnel, optionally with the
            outside IP it terminates on.
          </DialogDescription>
        </DialogHeader>
        <form
          onSubmit={(e) => {
            e.preventDefault()
            if (canSubmit) m.mutate()
          }}
          className="grid gap-4"
        >
          <div className="grid grid-cols-2 gap-3">
            <FormSelect
              label="Role"
              value={role}
              onChange={(v) => setRole((v as TunnelTerminationRole) ?? "peer")}
              options={ROLE_OPTIONS}
            />
            <Field label="Endpoint type">
              <div className="flex h-9 items-center gap-1 rounded-md border border-border p-0.5">
                {(
                  [
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
          </div>

          {kind === "device" ? (
            <div className="grid grid-cols-2 gap-3">
              <DevicePicker
                value={deviceId}
                onChange={(v) => {
                  setDeviceId(v)
                  setInterfaceId(null)
                }}
              />
              <FormCombobox
                label="Interface"
                value={interfaceId}
                onChange={setInterfaceId}
                placeholder={deviceId ? "Pick interface" : "Pick device first"}
                options={(interfaces.data?.results ?? []).map((i) => ({
                  value: i.id,
                  label: i.name,
                }))}
                searchPlaceholder="Search interfaces…"
                emptyText="No interfaces."
              />
            </div>
          ) : (
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
              <FormCombobox
                label="VM interface"
                value={vmInterfaceId}
                onChange={setVmInterfaceId}
                placeholder={vmId ? "Pick interface" : "Pick VM first"}
                options={(vmInterfaces.data?.results ?? []).map((i) => ({
                  value: i.id,
                  label: i.name,
                }))}
                searchPlaceholder="Search interfaces…"
                emptyText="No interfaces."
              />
            </div>
          )}

          <IpPicker
            label="Outside IP"
            hint="optional - the address this end terminates on"
            value={outsideIpId}
            onChange={setOutsideIpId}
            noneLabel="No outside IP"
          />

          {isWireguard && (
            <FormSection title="WireGuard">
              <div className="grid grid-cols-3 gap-3">
                <FormText
                  label="Listen port"
                  type="number"
                  min={1}
                  max={65535}
                  value={listenPort}
                  onChange={setListenPort}
                  error={fieldErrors.listen_port}
                />
                <FormText
                  label="Endpoint port"
                  type="number"
                  min={1}
                  max={65535}
                  value={endpointPort}
                  onChange={setEndpointPort}
                  placeholder={listenPort || undefined}
                  info="The port the far end dials to reach this end, when NAT makes it differ from the listen port. Empty uses the listen port."
                  error={fieldErrors.endpoint_port}
                />
                <FormText
                  label="Keepalive"
                  type="number"
                  min={0}
                  value={keepalive}
                  onChange={setKeepalive}
                  info="Persistent keepalive, in seconds. Empty or 0 is off."
                  error={fieldErrors.persistent_keepalive}
                />
              </div>
              <FormText
                label="Public key"
                mono
                value={publicKey}
                onChange={setPublicKey}
                info="The far ends print it in their peer block. The router can write it back after it generates its key."
                error={fieldErrors.public_key}
              />
              <FormText
                label="Private key reference"
                mono
                value={privateKeyRef}
                onChange={setPrivateKeyRef}
                placeholder="/etc/wireguard/private.key"
                info="Where the key lives, never the key: a <keychain:NAME> placeholder or an absolute path on the box. A pasted key is refused."
                error={fieldErrors.private_key_ref}
              />
              <FormText
                label="Allowed IPs"
                mono
                value={allowedIps}
                onChange={setAllowedIps}
                placeholder="10.0.0.0/24, 10.255.0.1/32"
                info="The addresses behind this end. Every other end routes them to this end in its peer block."
                error={fieldErrors.allowed_ips}
              />
            </FormSection>
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
