---
icon: lucide/monitor
---

# Discovery: Windows hosts

A package inventory reads a Windows host's OS build, hotfixes, server
features and installed programs, over SSH or over WinRM with a client
certificate. Windows CVEs then come from Microsoft's own advisory data,
matched by the exact build. Profiles, scope and authorisation work as for
Linux hosts ([Package inventory](discovery-packages.md)).

!!! info "Where to find it"
    - Transports: **SSH key login**, **SSH password login** and **WinRM over
      HTTPS** in the **Host discovery** section (**Monitoring** page →
      **Settings** tab).
    - A host's own WinRM certificate: kind **WinRM certificate** on its
      **Credentials** card (a device's **Access** tab, a VM's **Monitoring**
      tab). Shared ones: **Settings → Devices & polling → Credentials**.
    - What was read: the host's **Packages** tab. Its CVEs: the
      **Vulnerabilities** tab, **Via: OS build**.
    - Microsoft's data: the **Vulnerability data** card ([Known
      vulnerabilities](vulnerabilities.md#turn-it-on)).

## Transports

Danbyte tries only the transports that are switched on. The host's own
credentials come first, then the profile's pinned one, then the matching
shared ones; within each, in this order:

| Order | Transport | Credential kind | Default |
|---|---|---|---|
| 1 | **SSH key login** | *SSH key* | on |
| 2 | **SSH password login** | *SSH password* | on |
| 3 | **WinRM over HTTPS** | *WinRM certificate* | off |

The next transport is tried only when the one before did not answer (SSH
unreachable or timed out → WinRM), or after an SSH key was refused (no
password was sent yet). A refused password stops there unless its shared
credential allows trying the next, so no account is locked out
([which login a host gets](discovery-credentials.md#which-login-a-host-gets)).
The run's host list says which transport read the host; hover the transport
for the others and why they were skipped or what they answered.

A host with no accepted SSH host key can still be read over WinRM, whose
server certificate is verified instead.

### Over SSH

Danbyte does not know in advance that a host runs Windows. It sends the Linux
commands first: `cat /etc/os-release` and `cat /usr/lib/os-release` fail on
Windows, so it sends `cmd /c ver`. Only an answer of the form
`Microsoft Windows [Version 10.0.20348.2849]` runs the PowerShell script
below; anything else is *Unsupported*. The same host keys, credentials and
first-use rules apply as for Linux.

What must be true on the host:

- The **OpenSSH Server** feature is installed and the `sshd` service runs,
  for example as an administrator in PowerShell:
  `Add-WindowsCapability -Online -Name OpenSSH.Server~~~~0.0.1.0`, then
  `Start-Service sshd` and `Set-Service sshd -StartupType Automatic`.
- The firewall lets the Danbyte server (or the Outpost) reach port 22, or the
  port the credential names.
- The account can log in with the key or password Danbyte holds. For a key,
  the public key is in the account's `%USERPROFILE%\.ssh\authorized_keys`;
  for an account in the Administrators group OpenSSH reads
  `C:\ProgramData\ssh\administrators_authorized_keys` instead.
- `cmd` and `powershell` (Windows PowerShell) start for that account. The
  default shell may be cmd or PowerShell.

### Over WinRM

WinRM (Windows Remote Management, WS-Management over HTTP) is for Windows
hosts without SSH. Danbyte uses it in exactly one way:

- **HTTPS only**, `https://<address>:5986/wsman` (or the port the credential
  names). There is no code path for plain HTTP.
- **The server certificate is verified**, always: against the Danbyte
  server's trust store (`DANBYTE_DISCOVERY_WINRM_CA_BUNDLE`, else the system
  CA bundle), for the address's **DNS name** in IPAM - or, when the address
  has none, the address itself. The connection still goes to the address the
  scope resolved, never to a name looked up again. A certificate that does
  not verify is *Certificate not trusted*.
- **Client-certificate authentication**, from a credential of kind *WinRM
  certificate*: a PEM client certificate and its private key (a passphrase
  is allowed). Certificate and key reach the TLS library through in-memory
  files, never disk.
- No redirects are followed and no proxy from the environment is used.
- Never NTLM, Basic, CredSSP, unverified TLS, or Kerberos. Kerberos is not
  available in this build: it would need `pykerberos` (or `pyspnego` with
  `gssapi`) and the system Kerberos libraries, none of which ships with
  Danbyte.

WinRM must be switched on per tenant (**WinRM over HTTPS**). It shows *Not
available in this build* when the server lacks the WinRM library or in-memory
files, and *Forbidden by the deployment* when
`DANBYTE_DISCOVERY_WINRM_ALLOWED` is off. Outposts never use WinRM
([On an Outpost](discovery-outposts.md#what-an-outpost-does-not-do)).

What must be true on the host. Windows-side steps vary with your PKI; this
list is what Danbyte depends on, with the standard commands where they are
fixed:

1. **An HTTPS listener** with a server certificate that names the address's
   IPAM DNS name (or its IP address), issued by a CA the Danbyte server
   trusts. For example:
   `New-Item -Path WSMan:\localhost\Listener -Transport HTTPS -Address * -CertificateThumbPrint <thumbprint> -Force`.
2. **Certificate authentication on** for the WinRM service:
   `Set-Item -Path WSMan:\localhost\Service\Auth\Certificate -Value $true`.
3. **A local account** for Danbyte. WinRM maps client certificates to local
   accounts only, not domain accounts. Membership of **Remote Management
   Users** lets it use WinRM without being an administrator.
4. **A client certificate** for that account: Client Authentication in its
   extended key usage and the account's user principal name in its subject
   alternative name (for a local account usually `user@localhost`). Its
   issuing CA must be trusted on the host.
5. **A mapping** from the certificate's issuer to the account, for example:
   `New-Item -Path WSMan:\localhost\ClientCertificate -Subject <upn> -URI * -Issuer <issuer CA thumbprint> -Credential (Get-Credential) -Force`.
6. **The firewall** allows TCP 5986 from the Danbyte server.
7. In Danbyte: the certificate and key as a *WinRM certificate* credential
   on the host or as a shared credential, and your CA in the server's trust
   store or in the file `DANBYTE_DISCOVERY_WINRM_CA_BUNDLE` names
   ([Settings](discovery-settings.md#environment-variables)).

## What is read

One fixed PowerShell script, the same over SSH and WinRM. It is started as
`powershell -NoProfile -NonInteractive -EncodedCommand <base64>`: the base64
of the constant script (UTF-16LE, as PowerShell takes it), so the command line
holds only letters, digits, `+`, `/` and `=`, and neither cmd.exe nor
PowerShell has anything to expand. Laid out for reading (the code holds it on
one line):

```powershell
$ErrorActionPreference='Stop'
[Console]::OutputEncoding=[Text.Encoding]::UTF8
$cv=Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion'
$os=$null; try { $os=Get-CimInstance Win32_OperatingSystem } catch {}
$hf=@(); try { $hf=@(Get-CimInstance Win32_QuickFixEngineering | ForEach-Object {
  [pscustomobject]@{ id=[string]$_.HotFixID; description=[string]$_.Description;
                     installed_on=[string]$_.InstalledOn } }) } catch {}
$pr=@()
foreach ($v in @(@('HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\*','x64'),
                 @('HKLM:\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*','x86'))) {
  $a=$v[1]
  $pr+=@(Get-ItemProperty $v[0] -ErrorAction SilentlyContinue |
    Where-Object { $_.DisplayName -and -not $_.SystemComponent -and -not $_.ParentKeyName } |
    ForEach-Object { [pscustomobject]@{ name=[string]$_.DisplayName;
      version=[string]$_.DisplayVersion; publisher=[string]$_.Publisher; arch=$a } }) }
$fe=@(); try { $fe=@(Get-CimInstance Win32_ServerFeature | ForEach-Object { [string]$_.Name }) } catch {}
[pscustomobject]@{ schema=1; product_name=[string]$cv.ProductName; edition_id=[string]$cv.EditionID;
  display_version=[string]$cv.DisplayVersion; release_id=[string]$cv.ReleaseId;
  current_build=[string]$cv.CurrentBuildNumber; ubr=$cv.UBR;
  installation_type=[string]$cv.InstallationType;
  caption=<Win32_OperatingSystem Caption>; version=<its Version>;
  architecture=<its OSArchitecture>;
  hotfixes=$hf; programs=$pr; features=$fe } | ConvertTo-Json -Depth 4 -Compress
```

It reads the `CurrentVersion` registry key, the CIM classes
`Win32_OperatingSystem`, `Win32_QuickFixEngineering` (what `Get-HotFix`
reads) and `Win32_ServerFeature` (Windows Server roles and features, empty
elsewhere), and the 64-bit and 32-bit Uninstall keys. No writes, no other
cmdlets. It is written for Windows PowerShell 5.1, which Windows Server 2016
and later and Windows 10 and 11 ship. A standard account can read all of it.

The answer must be that JSON document with `schema` 1 and a build number;
anything else fails the host. Strings are stripped of control characters and
capped.

## What is stored

| Fact | Example |
|---|---|
| Product, edition | `Windows Server 2022 Standard`, `ServerStandard` |
| Release | `21H2` (`DisplayVersion`, else `ReleaseId`) |
| Build and UBR | kept together as `10.0.20348.2849`; this is also the host's running version |
| Installation type | `Server` (shown as *Desktop Experience*), `Server Core`, `Client` |
| OS architecture | `x64`, `arm64` or `x86`, whatever spelling the host used |
| Hotfixes | KB numbers with description and install date, at most 2,000 |
| Server features | at most 1,000 names |
| Programs | at most 20,000, as packages of type `generic`: `pkg:generic/windows/<name>@<version>?arch=x64`, with the publisher; `x64` for the native Uninstall key, `x86` for `WOW6432Node` |

The **Packages** tab shows the build, release, installation type,
architecture and hotfix count (hover for the KB numbers) above the list, and
either *N open OS-build CVEs* or *OS build not matched*.

Programs are inventory: they are never matched against OSV, which has no
ecosystem for them. An application whose package names include a
`generic:` entry (`generic:Mozilla Firefox*`) still gets installs from them
([applications from packages](discovery-packages.md#applications-from-packages)).
Windows hosts get no **Set platform** proposal.

## Matching against Microsoft's data

Microsoft's monthly security update documents (the MSRC CVRF data) list, per
CVE and per Windows product, the build that fixes it and the KB that ships
it. Discovery reads the host's build and UBR, so the test is exact: a Windows
Server 2022 host at `10.0.20348.2849` is affected by a CVE Microsoft fixed in
`10.0.20348.5870`. These matches say **Via: OS build**. How builds are
compared and what is stored is on [Known vulnerabilities: Windows
hosts](vulnerabilities.md#windows-hosts-microsoft-data).

### Which product a host is

Microsoft names products, not builds, and some builds are shared (Windows
Server 2025 and Windows 11 24H2 are both 26100). Danbyte places a host from
its build line, then its caption, edition and release, using a table in
`vulnerabilities/msrc_products.py`:

| Release | Build line | Variants |
|---|---|---|
| Windows Server 2012 | `6.2.9200` | Desktop, Server Core |
| Windows Server 2012 R2 | `6.3.9600` | Desktop, Server Core |
| Windows Server 2016 | `10.0.14393` | Desktop, Server Core |
| Windows Server 2019 | `10.0.17763` | Desktop, Server Core |
| Windows Server 2022 | `10.0.20348` | Desktop, Server Core |
| Windows Server 2022, 23H2 Edition | `10.0.25398` | Server Core only |
| Windows Server 2025 | `10.0.26100` | Desktop, Server Core |
| Windows 10 1607 / 1809 | `10.0.14393` / `10.0.17763` | x64, 32-bit |
| Windows 10 21H2 / 22H2 | `10.0.19044` / `10.0.19045` | x64, ARM64, 32-bit |
| Windows 11 22H2, 23H2, 24H2, 25H2 | `10.0.22621`, `10.0.22631`, `10.0.26100`, `10.0.26200` | x64, ARM64 |
| Windows 11 26H1, 26H2 | `10.0.28000`, `10.0.26300` | x64, ARM64 |

Desktop Experience and Server Core are separate products in Microsoft's
data, and so is each CPU architecture of a client release. A Server Core
host is matched only against the Server Core products, a Windows 11 ARM64
host only against the ARM64 ones. When the installation type or architecture
is not known (an older read, a value Danbyte does not recognise), the host
keeps every variant of its release and a CVE matches only when every variant
agrees it is affected.

**Never a guess.** The host gets no OS-build match, and its Packages tab
says *OS build not matched*, when:

- its build line is not in the table (Windows 11 21H2, semi-annual Server
  releases, Azure Stack HCI, a release newer than the table), or its caption
  names another release than its build, or it is a Server Core host of a
  release Microsoft lists only as Desktop - hover: *This build could not be
  placed among Microsoft's Windows products …*;
- it reported no UBR - hover: *The host did not report its update build
  revision (UBR) …*.

Installed hotfixes are shown but not used for matching: Windows updates are
cumulative, so the build says it, and `Get-HotFix` misses updates the
servicing stack installs.

### Getting the data

| Update source | What it takes |
|---|---|
| Server | **Fetch Microsoft's Windows data** on (the default). Nothing is fetched until Discovery has read a Windows host. When a run reads a Windows release no month was fetched for yet, one fetch for that release starts right after the run; the daily refresh does the rest. |
| Upload | Import Microsoft's monthly documents as **Microsoft month** files (`2026-Nov.json`), one per month; refused until Discovery has read a Windows host. |
| Browser | Not available: Microsoft's API sends no cross-origin header, so a browser cannot read it. Upload the months instead. |

The window is the newest 12 months, `DANBYTE_VULN_MSRC_MONTHS` (1 to 36)
([Settings](../reference/settings.md#microsoft-data-window-danbyte_vuln_msrc_months)).
Each month is 4 to 30 MB and Microsoft revises old months often, so in
server mode expect most of the window to be read again over a week. A month
is read again when Microsoft revised it or when it was read for fewer
Windows releases than Discovery now sees.

What is sent: month ids (`2026-Nov`) only. The build, the release, the host
and its address never leave the deployment.

## What is not available

| Not available | Why, and what to do |
|---|---|
| Kerberos, NTLM, Basic, CredSSP | Not offered (Kerberos is not in this build). Use an SSH key or a WinRM client certificate. |
| WinRM over plain HTTP, or with an unverified certificate | No code path for it. |
| WinRM from an Outpost | Outposts read over SSH only. |
| Microsoft data in browser mode | Upload the months. |
| CVEs for installed programs | No OSV ecosystem. Map the application to a CPE for NVD matching. |
| End of life for Windows platforms from a read | No platform proposal; map Windows platforms by hand ([End-of-life data](end-of-life-data.md)). |
