---
icon: lucide/key-round
---

# Single sign-on (SSO)

Let people sign in to Danbyte with your identity provider — **OpenID Connect
(OIDC)** or **SAML 2.0** — instead of a local password. Works with Entra ID
(Azure AD), Keycloak, Okta, Google Workspace, AD FS, and any standards-compliant
provider. It's optional and off until an administrator adds a provider.

SSO sits alongside the existing [LDAP directory](permissions.md#directory-ldap)
and local logins; you can run any mix.

## How it works

1. A deployment admin adds an **identity provider** under **Settings →
   Identity providers (SSO)**.
2. Each enabled provider shows a **Sign in with…** button on the login page.
3. On sign-in, Danbyte reads the person's **email, username, and name** from the
   provider and either matches an existing account or — with **just-in-time
   (JIT) provisioning** on — creates one.
4. The groups the provider asserts are mapped to Danbyte groups, so all the
   usual [permissions](permissions.md) (tenant scope, roles, constraints) apply.
   Only groups you've explicitly mapped grant anything.

Group membership is re-synced on every login, so the provider decides *who's in
what* and Danbyte decides *what that means*.

## Provisioning

- **JIT on** (default): first sign-in creates the account automatically.
- **JIT off**: only accounts an admin already created may sign in; unknown users
  are refused. Toggle it per provider.

A JIT-created account is granted access to the provider's **tenant** (or the
provider's *default tenant* when it's deployment-wide).

## Add an OIDC provider (example: Microsoft Entra ID)

**In Entra → App registrations → New registration:**

- **Supported account types:** single tenant (your org only).
- **Redirect URI** (platform **Web**): the **callback URL** Danbyte shows on the
  provider's edit screen — `https://<your-danbyte>/api/auth/sso/<slug>/callback/`.
- After registering, note the **Application (client) ID** and **Directory
  (tenant) ID**, then create a **client secret** under *Certificates & secrets*.
- *(Optional, for group mapping)* under *Token configuration*, add the **groups**
  claim. Entra emits group **object IDs**.

**In Danbyte → Settings → Identity providers (SSO) → add:**

| Field | Value |
|---|---|
| Name | e.g. `Entra` (shown on the button) |
| Slug | e.g. `entra` (part of the callback URL — stable once set) |
| Protocol | OpenID Connect |
| Issuer | `https://login.microsoftonline.com/<tenant-id>/v2.0` |
| Client ID | the Application (client) ID |
| Client secret | the secret value (write-only; blank on edit keeps it) |
| Scopes | `openid email profile` |

The default claim mapping (`preferred_username`, `email`, `given_name`,
`family_name`, `groups`) matches Entra; adjust it for other providers.

!!! note "Redirect URI must match exactly"
    The URI you register at the IdP must equal the callback URL shown on the
    provider — same scheme, host, and `<slug>`. Behind a reverse proxy, make
    sure Danbyte sees the external `https` host.

## Group mapping

On a saved provider, add mappings: the **group value the IdP asserts** → a
**Danbyte group**. For Entra that value is the group's **object ID**; for
Keycloak/Okta it's usually the group name. Members of a mapped group receive that
Danbyte group's permissions on their next login.

## SAML

SAML 2.0 uses the same provider model and JIT/group-mapping behaviour; you supply
the IdP entity ID, SSO URL, and signing certificate instead of an OIDC issuer.
See the provider form's SAML fields.

## Security notes

- The OIDC flow uses `state` + `nonce` and validates the ID token against the
  provider's JWKS (issuer, audience, nonce, expiry).
- The client secret is stored encrypted at rest and never returned by the API.
- The provider is operator-configured, so Danbyte reaches it directly (TLS-
  verified) — the same trust tier as the LDAP/Vault configuration.
