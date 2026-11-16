import { useEffect, useMemo, useState } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { toast } from "sonner"
import { Play } from "lucide-react"

import {
  api,
  ApiError,
  type CliLintResult,
  type DeviceOption,
  type DeviceRenderFile,
  type ExportTemplate,
  type ExportTemplateLintFamily,
  type ExportTemplateWritePayload,
  type RBACObjectTypes,
} from "@/lib/api"
import { Badge } from "@/components/ui/badge"
import { apiAll } from "@/lib/api-all"
import {
  Field,
  FormCheckbox,
  FormCombobox,
  FormFooter,
  FormSection,
  FormSelect,
  FormText,
  FormTextarea,
  useFieldErrors,
  type SelectOption,
} from "@/components/forms"
import { CodeEditor } from "@/components/code-editor"
import { BundleFiles } from "@/components/device-config-render"
import { FileViewer } from "@/components/file-viewer"
import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"
import { useSaveObject } from "@/lib/save-object"

export interface ExportTemplateFormProps {
  template?: ExportTemplate
  onSaved: (v: ExportTemplate) => void
  onCancel: () => void
}

// Sentinel thrown from mutationFn when a client-side required-field check
// fails - onError swallows it so we don't fire a toast on top of the
// inline field errors.
const CLIENT_VALIDATION = "__client_validation__"

// The save-time Jinja check, run while typing (#465).
const TEMPLATE_CHECK = {
  url: "/api/export-templates/validate/",
  field: "template_code",
}

// The CLI check's families; "auto" stands for the stored "" (Radix selects
// take no empty value).
const LINT_OPTIONS: SelectOption[] = [
  { value: "auto", label: "From the platform" },
  { value: "ios", label: "Cisco IOS / IOS-XE" },
  { value: "off", label: "Off" },
]

function patternsOf(text: string): string[] {
  return text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
}

