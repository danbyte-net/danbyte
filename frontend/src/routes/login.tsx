import { createFileRoute, useNavigate } from "@tanstack/react-router"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import { useEffect, useState } from "react"
import { KeyRound, LogIn, Mail, } from "lucide-react"

import { api, ApiError, auth } from "@/lib/api"
import type { MfaMethod, SsoPublicProvider } from "@/lib/api"
import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { useMe } from "@/lib/use-me"

export const Route = createFileRoute("/login")({
  validateSearch: (
    search: Record<string, unknown>
  ): { redirect?: string; sso_error?: string; local?: boolean } => ({
    redirect: typeof search.redirect === "string" ? search.redirect : undefined,
    // The SSO handoff redirects back to /login?sso_error=<message> on failure.
    sso_error:
      typeof search.sso_error === "string" ? search.sso_error : undefined,
    // /login?local=1 opens the local form even when it's hidden (#119) -
    // the deep link support docs can hand out when the IdP is down.
    ...(search.local ? { local: true } : {}),
  }),
  component: LoginPage,
})

type Step = "credentials" | "code"

function errText(err: unknown): string {
  if (err instanceof ApiError) {
    // A CSRF rejection comes back as a 403 HTML page (no JSON body) - most
    // often a stale/missing token. Tell the user something actionable rather
    // than dumping markup.
    if (err.status === 403) {
      return "Your session needs a refresh - reload the page and try again."
    }
    if (err.body && typeof err.body === "object") {
      const body = err.body as Record<string, unknown>
      const d = body.detail
      if (typeof d === "string" && d.trim()) return d
      // DRF field errors → first message we can find.
      for (const v of Object.values(body)) {
        if (typeof v === "string" && v.trim()) return v
        if (Array.isArray(v) && typeof v[0] === "string") return v[0]
      }
    }
    if (err.status >= 500) return "The server hit an error. Try again shortly."
  }
  const msg = (err as Error)?.message
  // Network failure (server unreachable) surfaces as a TypeError from fetch.
  if (!msg || /failed to fetch|networkerror/i.test(msg)) {
    return "Couldn't reach the server. Check your connection and try again."
  }
  return msg
}

