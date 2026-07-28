import { createFileRoute, Link } from "@tanstack/react-router"
import { useQuery } from "@tanstack/react-query"
import { type ColumnDef } from "@tanstack/react-table"
import { useCallback, useMemo, useState } from "react"

import { api, type CustomField, type Paginated } from "@/lib/api"
import {
  CUSTOMIZABLE_MODELS,
  CUSTOM_FIELD_TYPES,
  useCustomizationMeta,
} from "@/lib/custom-fields"
import { Button } from "@/components/ui/button"
import { DataTable } from "@/components/data-table"
import { ListPageShell } from "@/components/list-page-shell"
import { buildCustomFieldColumns } from "@/components/columns/custom-field-columns"
import {
  FilterRail,
  FacetGroup,
  toggleInSet,
  type FacetOption,
} from "@/components/filter-rail"
import { CustomFieldDeleteDialog } from "@/components/custom-field-delete-dialog"
import { useMe } from "@/lib/use-me"

export const Route = createFileRoute("/custom-fields/")({
  component: CustomFieldsPage,
})

function CustomFieldsPage() {
  const { canDo } = useMe()
  const canAdd = canDo("customfield", "add")
  const canEdit = canDo("customfield", "change")
  const canDelete = canDo("customfield", "delete")
  const [q, setQ] = useState("")
  const [typeFilter, setTypeFilter] = useState<Set<string>>(new Set())
  const [modelFilter, setModelFilter] = useState<Set<string>>(new Set())
  const [deleting, setDeleting] = useState<CustomField | null>(null)

  const query = useQuery({
    queryKey: ["custom-fields", q],
    queryFn: () =>
      api<Paginated<CustomField>>(
        `/api/custom-fields/?${new URLSearchParams({ search: q }).toString()}`
      ),
  })
  const allRows = query.data?.results ?? []

  const rows = useMemo(() => {
    return allRows.filter((f) => {
      if (typeFilter.size > 0 && !typeFilter.has(f.type)) return false
      if (modelFilter.size > 0 && !f.applies_to.some((m) => modelFilter.has(m)))
        return false
      return true
    })
  }, [allRows, typeFilter, modelFilter])

  const meta = useCustomizationMeta()
  const modelList = meta.data?.models ?? CUSTOMIZABLE_MODELS
  const facets = useMemo(() => {
    const types: Record<string, number> = {}
    const models: Record<string, number> = {}
    for (const f of allRows) {
      types[f.type] = (types[f.type] ?? 0) + 1
      for (const m of f.applies_to) models[m] = (models[m] ?? 0) + 1
    }
    return {
      type: CUSTOM_FIELD_TYPES.filter((t) => types[t.value]).map<FacetOption>(
        (t) => ({
          value: t.value,
          label: t.label,
          count: types[t.value],
        })
      ),
      model: modelList
        .filter((m) => models[m.value])
        .map<FacetOption>((m) => ({
          value: m.value,
          label: m.label,
          count: models[m.value],
        })),
    }
  }, [allRows, modelList])

  const handleDelete = useCallback((f: CustomField) => setDeleting(f), [])
  const columns = useMemo<ColumnDef<CustomField>[]>(
    () => buildColumns({ onDelete: handleDelete, canEdit, canDelete }),
    [handleDelete, canEdit, canDelete]
  )

  const rail = (
    <FilterRail>
      <FacetGroup
        label="Type"
        options={facets.type}
        selected={typeFilter}
        onToggle={(v) => toggleInSet(typeFilter, v, setTypeFilter)}
      />
      <FacetGroup
        label="Applies to"
        options={facets.model}
        selected={modelFilter}
        onToggle={(v) => toggleInSet(modelFilter, v, setModelFilter)}
      />
    </FilterRail>
  )

  return (
    <ListPageShell
      title="Custom fields"
      count={query.data ? rows.length : undefined}
      rail={rail}
      search={{
        value: q,
        onChange: setQ,
        placeholder: "Filter by key, label…",
      }}
      actions={
        <>
          {canAdd && (
            <Button size="sm" asChild>
              <Link to="/custom-fields/new">Add field</Link>
            </Button>
          )}
        </>
      }
      query={query}
    >
      <DataTable
        data={rows}
        columns={columns}
        flexColumn="label"
        tableId="custom-fields"
      />
      <CustomFieldDeleteDialog
        field={deleting}
        onOpenChange={(o) => !o && setDeleting(null)}
      />
    </ListPageShell>
  )
}

function buildColumns({
  onDelete,
  canEdit,
  canDelete,
}: {
  onDelete: (f: CustomField) => void
  canEdit: boolean
  canDelete: boolean
}): ColumnDef<CustomField, unknown>[] {
  return buildCustomFieldColumns<CustomField>({
    selection: true,
    // Weight only reads as ordering *within* a section, so it lives on the
    // group page rather than this flat list.
    omit: ["weight"],
    actions: {
      editTo: "/custom-fields/$id/edit",
      editParams: (f) => ({ id: f.id }),
      canEdit: () => canEdit,
      canDelete: () => canDelete,
      onDelete,
    },
  })
}
