import { useMemo, useState } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { toast } from "sonner"

import {
  api,
  type DhcpScope,
  type Paginated,
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

/**
 * Author a DHCP scope. Saving pushes it to the Windows server first
 * (Add-DhcpServerv4Scope) — the row only exists once the server accepted it.
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
  const [subnet, setSubnet] = useState("")
  const [start, setStart] = useState("")
  const [end, setEnd] = useState("")
  const [description, setDescription] = useState("")

  const conns = useQuery({
    queryKey: ["windows-connections", "dhcp-picker"],
    queryFn: () =>
      api<Paginated<WindowsConnection>>(
        "/api/windows-connections/?page_size=200"
      ),
    staleTime: 5 * 60_000,
  })
  const servers = useMemo(
    () => (conns.data?.results ?? []).filter((c) => c.dhcp_enabled),
    [conns.data]
  )

  const save = useMutation({
    mutationFn: () =>
      api<DhcpScope>("/api/dhcp-scopes/", {
        method: "POST",
        body: JSON.stringify({
          connection,
          name: name.trim(),
          subnet: subnet.trim(),
          start_range: start.trim(),
          end_range: end.trim(),
          description: description.trim(),
        }),
      }),
    onSuccess: (scope) => {
      reset()
      toast.success("Scope created on the server")
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
    connection && name.trim() && subnet.trim() && start.trim() && end.trim()

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
            placeholder={
              servers.length ? "Select a server…" : "No DHCP servers"
            }
            options={servers.map((c) => ({ value: c.id, label: c.name }))}
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
          <FormText
            label="Subnet"
            value={subnet}
            onChange={setSubnet}
            required
            mono
            placeholder="10.50.0.0/24"
            error={fieldErrors.subnet}
          />
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
            Saving creates the scope on the DHCP server immediately.
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
