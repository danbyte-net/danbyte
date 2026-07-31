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

// ── Simple (low-code) builder ────────────────────────────────────────────────
// A stack of blocks — each a field token or a line of static text — that
// generates the HTML for authors who don't want to write Jinja. Switching to
// the HTML tab shows (and lets you refine) what it produced.
type SimpleBlock = {
  id: number
  kind: "field" | "text"
  value: string // a field token, or literal text
  bold: boolean
  size: "sm" | "md" | "lg"
}
const SIZE_PT: Record<SimpleBlock["size"], string> = {
  sm: "8pt",
  md: "10pt",
  lg: "13pt",
}
let _bid = 0
const nextBid = () => ++_bid

// Date-ish tokens get a `| date` filter so they print 2026-07-31, not a raw
// microsecond+timezone timestamp.
function fieldExpr(token: string): string {
  return /(_at$|date)/i.test(token) ? `{{ ${token} | date }}` : `{{ ${token} }}`
}
function escText(s: string): string {
  return s.replace(
    /[<>&]/g,
    (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" })[c] as string
  )
}
function buildHtml(blocks: SimpleBlock[], qrEnabled: boolean): string {
  const lines = blocks
    .filter((b) => (b.kind === "field" ? b.value : b.value.trim()))
    .map((b) => {
      const w = b.bold ? "font-weight:700;" : ""
      const inner = b.kind === "field" ? fieldExpr(b.value) : escText(b.value)
      return `    <div style="font-size:${SIZE_PT[b.size]};${w}">${inner}</div>`
    })
    .join("\n")
  if (!qrEnabled) return `<div>\n${lines}\n</div>`
  return (
    `<div style="display:flex;justify-content:space-between;align-items:center;height:100%">\n` +
    `  <div>\n${lines}\n  </div>\n  <div class="qr"></div>\n</div>`
  )
}

// mm → CSS px at 96dpi, for scaling the preview to fit the panel.
const MM_PX = 96 / 25.4

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

  // Simple vs raw-HTML authoring. New templates start in the low-code builder;
  // editing an existing one opens on HTML (its blocks can't be reconstructed).
  const [mode, setMode] = useState<"simple" | "html">(
    template ? "html" : "simple"
  )
  const [blocks, setBlocks] = useState<SimpleBlock[]>(
    template
      ? []
      : [
          {
            id: nextBid(),
            kind: "field",
            value: "device.name",
            bold: true,
            size: "lg",
          },
        ]
  )
  const [fieldSearch, setFieldSearch] = useState("")

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

  // In the Simple builder, regenerate the HTML from the blocks (and the QR
  // toggle) so the saved template_html always matches what's on screen.
  useEffect(() => {
    if (mode !== "simple") return
    set("template_html", buildHtml(blocks, d.qr_enabled))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [blocks, d.qr_enabled, mode])

  // A clicked field chip: adds a block in Simple mode, inserts `{{ }}` in HTML.
  const useField = (token: string) => {
    if (mode === "simple") {
      setBlocks((bs) => [
        ...bs,
        { id: nextBid(), kind: "field", value: token, bold: false, size: "md" },
      ])
      return
    }
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

  // Specials first, then model fields + custom fields; filtered by the search.
  const allTokens = useMemo(
    () => [...(fieldsQ.data?.special ?? []), ...(fieldsQ.data?.tokens ?? [])],
    [fieldsQ.data]
  )
  const shownTokens = useMemo(() => {
    const q = fieldSearch.trim().toLowerCase()
    return q ? allTokens.filter((t) => t.toLowerCase().includes(q)) : allTokens
  }, [allTokens, fieldSearch])

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
            <div>
              <div className="mb-1 flex items-center gap-2">
                <span className="text-[11px] font-medium text-muted-foreground">
                  Label content
                </span>
                <div className="ml-auto flex rounded-md border border-border p-0.5 text-[11px]">
                  {(["simple", "html"] as const).map((m) => (
                    <button
                      key={m}
                      type="button"
                      onClick={() => setMode(m)}
                      className={
                        "rounded px-2 py-0.5 " +
                        (mode === m
                          ? "bg-muted font-medium text-foreground"
                          : "text-muted-foreground hover:text-foreground")
                      }
                    >
                      {m === "simple" ? "Simple" : "HTML / Jinja"}
                    </button>
                  ))}
                </div>
              </div>

              {mode === "simple" ? (
                <div className="space-y-2 rounded-md border border-border bg-card p-2">
                  {blocks.length === 0 && (
                    <p className="px-1 py-2 text-[12px] text-muted-foreground">
                      Add a field or a line of text — or click a field on the
                      right. The label builds itself.
                    </p>
                  )}
                  {blocks.map((b, i) => (
                    <div key={b.id} className="flex items-center gap-1.5">
                      {b.kind === "field" ? (
                        <select
                          value={b.value}
                          onChange={(e) =>
                            setBlocks((bs) =>
                              bs.map((x) =>
                                x.id === b.id
                                  ? { ...x, value: e.target.value }
                                  : x
                              )
                            )
                          }
                          className="min-w-0 flex-1 rounded border border-input bg-transparent px-1.5 py-1 font-mono text-[11px] outline-none focus-visible:ring-1 focus-visible:ring-ring"
                        >
                          <option value="">— pick a field —</option>
                          {allTokens.map((t) => (
                            <option key={t} value={t}>
                              {t}
                            </option>
                          ))}
                        </select>
                      ) : (
                        <input
                          value={b.value}
                          placeholder="static text"
                          onChange={(e) =>
                            setBlocks((bs) =>
                              bs.map((x) =>
                                x.id === b.id
                                  ? { ...x, value: e.target.value }
                                  : x
                              )
                            )
                          }
                          className="min-w-0 flex-1 rounded border border-input bg-transparent px-1.5 py-1 text-[12px] outline-none focus-visible:ring-1 focus-visible:ring-ring"
                        />
                      )}
                      <select
                        value={b.size}
                        onChange={(e) =>
                          setBlocks((bs) =>
                            bs.map((x) =>
                              x.id === b.id
                                ? {
                                    ...x,
                                    size: e.target.value as SimpleBlock["size"],
                                  }
                                : x
                            )
                          )
                        }
                        className="rounded border border-input bg-transparent px-1 py-1 text-[11px]"
                        title="Text size"
                      >
                        <option value="sm">S</option>
                        <option value="md">M</option>
                        <option value="lg">L</option>
                      </select>
                      <button
                        type="button"
                        title="Bold"
                        onClick={() =>
                          setBlocks((bs) =>
                            bs.map((x) =>
                              x.id === b.id ? { ...x, bold: !x.bold } : x
                            )
                          )
                        }
                        className={
                          "rounded border border-border px-1.5 py-1 text-[11px] font-bold " +
                          (b.bold
                            ? "bg-muted text-foreground"
                            : "text-muted-foreground")
                        }
                      >
                        B
                      </button>
                      <button
                        type="button"
                        title="Move up"
                        disabled={i === 0}
                        onClick={() =>
                          setBlocks((bs) => {
                            const n = [...bs]
                            ;[n[i - 1], n[i]] = [n[i], n[i - 1]]
                            return n
                          })
                        }
                        className="rounded border border-border px-1 py-1 text-[11px] text-muted-foreground disabled:opacity-30"
                      >
                        ↑
                      </button>
                      <button
                        type="button"
                        title="Remove"
                        onClick={() =>
                          setBlocks((bs) => bs.filter((x) => x.id !== b.id))
                        }
                        className="rounded border border-border px-1 py-1 text-[11px] text-destructive"
                      >
                        ✕
                      </button>
                    </div>
                  ))}
                  <div className="flex gap-1.5 pt-1">
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      onClick={() =>
                        setBlocks((bs) => [
                          ...bs,
                          {
                            id: nextBid(),
                            kind: "field",
                            value: "",
                            bold: false,
                            size: "md",
                          },
                        ])
                      }
                    >
                      + Field
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      onClick={() =>
                        setBlocks((bs) => [
                          ...bs,
                          {
                            id: nextBid(),
                            kind: "text",
                            value: "",
                            bold: false,
                            size: "md",
                          },
                        ])
                      }
                    >
                      + Text
                    </Button>
                  </div>
                </div>
              ) : (
                <textarea
                  ref={htmlRef}
                  value={d.template_html}
                  onChange={(e) => set("template_html", e.target.value)}
                  rows={9}
                  spellCheck={false}
                  className="w-full rounded-md border border-input bg-transparent p-2 font-mono text-[12px] outline-none focus-visible:ring-1 focus-visible:ring-ring"
                />
              )}
            </div>
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
              <div className="flex justify-center overflow-auto rounded-md border border-border bg-card p-3">
                {previewErr ? (
                  <p className="py-6 text-center text-[12px] text-destructive">
                    {previewErr}
                  </p>
                ) : (
                  (() => {
                    // Scale the true-mm label down to fit the panel so a large
                    // label (e.g. 116×71mm) can't blow out of the modal.
                    const w = Math.max(d.width_mm, 1) * MM_PX
                    const h = Math.max(d.height_mm, 1) * MM_PX
                    const scale = Math.min(1, 300 / w, 380 / h)
                    return (
                      <div
                        style={{
                          width: w * scale,
                          height: h * scale,
                          overflow: "hidden",
                          border: "1px solid var(--border)",
                          background: "#fff",
                        }}
                      >
                        <iframe
                          title="Label preview"
                          sandbox=""
                          srcDoc={srcDoc}
                          style={{
                            width: `${d.width_mm}mm`,
                            height: `${d.height_mm}mm`,
                            transform: `scale(${scale})`,
                            transformOrigin: "top left",
                            border: 0,
                            background: "#fff",
                          }}
                        />
                      </div>
                    )
                  })()
                )}
              </div>
              <p className="mt-1 text-[11px] text-muted-foreground">
                {d.width_mm} × {d.height_mm} mm
              </p>
            </div>
            <div>
              <span className="mb-1 block text-[11px] font-medium text-muted-foreground">
                Fields —{" "}
                {mode === "simple" ? "click to add a line" : "click to insert"}
              </span>
              <input
                value={fieldSearch}
                onChange={(e) => setFieldSearch(e.target.value)}
                placeholder="Search fields…"
                className="mb-1 w-full rounded-md border border-input bg-transparent px-2 py-1 text-[12px] outline-none focus-visible:ring-1 focus-visible:ring-ring"
              />
              <div className="flex max-h-48 flex-wrap gap-1 overflow-y-auto rounded-md border border-border bg-card p-2">
                {shownTokens.map((tok) => (
                  <button
                    key={tok}
                    type="button"
                    onClick={() => useField(tok)}
                    className="rounded border border-border px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground hover:bg-muted hover:text-foreground"
                  >
                    {tok}
                  </button>
                ))}
                {shownTokens.length === 0 && (
                  <span className="px-1 py-1 text-[11px] text-muted-foreground">
                    No fields match “{fieldSearch}”.
                  </span>
                )}
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
