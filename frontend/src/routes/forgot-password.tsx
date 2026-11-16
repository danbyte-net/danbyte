import { createFileRoute, Link } from "@tanstack/react-router"
import { useState } from "react"

import { apiErrorMessage, auth } from "@/lib/api"
import { useMe } from "@/lib/use-me"
import { usePageTitle } from "@/lib/page-title"
import { Button } from "@/components/ui/button"
import { FormText } from "@/components/forms"
import { Loading } from "@/components/loading"
import { AuthCard } from "@/components/auth-card"

export const Route = createFileRoute("/forgot-password")({
  component: ForgotPasswordPage,
})

// "Forgot password?" (#492). The server answers the same whether or not the
// account exists, so this page shows that answer and nothing else.
function ForgotPasswordPage() {
  usePageTitle("Forgot password")
  const { me, isLoading } = useMe()
  const [identifier, setIdentifier] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [sent, setSent] = useState<string | null>(null)

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try {
      const res = await auth.requestPasswordReset(identifier.trim())
      setSent(res.detail)
    } catch (err) {
      setError(apiErrorMessage(err, "Couldn't send the link."))
    } finally {
      setBusy(false)
    }
  }

  return (
    <AuthCard subtitle="Reset your password">
      {isLoading ? (
        <Loading />
      ) : !me.password_reset_available ? (
        <p className="text-[13px] text-muted-foreground">
          Password reset is not available. Ask an administrator.
        </p>
      ) : sent ? (
        <p className="text-[13px]">{sent}</p>
      ) : (
        <form onSubmit={submit} className="grid gap-4">
          <FormText
            label="Username or email"
            value={identifier}
            onChange={setIdentifier}
            autoFocus
            autoComplete="username"
          />
          {error && <p className="text-[13px] text-destructive">{error}</p>}
          <Button
            type="submit"
            disabled={busy || !identifier.trim()}
            className="w-full"
          >
            {busy ? "Sending…" : "Send reset link"}
          </Button>
        </form>
      )}
      <div className="mt-4 text-center text-[13px]">
        <Link
          to="/login"
          search={{ redirect: undefined }}
          className="text-muted-foreground hover:text-foreground"
        >
          Back to sign in
        </Link>
      </div>
    </AuthCard>
  )
}
