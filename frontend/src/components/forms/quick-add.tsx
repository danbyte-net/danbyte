import { useState } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Plus } from "lucide-react"
import { toast } from "sonner"

import { api } from "@/lib/api"
import { apiAll } from "@/lib/api-all"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { Field } from "./field"
import { FormCombobox } from "./combobox"
import type { ComboboxOption } from "@/components/ui/combobox"
import { apiErrorToast } from "@/lib/api-toast"

type MiniNamed = { id: string; name: string }

/** A field in a quick-add mini form. Mostly text; `combobox` covers a required
 * parent that is itself an FK (e.g. a Cluster needs a Cluster type). */
export type QuickAddField =
  | {
      name: string
      label: string
      type?: "text" | "textarea"
      required?: boolean
      placeholder?: string
      /** The value the dialog opens with. */
      initial?: string
    }
  | {
      name: string
      label: string
      type: "combobox"
      /** Picker endpoint returning `{results:[{id,name}]}` - or `options`. */
      endpoint?: string
      /** react-query key to invalidate so the parent picker refreshes too. */
      queryKey?: string
      /** The options as given (colour badges and all), in place of
       * `endpoint` - e.g. the locations of a floor plan's site. */
      options?: ComboboxOption[]
      required?: boolean
      placeholder?: string
      /** The value the dialog opens with. */
      initial?: string
      /** The "none" row's label for an optional pick. */
      noneLabel?: string
      /** Nested quick-add: a "+" on this inner picker too (e.g. create a
       * Cluster type from within the "new Cluster" dialog). */
      quickAdd?: { title: string; endpoint: string; fields: QuickAddField[] }
    }

/**
 * "+" button beside an FK picker that opens a small dialog to create the
 * related object inline - no navigating away to the real create page
 * (inline quick-add). On success it calls `onCreated(newObject)` so the
 * caller can select the new row and refresh its options.
 */
export function QuickAddDialog({
  title,
  endpoint,
  fields,
  fixed,
  onCreated,
}: {
  title: string
  endpoint: string
  fields: QuickAddField[]
  /** Values sent with every create that the dialog never shows - the owning
   * device, a forced type (e.g. `{device_id, type: "lag"}` for "New
   * aggregate"). Dialog fields win on a key clash. */
  fixed?: Record<string, unknown>
  onCreated: (created: MiniNamed) => void
}) {
  const [open, setOpen] = useState(false)
  const [vals, setVals] = useState<Record<string, string>>({})
  // Each opening starts from the fields' initial values.
  const openWith = (o: boolean) => {
    if (o)
      setVals(
        Object.fromEntries(
          fields.flatMap((f) => (f.initial ? [[f.name, f.initial]] : []))
        )
      )
    setOpen(o)
  }

  const create = useMutation({
    mutationFn: () =>
      api<MiniNamed>(endpoint, {
        method: "POST",
        // An optional pick left empty is not sent.
        body: JSON.stringify({
          ...fixed,
          ...Object.fromEntries(
            Object.entries(vals).filter(
              ([k, v]) =>
                v !== "" ||
                fields.find((f) => f.name === k)?.type !== "combobox"
            )
          ),
        }),
      }),
    onSuccess: (obj) => {
      toast.success(`Created ${obj.name}`)
      onCreated(obj)
      setOpen(false)
      setVals({})
    },
    onError: (e) => apiErrorToast(e),
  })

  const missing = fields.some((f) => f.required && !(vals[f.name] || "").trim())
  const set = (name: string, v: string) => setVals((s) => ({ ...s, [name]: v }))

  return (
    <Dialog open={open} onOpenChange={openWith}>
      <DialogTrigger asChild>
        <Button
          type="button"
          variant="outline"
          size="icon"
          className="h-9 w-9 shrink-0"
          title={title}
        >
          <Plus className="h-4 w-4" />
          <span className="sr-only">{title}</span>
        </Button>
      </DialogTrigger>
      <DialogContent size="lg">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
        </DialogHeader>
        <div className="grid gap-3">
          {fields.map((f, i) =>
            f.type === "combobox" ? (
              <QuickAddCombobox
                key={f.name}
                field={f}
                value={vals[f.name] ?? null}
                onChange={(v) => set(f.name, v ?? "")}
              />
            ) : (
              <Field key={f.name} label={f.label}>
                {f.type === "textarea" ? (
                  <Textarea
                    value={vals[f.name] || ""}
                    onChange={(e) => set(f.name, e.target.value)}
                    placeholder={f.placeholder}
                    className="min-h-16 text-[13px]"
                  />
                ) : (
                  <Input
                    value={vals[f.name] || ""}
                    onChange={(e) => set(f.name, e.target.value)}
                    placeholder={f.placeholder}
                    autoFocus={i === 0}
                  />
                )}
              </Field>
            )
          )}
        </div>
        <DialogFooter>
          <Button type="button" variant="ghost" onClick={() => setOpen(false)}>
            Cancel
          </Button>
          <Button
            type="button"
            disabled={missing || create.isPending}
            onClick={() => create.mutate()}
          >
            {create.isPending ? "Creating…" : "Create"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function QuickAddCombobox({
  field,
  value,
  onChange,
}: {
  field: Extract<QuickAddField, { type: "combobox" }>
  value: string | null
  onChange: (v: string | null) => void
}) {
  const qc = useQueryClient()
  const q = useQuery({
    queryKey: [field.queryKey ?? field.endpoint],
    queryFn: () => apiAll<MiniNamed>(field.endpoint!),
    enabled: !field.options && !!field.endpoint,
  })
  return (
    <FormCombobox
      label={field.label}
      value={value || null}
      onChange={onChange}
      options={
        field.options ??
        (q.data?.results ?? []).map((o) => ({
          value: o.id,
          label: o.name,
        }))
      }
      noneLabel={field.noneLabel}
      placeholder={field.placeholder ?? `Select ${field.label.toLowerCase()}…`}
      quickAdd={
        field.quickAdd ? (
          <QuickAddDialog
            title={field.quickAdd.title}
            endpoint={field.quickAdd.endpoint}
            fields={field.quickAdd.fields}
            onCreated={(o) => {
              if (field.queryKey)
                qc.invalidateQueries({ queryKey: [field.queryKey] })
              onChange(o.id)
            }}
          />
        ) : undefined
      }
    />
  )
}
