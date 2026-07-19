import { type CheckKind, type CheckTemplate } from "@/lib/api"
import {
  FormCheckbox,
  FormSelect,
  FormText,
  FormTextarea,
} from "@/components/forms"

// Shared kind-switched check configuration: the field specs, the renderer, and
// the value→{params, secret_params} builder. Used by both the Add-check dialog
// and the Check-template editor so they stay perfectly in sync.

export const KINDS: { value: CheckKind; label: string }[] = [
  { value: "icmp", label: "ICMP (ping)" },
  { value: "tcp", label: "TCP port" },
  { value: "udp", label: "UDP port" },
  { value: "http", label: "HTTP(S)" },
  { value: "snmp", label: "SNMP" },
  { value: "ssh", label: "SSH" },
  { value: "telnet", label: "Telnet" },
  { value: "exec", label: "Script / exec" },
]

export const INTERVALS = [
  { value: "60", label: "1 minute" },
  { value: "300", label: "5 minutes" },
  { value: "900", label: "15 minutes" },
  { value: "1800", label: "30 minutes" },
  { value: "3600", label: "Hourly" },
  { value: "21600", label: "6 hours" },
  { value: "86400", label: "Daily" },
]

type FieldType =
  | "text"
  | "number"
  | "csvint"
  | "select"
  | "checkbox"
  | "textarea"
  | "args"

export interface Spec {
  key: string
  label: string
  type: FieldType
  options?: { value: string; label: string }[]
  placeholder?: string
  required?: boolean
  default?: string | boolean
  secret?: boolean
  when?: (vals: Vals) => boolean
}

export type Vals = Record<string, string | boolean>

export const SPECS: Record<CheckKind, Spec[]> = {
  icmp: [
    { key: "count", label: "Packets per check", type: "number", default: "2" },
    {
      key: "latency_degraded_ms",
      label: "Degraded over latency (ms)",
      type: "number",
    },
  ],
  tcp: [
    {
      key: "port",
      label: "Port",
      type: "number",
      required: true,
      placeholder: "22",
    },
    { key: "expect", label: "Expect banner (regex, optional)", type: "text" },
  ],
  udp: [
    {
      key: "port",
      label: "Port",
      type: "number",
      required: true,
      placeholder: "53",
    },
    { key: "send", label: "Send probe (optional)", type: "text" },
    { key: "expect", label: "Expect reply (regex, optional)", type: "text" },
  ],
  http: [
    {
      key: "scheme",
      label: "Scheme",
      type: "select",
      default: "http",
      options: [
        { value: "http", label: "http" },
        { value: "https", label: "https" },
      ],
    },
    {
      key: "port",
      label: "Port (optional)",
      type: "number",
      placeholder: "80 / 443",
    },
    {
      key: "path",
      label: "Path",
      type: "text",
      default: "/",
      placeholder: "/health",
    },
    {
      key: "method",
      label: "Method",
      type: "select",
      default: "GET",
      options: ["GET", "HEAD", "POST"].map((m) => ({ value: m, label: m })),
    },
    {
      key: "expected_status",
      label: "Expected status",
      type: "csvint",
      default: "200",
    },
    {
      key: "verify_tls",
      label: "Verify TLS certificate",
      type: "checkbox",
      default: true,
    },
  ],
  snmp: [
    {
      key: "version",
      label: "Version",
      type: "select",
      default: "v2c",
      options: [
        { value: "v2c", label: "v2c" },
        { value: "v3", label: "v3" },
      ],
    },
    { key: "oid", label: "OID", type: "text", default: "1.3.6.1.2.1.1.3.0" },
    { key: "port", label: "Port", type: "number", default: "161" },
    {
      key: "community",
      label: "Community",
      type: "text",
      secret: true,
      placeholder: "public",
      when: (v) => v.version !== "v3",
    },
    {
      key: "username",
      label: "v3 username",
      type: "text",
      secret: true,
      when: (v) => v.version === "v3",
    },
    {
      key: "auth_key",
      label: "v3 auth key",
      type: "text",
      secret: true,
      when: (v) => v.version === "v3",
    },
    {
      key: "priv_key",
      label: "v3 priv key",
      type: "text",
      secret: true,
      when: (v) => v.version === "v3",
    },
  ],
  ssh: [
    { key: "port", label: "Port", type: "number", default: "22" },
    { key: "username", label: "Username", type: "text", secret: true },
    { key: "password", label: "Password", type: "text", secret: true },
    {
      key: "command",
      label: "Script (optional)",
      type: "textarea",
      placeholder: "systemctl is-active nginx\nexit $?",
    },
    {
      key: "expected_exit_code",
      label: "Expected exit code (optional)",
      type: "number",
      when: (v) => String(v.command ?? "").trim() !== "",
    },
    {
      key: "expected_output_regex",
      label: "Expect output (regex, optional)",
      type: "text",
      when: (v) => String(v.command ?? "").trim() !== "",
    },
  ],
  telnet: [
    { key: "port", label: "Port", type: "number", default: "23" },
    { key: "expect", label: "Expect banner (regex, optional)", type: "text" },
  ],
  exec: [
    {
      key: "command",
      label: "Plugin name",
      type: "text",
      required: true,
      placeholder: "check_http",
    },
    {
      key: "args",
      label: "Arguments",
      type: "args",
      placeholder: "-H {host} -w 80 -c 90",
    },
  ],
}

