import { useEffect, useMemo, useState } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { toast } from "sonner"

import {
  api,
  type RBACObjectTypes,
  type Webhook,
  type WebhookMethod,
  type WebhookWritePayload,
} from "@/lib/api"
import {
  CheckList,
  Field,
  FormCheckbox,
  FormFooter,
  FormSelect,
  FormText,
  FormTextarea,
  useFieldErrors,
  type CheckOption,
} from "@/components/forms"

const METHODS: { value: WebhookMethod; label: string }[] = [
  { value: "POST", label: "POST" },
  { value: "PUT", label: "PUT" },
  { value: "PATCH", label: "PATCH" },
]
const WILDCARD = "*"

export interface WebhookFormProps {
  webhook?: Webhook
  onSaved: (v: Webhook) => void
  onCancel: () => void
}

export function WebhookForm({ webhook, onSaved, onCancel }: WebhookFormProps) {
  const isEdit = !!webhook
  const qc = useQueryClient()
  const { fieldErrors, handleApiError, reset } = useFieldErrors()

  const [name, setName] = useState(webhook?.name ?? "")
  const [enabled, setEnabled] = useState(webhook?.enabled ?? true)
  const [payloadUrl, setPayloadUrl] = useState(webhook?.payload_url ?? "")
  const [method, setMethod] = useState<WebhookMethod>(
    webhook?.http_method ?? "POST"
  )
  const [allTypes, setAllTypes] = useState(
    webhook?.object_types.includes(WILDCARD) ?? false
  )
  const [objectTypes, setObjectTypes] = useState<string[]>(
    webhook?.object_types.filter((t) => t !== WILDCARD) ?? []
  )
  const [onCreate, setOnCreate] = useState(webhook?.on_create ?? true)
  const [onUpdate, setOnUpdate] = useState(webhook?.on_update ?? true)
  const [onDelete, setOnDelete] = useState(webhook?.on_delete ?? false)
  const [secret, setSecret] = useState("")
  const [contentType, setContentType] = useState(
    webhook?.http_content_type ?? "application/json"
  )
  const [headers, setHeaders] = useState(webhook?.additional_headers ?? "")
  const [sslVerify, setSslVerify] = useState(webhook?.ssl_verification ?? true)

  useEffect(() => {
    if (!webhook) return
    setName(webhook.name)
    setEnabled(webhook.enabled)
    setPayloadUrl(webhook.payload_url)
    setMethod(webhook.http_method)
    setAllTypes(webhook.object_types.includes(WILDCARD))
    setObjectTypes(webhook.object_types.filter((t) => t !== WILDCARD))
    setOnCreate(webhook.on_create)
    setOnUpdate(webhook.on_update)
    setOnDelete(webhook.on_delete)
    setSecret("")
    setContentType(webhook.http_content_type)
    setHeaders(webhook.additional_headers)
    setSslVerify(webhook.ssl_verification)
    reset()
  }, [webhook, reset])

  const typesQuery = useQuery({
    queryKey: ["rbac", "object-types"],
    queryFn: () => api<RBACObjectTypes>("/api/rbac/object-types/"),
    staleTime: 10 * 60_000,
  })
  const typeOptions = useMemo<CheckOption<string>[]>(
    () =>
      (typesQuery.data?.object_types ?? []).map((t) => ({
        value: t.slug,
        label: t.label,
        hint: t.group,
      })),
    [typesQuery.data]
  )

  const mutation = useMutation({
    mutationFn: async () => {
      const payload: WebhookWritePayload = {
        name: name.trim(),
        enabled,
        object_types: allTypes ? [WILDCARD] : objectTypes,
        on_create: onCreate,
        on_update: onUpdate,
        on_delete: onDelete,
        payload_url: payloadUrl.trim(),
        http_method: method,
        http_content_type: contentType.trim() || "application/json",
        additional_headers: headers,
        ssl_verification: sslVerify,
      }
      if (secret.trim()) payload.secret = secret
      if (isEdit)
        return api<Webhook>(`/api/webhooks/${webhook!.id}/`, {
          method: "PATCH",
          body: JSON.stringify(payload),
        })
      return api<Webhook>("/api/webhooks/", {
        method: "POST",
        body: JSON.stringify(payload),
      })
    },
    onSuccess: (saved) => {
      qc.invalidateQueries({ queryKey: ["webhooks"] })
      qc.invalidateQueries({ queryKey: ["webhook", saved.id] })
      toast.success(isEdit ? `Updated ${saved.name}` : `Created ${saved.name}`)
      onSaved(saved)
    },
    onError: (err) => {
      const msg = handleApiError(err)
      if (msg) toast.error(msg)
    },
  })

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault()
        mutation.mutate()
      }}
      className="grid max-w-2xl gap-4"
    >
      <div className="grid grid-cols-[1fr_auto] items-end gap-4">
        <FormText
          label="Name"
          required
          autoFocus={!isEdit}
          value={name}
          onChange={setName}
          error={fieldErrors.name}
        />
        <FormCheckbox
          label="Enabled"
          checked={enabled}
          onChange={setEnabled}
          className="pb-2"
        />
      </div>

      <div className="grid grid-cols-[auto_1fr] gap-3">
        <FormSelect
          label="Method"
          value={method}
          onChange={(v) => setMethod((v as WebhookMethod) ?? "POST")}
          options={METHODS}
        />
        <FormText
          label="Payload URL"
          required
          type="url"
          mono
          placeholder="https://example.com/hook"
          value={payloadUrl}
          onChange={setPayloadUrl}
          error={fieldErrors.payload_url}
        />
      </div>

      <Field
        label="Triggers"
        hint="Which changes fire this webhook"
        error={fieldErrors.object_types}
      >
        <div className="flex flex-wrap gap-x-6 gap-y-2 rounded-md border border-border p-3">
          <FormCheckbox
            label="Create"
            checked={onCreate}
            onChange={setOnCreate}
          />
          <FormCheckbox
            label="Update"
            checked={onUpdate}
            onChange={setOnUpdate}
          />
          <FormCheckbox
            label="Delete"
            checked={onDelete}
            onChange={setOnDelete}
          />
        </div>
      </Field>

      <Field label="Object types" error={fieldErrors.object_types}>
        <FormCheckbox
          label="All object types"
          checked={allTypes}
          onChange={setAllTypes}
          hint="Fire for every model"
          className="mb-2"
        />
        {!allTypes && (
          <CheckList
            options={typeOptions}
            value={objectTypes}
            onChange={setObjectTypes}
            empty="Loading object types…"
          />
        )}
      </Field>

      <FormText
        label="Secret"
        type="password"
        autoComplete="new-password"
        placeholder={
          webhook?.secret_set ? "Saved — leave blank to keep" : "Optional"
        }
        hint="HMAC-SHA512 signs the body in X-Danbyte-Signature"
        value={secret}
        onChange={setSecret}
        error={fieldErrors.secret}
      />
      <div className="grid grid-cols-2 gap-3">
        <FormText
          label="Content-Type"
          mono
          value={contentType}
          onChange={setContentType}
          error={fieldErrors.http_content_type}
        />
        <div className="flex items-end pb-2">
          <FormCheckbox
            label="Verify TLS certificate"
            checked={sslVerify}
            onChange={setSslVerify}
          />
        </div>
      </div>
      <FormTextarea
        label="Additional headers"
        hint="One 'Name: value' per line"
        rows={3}
        value={headers}
        onChange={setHeaders}
        error={fieldErrors.additional_headers}
      />

      <FormFooter
        onCancel={onCancel}
        submitting={mutation.isPending}
        submitLabel={isEdit ? "Save changes" : "Create webhook"}
      />
    </form>
  )
}
