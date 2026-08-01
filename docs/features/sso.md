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

## SAML 2.0

SAML uses the same provider model, JIT provisioning, default group, and group
mapping as OIDC. There are two ways to point Danbyte at the IdP:

- **IdP metadata URL** (recommended): paste the IdP's federation-metadata URL and
  Danbyte fetches the **entity ID**, **SSO URL**, and **signing certificate(s)**
  from it on save — and re-reads them hourly, so the login keeps working when the
  IdP rotates its signing certificate. The fetch goes **directly to the IdP**
  (same trust tier as the OIDC issuer / LDAP / Vault address); for a cloud IdP it
  needs internet, for an on-prem IdP it only needs the LAN.
- **Manual**: supply the IdP's **entity ID**, **SSO URL**, and **signing
  certificate** (PEM or base64) by hand. Use this on fully offline installs, or
  any time you'd rather not fetch. The X.509 field accepts several concatenated
  PEM blocks if the IdP publishes more than one signing cert.

When you save a SAML provider, its edit screen shows the values to register at
the IdP:

- **ACS / Reply URL** — `https://<danbyte>/api/auth/sso/<slug>/acs/`
- **SP Identifier (Entity ID)** — `https://<danbyte>/api/auth/sso/<slug>/metadata/`
- **SP metadata URL** — some IdPs import SP config from it directly.

Danbyte requires the **assertion to be signed** and validates the issuer,
audience (must be this SP), recipient (must be this ACS), `InResponseTo` (replay
protection), and the validity window before trusting it.

### Example: Microsoft Entra ID (SAML)

Entra does SAML through an **Enterprise Application** (separate from the OIDC app
registration):

1. Entra admin center → **Enterprise applications → New application → Create your
   own application** → *Integrate any other application* → create.
2. **Single sign-on → SAML.**
3. **Basic SAML Configuration:** set **Identifier (Entity ID)** to Danbyte's SP
   Identifier and **Reply URL (ACS)** to Danbyte's ACS URL (both shown on the
   provider's edit screen).
4. **Attributes & Claims:** ensure email/username (and a **groups** claim if you
   want group mapping) are emitted.
5. **SAML Certificates:** copy the **App Federation Metadata Url** — this is the
   easy path.
6. In Danbyte, create a SAML provider, paste that URL into **IdP metadata URL**,
   and save. Danbyte fills the entity ID, SSO URL, and signing cert for you.
   Assign users/groups to the Enterprise Application in Entra and you're done.

    !!! tip "Why the metadata URL beats downloading the cert"
        Entra shows one certificate in *SAML Certificates* but signs assertions
        with a separate, app-specific signing certificate, and it rotates on its
        own schedule. Pulling from the metadata URL always has the current
        signing cert, so you never pick the wrong one or get locked out on
        rotation. If you must go manual, take the **Login URL** and **Microsoft
        Entra Identifier** from *Set up*, and be sure the pasted cert is the one
        actually signing (the metadata lists it).

7. Set the claim mapping to the attribute names Entra emits (the defaults —
   `emailaddress`, `givenname`, `surname`, `name` — already match).

### Example: Keycloak

Keycloak can be the IdP for either protocol and can federate to your AD over
LDAP, so AD accounts sign in via Keycloak:

- **OIDC:** create a confidential client; issuer is
  `https://<keycloak>/realms/<realm>`, with the client ID/secret. Redirect URI =
  Danbyte's OIDC callback URL.
- **SAML:** create a SAML client with client ID = Danbyte's SP Identifier and a
  valid redirect/ACS = Danbyte's ACS URL; export the realm's SAML signing
  certificate into the provider.

## Security notes

- **Account binding is by the IdP's stable subject** (OIDC `sub` / SAML
  `NameID`), never a mutable email. An existing local account that already has a
  password is never silently taken over by an SSO assertion — an administrator
  must link it deliberately. An unverified email never links an account.
- The OIDC flow uses `state` + `nonce` and validates the ID token against the
  provider's JWKS (issuer, audience, `azp` when multi-audience, nonce, expiry).
- **SAML is SP-initiated and replay-safe:** every login is started from Danbyte,
  and each response must carry an `InResponseTo` for a request Danbyte issued and
  hasn't already consumed (tracked in the database, since the IdP's cross-site
  ACS POST can't carry the session cookie). Unsolicited/IdP-initiated responses
  are rejected. The assertion signature, issuer, audience (this SP), recipient
  (this ACS), and validity window are all mandatory.
- The client secret is stored encrypted at rest and never returned by the API.
- Tenant-scoped providers aren't advertised on the public login page, and a
  tenant provider can only map (or default to) groups narrowed to its tenant.
- The provider is operator-configured, so Danbyte reaches it directly (TLS-
  verified) — the same trust tier as the LDAP/Vault configuration.
