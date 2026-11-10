import { useState } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Pencil, Plus, Unlink } from "lucide-react"
import { toast } from "sonner"

import { api } from "@/lib/api"
import type {
  ProductMapping,
  ProductMappingWrite,
  VulnCoverageRow,
  VulnVersionScheme,
} from "@/lib/api"
import { apiErrorToast } from "@/lib/api-toast"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  FormCheckbox,
  FormFooter,
  FormSelect,
  FormText,
} from "@/components/forms"
import { KvCard } from "@/components/kv-card"
import type { KvRow } from "@/components/kv-card"
import { Loading } from "@/components/loading"
import { QueryError } from "@/components/query-error"
import { SegmentedTabs } from "@/components/segmented-tabs"
import { CpePicker } from "@/components/vulnerabilities/cpe-picker"
import type { CpePart } from "@/components/vulnerabilities/cpe-picker"
import { useVulnSettings } from "@/components/vulnerabilities/use-vuln-settings"

// "Vulnerability data" on the platform, device type and application pages
// (#451): which public products the object is mapped to, how many of its
// hosts or installs that matched, and the picker to map one. Hidden while
// the feature is off.

export type MappingSubject = "platform" | "device_type" | "application"

export const VERSION_SCHEMES: { value: VulnVersionScheme; label: string }[] = [
  { value: "auto", label: "Automatic" },
  { value: "cisco_ios", label: "Cisco IOS" },
  { value: "cisco_iosxe", label: "Cisco IOS XE" },
  { value: "cisco_nxos", label: "Cisco NX-OS" },
  { value: "junos", label: "Juniper Junos" },
  { value: "arista_eos", label: "Arista EOS" },
  { value: "semver", label: "Semantic versioning" },
  { value: "pep440", label: "Python PEP 440" },
  { value: "dpkg", label: "Debian package" },
  { value: "apk", label: "Alpine package" },
  { value: "generic", label: "Exact only" },
]

const SCHEME_LABEL = Object.fromEntries(
  VERSION_SCHEMES.map((s) => [s.value, s.label])
) as Record<VulnVersionScheme, string>

const PARTS: Record<MappingSubject, CpePart[]> = {
  platform: ["o", "a"],
  device_type: ["h"],
  application: ["a", "o"],
}

export interface MappingObject {
  id: string
  name: string
  purl_template?: string
  cpe_template?: string
}

/** The SBOM identifier the subject already carries, if any. */
export function sbomIdentifier(obj: MappingObject): string {
  return obj.purl_template || obj.cpe_template || ""
}

/** "41 of 44 matched · 3 with a version Danbyte cannot read". */
export function coverageLine(
  row: VulnCoverageRow,
  subject: MappingSubject
): string {
  if (subject === "device_type")
    return `Hardware context for ${row.objects} ${row.objects === 1 ? "device" : "devices"}`
  const noun = subject === "application" ? "installs" : "hosts"
  const parts = [`${row.matched} of ${row.objects} ${noun} matched`]
  if (row.blank_version) parts.push(`${row.blank_version} without a version`)
  if (row.version_not_understood)
    parts.push(
      `${row.version_not_understood} with a version Danbyte cannot read`
    )
  return parts.join(" · ")
}

export function coverageKey(subject: MappingSubject, id: string) {
  return ["vulnerability-coverage", subject, id] as const
}

export function VulnerabilityMappingCard({
  subject,
  object,
  canEdit,
}: {
  subject: MappingSubject
  object: MappingObject
  canEdit: boolean
}) {
  const settings = useVulnSettings()
  const qc = useQueryClient()
  const [editing, setEditing] = useState<ProductMapping | "new" | null>(null)
  const q = useQuery({
    queryKey: coverageKey(subject, object.id),
    queryFn: () =>
      api<{ results: VulnCoverageRow[] }>(
        `/api/vulnerabilities/coverage/?${subject}=${object.id}`
      ),
    enabled: settings.enabled,
  })
  const remove = useMutation({
    mutationFn: (m: ProductMapping) =>
      api(`/api/vulnerabilities/mappings/${m.id}/`, { method: "DELETE" }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["vulnerability-coverage"] })
      qc.invalidateQueries({ queryKey: ["vulnerabilities"] })
      toast.success("Mapping removed")
    },
    onError: (e) => apiErrorToast(e),
  })
  if (!settings.enabled) return null
  const rows = q.data?.results ?? []
  const kv: KvRow[] = rows.length
    ? rows.map((r, i) => ({
        // KvCard keys rows by label: number them when there are several.
        label: `${r.mapping.kind === "purl" ? "Package" : "CPE"}${rows.length > 1 ? ` ${i + 1}` : ""}`,
        value: (
          <div className="grid gap-1">
            <span className="inline-flex flex-wrap items-center gap-1.5">
              <span className="font-mono text-xs break-all">
                {r.mapping.identifier}
              </span>
              {subject !== "device_type" && (
                <Badge variant="secondary">
                  {SCHEME_LABEL[r.mapping.scheme]}
                </Badge>
              )}
              {!r.mapping.enabled && <Badge variant="outline">Off</Badge>}
            </span>
            <span className="text-xs text-muted-foreground">
              {coverageLine(r, subject)}
            </span>
            {canEdit && (
              <span className="flex gap-1">
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-6 px-2"
                  onClick={() => setEditing(r.mapping)}
                >
                  <Pencil className="h-3.5 w-3.5" /> Change
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-6 px-2"
                  disabled={remove.isPending}
                  onClick={() => remove.mutate(r.mapping)}
                >
                  <Unlink className="h-3.5 w-3.5" />
                  {remove.isPending && remove.variables.id === r.mapping.id
                    ? "Removing…"
                    : "Remove"}
                </Button>
              </span>
            )}
          </div>
        ),
      }))
    : [
        {
          label: "Product",
          value: <span className="text-muted-foreground">Not mapped</span>,
        },
      ]

  return (
    <section className="space-y-2">
      {q.isLoading ? (
        <Loading />
      ) : q.isError ? (
        <QueryError error={q.error} />
      ) : (
        <KvCard title="Vulnerability data" rows={kv} />
      )}
      {canEdit && (
        <Button variant="outline" size="sm" onClick={() => setEditing("new")}>
          <Plus className="h-3.5 w-3.5" /> Map product
        </Button>
      )}
      {editing && (
        <MappingDialog
          subject={subject}
          object={object}
          mapping={editing === "new" ? null : editing}
          first={rows.length === 0}
          onOpenChange={(o) => !o && setEditing(null)}
        />
      )}
    </section>
  )
}

