import { useEffect, useMemo, useState } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { toast } from "sonner"
import { Play } from "lucide-react"

import {
  api,
  ApiError,
  type DeviceOption,
  type ExportTemplate,
  type ExportTemplateWritePayload,
  type Paginated,
  type RBACObjectTypes,
} from "@/lib/api"
import {
  Field,
  FormCheckbox,
  FormCombobox,
  FormFooter,
  FormSelect,
  FormText,
  FormTextarea,
  useFieldErrors,
  type SelectOption,
} from "@/components/forms"
import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"

export interface ExportTemplateFormProps {
  template?: ExportTemplate
  onSaved: (v: ExportTemplate) => void
  onCancel: () => void
}

// Sentinel thrown from mutationFn when a client-side required-field check
// fails — onError swallows it so we don't fire a toast on top of the
// inline field errors.
const CLIENT_VALIDATION = "__client_validation__"

export function ExportTemplateForm({
  template,
  onSaved,
  onCancel,
}: ExportTemplateFormProps) {
  const isEdit = !!template
  const qc = useQueryClient()
  const { fieldErrors, handleApiError, reset } = useFieldErrors()

  const [name, setName] = useState(template?.name ?? "")
  const [objectType, setObjectType] = useState<string | null>(
    template?.object_type ?? null
  )
  const [description, setDescription] = useState(template?.description ?? "")
  const [code, setCode] = useState(template?.template_code ?? "")
  const [mimeType, setMimeType] = useState(template?.mime_type ?? "text/plain")
  const [ext, setExt] = useState(template?.file_extension ?? "txt")
  const [asAttachment, setAsAttachment] = useState(
    template?.as_attachment ?? true
  )
  const [preview, setPreview] = useState<string | null>(null)
  const [sampleId, setSampleId] = useState<string | null>(null)
  // Client-side required-field errors, merged with the DRF field errors.
  const [clientErrors, setClientErrors] = useState<Record<string, string>>({})

  useEffect(() => {
    if (!template) return
    setName(template.name)
    setObjectType(template.object_type)
    setDescription(template.description)
    setCode(template.template_code)
    setMimeType(template.mime_type)
    setExt(template.file_extension)
    setAsAttachment(template.as_attachment)
    setSampleId(null)
    setPreview(null)
    setClientErrors({})
    reset()
  }, [template, reset])

  // Device / VM templates render against a *single* object (context:
  // device · config_context · interfaces · ip_addresses), not a queryset, so
  // the live preview goes through the per-object render endpoint and needs a
  // sample object to render against.
  const perObjectEndpoint: string | null = objectType
    ? ({ device: "devices", virtualmachine: "virtual-machines" }[objectType] ??
      null)
    : null
  const isPerObject = perObjectEndpoint !== null

  const contextHint = isPerObject
    ? "Context: device · config_context · interfaces · ip_addresses"
    : "Context: objects · queryset · count"

  const types = useQuery({
    queryKey: ["rbac", "object-types"],
    queryFn: () => api<RBACObjectTypes>("/api/rbac/object-types/"),
    staleTime: 10 * 60_000,
  })
  const typeOptions = useMemo<SelectOption[]>(
    () =>
      (types.data?.object_types ?? []).map((t) => ({
        value: t.slug,
        label: `${t.label} (${t.group})`,
      })),
    [types.data]
  )

  // Sample-object picker — only for per-object (device / VM) templates.
  const samples = useQuery({
    queryKey: ["export-template-samples", perObjectEndpoint],
    queryFn: () =>
      api<Paginated<DeviceOption>>(`/api/${perObjectEndpoint}/?picker=1`),
    enabled: isEdit && isPerObject,
    staleTime: 10 * 60_000,
  })
  const sampleOptions = useMemo(
    () =>
      (samples.data?.results ?? []).map((o) => ({
        value: o.id,
        label: o.name,
      })),
    [samples.data]
  )

  const save = useMutation({
    mutationFn: async () => {
      // Both fields are required by the backend; guard so we never send an
      // empty object_type or a blank template_code.
      if (!objectType || !code.trim()) {
        const errs: Record<string, string> = {}
        if (!objectType) errs.object_type = "Pick an object type."
        if (!code.trim()) errs.template_code = "Template code is required."
        setClientErrors(errs)
        throw new Error(CLIENT_VALIDATION)
      }
      setClientErrors({})
      const payload: ExportTemplateWritePayload = {
        name: name.trim(),
        object_type: objectType,
        description: description.trim(),
        template_code: code,
        mime_type: mimeType.trim() || "text/plain",
        file_extension: ext.trim() || "txt",
        as_attachment: asAttachment,
      }
      if (isEdit)
        return api<ExportTemplate>(`/api/export-templates/${template!.id}/`, {
          method: "PATCH",
          body: JSON.stringify(payload),
        })
      return api<ExportTemplate>("/api/export-templates/", {
        method: "POST",
        body: JSON.stringify(payload),
      })
    },
    onSuccess: (saved) => {
      qc.invalidateQueries({ queryKey: ["export-templates"] })
      qc.invalidateQueries({ queryKey: ["export-template", saved.id] })
      toast.success(isEdit ? `Updated ${saved.name}` : `Created ${saved.name}`)
      onSaved(saved)
    },
    onError: (err) => {
      if ((err as Error).message === CLIENT_VALIDATION) return
      const msg = handleApiError(err)
      if (msg) toast.error(msg)
    },
  })

  // Preview renders the *saved* template against live objects.
  const runPreview = useMutation({
    mutationFn: () =>
      isPerObject
        ? api<{ output: string }>(
            `/api/${perObjectEndpoint}/${sampleId}/render/?template=${template!.id}`
          )
        : api<{ output: string }>(
            `/api/export-templates/${template!.id}/preview/`
          ),
    onSuccess: (r) => setPreview(r.output),
    onError: (err) => {
      const detail =
        err instanceof ApiError &&
        err.body &&
        typeof err.body === "object" &&
        "detail" in err.body
          ? String((err.body as { detail: unknown }).detail)
          : (err as Error).message
      setPreview(`⚠ ${detail}`)
    },
  })

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault()
        save.mutate()
      }}
      className="grid max-w-3xl gap-4"
    >
      <div className="grid grid-cols-2 gap-3">
        <FormText
          label="Name"
          required
          autoFocus={!isEdit}
          value={name}
          onChange={setName}
          error={fieldErrors.name}
        />
        <FormSelect
          label="Object type"
          hint="required"
          value={objectType}
          onChange={(v) => {
            setObjectType(v)
            setClientErrors((e) => ({ ...e, object_type: "" }))
            // Drop a now-stale sample selection / preview when the type changes
            // so we never render the wrong per-object endpoint.
            setSampleId(null)
            setPreview(null)
          }}
          options={typeOptions}
          placeholder="Pick a type"
          error={clientErrors.object_type || fieldErrors.object_type}
        />
      </div>

      <FormTextarea
        label="Description"
        value={description}
        onChange={setDescription}
        error={fieldErrors.description}
      />

      <Field
        label="Template (Jinja2)"
        hint={contextHint}
        error={clientErrors.template_code || fieldErrors.template_code}
      >
        <textarea
          value={code}
          onChange={(e) => {
            setCode(e.target.value)
            setClientErrors((err) => ({ ...err, template_code: "" }))
          }}
          rows={12}
          spellCheck={false}
          className="w-full rounded-md border border-input bg-transparent p-3 font-mono text-[12px] leading-relaxed outline-none focus-visible:ring-1 focus-visible:ring-ring"
          placeholder={"{% for o in objects %}\n{{ o.name }}\n{% endfor %}"}
        />
      </Field>

      <div className="grid grid-cols-[1fr_auto_auto] items-end gap-3">
        <FormText
          label="MIME type"
          mono
          value={mimeType}
          onChange={setMimeType}
          error={fieldErrors.mime_type}
        />
        <FormText
          label="Extension"
          mono
          value={ext}
          onChange={setExt}
          error={fieldErrors.file_extension}
        />
        <FormCheckbox
          label="As download"
          checked={asAttachment}
          onChange={setAsAttachment}
          className="pb-2"
        />
      </div>

      {isEdit && (
        <Field
          label="Preview"
          hint="Renders the saved template against live objects"
        >
          {isPerObject && (
            <div className="mb-2">
              <FormCombobox
                label="Sample object"
                value={sampleId}
                onChange={setSampleId}
                placeholder="Pick a sample object"
                searchPlaceholder="Search…"
                emptyText="No objects."
                options={sampleOptions}
              />
            </div>
          )}
          <div className="mb-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => runPreview.mutate()}
              disabled={runPreview.isPending || (isPerObject && !sampleId)}
            >
              {runPreview.isPending ? (
                <Spinner className="size-4" />
              ) : (
                <Play className="size-4" />
              )}
              Run preview
            </Button>
          </div>
          {isPerObject && !sampleId && (
            <p className="mb-2 text-[11px] text-muted-foreground">
              Pick a sample object to render this template against.
            </p>
          )}
          {preview !== null && (
            <pre className="max-h-72 overflow-auto rounded-md bg-muted/40 p-3 font-mono text-[12px] leading-relaxed">
              {preview || "(empty)"}
            </pre>
          )}
        </Field>
      )}

      <FormFooter
        onCancel={onCancel}
        submitting={save.isPending}
        submitLabel={isEdit ? "Save changes" : "Create template"}
      />
    </form>
  )
}
