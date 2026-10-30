import { useEffect, useMemo, useRef, useState } from "react"
import {
  keepPreviousData,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query"
import { toast } from "sonner"

import { api, ApiError } from "@/lib/api"
import type {
  ComplianceCheck,
  ComplianceExpr,
  ComplianceField,
  CompliancePreview,
  ComplianceRule,
  ComplianceSeverity,
} from "@/lib/api"
import { apiAll } from "@/lib/api-all"
import {
  blankRule,
  fromTreeWithPaths,
  nodeForPath,
  toTree,
  treeId,
} from "@/lib/filter-expr"
import type { TreeGroup, TreeRule } from "@/lib/filter-expr"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import {
  Field,
  FormCheckbox,
  FormColumn,
  FormColumns,
  FormFooter,
  FormSection,
  FormSelect,
  FormText,
  FormTextarea,
} from "@/components/forms"
import type { SelectOption } from "@/components/forms"
import { ExpressionBuilder, MAX_GROUPS } from "@/components/filter-expression"
import type { FieldSpec } from "@/components/filter-expression"
import {
  OBJECT_TYPE_LABEL,
  countOf,
  invalidateCompliance,
} from "@/components/compliance/compliance-shared"
import { apiErrorToast } from "@/lib/api-toast"

const OBJECT_TYPES = Object.entries(OBJECT_TYPE_LABEL).map(
  ([value, label]) => ({
    value,
    label,
  })
)

// New rules are built from conditions; the three computed checks stay their
// own types and take the scope like any other.
const CHECKS: { value: ComplianceCheck; label: string }[] = [
  { value: "expression", label: "Conditions" },
  { value: "eol_status", label: "End-of-life status" },
  { value: "coverage", label: "Support coverage" },
  { value: "software_target", label: "Software target" },
]
// The single-field checks from before conditions: offered only on a rule
// that already uses one, with Convert to conditions.
const LEGACY_CHECKS: { value: ComplianceCheck; label: string }[] = [
  { value: "required", label: "Field must be set" },
  { value: "forbidden", label: "Field must be empty" },
  { value: "regex", label: "Field must match a pattern" },
  { value: "required_tag", label: "Must carry a tag" },
  { value: "required_cf", label: "Custom field must be set" },
]
const LEGACY = new Set(LEGACY_CHECKS.map((c) => c.value))

// An end-of-life or software target check reads the platform, so it suits
// devices and VMs; support coverage is a device's.
const PLATFORM_TYPES = new Set(["device", "virtualmachine"])
const suits = (check: ComplianceCheck, types: string[]) =>
  check === "eol_status" || check === "software_target"
    ? types.every((t) => PLATFORM_TYPES.has(t))
    : check === "coverage"
      ? types.every((t) => t === "device")
      : true

const EOL_FAIL_ON: SelectOption[] = [
  { value: "eol", label: "End of life" },
  { value: "ending", label: "Support ending or ended" },
  { value: "unknown", label: "No end-of-life data" },
]
const COVERAGE_FAIL_ON: SelectOption[] = [
  { value: "expired", label: "Expired or not covered" },
  { value: "expiring", label: "Expiring, expired or not covered" },
]

// Compliance severity is a fixed scale rather than a catalog row, but it is
// rendered as a tinted pill wherever violations show up - the picker uses the
// same pill so the two never disagree.
const SEV_VARIANT: Record<
  ComplianceSeverity,
  "destructive" | "warning" | "secondary"
> = { critical: "destructive", warning: "warning", info: "secondary" }

const SEVERITIES: SelectOption[] = (
  ["critical", "warning", "info"] as ComplianceSeverity[]
).map((s) => ({
  value: s,
  label: (
    <Badge variant={SEV_VARIANT[s]} className="capitalize">
      {s}
    </Badge>
  ),
}))

// A legacy `field` is a model attribute; a few are a different key in the
// condition fields.
const FIELD_ALIASES: Record<string, Record<string, string>> = {
  prefix: { cidr: "prefix" },
  ipaddress: { ip_address: "address", role: "ip_role" },
  vlan: { vlan_id: "vid", group: "vlan_group" },
  virtualmachine: { group: "vm_group", device: "host" },
}

interface ExprError {
  path: string
  detail: string
}

/** The fields a rule on these types can name. */
export function useComplianceFields(types: string[]) {
  return useQuery({
    queryKey: ["compliance-fields", types.join(",")],
    queryFn: () =>
      api<{ fields: ComplianceField[] }>(
        `/api/compliance/fields/?object_types=${types.join(",")}`
      ),
    enabled: types.length > 0,
    placeholderData: keepPreviousData,
    staleTime: 60_000,
  })
}

const rootOf = (e: ComplianceExpr | null | undefined): TreeGroup =>
  toTree(e ?? null, MAX_GROUPS) ?? {
    kind: "group",
    id: treeId(),
    op: "and",
    items: [],
  }

function withRow(tree: TreeGroup): TreeGroup {
  return tree.items.length ? tree : { ...tree, items: [blankRule()] }
}

/** One more condition ANDed onto a tree. */
function andWith(tree: TreeGroup, rule: TreeRule): TreeGroup {
  const rows = tree.items.filter((i) => i.kind === "group" || i.field)
  if (tree.op === "and") return { ...tree, items: [...rows, rule] }
  return {
    kind: "group",
    id: treeId(),
    op: "and",
    items: rows.length ? [{ ...tree, items: rows }, rule] : [rule],
  }
}

function errorMap(tree: TreeGroup, errors: ExprError[] | undefined) {
  const out = new Map<number, string>()
  if (!errors?.length) return out
  const { paths } = fromTreeWithPaths(tree)
  for (const e of errors) {
    const id = nodeForPath(paths, e.path) ?? tree.id
    out.set(id, out.has(id) ? `${out.get(id)} ${e.detail}` : e.detail)
  }
  return out
}

function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value)
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms)
    return () => clearTimeout(t)
  }, [value, ms])
  return v
}

