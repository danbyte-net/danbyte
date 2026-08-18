import { useMemo, useState } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { toast } from "sonner"

import {
  api,
  type DhcpScope,
  type Paginated,
  type Prefix,
  type VRFOption,
  type WindowsConnection,
} from "@/lib/api"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  FormFooter,
  FormSelect,
  FormText,
  useFieldErrors,
} from "@/components/forms"

// The Server select's "no server" sentinel — a local, Danbyte-owned scope.
const LOCAL = "__local__"
// The Prefix select's "type a subnet instead" sentinel.
const NEW_SUBNET = "__new__"

/**
 * Author a DHCP scope. With a server picked, saving pushes it to that Windows
 * server first (Add-DhcpServerv4Scope) — the row only exists once the server
 * accepted it. With "Local", the scope is Danbyte-owned documentation for
 * deployments that don't sync a DHCP server. The subnet comes from an existing
 * prefix (keeping its VRF) or a typed CIDR in a chosen VRF.
 */
export function DhcpScopeDialog({
  onOpenChange,
  onCreated,
}: {
  onOpenChange: (open: boolean) => void
  /** Called with the new scope so a caller can auto-select it. */
  onCreated?: (scope: DhcpScope) => void
}) {
  const qc = useQueryClient()
  const { fieldErrors, handleApiError, reset } = useFieldErrors()
  const [connection, setConnection] = useState("")
  const [name, setName] = useState("")
  const [prefixId, setPrefixId] = useState<string>(NEW_SUBNET)
  const [subnet, setSubnet] = useState("")
  const [vrfId, setVrfId] = useState("")
  const [start, setStart] = useState("")
  const [end, setEnd] = useState("")
  const [description, setDescription] = useState("")

  const conns = useQuery({
    queryKey: ["windows-connections", "dhcp-picker"],
    queryFn: () =>
      api<Paginated<WindowsConnection>>("/api/windows-connections/?page_size=200"),
    staleTime: 5 * 60_000,
  })
  const servers = useMemo(
    () => (conns.data?.results ?? []).filter((c) => c.dhcp_enabled),
    [conns.data]
  )
  const prefixes = useQuery({
    queryKey: ["prefixes-pick", "dhcp-scope"],
    queryFn: () => api<Paginated<Prefix>>("/api/prefixes/?page_size=500"),
    staleTime: 60_000,
  })
  const vrfs = useQuery({
    queryKey: ["vrfs-picker"],
    queryFn: () => api<Paginated<VRFOption>>("/api/vrfs/?picker=1"),
    staleTime: 5 * 60_000,
  })

  const usingPrefix = prefixId !== NEW_SUBNET
  const isLocal = connection === LOCAL

  const save = useMutation({
    mutationFn: () =>
      api<DhcpScope>("/api/dhcp-scopes/", {
        method: "POST",
        body: JSON.stringify({
          connection: isLocal || !connection ? null : connection,
          name: name.trim(),
          ...(usingPrefix
            ? { prefix: prefixId }
            : { subnet: subnet.trim(), vrf: vrfId || null }),
          start_range: start.trim(),
          end_range: end.trim(),
          description: description.trim(),
        }),
      }),
    onSuccess: (scope) => {
      reset()
      toast.success(
        isLocal ? "Local scope created" : "Scope created on the server"
      )
      qc.invalidateQueries({ queryKey: ["dhcp-scopes"] })
      onCreated?.(scope)
      onOpenChange(false)
    },
    onError: (err) => {
      const msg = handleApiError(err)
      if (msg) toast.error(msg)
    },
  })

  const ready =
    connection &&
    name.trim() &&
    (usingPrefix || subnet.trim()) &&
    start.trim() &&
    end.trim()

  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent size="md">
        <DialogHeader>
          <DialogTitle>New DHCP scope</DialogTitle>
        </DialogHeader>
        <form
          onSubmit={(e) => {
            e.preventDefault()
            if (ready) save.mutate()
          }}
          className="grid gap-3"
        >
          <FormSelect
            label="Server"
            value={connection || null}
            onChange={(v) => setConnection(v ?? "")}
            placeholder="Select a server…"
            info="Pick the Windows DHCP server to create the scope on, or Local for a Danbyte-owned scope with no server behind it."
            options={[
              { value: LOCAL, label: "Local — Danbyte-managed" },
              ...servers.map((c) => ({ value: c.id, label: c.name })),
            ]}
            error={fieldErrors.connection}
          />
          <FormText
            label="Name"
            value={name}
            onChange={setName}
            required
            placeholder="Lab clients"
            error={fieldErrors.name}
          />
          <FormSelect
            label="Subnet"
            value={prefixId}
            onChange={(v) => setPrefixId(v ?? NEW_SUBNET)}
            info="Back the scope with an existing prefix (keeping its VRF), or type a new subnet below."
            options={[
              { value: NEW_SUBNET, label: "New subnet…" },
              ...(prefixes.data?.results ?? []).map((p) => ({
                value: p.id,
                label: p.vrf ? `${p.cidr} · ${p.vrf.name}` : p.cidr,
              })),
            ]}
            error={fieldErrors.prefix}
          />
          {!usingPrefix && (
            <div className="grid grid-cols-2 gap-3">
              <FormText
                label="Subnet CIDR"
                value={subnet}
                onChange={setSubnet}
                required
                mono
                placeholder="10.50.0.0/24"
                error={fieldErrors.subnet}
              />
              <FormSelect
                label="VRF"
                value={vrfId || null}
                onChange={(v) => setVrfId(v ?? "")}
                noneLabel="Global"
                options={(vrfs.data?.results ?? []).map((v) => ({
                  value: v.id,
                  label: v.name,
                }))}
                error={fieldErrors.vrf}
              />
            </div>
          )}
          <div className="grid grid-cols-2 gap-3">
            <FormText
              label="Range start"
              value={start}
              onChange={setStart}
              required
              mono
              placeholder="10.50.0.50"
              error={fieldErrors.start_range}
            />
            <FormText
              label="Range end"
              value={end}
              onChange={setEnd}
              required
              mono
              placeholder="10.50.0.200"
              error={fieldErrors.end_range}
            />
          </div>
          <FormText
            label="Description"
            value={description}
            onChange={setDescription}
            placeholder="optional"
            error={fieldErrors.description}
          />
          <p className="text-[11px] text-muted-foreground">
            {isLocal
              ? "A local scope is stored in Danbyte only — nothing is pushed anywhere."
              : "Saving creates the scope on the DHCP server immediately."}
          </p>
          <FormFooter
            onCancel={() => onOpenChange(false)}
            submitting={save.isPending}
            submitLabel="Create scope"
          />
        </form>
      </DialogContent>
    </Dialog>
  )
}
