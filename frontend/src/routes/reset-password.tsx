import { createFileRoute, Link } from "@tanstack/react-router"
import { useState } from "react"

import { ApiError, apiErrorMessage, auth } from "@/lib/api"
import { usePageTitle } from "@/lib/page-title"
import { Button } from "@/components/ui/button"
import { FormText } from "@/components/forms"
import { AuthCard } from "@/components/auth-card"

export const Route = createFileRoute("/reset-password")({
  validateSearch: (search: Record<string, unknown>) => ({
    uid: typeof search.uid === "string" ? search.uid : "",
    token: typeof search.token === "string" ? search.token : "",
  }),
  component: ResetPasswordPage,
})

// The emailed reset link lands here (#492). Setting the password signs out
// every session and does not sign in: the next sign-in asks for the new
// password and, when the account has one, the second factor.
function ResetPasswordPage() {
  usePageTitle("Reset password")
  const { uid, token } = Route.useSearch()
  const [password, setPassword] = useState("")
  const [confirm, setConfirm] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [fieldError, setFieldError] = useState<string | undefined>()
  const [done, setDone] = useState(false)

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setError(null)
    setFieldError(undefined)
    if (password !== confirm) {
      setFieldError("The two passwords don't match.")
      return
    }
    setBusy(true)
    try {
      await auth.confirmPasswordReset(uid, token, password)
      setDone(true)
    } catch (err) {
      const body =
        err instanceof ApiError && err.body && typeof err.body === "object"
          ? (err.body as Record<string, unknown>)
          : null
      if (body && Array.isArray(body.password)) {
        setFieldError(body.password.map(String).join(" "))
      } else {
        setError(apiErrorMessage(err, "Couldn't set the password."))
      }
    } finally {
      setBusy(false)
    }
  }

  return (
    <AuthCard subtitle="Choose a new password">
      {!uid || !token ? (
        <p className="text-[13px] text-destructive">
          This link is invalid or has expired.
        </p>
      ) : done ? (
        <p className="text-[13px]">Password changed. Sign in with it now.</p>
      ) : (
        <form onSubmit={submit} className="grid gap-4">
          <FormText
            label="New password"
            type="password"
            value={password}
            onChange={setPassword}
            autoFocus
            autoComplete="new-password"
            error={fieldError}
          />
          <FormText
            label="Confirm new password"
            type="password"
            value={confirm}
            onChange={setConfirm}
            autoComplete="new-password"
          />
          {error && <p className="text-[13px] text-destructive">{error}</p>}
          <Button
            type="submit"
            disabled={busy || !password || !confirm}
            className="w-full"
          >
            {busy ? "Saving…" : "Set password"}
          </Button>
        </form>
      )}
      <div className="mt-4 text-center text-[13px]">
        <Link
          to="/login"
          search={{ redirect: undefined }}
          className="text-muted-foreground hover:text-foreground"
        >
          {done ? "Sign in" : "Back to sign in"}
        </Link>
      </div>
    </AuthCard>
  )
}
