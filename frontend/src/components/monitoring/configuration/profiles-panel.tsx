import { useMemo, useState } from "react"
import { useMutation, useQueryClient } from "@tanstack/react-query"
import type { ColumnDef } from "@tanstack/react-table"
import { toast } from "sonner"

import { api, type MonitoringProfile } from "@/lib/api"
import { apiErrorToast } from "@/lib/api-toast"
import { DataTable, SortHeader } from "@/components/data-table"
import { useTableFilters } from "@/components/table-filters"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import { useMonitoringConfig } from "./config-context"
import { FilteredTable } from "./filtered-table"
import { TemplateMenu } from "./policy-controls"

// Global templates tab: CRUD for monitoring profiles (named bundles of
// check templates that policies reference).
export function ProfilesPanel() {
  const qc = useQueryClient()
  const { templates, profiles } = useMonitoringConfig()
  const [open, setOpen] = useState(false)
  const [name, setName] = useState("")
  const [selected, setSelected] = useState<string[]>([])

  const create = useMutation({
    mutationFn: () =>
      api<MonitoringProfile>("/api/monitoring/profiles/", {
        method: "POST",
        body: JSON.stringify({
          name: name.trim(),
          templates: selected,
        }),
      }),
    onSuccess: () => {
      setName("")
      setSelected([])
      setOpen(false)
      qc.invalidateQueries({ queryKey: ["monitoring-profiles"] })
      toast.success("Monitoring profile created")
    },
    onError: (err) => apiErrorToast(err, "Update failed"),
  })

  const patch = useMutation({
    mutationFn: (p: Partial<MonitoringProfile> & { id: string }) =>
      api<MonitoringProfile>(`/api/monitoring/profiles/${p.id}/`, {
        method: "PATCH",
        body: JSON.stringify(p),
      }),
    onSuccess: () =>
      qc.invalidateQueries({ queryKey: ["monitoring-profiles"] }),
    onError: (err) => apiErrorToast(err, "Update failed"),
  })

  const columns = useMemo<ColumnDef<MonitoringProfile>[]>(
    () => [
      {
        id: "name",
        accessorKey: "name",
        header: ({ column }) => <SortHeader column={column} label="Profile" />,
        cell: ({ row }) => (
          <div className="font-medium">{row.original.name}</div>
        ),
      },
      {
        id: "templates",
        header: "Templates",
        cell: ({ row }) => (
          <TemplateMenu
            templates={templates}
            selected={row.original.templates}
            onChange={(next) =>
              patch.mutate({ id: row.original.id, templates: next })
            }
          />
        ),
      },
      {
        id: "enabled",
        accessorFn: (row) => (row.enabled ? "enabled" : "disabled"),
        header: "State",
        cell: ({ row }) => (
          <SwitchField
            id={`monitoring-profile-${row.original.id}`}
            checked={row.original.enabled}
            label={row.original.enabled ? "Enabled" : "Disabled"}
            disabled={patch.isPending}
            onCheckedChange={() =>
              patch.mutate({
                id: row.original.id,
                enabled: !row.original.enabled,
              })
            }
          />
        ),
        meta: {
          facet: {
            kind: "enum",
            label: "State",
            get: (row) => (row.enabled ? "enabled" : "disabled"),
            formatValue: (value) => ({
              label: value === "enabled" ? "Enabled" : "Disabled",
            }),
          },
        },
      },
    ],
    [patch, templates]
  )
  const { rail, filteredRows } = useTableFilters(columns, profiles)

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      <div className="flex justify-end">
        <Button size="sm" onClick={() => setOpen(true)}>
          Create profile
        </Button>
      </div>
      <FilteredTable rail={rail}>
        <DataTable
          data={filteredRows}
          columns={columns}
          tableId="monitoring-config-profiles"
          exportName="monitoring-profiles"
        />
      </FilteredTable>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <form
            className="flex flex-col gap-4"
            onSubmit={(e) => {
              e.preventDefault()
              if (name.trim()) create.mutate()
            }}
          >
            <DialogHeader>
              <DialogTitle>Create monitoring profile</DialogTitle>
              <DialogDescription>
                Group check templates into a profile that policies can reuse.
              </DialogDescription>
            </DialogHeader>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Profile name"
            />
            <TemplateMenu
              templates={templates}
              selected={selected}
              onChange={setSelected}
            />
            <DialogFooter>
              <Button type="submit" disabled={create.isPending}>
                Create profile
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  )
}

function SwitchField({
  id,
  checked,
  label,
  disabled,
  onCheckedChange,
}: {
  id: string
  checked: boolean
  label: string
  disabled?: boolean
  onCheckedChange: (checked: boolean) => void
}) {
  return (
    <div className="flex items-center gap-2">
      <Switch
        id={id}
        size="sm"
        checked={checked}
        disabled={disabled}
        onCheckedChange={onCheckedChange}
      />
      <Label htmlFor={id} className="text-xs text-muted-foreground">
        {label}
      </Label>
    </div>
  )
}
