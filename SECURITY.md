# Security policy

Danbyte holds the map of a network: addresses, devices, credentials, and who
may see which site. Security reports are welcome and taken seriously.

## Reporting a vulnerability

Please report privately through GitHub:
**[Report a vulnerability](https://github.com/danbyte-net/danbyte/security/advisories/new)**
(Security tab → Report a vulnerability).

Do not open a public issue, pull request or discussion for a vulnerability
until a fix is released.

A useful report includes:

- the Danbyte version (the user menu or Settings → Updates) and how it is
  installed (`install.sh`, Docker, source checkout);
- the steps to reproduce, with the user's role and permissions;
- what an attacker gains, and what access they need first.

The same applies to the Outpost agent
([danbyte-outpost](https://github.com/danbyte-net/danbyte-outpost)): report it
here or in that repository's Security tab.

## Supported versions

| Version | Security fixes |
|---|---|
| The latest release | Yes |
| Older releases | No - upgrade to the latest release |
| `-dev` pre-releases | No - never run them in production |

Fixes land in the next release; there are no patch releases for older lines.
Reports found on a `-dev` build are still welcome when the code is headed for
a release.

## What happens next

1. The report is acknowledged on the advisory.
2. It is confirmed or declined, with the reasoning.
3. A confirmed issue is fixed in the next release, and the release notes
   carry a **Security** line for it.
4. The advisory is published after the release, with a CVE when one applies.
   Reporters are credited unless they ask not to be.

## Scope

In scope, for example:

- reading or changing data across a tenant, or across sites with enhanced
  site separation on;
- acting beyond a user's role or object permissions, including through bulk
  actions, imports, exports, templates, search or the change log;
- revealing secrets: credentials, API tokens, SNMP communities, keys;
- server-side request forgery, or a way out of the script and CAD sandboxes;
- authentication, session, CSRF or API token flaws.

Out of scope:

- anything that needs superuser or deployment admin rights, unless it crosses
  a tenant boundary;
- the live demo at danbyte.net - please don't test against it;
- denial of service by sheer volume, and missing hardening headers without a
  concrete attack;
- vulnerable dependencies with no path to exploit them in Danbyte (Dependabot
  already tracks those).
