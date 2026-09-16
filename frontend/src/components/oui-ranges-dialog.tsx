import { useState } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { toast } from "sonner"

import { api } from "@/lib/api"
import type { OuiRange, Paginated } from "@/lib/api"
import { apiErrorToast } from "@/lib/api-toast"
import { useMe } from "@/lib/use-me"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { SimpleTable } from "@/components/ui/simple-table"
import type { SimpleColumn } from "@/components/ui/simple-table"
import { FormText, useFieldErrors } from "@/components/forms"
import { RowActions } from "@/components/row-actions"
import { useSaveObject } from "@/lib/save-object"

export const OUI_RANGES_KEY = ["oui-ranges"]

export function useOuiRanges(enabled = true) {
  return useQuery({
    queryKey: OUI_RANGES_KEY,
    queryFn: () => api<Paginated<OuiRange>>("/api/oui-ranges/?page_size=500"),
    enabled,
    staleTime: 60_000,
  })
}

/**
 * A tenant's own OUI ranges - internally assigned blocks (a VM cluster's
 * locally-administered prefix, say) that resolve to a label of your choosing
 * and beat the public registry at the same length.
 */
export function OuiRangesDialog({
  open,
  onOpenChange,
}: {
  open: boolean
  onOpenChange: (o: boolean) => void
}) {
  const qc = useQueryClient()
  const { canDo } = useMe()
  const canEdit = canDo("macaddress", "change")
  const ranges = useOuiRanges(open)
  const saveObject = useSaveObject()
  const { fieldErrors, handleApiError, reset } = useFieldErrors()
  const [prefix, setPrefix] = useState("")
  const [vendor, setVendor] = useState("")
  const [description, setDescription] = useState("")

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: OUI_RANGES_KEY })
    qc.invalidateQueries({ queryKey: ["macs"] })
    qc.invalidateQueries({ queryKey: ["mac"] })
  }

  const create = useMutation({
    mutationFn: () =>
      saveObject<OuiRange>({
        objectType: "api.ouiprefix",
        endpoint: "/api/oui-ranges/",
        payload: {
          prefix: prefix.trim(),
          vendor: vendor.trim(),
          description: description.trim(),
        },
      }),
    onSuccess: (r) => {
      invalidate()
      setPrefix("")
      setVendor("")
      setDescription("")
      reset()
      toast.success(`Added ${r.prefix}`)
    },
    onError: (err) => {
      const msg = handleApiError(err)
      if (msg) toast.error(msg)
    },
  })

  const remove = useMutation({
    mutationFn: (id: string) =>
      api<void>(`/api/oui-ranges/${id}/`, { method: "DELETE" }),
    onSuccess: () => {
      invalidate()
      toast.success("Range removed")
    },
    onError: (err) => apiErrorToast(err),
  })

  const rows = ranges.data?.results ?? []
  const columns: SimpleColumn<OuiRange>[] = [
    {
      id: "prefix",
      header: "Prefix",
      cell: (r) => <span className="font-mono text-xs">{r.prefix}</span>,
    },
    {
      id: "bits",
      header: "Bits",
      cell: (r) => <span className="num text-xs">{r.bits}</span>,
    },
    {
      id: "vendor",
      header: "Label",
      flex: true,
      cell: (r) => (
        <span className="text-xs">
          {r.vendor}
          {r.description && (
            <span className="text-muted-foreground"> · {r.description}</span>
          )}
        </span>
      ),
    },
    ...(canEdit
      ? [
          {
            id: "actions",
            header: "",
            align: "right" as const,
            cell: (r: OuiRange) => (
              <RowActions
                deleteLabel="Remove"
                onDelete={() => !remove.isPending && remove.mutate(r.id)}
              />
            ),
          },
        ]
      : []),
  ]

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="lg">
        <DialogHeader>
          <DialogTitle>Vendor ranges</DialogTitle>
        </DialogHeader>
        <div className="grid gap-4">
          <SimpleTable
            columns={columns}
            data={rows}
            getRowKey={(r) => r.id}
            empty="No custom ranges. MACs resolve from the public registry only."
          />
          {canEdit && (
            <form
              onSubmit={(e) => {
                e.preventDefault()
                if (prefix.trim() && vendor.trim()) create.mutate()
              }}
              className="grid gap-3 rounded-lg border border-border p-3 sm:grid-cols-[1fr_1fr_1fr_auto] sm:items-end"
            >
              <FormText
                label="Prefix"
                value={prefix}
                onChange={setPrefix}
                mono
                placeholder="02:00:aa"
                error={fieldErrors.prefix}
              />
              <FormText
                label="Label"
                value={vendor}
                onChange={setVendor}
                placeholder="Lab VM cluster"
                error={fieldErrors.vendor}
              />
              <FormText
                label="Description"
                value={description}
                onChange={setDescription}
                placeholder="optional"
              />
              <Button
                type="submit"
                size="sm"
                disabled={!prefix.trim() || !vendor.trim() || create.isPending}
              >
                {create.isPending ? "Adding..." : "Add range"}
              </Button>
            </form>
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}
