import { type SmtpSecurity } from "@/lib/api"
import { Input } from "@/components/ui/input"
import { Checkbox } from "@/components/ui/checkbox"
import { Field, FormSelect } from "@/components/forms"

const SECURITY: { value: SmtpSecurity; label: string }[] = [
  { value: "starttls", label: "STARTTLS (587)" },
  { value: "ssl", label: "SSL/TLS (465)" },
  { value: "none", label: "None (25)" },
]

/** The SMTP subset shared by DeploymentSettings and TenantSettings — both
 * satisfy this structurally (mirrored field names). */
export interface SmtpValues {
  email_enabled: boolean
  smtp_host: string
  smtp_port: number
  smtp_security: SmtpSecurity
  smtp_username: string
  smtp_password_set: boolean
  email_from: string
}

/** Controlled SMTP fieldset — used by both the deployment Email page and the
 * tenant Email override card. The password is write-only state owned by the
 * parent (blank = keep the stored one). */
export function SmtpFields({
  value,
  onChange,
  password,
  onPasswordChange,
}: {
  value: SmtpValues
  onChange: <K extends keyof SmtpValues>(key: K, v: SmtpValues[K]) => void
  password: string
  onPasswordChange: (v: string) => void
}) {
  return (
    <div className="space-y-4">
      <label className="flex items-center gap-2 text-sm">
        <Checkbox
          checked={value.email_enabled}
          onCheckedChange={(v) => onChange("email_enabled", !!v)}
        />
        Enable email delivery
      </label>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <Field label="SMTP host" className="sm:col-span-2">
          <Input
            value={value.smtp_host}
            onChange={(e) => onChange("smtp_host", e.target.value)}
            placeholder="smtp.acme.com"
            className="font-mono text-[13px]"
          />
        </Field>
        <Field label="Port">
          <Input
            type="number"
            value={value.smtp_port}
            onChange={(e) => onChange("smtp_port", Number(e.target.value) || 0)}
            className="font-mono text-[13px]"
          />
        </Field>
      </div>

      <FormSelect
        label="Security"
        value={value.smtp_security}
        onChange={(v) =>
          onChange("smtp_security", (v as SmtpSecurity) ?? "starttls")
        }
        options={SECURITY}
      />

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Field label="Username">
          <Input
            value={value.smtp_username}
            onChange={(e) => onChange("smtp_username", e.target.value)}
            placeholder="alerts@acme.com"
            className="font-mono text-[13px]"
            autoComplete="off"
          />
        </Field>
        <Field
          label="Password"
          hint={
            value.smtp_password_set ? "saved — leave blank to keep" : undefined
          }
        >
          <Input
            type="password"
            value={password}
            onChange={(e) => onPasswordChange(e.target.value)}
            placeholder={value.smtp_password_set ? "••••••••" : ""}
            className="font-mono text-[13px]"
            autoComplete="new-password"
          />
        </Field>
      </div>

      <Field
        label="From address"
        hint="Shown as the sender of every alert email."
      >
        <Input
          value={value.email_from}
          onChange={(e) => onChange("email_from", e.target.value)}
          placeholder="Danbyte Alerts <alerts@acme.com>"
          className="font-mono text-[13px]"
        />
      </Field>
    </div>
  )
}
