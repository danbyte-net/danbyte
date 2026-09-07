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
  FormColumn,
  FormColumns,
  FormFooter,
  FormSection,
  FormSelect,
  FormText,
  FormTextarea,
  useFieldErrors,
  type CheckOption,
} from "@/components/forms"
import { useSaveObject } from "@/lib/save-object"

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
  const saveObject = useSaveObject()

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
      return saveObject<Webhook>({
        objectType: "integrations.webhook",
        endpoint: "/api/webhooks/",
        id: isEdit ? webhook!.id : undefined,
        payload,
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
      className="grid gap-4"
    >
      <FormColumns>
        <FormColumn>
          <FormSection title="Webhook" card>
            <FormText
              label="Name"
              required
              autoFocus={!isEdit}
              value={name}
              onChange={setName}
              error={fieldErrors.name}
            />
            <div className="grid gap-3 @md:grid-cols-2">
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
            <FormCheckbox
              label="Enabled"
              checked={enabled}
              onChange={setEnabled}
            />
          </FormSection>

          <FormSection title="Delivery" card>
            <FormText
              label="Secret"
              type="password"
              autoComplete="new-password"
              placeholder={
                webhook?.secret_set ? "Saved - leave blank to keep" : "Optional"
              }
              hint="HMAC-SHA512 signs the body in X-Danbyte-Signature"
              value={secret}
              onChange={setSecret}
              error={fieldErrors.secret}
            />
            <FormText
              label="Content-Type"
              mono
              value={contentType}
              onChange={setContentType}
              error={fieldErrors.http_content_type}
            />
            <FormCheckbox
              label="Verify TLS certificate"
              checked={sslVerify}
              onChange={setSslVerify}
            />
            <FormTextarea
              label="Additional headers"
              hint="One 'Name: value' per line"
              rows={3}
              value={headers}
              onChange={setHeaders}
              error={fieldErrors.additional_headers}
            />
          </FormSection>
        </FormColumn>

        <FormColumn>
          <FormSection title="Triggers" card>
            <p className="text-[11px] text-muted-foreground">
              Which changes fire this webhook.
            </p>
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
          </FormSection>

          <FormSection title="Object types" card>
            <Field label="Models" required error={fieldErrors.object_types}>
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
          </FormSection>
        </FormColumn>
      </FormColumns>

      <FormFooter
        onCancel={onCancel}
        submitting={mutation.isPending}
        submitLabel={isEdit ? "Save changes" : "Create webhook"}
      />
    </form>
  )
}
