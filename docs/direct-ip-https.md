# Direct address (HTTPS)

Choose **Direct address (HTTPS)** immediately after **Direct address** in the in-game connection-method
selector. This connects directly to an IPv4 URL such as `https://192.168.0.123:13337/`. It does not use a
hostname, public DNS, or an internet certificate service. The original HTTP Direct address, Website,
and hostname HTTPS methods remain available.

Each host installation creates its own local certificate authority (CA). Each client must explicitly
install and trust the host's public root certificate. **Downloading or installing a certificate alone
does not necessarily make a browser trust it.** Do not bypass certificate-error pages.

## Set up trust

Only trust a host you control. Installing its root grants that host the ability to certify other
websites too; the trust is not limited to the game. Managed devices may prohibit this setup.

1. Select the host's network interface and **Direct address (HTTPS)**. This opens native setup instructions,
   which remain accessible even when the browser refuses the HTTPS page. Restoring a remembered method
   does not create a CA automatically.
2. Select **Prepare host**. The native dialog shows the complete SHA-256 CA fingerprint and expiry date.
3. Select **Export public certificate**. This exports a public-only `.cer` and opens its local folder.
   The CA private key never belongs in this file. The dialog displays the export path if opening the
   folder fails.
4. Transfer the file by cable or an authenticated file-transfer mechanism. Compare the complete SHA-256
   certificate fingerprint with the host's in-game value. Do not obtain trust material from an unverified
   HTTP page, email attachment, or QR pointing to an unauthenticated download. An attacker replacing the
   root during setup would become trusted.
5. Install and explicitly trust the CA using the platform steps below. Return to the QR dialog and scan
   the HTTPS address. “Host ready” means that the host has a usable certificate, not that the phone has
   installed trust. Re-select this connection method to reopen its setup instructions.

For the exported DER `.cer`, the file's SHA-256 hash equals the certificate fingerprint. Windows can
show it with `certutil -hashfile "CouchCoop-root.cer" SHA256`; macOS with
`shasum -a 256 "CouchCoop-root.cer"`; Linux with `sha256sum "CouchCoop-root.cer"`. Substitute the actual
exported filename. Compare the value with the host's native display, not merely the file's name or a
message sent alongside it. On phones, inspect certificate details where available and use the verified
transfer channel; do not treat a warning page as proof of identity.

A trusted HTTPS origin supports the browser's secure-context features, subject to each browser's own
permissions and capabilities. All game requests and WebSockets remain on HTTPS/WSS; no insecure-content
exception or automatic downgrade is used.

## Client platforms

**iPhone/iPad:** open the transferred `.cer`, install its configuration profile in Settings → General →
VPN & Device Management, then open Settings → General → About → Certificate Trust Settings and enable
full trust for this root. Merely installing the profile is insufficient. Remove trust by removing the
profile from VPN & Device Management. [Apple's manual trust instructions](https://support.apple.com/en-us/102390)

**Android Chrome:** open Settings → Security → Encryption & credentials → Install a certificate →
CA certificate, select the transferred file, and confirm the OS warning. Names and paths vary by vendor
and Android release. Installing it as a Wi-Fi or VPN client certificate is not equivalent to installing
it as a CA. Remove it from the user-installed CA/trusted-credentials list. Chrome recognizes locally
managed roots for TCP TLS; this does not imply that arbitrary Android apps trust user CAs.
[Chrome local trust behavior](https://chromium.googlesource.com/chromium/src/+/main/net/data/ssl/chrome_root_store/faq.md)

**Windows Chrome/Edge:** import the certificate into the current user's **Trusted Root Certification
Authorities** store. Inspect the certificate before confirming trust. Remove it through the same store
(`certmgr.msc`). Administrative policy can restrict user-managed roots.

**macOS Safari/Chrome:** import into Keychain Access, open the certificate, expand Trust, and enable
trust for Secure Sockets Layer (SSL), authenticating if requested. Remove the root from that keychain to
revoke trust. Firefox may require its own import or platform-root setting.

**Linux and Firefox:** use the browser's certificate manager to import the certificate under
**Authorities** and enable website trust, or configure the browser to use an appropriate system trust
store. Linux browser packaging and policy differ; installing a certificate into one store does not
prove another browser uses it. Remove the root from every store where it was imported.
[Firefox authority and platform-root configuration](https://support.mozilla.org/en-US/kb/setting-certificate-authorities-firefox)

The game-free desktop checks do not establish physical iOS/Android compatibility. Certificate installation,
OS settings, permissions and managed-device restrictions require verification on the actual device.

## Address changes and renewal

The root uses RSA-3072/SHA-256 and lasts five years. RSA-2048/SHA-256 server certificates last 90 days,
bounded by root expiry, and renew within 30 days of expiry. They identify the host's eligible local IPv4
addresses using IP-address subject alternative names (SANs), not DNS-name SANs containing IP text.

The host refreshes address coverage after OS network-address-change events and checks renewal on setup
and TLS demand. A QR is available only when its selected IP and bound port are ready. After DHCP or
network changes, rescan the new QR; the existing root still establishes trust. Browser storage, cached
origins and installed shortcuts belong to the old address and may need recreating. IPv6 is not included.

A corrupt or expired CA is never silently replaced. Select **Replace certificate authority**, read the
warning, and confirm replacement. Remove the old root and install the new public root on every client.
Existing trust and links cannot survive a root replacement. If a host is lost or its private keys may
have been exposed, remove that CA from all client devices before trusting a replacement.

## Storage and transport

Private identity is stored in persistent per-user application data, outside the mod installation,
frontend document roots and disposable caches. Files and temporary writes require owner-only Unix
permissions or restricted Windows ACLs. If secure persistence cannot be established, setup fails.
Never copy the CA private key to clients, seat processes, diagnostic bundles or a public directory.
Only the public root is exported. Direct-port seats receive host-issued leaf credentials through
protected local storage and never receive the CA signing key.

The browser server retains its raw TCP listener and supports HTTP and HTTPS on the same port. Hostname
HTTPS and direct-IP HTTPS have independent certificate identities and readiness. The host selects a
certificate appropriate to the requested identity; unknown names do not cause certificates to be issued.
Existing hostname HTTPS uses its original certificate provider and is unaffected by this CA setup.
