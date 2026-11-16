import { useState } from "react"
import { useMutation } from "@tanstack/react-query"
import { toast } from "sonner"

import { ApiError, auth } from "@/lib/api"
import { useMe } from "@/lib/use-me"
import { FormText } from "@/components/forms"
import { SettingsCard } from "@/components/settings/settings-card"
import { apiErrorToast } from "@/lib/api-toast"

const MANAGED: Record<string, string> = {
  ldap: "Your password is managed by your company directory.",
  sso: "Your password is managed by your identity provider.",
  none: "This account has no Danbyte password.",
}

type Errors = Partial<Record<"current" | "next" | "confirm", string>>

/** Every message of a field, so all the password rules that failed show. */
function joined(v: unknown): string | undefined {
  if (Array.isArray(v)) return v.map(String).join(" ")
  return typeof v === "string" ? v : undefined
}

// Change your own password (#492). The server checks the current password
// against the sign-in lockout, applies the password rules, keeps this
// session and ends every other one. API tokens are left alone.
export function PasswordSection() {
  const { me } = useMe()
  const source = me.password_source ?? "local"
  const [current, setCurrent] = useState("")
  const [next, setNext] = useState("")
  const [confirm, setConfirm] = useState("")
  const [errors, setErrors] = useState<Errors>({})

  const change = useMutation({
    mutationFn: () => auth.changePassword(current, next),
    onSuccess: () => {
      toast.success("Password changed")
      setCurrent("")
      setNext("")
      setConfirm("")
      setErrors({})
    },
    onError: (err) => {
      if (err instanceof ApiError && err.status === 400) {
        const body = (err.body ?? {}) as Record<string, unknown>
        const e: Errors = {
          current: joined(body.current_password),
          next: joined(body.new_password),
        }
        if (e.current || e.next) {
          setErrors(e)
          return
        }
      }
      setErrors({})
      apiErrorToast(err, "Couldn't change the password.")
    },
  })

  function save() {
    if (next !== confirm) {
      setErrors({ confirm: "The two passwords don't match." })
      return
    }
    change.mutate()
  }

  if (source !== "local") {
    return (
      <SettingsCard title="Password">
        <p className="text-sm text-muted-foreground">
          {MANAGED[source] ?? MANAGED.none}
        </p>
      </SettingsCard>
    )
  }

  return (
    <SettingsCard
      title="Password"
      description="Other sessions are signed out. API tokens keep working."
      onSave={save}
      dirty={!!current && !!next && !!confirm}
      saving={change.isPending}
      saveLabel="Change password"
    >
      <form
        className="grid gap-3"
        onSubmit={(e) => {
          e.preventDefault()
          if (current && next && confirm && !change.isPending) save()
        }}
      >
        <FormText
          label="Current password"
          type="password"
          autoComplete="current-password"
          value={current}
          onChange={setCurrent}
          error={errors.current}
        />
        <FormText
          label="New password"
          type="password"
          autoComplete="new-password"
          value={next}
          onChange={setNext}
          error={errors.next}
        />
        <FormText
          label="Confirm new password"
          type="password"
          autoComplete="new-password"
          value={confirm}
          onChange={setConfirm}
          error={errors.confirm}
        />
        {/* Enter submits; the card's footer button is the visible action. */}
        <button type="submit" hidden />
      </form>
    </SettingsCard>
  )
}