type Source = "sbom" | "cpe" | "purl"

export function MappingDialog({
  subject,
  object,
  mapping,
  first,
  onOpenChange,
}: {
  subject: MappingSubject
  object: MappingObject
  /** The mapping to change; null maps a new product. */
  mapping: ProductMapping | null
  /** No mapping yet: offer the SBOM identifier first. */
  first: boolean
  onOpenChange: (open: boolean) => void
}) {
  const qc = useQueryClient()
  const sbom = sbomIdentifier(object)
  const sources: { value: Source; label: string }[] = [
    ...(sbom && !mapping
      ? [{ value: "sbom" as const, label: "SBOM identifier" }]
      : []),
    { value: "cpe", label: "CPE" },
    ...(subject !== "device_type"
      ? [{ value: "purl" as const, label: "Package URL" }]
      : []),
  ]
  const [source, setSource] = useState<Source>(
    mapping
      ? mapping.kind === "purl"
        ? "purl"
        : "cpe"
      : sbom && first
        ? "sbom"
        : "cpe"
  )
  const [cpe, setCpe] = useState<string | null>(
    mapping?.kind === "cpe" ? mapping.identifier : null
  )
  const [purl, setPurl] = useState(
    mapping?.kind === "purl" ? mapping.identifier : ""
  )
  const [scheme, setScheme] = useState<VulnVersionScheme>(
    mapping?.version_scheme ?? "auto"
  )
  const [enabled, setEnabled] = useState(mapping?.enabled ?? true)

  const identifier =
    source === "sbom" ? null : source === "cpe" ? cpe : purl.trim() || null
  const ready = source === "sbom" || !!identifier

  const save = useMutation({
    mutationFn: () => {
      const body: ProductMappingWrite = { enabled }
      if (subject !== "device_type") body.version_scheme = scheme
      if (identifier && identifier !== mapping?.identifier)
        body.identifier = identifier
      if (mapping)
        return api<ProductMapping>(
          `/api/vulnerabilities/mappings/${mapping.id}/`,
          { method: "PATCH", body: JSON.stringify(body) }
        )
      body[subject] = object.id
      return api<ProductMapping>("/api/vulnerabilities/mappings/", {
        method: "POST",
        body: JSON.stringify(body),
      })
    },
    onSuccess: (m) => {
      qc.invalidateQueries({ queryKey: ["vulnerability-coverage"] })
      qc.invalidateQueries({ queryKey: ["vulnerabilities"] })
      toast.success(`Mapped ${m.identifier}`)
      onOpenChange(false)
    },
    onError: (e) => apiErrorToast(e),
  })

  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>
            {mapping ? "Change mapping" : "Map product"} · {object.name}
          </DialogTitle>
        </DialogHeader>
        <form
          className="grid gap-4"
          onSubmit={(e) => {
            e.preventDefault()
            if (ready) save.mutate()
          }}
        >
          {sources.length > 1 && (
            <SegmentedTabs
              items={sources}
              value={source}
              onValueChange={setSource}
            />
          )}
          {source === "sbom" && (
            <p className="text-sm">
              <span className="font-mono text-xs break-all">{sbom}</span>
            </p>
          )}
          {source === "cpe" && (
            <>
              <CpePicker
                value={cpe}
                onChange={setCpe}
                parts={PARTS[subject]}
                initialQuery={mapping ? "" : object.name}
              />
              <FormText
                label="CPE"
                mono
                value={cpe ?? ""}
                onChange={(v) => setCpe(v.trim() || null)}
                placeholder={
                  subject === "device_type"
                    ? "cpe:2.3:h:vendor:product"
                    : "cpe:2.3:o:vendor:product"
                }
              />
            </>
          )}
          {source === "purl" && (
            <FormText
              label="Package URL"
              mono
              value={purl}
              onChange={setPurl}
              placeholder="pkg:pypi/django"
            />
          )}
          {subject !== "device_type" && (
            <FormSelect
              label="Version scheme"
              info="How versions are read and ordered. Automatic picks from the product."
              value={scheme}
              onChange={(v) => setScheme(v ? (v as VulnVersionScheme) : "auto")}
              options={VERSION_SCHEMES}
            />
          )}
          {mapping && (
            <FormCheckbox
              label="Enabled"
              checked={enabled}
              onChange={setEnabled}
            />
          )}
          <FormFooter
            onCancel={() => onOpenChange(false)}
            submitting={save.isPending}
            submitLabel={mapping ? "Save mapping" : "Map"}
          />
        </form>
      </DialogContent>
    </Dialog>
  )
}