export function ComplianceRuleForm({
  rule,
  onSaved,
  onCancel,
}: {
  rule?: ComplianceRule
  onSaved: () => void
  onCancel: () => void
}) {
  const qc = useQueryClient()
  const isEdit = !!rule
  const [name, setName] = useState(rule?.name ?? "")
  const [description, setDescription] = useState(rule?.description ?? "")
  const [remediation, setRemediation] = useState(rule?.remediation ?? "")
  const [types, setTypes] = useState<string[]>(
    rule?.object_types.length
      ? rule.object_types
      : rule
        ? [rule.object_type]
        : ["device"]
  )
  const [check, setCheck] = useState<ComplianceCheck>(
    rule?.check_type ?? "expression"
  )
  const [severity, setSeverity] = useState<ComplianceSeverity>(
    rule?.severity ?? "warning"
  )
  const [enabled, setEnabled] = useState(rule?.enabled ?? true)
  const [field, setField] = useState(rule?.field ?? "")
  const [pattern, setPattern] = useState(rule?.pattern ?? "")
  const [tag, setTag] = useState(rule?.tag ?? "")
  const [cfKey, setCfKey] = useState(rule?.cf_key ?? "")
  const [eolFailOn, setEolFailOn] = useState<string>(rule?.eol_fail_on || "eol")
  const [coverageFailOn, setCoverageFailOn] = useState<string>(
    rule?.coverage_fail_on || "expired"
  )
  const [includeSoftware, setIncludeSoftware] = useState(
    rule?.include_software ?? false
  )
  const [failOnUnknown, setFailOnUnknown] = useState(
    rule?.fail_on_unknown ?? false
  )
  const [scope, setScopeTree] = useState<TreeGroup>(() => rootOf(rule?.scope))
  const [condition, setConditionTree] = useState<TreeGroup>(() =>
    withRow(rootOf(rule?.condition))
  )
  const [errors, setErrors] = useState<{
    scope?: ExprError[]
    condition?: ExprError[]
  }>({})
  const setScope = (t: TreeGroup) => {
    setScopeTree(t)
    setErrors((e) => ({ ...e, scope: undefined }))
  }
  const setCondition = (t: TreeGroup) => {
    setConditionTree(t)
    setErrors((e) => ({ ...e, condition: undefined }))
  }

  const fieldsQ = useComplianceFields(types)
  const fields: FieldSpec[] = useMemo(
    () => (fieldsQ.data?.fields ?? []) as FieldSpec[],
    [fieldsQ.data]
  )

  // Tags by slug, for the legacy checks that name one.
  const wantsTags = (check === "coverage" && !!tag) || check === "required_tag"
  const tagsQ = useQuery({
    queryKey: ["expr-ref-options", "/api/tags/?picker=1"],
    queryFn: () =>
      apiAll<{ id: string; slug: string; name: string }>("/api/tags/?picker=1"),
    enabled: wantsTags,
    staleTime: 5 * 60_000,
  })
  const tagIdOf = (slug: string): string | null => {
    const hits = (tagsQ.data?.results ?? []).filter((t) => t.slug === slug)
    return hits.length === 1 ? String(hits[0].id) : null
  }

  // A coverage rule's "only with tag" is a scope condition now: moved over
  // once, when the slug names exactly one tag; the save then clears it.
  const movedTag = useRef(false)
  useEffect(() => {
    if (movedTag.current || check !== "coverage" || !tag || !tagsQ.data) return
    movedTag.current = true
    const id = tagIdOf(tag)
    if (!id) return
    setScopeTree((t) =>
      andWith(t, {
        kind: "rule",
        id: treeId(),
        field: "tags",
        cmp: "in",
        value: "",
        values: [id],
      })
    )
    setTag("")
  }, [tagsQ.data, check, tag])

  const scopeExpr = fromTreeWithPaths(scope).expr
  const conditionExpr = fromTreeWithPaths(condition).expr

  const body = {
    name: name.trim(),
    description,
    remediation,
    object_types: types,
    scope: scopeExpr,
    condition: check === "expression" ? conditionExpr : null,
    check_type: check,
    severity,
    enabled,
    field: LEGACY.has(check) ? field : "",
    pattern: check === "regex" ? pattern : "",
    tag: check === "required_tag" || check === "coverage" ? tag : "",
    cf_key: check === "required_cf" ? cfKey : "",
    eol_fail_on: check === "eol_status" ? eolFailOn : "",
    coverage_fail_on: check === "coverage" ? coverageFailOn : "",
    fail_on_unknown: check === "software_target" && failOnUnknown,
    include_software:
      check === "eol_status" && eolFailOn !== "unknown" && includeSoftware,
  }

  const save = useMutation({
    mutationFn: () =>
      isEdit
        ? api(`/api/compliance-rules/${rule!.id}/`, {
            method: "PATCH",
            body: JSON.stringify(body),
          })
        : api("/api/compliance-rules/", {
            method: "POST",
            body: JSON.stringify(body),
          }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["compliance-rules"] })
      qc.invalidateQueries({ queryKey: ["compliance-rule"] })
      invalidateCompliance(qc)
      toast.success(isEdit ? `Saved ${name.trim()}` : `Created ${name.trim()}`)
      onSaved()
    },
    onError: (err) => {
      const b =
        err instanceof ApiError && err.status === 400
          ? (err.body as Record<string, unknown>)
          : null
      const pathErrors = (v: unknown) =>
        Array.isArray(v) && v.every((x) => x && typeof x === "object")
          ? (v as ExprError[])
          : undefined
      const scopeErr = pathErrors(b?.scope)
      const condErr = pathErrors(b?.condition)
      if (scopeErr || condErr) {
        setErrors({ scope: scopeErr, condition: condErr })
        toast.error("Fix the marked conditions.")
        return
      }
      apiErrorToast(err)
    },
  })

  const legacyRule = LEGACY.has(check)
  const checkOptions = [
    ...CHECKS.filter((c) => suits(c.value, types)),
    ...(legacyRule ? LEGACY_CHECKS.filter((c) => c.value === check) : []),
  ]

  const convert = () => {
    const keyOf = (f: string) => {
      if (fields.some((x) => x.key === f)) return f
      for (const t of types) {
        const alias = (
          FIELD_ALIASES[t] as Record<string, string> | undefined
        )?.[f]
        if (alias && fields.some((x) => x.key === alias)) return alias
      }
      return null
    }
    const row = (patch: Partial<TreeRule>): TreeRule => ({
      ...blankRule(),
      ...patch,
    })
    let tree: TreeGroup | null = null
    if (check === "required" || check === "forbidden" || check === "regex") {
      const key = keyOf(field)
      if (key && check === "regex")
        // The old check passed an empty value; so does this.
        tree = {
          kind: "group",
          id: treeId(),
          op: "or",
          items: [
            row({ field: key, cmp: "empty" }),
            row({ field: key, cmp: "matches", value: pattern }),
          ],
        }
      else if (key)
        tree = {
          kind: "group",
          id: treeId(),
          op: "and",
          items: [
            row({
              field: key,
              cmp: check === "required" ? "not_empty" : "empty",
            }),
          ],
        }
    } else if (check === "required_cf") {
      const key = keyOf(`cf.${cfKey}`)
      if (key)
        tree = {
          kind: "group",
          id: treeId(),
          op: "and",
          items: [row({ field: key, cmp: "not_empty" })],
        }
    } else if (check === "required_tag") {
      const id = tagIdOf(tag)
      if (id)
        tree = {
          kind: "group",
          id: treeId(),
          op: "and",
          items: [row({ field: "tags", cmp: "in", values: [id] })],
        }
    }
    if (!tree) {
      toast.error("This check has no condition to convert to.")
      return
    }
    setCondition(tree)
    setCheck("expression")
  }

  const toggleTypes = (next: string[]) => {
    if (!next.length) return
    // Keep the order picked: the first type is the rule's main one.
    const ordered = [
      ...types.filter((t) => next.includes(t)),
      ...next.filter((t) => !types.includes(t)),
    ]
    setTypes(ordered)
    if (!suits(check, ordered)) setCheck("expression")
  }

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault()
        if (name.trim()) save.mutate()
      }}
      className="@container grid gap-4"
    >
      <FormColumns>
        <FormColumn>
          <FormSection title="Rule" card>
            <FormText
              label="Name"
              required
              autoFocus
              value={name}
              onChange={setName}
              placeholder="Servers need an owner"
            />

            <FormSelect
              label="Severity"
              value={severity}
              onChange={(v) =>
                setSeverity((v as ComplianceSeverity) ?? "warning")
              }
              options={SEVERITIES}
            />

            <FormTextarea
              label="Description"
              hint="Why this rule exists"
              value={description}
              onChange={setDescription}
              rows={3}
            />

            <FormCheckbox
              label="Enabled"
              checked={enabled}
              onChange={setEnabled}
            />
          </FormSection>
        </FormColumn>

        <FormColumn>
          <FormSection title="Remediation" card>
            <FormTextarea
              label="How to fix"
              hint="Markdown guide shown with this rule's violations - headings, lists, `code`, **bold**, links"
              value={remediation}
              onChange={setRemediation}
              rows={6}
              placeholder={"1. Open the device\n2. Set the missing field…"}
            />
          </FormSection>
        </FormColumn>
      </FormColumns>

      <FormSection title="Applies to" card>
        <Field label="Object types" required group>
          <ToggleGroup
            type="multiple"
            variant="outline"
            size="sm"
            value={types}
            onValueChange={toggleTypes}
            className="flex-wrap"
            aria-label="Object types"
          >
            {OBJECT_TYPES.map((t) => (
              <ToggleGroupItem
                key={t.value}
                value={t.value}
                className="px-3 whitespace-nowrap"
              >
                {t.label}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
        </Field>
        <Field label="Only objects where" group>
          <ExpressionBuilder
            fields={fields}
            value={scope}
            onChange={setScope}
            types={types}
            errors={errorMap(scope, errors.scope)}
            refs={rule?.refs}
            emptyText="Every object of the chosen types."
          />
        </Field>
      </FormSection>

      <FormSection title="Check" card>
        <div className="grid gap-3 @md:grid-cols-2">
          <FormSelect
            label="Check"
            required
            value={check}
            onChange={(v) => setCheck((v as ComplianceCheck) ?? "expression")}
            options={checkOptions}
          />
          {legacyRule && (
            <div className="flex items-end">
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={convert}
              >
                Convert to conditions
              </Button>
            </div>
          )}
        </div>

        {check === "expression" && (
          <Field label="Must match" required group>
            <ExpressionBuilder
              fields={fields}
              value={condition}
              onChange={setCondition}
              types={types}
              errors={errorMap(condition, errors.condition)}
              refs={rule?.refs}
            />
          </Field>
        )}

        {legacyRule && check !== "required_tag" && check !== "required_cf" && (
          <FormText
            label="Field"
            required
            mono
            value={field}
            onChange={setField}
            placeholder="description"
          />
        )}
        {check === "regex" && (
          <FormText
            label="Pattern"
            required
            mono
            value={pattern}
            onChange={setPattern}
            placeholder="^[a-z0-9.-]+$"
            hint="Python regex"
          />
        )}
        {check === "required_tag" && (
          <FormText
            label="Tag slug"
            required
            mono
            value={tag}
            onChange={setTag}
            placeholder="monitored"
          />
        )}
        {check === "required_cf" && (
          <FormText
            label="Custom-field key"
            required
            mono
            value={cfKey}
            onChange={setCfKey}
            placeholder="owner"
          />
        )}
        {check === "eol_status" && (
          <>
            <FormSelect
              label="Fails on"
              required
              value={eolFailOn}
              onChange={(v) => setEolFailOn(v ?? "eol")}
              options={EOL_FAIL_ON}
              hint="The platform's end-of-life status"
            />
            {eolFailOn !== "unknown" && (
              <FormCheckbox
                label="Include installed software"
                checked={includeSoftware}
                onChange={setIncludeSoftware}
              />
            )}
          </>
        )}
        {check === "coverage" && (
          <FormSelect
            label="Fails on"
            required
            value={coverageFailOn}
            onChange={(v) => setCoverageFailOn(v ?? "expired")}
            options={COVERAGE_FAIL_ON}
            hint="The device's support and warranty coverage"
          />
        )}
        {check === "software_target" && (
          <FormCheckbox
            label="Fail without a version"
            checked={failOnUnknown}
            onChange={setFailOnUnknown}
          />
        )}
      </FormSection>

      <PreviewStrip body={body} />

      <FormFooter
        onCancel={onCancel}
        submitting={save.isPending}
        submitLabel={isEdit ? "Save rule" : "Create rule"}
      />
    </form>
  )
}

/** "In scope 214 devices · 38 virtual machines - failing 12 · 3", refreshed
 * half a second after the rule stops changing, with a sample of the failing
 * objects per type. Counts only what you may view. Never blocks saving. */
function PreviewStrip({ body }: { body: Record<string, unknown> }) {
  const key = JSON.stringify({ ...body, name: undefined })
  const debounced = useDebounced(key, 500)
  const [showSample, setShowSample] = useState(false)
  const ready =
    (body.object_types as string[]).length > 0 &&
    (body.check_type !== "expression" || body.condition !== null)
  const q = useQuery({
    queryKey: ["compliance-preview", debounced],
    queryFn: () =>
      api<CompliancePreview>("/api/compliance-rules/preview/", {
        method: "POST",
        body: debounced,
      }),
    enabled: ready,
    retry: false,
    placeholderData: keepPreviousData,
    refetchOnWindowFocus: false,
  })
  const byType = Object.entries(q.data?.by_type ?? {})

  return (
    <div
      className="rounded-lg border border-border bg-card px-4 py-3 text-[13px]"
      data-testid="rule-preview"
    >
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className="text-[11px] font-semibold tracking-wide whitespace-nowrap uppercase">
          Preview
        </span>
        {!ready ? (
          <span className="text-muted-foreground">Add a condition.</span>
        ) : q.isError ? (
          <span className="text-muted-foreground">
            Fix the rule to preview it.
          </span>
        ) : q.data?.error ? (
          <Badge variant="destructive">{q.data.error}</Badge>
        ) : q.data ? (
          <>
            <span className="whitespace-nowrap">
              In scope{" "}
              {byType.map(([t, r]) => countOf(t, r.in_scope)).join(" · ")}
            </span>
            <span className="text-muted-foreground">-</span>
            <span className="whitespace-nowrap">
              failing{" "}
              {byType.map(([, r]) => r.failing.toLocaleString()).join(" · ")}
            </span>
            {byType.some(([, r]) => r.sample.length) && (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="ml-auto"
                onClick={() => setShowSample((s) => !s)}
              >
                {showSample ? "Hide sample" : "Sample"}
              </Button>
            )}
          </>
        ) : (
          <span className="text-muted-foreground">Counting…</span>
        )}
      </div>
      {showSample && q.data && !q.data.error && (
        <div className="mt-2 grid gap-3 @md:grid-cols-2">
          {byType
            .filter(([, r]) => r.sample.length)
            .map(([t, r]) => (
              <div key={t}>
                <div className="mb-1 text-[11px] text-muted-foreground">
                  {OBJECT_TYPE_LABEL[t] ?? t}
                </div>
                <ul className="space-y-0.5">
                  {r.sample.map((s) => (
                    <li key={s.id} className="flex gap-2">
                      <span className="truncate">{s.repr}</span>
                      {s.site_name && (
                        <span className="text-muted-foreground">
                          {s.site_name}
                        </span>
                      )}
                    </li>
                  ))}
                </ul>
              </div>
            ))}
        </div>
      )}
    </div>
  )
}
