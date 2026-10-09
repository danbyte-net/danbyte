import { useState } from "react"
import { useMutation, useQueryClient } from "@tanstack/react-query"
import { QRCodeSVG } from "qrcode.react"
import { toast } from "sonner"
import { Check, ShieldCheck, ShieldOff } from "lucide-react"

import { auth, type TotpSetup } from "@/lib/api"
import { useMe } from "@/lib/use-me"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Badge } from "@/components/ui/badge"
import { SettingsCard } from "@/components/settings/settings-card"
import { apiErrorToast } from "@/lib/api-toast"

// Two-factor authentication: authenticator (TOTP) enrolment for the current
// user. Email OTP needs no setup here - it's available at login whenever the
// account has an email and `mfa_email` is on; an admin toggles `require_mfa`.
export function TwoFactorSection() {
  const { me } = useMe()
  const qc = useQueryClient()
  const confirmed = me.mfa?.totp_confirmed ?? false

  const [setup, setSetup] = useState<TotpSetup | null>(null)
  const [code, setCode] = useState("")
  // Removing the authenticator asks for the password or a current code.
  const [removing, setRemoving] = useState(false)
  const [proof, setProof] = useState("")

  const begin = useMutation({
    mutationFn: () => auth.totpSetup(),
    onSuccess: (s) => {
      setSetup(s)
      setCode("")
    },
    onError: (err) => apiErrorToast(err),
  })

  const confirm = useMutation({
    mutationFn: () => auth.totpConfirm(code.trim()),
    onSuccess: async () => {
      toast.success("Authenticator enabled")
      setSetup(null)
      setCode("")
      await qc.invalidateQueries({ queryKey: ["me"] })
    },
    onError: (err) => apiErrorToast(err),
  })

  const disable = useMutation({
    mutationFn: () => {
      const v = proof.trim()
      // Six digits may be a code or a numeric password - the server tries both.
      return auth.totpDisable(
        /^\d{6}$/.test(v) ? { code: v, password: proof } : { password: proof }
      )
    },
    onSuccess: async () => {
      toast.success("Authenticator removed")
      setRemoving(false)
      setProof("")
      await qc.invalidateQueries({ queryKey: ["me"] })
    },
    onError: (err) => apiErrorToast(err),
  })

  return (
    <SettingsCard
      title="Two-factor authentication"
      badge={
        confirmed && (
          <Badge variant="success" className="text-[10px]">
            <Check className="size-3" /> Authenticator on
          </Badge>
        )
      }
      description={
        <>
          Add a second factor to your sign-in. Scan the QR with an authenticator
          app (1Password, Authy, Google Authenticator) for a rolling 6-digit
          code. {me.mfa?.email_available && "Email codes are also available."}
        </>
      }
    >
      <div className="rounded-lg border border-border p-4">
        {confirmed && removing ? (
          <form
            className="grid gap-1.5"
            onSubmit={(e) => {
              e.preventDefault()
              disable.mutate()
            }}
          >
            <Label htmlFor="totp-remove" className="text-xs whitespace-nowrap">
              Password or authenticator code
            </Label>
            <div className="flex gap-2">
              <Input
                id="totp-remove"
                type="password"
                autoFocus
                autoComplete="current-password"
                value={proof}
                onChange={(e) => setProof(e.target.value)}
                className="w-64"
              />
              <Button
                type="submit"
                variant="destructive"
                disabled={!proof || disable.isPending}
              >
                {disable.isPending ? "Removing…" : "Remove"}
              </Button>
              <Button
                type="button"
                variant="ghost"
                onClick={() => {
                  setRemoving(false)
                  setProof("")
                }}
              >
                Cancel
              </Button>
            </div>
          </form>
        ) : confirmed ? (
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2 text-sm">
              <ShieldCheck className="size-4 text-emerald-600 dark:text-emerald-400" />
              Authenticator app is set up.
            </div>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setRemoving(true)}
            >
              <ShieldOff className="size-4" /> Remove
            </Button>
          </div>
        ) : setup ? (
          <div className="grid gap-4 sm:grid-cols-[auto_1fr] sm:items-start">
            <div className="rounded-md bg-white p-2">
              <QRCodeSVG value={setup.otpauth_uri} size={148} />
            </div>
            <div className="grid gap-3">
              <div className="text-xs text-muted-foreground">
                Can't scan? Enter this key manually:
                <code className="mt-1 block font-mono text-[11px] break-all text-foreground">
                  {setup.secret}
                </code>
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="totp-code" className="text-xs">
                  Enter the 6-digit code to confirm
                </Label>
                <div className="flex gap-2">
                  <Input
                    id="totp-code"
                    inputMode="numeric"
                    maxLength={6}
                    placeholder="000000"
                    value={code}
                    onChange={(e) =>
                      setCode(e.target.value.replace(/\D/g, "").slice(0, 6))
                    }
                    className="w-32 text-center font-mono tracking-[0.3em]"
                  />
                  <Button
                    onClick={() => confirm.mutate()}
                    disabled={code.length < 6 || confirm.isPending}
                  >
                    Confirm
                  </Button>
                  <Button
                    variant="ghost"
                    onClick={() => {
                      setSetup(null)
                      setCode("")
                    }}
                  >
                    Cancel
                  </Button>
                </div>
              </div>
            </div>
          </div>
        ) : (
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <ShieldOff className="size-4" />
              No authenticator configured.
            </div>
            <Button
              size="sm"
              onClick={() => begin.mutate()}
              disabled={begin.isPending}
            >
              <ShieldCheck className="size-4" /> Set up authenticator
            </Button>
          </div>
        )}
      </div>
    </SettingsCard>
  )
}