function LoginPage() {
  const nav = useNavigate()
  const qc = useQueryClient()
  const { redirect, sso_error, local } = Route.useSearch()
  // `/api/me/` is what plants the CSRF cookie (it's @ensure_csrf_cookie) - wait
  // for it before allowing a submit so the login POST always carries a token.
  const { me, isLoading: meLoading } = useMe()

  // Enabled SSO providers for the "Sign in with…" buttons. Public endpoint, but
  // skip it for an already-authenticated visitor - they're bounced immediately
  // by the redirect effect below, so the fetch would be wasted.
  const providersQ = useQuery({
    queryKey: ["sso-providers"],
    queryFn: () =>
      api<{ providers: SsoPublicProvider[] }>("/api/auth/sso/providers/"),
    enabled: !me.is_authenticated,
  })
  const providers = providersQ.data?.providers ?? []
  // Hide the local form only when the deployment asks AND at least one SSO
  // button exists to sign in with - fail OPEN if every provider is disabled
  // later, or nobody could sign in at all. The link below reveals it; that is
  // the break-glass, so the server keeps accepting local credentials always.
  const [showLocal, setShowLocal] = useState(!!local)
  const hideLocal =
    !!me?.hide_local_login && providers.length > 0 && !showLocal

  const [step, setStep] = useState<Step>("credentials")
  const [username, setUsername] = useState("")
  const [password, setPassword] = useState("")
  const [methods, setMethods] = useState<MfaMethod[]>([])
  const [method, setMethod] = useState<MfaMethod>("totp")
  const [emailHint, setEmailHint] = useState<string | null>(null)
  const [code, setCode] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [resent, setResent] = useState(false)

  // Already signed in? Bounce straight through.
  useEffect(() => {
    if (me.is_authenticated) nav({ to: redirect ?? "/", replace: true })
  }, [me.is_authenticated, nav, redirect])

  async function finish() {
    // Wipe any cached data from a previous account in this browser before
    // the new session's queries run (cross-account cache leak).
    qc.clear()
    await qc.invalidateQueries({ queryKey: ["me"] })
    nav({ to: redirect ?? "/", replace: true })
  }

  async function submitCredentials(e: React.FormEvent) {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try {
      const res = await auth.login(username.trim(), password)
      if (res.mfa_required) {
        const ms = res.methods ?? []
        setMethods(ms)
        setMethod(ms[0] ?? "email")
        setEmailHint(res.email_hint ?? null)
        setStep("code")
      } else {
        await finish()
      }
    } catch (err) {
      setError(errText(err))
    } finally {
      setBusy(false)
    }
  }

  async function submitCode(e: React.FormEvent) {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try {
      await auth.verifyMfa(method, code.trim())
      await finish()
    } catch (err) {
      setError(errText(err))
    } finally {
      setBusy(false)
    }
  }

  async function resend() {
    setError(null)
    setResent(false)
    try {
      await auth.resendMfa()
      setResent(true)
    } catch (err) {
      setError(errText(err))
    }
  }

  return (
    <main className="flex min-h-svh items-center justify-center bg-zinc-50 px-4 dark:bg-zinc-950">
      <div className="w-full max-w-sm">
        <div className="mb-6 flex flex-col items-center gap-2 text-center">
          {me.login_logo_url ? (
            <img
              src={me.login_logo_url}
              alt={me.deployment_name?.trim() || "Danbyte"}
              className="max-h-14 max-w-64 object-contain"
            />
          ) : (
            <>
              {/* The Danbyte wordmark, one variant per theme. */}
              <img
                src="/branding/logo-full.png"
                alt="Danbyte"
                className="h-9 object-contain dark:hidden"
              />
              <img
                src="/branding/logo-full-white.png"
                alt="Danbyte"
                className="hidden h-9 object-contain dark:block"
              />
            </>
          )}
          {(me.login_logo_url || me.deployment_name?.trim()) && (
            <h1 className="text-xl font-semibold tracking-tight">
              {me.deployment_name?.trim() || "Danbyte"}
            </h1>
          )}
          <p className="text-sm text-muted-foreground">
            {step === "credentials"
              ? "Sign in to your account"
              : "Two-factor verification"}
          </p>
        </div>

        <div className="rounded-lg border border-zinc-200 bg-white p-6 dark:border-zinc-800 dark:bg-zinc-950">
          {step === "credentials" ? (
            <form onSubmit={submitCredentials} className="grid gap-4">
              {sso_error && (
                <p
                  role="alert"
                  className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-[13px] text-destructive"
                >
                  {sso_error}
                </p>
              )}
              {hideLocal && (
                <>
                  <div className="grid gap-2">
                    {providers.map((p) => (
                      <Button
                        key={p.slug}
                        type="button"
                        className="w-full"
                        onClick={() => {
                          window.location.href = `/api/auth/sso/${p.slug}/login/`
                        }}
                      >
                        <LogIn className="size-4" />
                        Sign in with {p.name}
                      </Button>
                    ))}
                  </div>
                  <button
                    type="button"
                    className="text-center text-[12px] text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
                    onClick={() => setShowLocal(true)}
                  >
                    Sign in with a local account
                  </button>
                </>
              )}
              {!hideLocal && (
              <>
              <div className="grid gap-1.5">
                <Label htmlFor="username" className="text-xs">
                  Username
                </Label>
                <Input
                  id="username"
                  autoFocus
                  autoComplete="username"
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  className="font-mono"
                />
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="password" className="text-xs">
                  Password
                </Label>
                <Input
                  id="password"
                  type="password"
                  autoComplete="current-password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                />
              </div>
              {error && <p className="text-[13px] text-destructive">{error}</p>}
              <Button
                type="submit"
                disabled={busy || meLoading || !username || !password}
                className="w-full"
              >
                {busy && <Spinner className="size-4" />}
                Sign in
              </Button>

              {providers.length > 0 && (
                <>
                  <div className="flex items-center gap-3 text-[11px] text-muted-foreground">
                    <span className="h-px flex-1 bg-border" />
                    or
                    <span className="h-px flex-1 bg-border" />
                  </div>
                  <div className="grid gap-2">
                    {providers.map((p) => (
                      <Button
                        key={p.slug}
                        type="button"
                        variant="outline"
                        className="w-full"
                        onClick={() => {
                          // Leaves the SPA - the backend 302-redirects to the
                          // IdP, so this must be a real navigation, not a Link.
                          window.location.href = `/api/auth/sso/${p.slug}/login/`
                        }}
                      >
                        <LogIn className="size-4" />
                        Sign in with {p.name}
                      </Button>
                    ))}
                  </div>
                </>
              )}
              </>
              )}
            </form>
          ) : (
            <form onSubmit={submitCode} className="grid gap-4">
              {methods.length > 1 && (
                <div className="flex gap-2">
                  {methods.map((m) => (
                    <button
                      key={m}
                      type="button"
                      onClick={() => {
                        setMethod(m)
                        setCode("")
                        setError(null)
                      }}
                      className={
                        "inline-flex h-8 flex-1 items-center justify-center gap-1.5 rounded-md border px-3 text-[13px] font-medium " +
                        (method === m
                          ? "border-primary bg-primary text-primary-foreground"
                          : "border-zinc-200 text-zinc-600 hover:bg-zinc-50 dark:border-zinc-800 dark:text-zinc-300 dark:hover:bg-zinc-900")
                      }
                    >
                      {m === "totp" ? (
                        <KeyRound className="size-3.5" />
                      ) : (
                        <Mail className="size-3.5" />
                      )}
                      {m === "totp" ? "Authenticator" : "Email"}
                    </button>
                  ))}
                </div>
              )}
              <p className="text-[13px] text-muted-foreground">
                {method === "totp"
                  ? "Enter the 6-digit code from your authenticator app."
                  : `Enter the code we sent to ${emailHint ?? "your email"}.`}
              </p>
              <div className="grid gap-1.5">
                <Label htmlFor="code" className="text-xs">
                  Verification code
                </Label>
                <Input
                  id="code"
                  autoFocus
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  maxLength={6}
                  placeholder="000000"
                  value={code}
                  onChange={(e) =>
                    setCode(e.target.value.replace(/\D/g, "").slice(0, 6))
                  }
                  className="text-center font-mono text-lg tracking-[0.4em]"
                />
              </div>
              {error && <p className="text-[13px] text-destructive">{error}</p>}
              {resent && (
                <p className="text-[13px] text-emerald-600 dark:text-emerald-400">
                  A new code is on its way.
                </p>
              )}
              <Button
                type="submit"
                disabled={busy || code.length < 6}
                className="w-full"
              >
                {busy && <Spinner className="size-4" />}
                Verify
              </Button>
              <div className="flex items-center justify-between text-[13px]">
                <button
                  type="button"
                  className="text-muted-foreground hover:text-foreground"
                  onClick={() => {
                    setStep("credentials")
                    setCode("")
                    setError(null)
                    setResent(false)
                  }}
                >
                  ← Back
                </button>
                {method === "email" && (
                  <button type="button" className="link" onClick={resend}>
                    Resend code
                  </button>
                )}
              </div>
            </form>
          )}
        </div>
      </div>
    </main>
  )
}
