import { useEffect, useMemo, useRef, useState } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { toast } from "sonner"

import { api } from "@/lib/api"
import type { LabelFields, LabelTemplate, RenderedLabel } from "@/lib/api"
import { apiErrorToast } from "@/lib/api-toast"
import { labelDocument } from "@/lib/label-render"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Field, FormCheckbox, FormSelect, FormText } from "@/components/forms"

// Object types a label makes sense for — matches api/label_templates.py's
// FRONTEND_ROUTES so `{{ url }}` and the default QR resolve to a real page.
const OBJECT_TYPES: { value: string; label: string }[] = [
  { value: "device", label: "Device" },
  { value: "rack", label: "Rack" },
  { value: "ipaddress", label: "IP address" },
  { value: "interface", label: "Interface" },
  { value: "cable", label: "Cable" },
  { value: "inventoryitem", label: "Inventory item" },
  { value: "site", label: "Site" },
  { value: "location", label: "Location" },
  { value: "circuit", label: "Circuit" },
  { value: "virtualmachine", label: "Virtual machine" },
  { value: "prefix", label: "Prefix" },
]

const STARTER_HTML =
  '<div style="display:flex;justify-content:space-between;align-items:center;height:100%">\n' +
  '  <div>\n    <div style="font-weight:700;font-size:11pt">{{ device.name }}</div>\n' +
  "    <div>{{ device.serial|default('') }}</div>\n  </div>\n" +
  '  <div class="qr"></div>\n</div>'

type Draft = Omit<
  LabelTemplate,
  "id" | "object_type_label" | "created_at" | "updated_at"
>

const BLANK: Draft = {
  name: "",
  object_type: "device",
  description: "",
  width_mm: 62,
  height_mm: 29,
  margin_mm: 2,
  template_html: STARTER_HTML,
  css: "",
  qr_enabled: true,
  qr_content: "",
  qr_size_mm: 18,
  is_default: false,
}

