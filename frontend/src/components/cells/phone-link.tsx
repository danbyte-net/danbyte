/** A phone number as a `tel:` link, so a click places the call through
 * whatever the desk uses (Teams, a softphone). Spaces and dashes stay in the
 * text; the link carries only what a dialler accepts. */
export function PhoneLink({ phone }: { phone: string }) {
  const dial = phone.replace(/[^\d+#*]/g, "")
  return (
    <a href={`tel:${dial}`} className="link font-mono">
      {phone}
    </a>
  )
}