export function ExportTemplateForm({
  template,
  onSaved,
  onCancel,
}: ExportTemplateFormProps) {
  const isEdit = !!template
  const qc = useQueryClient()
  const { fieldErrors, handleApiError, reset } = useFieldErrors()
  const saveObject = useSaveObject()

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
  const [targetPath, setTargetPath] = useState(template?.target_path ?? "")
  const [lintFamily, setLintFamily] = useState<string>(
    template?.lint_family || "auto"
  )
  const [ignoreText, setIgnoreText] = useState(
    (template?.ignore_lint_patterns ?? []).join("\n")
  )
  const [lint, setLint] = useState<CliLintResult | null>(null)
  const [preview, setPreview] = useState<string | null>(null)
  // A directory template's preview: one entry per file block.
  const [previewFiles, setPreviewFiles] = useState<DeviceRenderFile[] | null>(
    null
  )
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
    setTargetPath(template.target_path)
    setLintFamily(template.lint_family || "auto")
    setIgnoreText(template.ignore_lint_patterns.join("\n"))
    setLint(null)
    setSampleId(null)
    setPreview(null)
    setPreviewFiles(null)
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

  // Sample-object picker - only for per-object (device / VM) templates.
  const samples = useQuery({
    queryKey: ["export-template-samples", perObjectEndpoint],
    queryFn: () => apiAll<DeviceOption>(`/api/${perObjectEndpoint}/?picker=1`),
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
        // Only a device template lands in a bundle; the path means nothing
        // on any other type, so it is not carried over when the type changes.
        target_path: objectType === "device" ? targetPath.trim() : "",
        lint_family: (lintFamily === "auto"
          ? ""
          : lintFamily) as ExportTemplateLintFamily,
        ignore_lint_patterns: patternsOf(ignoreText),
      }
      return saveObject<ExportTemplate>({
        objectType: "api.exporttemplate",
        endpoint: "/api/export-templates/",
        id: isEdit ? template!.id : undefined,
        payload,
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

  // A failed check says nothing: it is advice, and the render stands.
  const runLint = useMutation({
    mutationFn: (output: string) =>
      api<CliLintResult>(`/api/export-templates/${template!.id}/lint/`, {
        method: "POST",
        body: JSON.stringify({ output }),
      }),
    onSuccess: setLint,
    onError: () => setLint(null),
  })

  // Preview renders the *saved* template against live objects.
  const runPreview = useMutation({
    mutationFn: () =>
      isPerObject
        ? api<{ output?: string; files?: Record<string, DeviceRenderFile> }>(
            `/api/${perObjectEndpoint}/${sampleId}/render/?template=${template!.id}`
          )
        : api<{ output?: string; files?: Record<string, DeviceRenderFile> }>(
            `/api/export-templates/${template!.id}/preview/`
          ),
    onSuccess: (r) => {
      setLint(null)
      if (r.files) {
        setPreview(null)
        setPreviewFiles(Object.values(r.files))
      } else {
        setPreviewFiles(null)
        setPreview(r.output ?? "")
        // The CLI check on what a device would get: warnings only (#465).
        if (isPerObject && r.output) runLint.mutate(r.output)
      }
    },
    onError: (err) => {
      setPreviewFiles(null)
      setLint(null)
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
      className="@container grid gap-4"
    >
      <FormSection title="Template" card>
        <div className="grid gap-3 @md:grid-cols-2">
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
            required
            value={objectType}
            onChange={(v) => {
              setObjectType(v)
              setClientErrors((e) => ({ ...e, object_type: "" }))
              // Drop a now-stale sample selection / preview when the type
              // changes so we never render the wrong per-object endpoint.
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
      </FormSection>

      <FormSection title="Template code" card>
        <Field
          label="Template (Jinja2)"
          required
          hint={contextHint}
          error={clientErrors.template_code || fieldErrors.template_code}
        >
          <CodeEditor
            value={code}
            onChange={(v) => {
              setCode(v)
              setClientErrors((err) => ({ ...err, template_code: "" }))
            }}
            height="20rem"
            check={TEMPLATE_CHECK}
            placeholder={"{% for o in objects %}\n{{ o.name }}\n{% endfor %}"}
          />
        </Field>
      </FormSection>

      <FormSection title="Output" card>
        <div className="grid gap-3 @md:grid-cols-2">
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
        </div>
        {objectType === "device" && (
          <FormText
            label="Target path"
            mono
            placeholder="/etc/frr/frr.conf"
            info={
              "Where a bundle's render puts this file. Blank uses the template's name and extension. Ending in / makes it a directory: each {% file \"name\" %} … {% endfile %} block writes one file there."
            }
            value={targetPath}
            onChange={setTargetPath}
            error={fieldErrors.target_path}
          />
        )}
        <FormCheckbox
          label="As download"
          checked={asAttachment}
          onChange={setAsAttachment}
        />
      </FormSection>

      {isPerObject && (
        <FormSection title="CLI check" card>
          <div className="grid gap-3 @md:grid-cols-2">
            <FormSelect
              label="Commands"
              info="The preview warns about top-level commands the platform's command list does not know, with a did-you-mean hint. The list is a short seed plus every command in this tenant's stored configs for the platform. Warnings never block a save."
              value={lintFamily}
              onChange={(v) => setLintFamily(v ?? "auto")}
              options={LINT_OPTIONS}
              error={fieldErrors.lint_family}
            />
          </div>
          <FormTextarea
            label="Ignore"
            info="One per line: a command prefix (vendor-cmd) or a pattern with * and ? (snmp-server * RO). A template line with {# lint: ignore #} ignores the lines it renders."
            value={ignoreText}
            onChange={setIgnoreText}
            rows={3}
            error={fieldErrors.ignore_lint_patterns}
          />
        </FormSection>
      )}

      {isEdit && (
        <FormSection title="Preview" card>
          <p className="text-[11px] text-muted-foreground">
            Renders the saved template against live objects.
          </p>
          {isPerObject && (
            <FormCombobox
              label="Sample object"
              value={sampleId}
              onChange={setSampleId}
              placeholder="Pick a sample object"
              searchPlaceholder="Search…"
              emptyText="No objects."
              options={sampleOptions}
            />
          )}
          <div>
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
            <p className="text-[11px] text-muted-foreground">
              Pick a sample object to render this template against.
            </p>
          )}
          {preview !== null &&
            (preview.startsWith("⚠ ") ? (
              <div className="rounded-md border border-destructive/40 bg-destructive/10 p-3 font-mono text-[12px] whitespace-pre-wrap">
                {preview}
              </div>
            ) : (
              <>
                <FileViewer
                  text={preview}
                  filename={`${template.name}.${template.file_extension || "txt"}`}
                  storageKey="template-preview"
                  label="Preview"
                  marks={lint?.warnings.map((w) => w.line)}
                  meta={
                    lint && lint.family ? (
                      lint.warnings.length ? (
                        <Badge variant="warning">
                          {lint.warnings.length}{" "}
                          {lint.warnings.length === 1 ? "warning" : "warnings"}
                        </Badge>
                      ) : (
                        <Badge variant="success">CLI check clean</Badge>
                      )
                    ) : undefined
                  }
                />
                {lint && lint.warnings.length > 0 && (
                  <ul className="space-y-0.5 font-mono text-[12px]">
                    {lint.warnings.map((w) => (
                      <li key={`${w.line}:${w.keyword}`}>
                        <span className="text-muted-foreground">
                          Line {w.line}
                        </span>{" "}
                        {w.message}
                      </li>
                    ))}
                  </ul>
                )}
              </>
            ))}
          {previewFiles !== null && (
            <BundleFiles
              files={previewFiles}
              empty="No files for this sample."
            />
          )}
        </FormSection>
      )}

      <FormFooter
        onCancel={onCancel}
        submitting={save.isPending}
        submitLabel={isEdit ? "Save changes" : "Create template"}
      />
    </form>
  )
}