export function LabelTemplateFormDialog({
  template,
  open,
  onOpenChange,
}: {
  template: LabelTemplate | null
  open: boolean
  onOpenChange: (o: boolean) => void
}) {
  const qc = useQueryClient()
  const [d, setD] = useState<Draft>(template ?? BLANK)
  const set = <K extends keyof Draft>(k: K, v: Draft[K]) =>
    setD((prev) => ({ ...prev, [k]: v }))
  const htmlRef = useRef<HTMLTextAreaElement>(null)

  // Field-reference tokens for the chosen object type.
  const fieldsQ = useQuery({
    queryKey: ["label-fields", d.object_type],
    queryFn: () =>
      api<LabelFields>(
        `/api/label-templates/fields/?object_type=${d.object_type}`
      ),
    enabled: open,
  })

  // Debounced live preview against a representative object of the type.
  const [srcDoc, setSrcDoc] = useState("")
  const [previewErr, setPreviewErr] = useState("")
  const previewKey = JSON.stringify({
    t: d.object_type,
    h: d.template_html,
    c: d.css,
    q: d.qr_enabled,
    qc: d.qr_content,
    qs: d.qr_size_mm,
    w: d.width_mm,
    ht: d.height_mm,
    m: d.margin_mm,
  })
  useEffect(() => {
    if (!open) return
    const t = setTimeout(async () => {
      try {
        const r = await api<RenderedLabel>("/api/label-templates/preview/", {
          method: "POST",
          body: JSON.stringify({
            object_type: d.object_type,
            template_html: d.template_html,
            css: d.css,
            qr_enabled: d.qr_enabled,
            qr_content: d.qr_content,
          }),
        })
        setPreviewErr("")
        setSrcDoc(labelDocument(d, r))
      } catch (e) {
        setPreviewErr(e instanceof Error ? e.message : "Preview failed")
      }
    }, 400)
    return () => clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [previewKey, open])

  const insertToken = (token: string) => {
    const ta = htmlRef.current
    const snippet = `{{ ${token} }}`
    if (!ta) {
      set("template_html", d.template_html + snippet)
      return
    }
    const start = ta.selectionStart ?? d.template_html.length
    const end = ta.selectionEnd ?? start
    set(
      "template_html",
      d.template_html.slice(0, start) + snippet + d.template_html.slice(end)
    )
  }

  const save = useMutation({
    mutationFn: () =>
      template
        ? api(`/api/label-templates/${template.id}/`, {
            method: "PATCH",
            body: JSON.stringify(d),
          })
        : api("/api/label-templates/", {
            method: "POST",
            body: JSON.stringify(d),
          }),
    onSuccess: () => {
      toast.success(
        template ? "Label template saved" : "Label template created"
      )
      qc.invalidateQueries({ queryKey: ["label-templates"] })
      onOpenChange(false)
    },
    onError: (e) => apiErrorToast(e),
  })

  const tokens = useMemo(() => fieldsQ.data?.tokens ?? [], [fieldsQ.data])

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="xl">
        <DialogHeader>
          <DialogTitle>
            {template ? "Edit label template" : "New label template"}
          </DialogTitle>
        </DialogHeader>

        <div className="grid max-h-[72vh] gap-4 overflow-y-auto md:grid-cols-2">
          {/* ── Left: configuration ── */}
          <div className="space-y-3">
            <FormText
              label="Name"
              value={d.name}
              onChange={(v) => set("name", v)}
              required
            />
            <FormSelect
              label="Object type"
              value={d.object_type}
              onChange={(v) => v && set("object_type", v)}
              options={OBJECT_TYPES}
            />
            <div className="grid grid-cols-3 gap-2">
              <FormText
                label="Width (mm)"
                type="number"
                value={String(d.width_mm)}
                onChange={(v) => set("width_mm", Number(v) || 0)}
              />
              <FormText
                label="Height (mm)"
                type="number"
                value={String(d.height_mm)}
                onChange={(v) => set("height_mm", Number(v) || 0)}
              />
              <FormText
                label="Margin (mm)"
                type="number"
                value={String(d.margin_mm)}
                onChange={(v) => set("margin_mm", Number(v) || 0)}
              />
            </div>
            <FormCheckbox
              label="Include a QR code"
              checked={d.qr_enabled}
              onChange={(v) => set("qr_enabled", v)}
              hint={
                'Drop a <div class="qr"></div> in the HTML where it should appear.'
              }
            />
            {d.qr_enabled && (
              <div className="grid grid-cols-[1fr_auto] gap-2">
                <FormText
                  label="QR content"
                  value={d.qr_content}
                  onChange={(v) => set("qr_content", v)}
                  placeholder="blank = the object's URL"
                  info="A Jinja expression, e.g. ASSET:{{ device.name }}. Blank encodes the object's page URL."
                />
                <FormText
                  label="QR (mm)"
                  type="number"
                  value={String(d.qr_size_mm)}
                  onChange={(v) => set("qr_size_mm", Number(v) || 0)}
                  inputClassName="w-20"
                />
              </div>
            )}
            <Field label="Label HTML" hint="Jinja2 + HTML">
              <textarea
                ref={htmlRef}
                value={d.template_html}
                onChange={(e) => set("template_html", e.target.value)}
                rows={9}
                spellCheck={false}
                className="w-full rounded-md border border-input bg-transparent p-2 font-mono text-[12px] outline-none focus-visible:ring-1 focus-visible:ring-ring"
              />
            </Field>
            <Field label="Extra CSS" hint="optional">
              <textarea
                value={d.css}
                onChange={(e) => set("css", e.target.value)}
                rows={3}
                spellCheck={false}
                className="w-full rounded-md border border-input bg-transparent p-2 font-mono text-[12px] outline-none focus-visible:ring-1 focus-visible:ring-ring"
              />
            </Field>
            <FormCheckbox
              label="Default for this object type"
              checked={d.is_default}
              onChange={(v) => set("is_default", v)}
              hint="Preselected when printing labels for this type."
            />
          </div>

          {/* ── Right: preview + field reference ── */}
          <div className="space-y-3">
            <div>
              <span className="mb-1 block text-[11px] font-medium text-muted-foreground">
                Live preview{" "}
                <span className="text-muted-foreground/70">
                  (first{" "}
                  {OBJECT_TYPES.find((o) => o.value === d.object_type)?.label ??
                    d.object_type}
                  )
                </span>
              </span>
              <div className="flex justify-center rounded-md border border-border bg-card p-3">
                {previewErr ? (
                  <p className="py-6 text-center text-[12px] text-destructive">
                    {previewErr}
                  </p>
                ) : (
                  <iframe
                    title="Label preview"
                    sandbox=""
                    srcDoc={srcDoc}
                    style={{
                      width: `${d.width_mm}mm`,
                      height: `${d.height_mm}mm`,
                      border: "1px solid var(--border)",
                      background: "#fff",
                    }}
                  />
                )}
              </div>
            </div>
            <div>
              <span className="mb-1 block text-[11px] font-medium text-muted-foreground">
                Fields — click to insert
              </span>
              <div className="flex max-h-48 flex-wrap gap-1 overflow-y-auto rounded-md border border-border bg-card p-2">
                {[...(fieldsQ.data?.special ?? []), ...tokens].map((tok) => (
                  <button
                    key={tok}
                    type="button"
                    onClick={() => insertToken(tok)}
                    className="rounded border border-border px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground hover:bg-muted hover:text-foreground"
                  >
                    {tok}
                  </button>
                ))}
              </div>
            </div>
          </div>
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            disabled={!d.name.trim() || save.isPending}
            onClick={() => save.mutate()}
          >
            {save.isPending ? "Saving…" : template ? "Save" : "Create"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