export function initialValues(kind: CheckKind): Vals {
  const out: Vals = {}
  for (const s of SPECS[kind])
    out[s.key] = s.default ?? (s.type === "checkbox" ? false : "")
  return out
}

/** Populate field values from an existing template's params (for editing).
 * Secret fields are never returned by the API, so they start blank. */
export function valuesFromTemplate(t: CheckTemplate): Vals {
  const out = initialValues(t.kind)
  const params = (t.params ?? {}) as Record<string, unknown>
  for (const s of SPECS[t.kind]) {
    if (s.secret) continue
    const v = params[s.key]
    if (v === undefined) continue
    if (s.type === "checkbox") out[s.key] = !!v
    else if (s.type === "csvint")
      out[s.key] = Array.isArray(v) ? v.join(",") : String(v)
    else if (s.type === "args")
      out[s.key] = Array.isArray(v) ? v.join(" ") : String(v)
    else out[s.key] = String(v)
  }
  return out
}

export function visibleSpecs(kind: CheckKind, vals: Vals): Spec[] {
  return SPECS[kind].filter((s) => !s.when || s.when(vals))
}

export function missingRequired(kind: CheckKind, vals: Vals): boolean {
  return visibleSpecs(kind, vals).some(
    (s) => s.required && String(vals[s.key] ?? "").trim() === ""
  )
}

/** Split the field values into the public `params` and the encrypted
 * `secret_params` payloads, with per-type coercion. */
export function buildParams(kind: CheckKind, vals: Vals) {
  const params: Record<string, unknown> = {}
  const secret_params: Record<string, unknown> = {}
  for (const s of visibleSpecs(kind, vals)) {
    const raw = vals[s.key]
    const bucket = s.secret ? secret_params : params
    if (s.type === "checkbox") bucket[s.key] = !!raw
    else if (String(raw ?? "").trim() === "") continue
    else if (s.type === "number") bucket[s.key] = Number(raw)
    else if (s.type === "csvint")
      bucket[s.key] = String(raw)
        .split(",")
        .map((n) => Number(n.trim()))
        .filter((n) => Number.isFinite(n))
    else if (s.type === "args")
      // Whitespace-separated tokens → argv list (no shell on the backend).
      bucket[s.key] = String(raw).trim().split(/\s+/).filter(Boolean)
    else bucket[s.key] = raw
  }
  return { params, secret_params }
}

/** Renders the kind's fields. `vals` is controlled; `onChange(key, value)`. */
export function CheckFields({
  kind,
  vals,
  onChange,
}: {
  kind: CheckKind
  vals: Vals
  onChange: (key: string, value: string | boolean) => void
}) {
  const specs = visibleSpecs(kind, vals)
  return (
    <>
      {specs.map((s) => {
        if (s.type === "checkbox") {
          return (
            <FormCheckbox
              key={s.key}
              label={s.label}
              checked={!!vals[s.key]}
              onChange={(v) => onChange(s.key, v)}
            />
          )
        }
        if (s.type === "select") {
          return (
            <FormSelect
              key={s.key}
              label={s.label}
              value={String(vals[s.key] ?? "")}
              onChange={(v) => onChange(s.key, v ?? "")}
              options={s.options ?? []}
            />
          )
        }
        if (s.type === "textarea") {
          return (
            <FormTextarea
              key={s.key}
              label={s.label}
              value={String(vals[s.key] ?? "")}
              onChange={(v) => onChange(s.key, v)}
              placeholder={s.placeholder}
              rows={4}
            />
          )
        }
        return (
          <FormText
            key={s.key}
            label={s.label}
            required={s.required}
            value={String(vals[s.key] ?? "")}
            onChange={(v) => onChange(s.key, v)}
            mono={s.type === "number" || s.type === "csvint" || s.secret}
            placeholder={s.placeholder}
          />
        )
      })}
      {specs.some((s) => s.secret) && (
        <p className="text-[11px] text-muted-foreground">
          Credentials are encrypted at rest and never shown again after saving.
        </p>
      )}
    </>
  )
}
