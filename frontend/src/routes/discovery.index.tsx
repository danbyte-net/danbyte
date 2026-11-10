import { createFileRoute, useNavigate } from "@tanstack/react-router"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { useMemo, useState } from "react"
import { toast } from "sonner"

import { api } from "@/lib/api"
import type { DiscoverySettings, InventoryProfile } from "@/lib/api"
import { apiAll } from "@/lib/api-all"
import { apiErrorToast } from "@/lib/api-toast"
import { useMe } from "@/lib/use-me"
import { useUrlSearch } from "@/lib/url-filters"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { DataTable } from "@/components/data-table"
import { EmptyState } from "@/components/empty-state"
import { ListPageShell } from "@/components/list-page-shell"
import { FormFooter, FormTextarea, useFieldErrors } from "@/components/forms"
import { useUrlTableFilters } from "@/components/table-filters"
import { buildInventoryProfileColumns } from "@/components/columns/inventory-columns"
import { ProfileDialog } from "@/components/discovery/profile-dialog"
import { useDiscoveryStatus } from "@/components/discovery/status"

// Discovery (#451 B2): the tenant's inventory profiles - what package
// inventory reads, when, and who authorised it - and the deny subnets
// nothing here ever contacts. The page is reachable while the Discovery
// integration is on for the tenant and the deployment allows it.

export const Route = createFileRoute("/discovery/")({
  component: DiscoveryPage,
})

function DiscoveryPage() {
  const [q, setQ] = useUrlSearch()
  const { canDo } = useMe()
  const nav = useNavigate()
  const status = useDiscoveryStatus()
  const [creating, setCreating] = useState(false)
  const [denyOpen, setDenyOpen] = useState(false)
  const active = !!status.data?.active
  const query = useQuery({
    queryKey: ["discovery", "profiles", q],
    queryFn: () =>
      apiAll<InventoryProfile>(
        `/api/discovery/profiles/?${new URLSearchParams({ search: q }).toString()}`
      ),
    enabled: active,
  })
  const rows = useMemo(() => query.data?.results ?? [], [query.data])
  const columns = useMemo(() => buildInventoryProfileColumns(), [])
  const {
    rail,
    filteredRows,
    columns: wired,
  } = useUrlTableFilters(columns, rows)

  if (status.data && !active)
    return (
      <div className="p-6">
        <EmptyState title="Discovery is off">
          {status.data.deployment_enabled
            ? "Turn it on under Settings → Integrations."
            : "This deployment does not allow discovery."}
        </EmptyState>
      </div>
    )

  return (
    <ListPageShell
      title="Discovery"
      count={query.data ? filteredRows.length : undefined}
      rail={rail}
      search={{ value: q, onChange: setQ, placeholder: "Filter…" }}
      actions={
        <>
          <Button size="sm" variant="outline" onClick={() => setDenyOpen(true)}>
            Deny subnets
          </Button>
          {canDo("inventoryprofile", "add") && (
            <Button size="sm" onClick={() => setCreating(true)}>
              Add profile
            </Button>
          )}
        </>
      }
      query={
        status.isLoading
          ? { isLoading: true, isError: false, error: null }
          : query
      }
    >
      <DataTable
        data={filteredRows}
        total={query.data?.count}
        columns={wired}
        flexColumn="description"
        tableId="inventory-profiles"
      />
      <ProfileDialog
        open={creating}
        onOpenChange={setCreating}
        profile={null}
        onSaved={(p) => nav({ to: "/discovery/$id", params: { id: p.id } })}
      />
      <DenySubnetsDialog open={denyOpen} onOpenChange={setDenyOpen} />
    </ListPageShell>
  )
}

function DenySubnetsDialog({
  open,
  onOpenChange,
}: {
  open: boolean
  onOpenChange: (o: boolean) => void
}) {
  const qc = useQueryClient()
  const { fieldErrors, handleApiError, reset } = useFieldErrors()
  const q = useQuery({
    queryKey: ["discovery", "settings"],
    queryFn: () => api<DiscoverySettings>("/api/discovery/settings/"),
    enabled: open,
  })
  const [text, setText] = useState<string | null>(null)
  const value = text ?? (q.data?.deny_subnets ?? []).join("\n")
  const save = useMutation({
    mutationFn: () =>
      api<DiscoverySettings>("/api/discovery/settings/", {
        method: "PATCH",
        body: JSON.stringify({
          deny_subnets: value
            .split(/[\s,]+/)
            .map((s) => s.trim())
            .filter(Boolean),
        }),
      }),
    onSuccess: (d) => {
      qc.setQueryData(["discovery", "settings"], d)
      toast.success("Deny subnets saved")
      setText(null)
      onOpenChange(false)
    },
    onError: (err) => {
      if (handleApiError(err) !== null) apiErrorToast(err)
    },
  })
  const canChange = !!q.data?.can_change
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) {
          setText(null)
          reset()
        }
        onOpenChange(o)
      }}
    >
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Deny subnets</DialogTitle>
        </DialogHeader>
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault()
            if (canChange) save.mutate()
          }}
        >
          <FormTextarea
            label="Never contacted"
            rows={6}
            value={value}
            onChange={setText}
            placeholder="10.20.0.0/16"
            error={fieldErrors.deny_subnets}
            info="One CIDR per line, any VRF. The monitoring deny subnets apply as well."
          />
          {canChange ? (
            <FormFooter
              onCancel={() => onOpenChange(false)}
              submitting={save.isPending}
              submitLabel="Save"
            />
          ) : (
            <p className="text-xs text-muted-foreground">
              Tenant admins change these.
            </p>
          )}
        </form>
      </DialogContent>
    </Dialog>
  )
}
