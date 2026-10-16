# Direct address (HTTPS)

Choose **Direct address (HTTPS)** immediately after **Direct address** in the in-game connection-method
selector. This connects directly to an IPv4 URL such as `https://192.168.0.123:13337/`. It does not use a
hostname, public DNS, or an internet certificate service. The original HTTP Direct address, Website,
and hostname HTTPS methods remain available.

A **certificate authority (CA)** issues security certificates. Here, your PC acts as that authority.
Installing its public certificate tells each player's device to trust certificates issued by this PC.
**Only do this for a PC you control and trust:** it can approve secure connections beyond this game.
Downloading or installing the certificate alone does not necessarily establish browser trust.
Never bypass a browser's certificate warning.

## Follow the setup guide

Selecting **Direct address (HTTPS)** opens the guide automatically. Closing it returns to the QR dialog,
where **Set up HTTPS** reopens it. Once the PC is ready, that button becomes **Device setup**. You do not
need to select the same connection method again. Restoring a saved preference or refreshing status does
not open the guide or create a certificate automatically.

### 1. Prepare this PC

Choose **Create setup file**. This prepares the PC and exports a public-only `.cer` file, reusing an
existing valid certificate. The private signing key is never part of this file. If creation fails,
use **Try again**; ordinary failures do not require resetting the authority.

### 2. Set up a device

Choose **iPhone / iPad**, **Android**, **Windows**, **macOS**, or **Linux / Firefox**. The guide shows
only that device's instructions; the host PC's operating system does not select the player's device.

1. Use **Show file** to open the exported file's folder. Its path remains visible if the folder cannot
   open. Transfer the file by cable or an authenticated file-transfer connection.
2. Use **Show verification code** and follow the device's instructions to compare the received file
   with the PC's complete SHA-256 code. A matching filename does not verify the file. On phones that
   cannot show the full code, rely on the verified cable/authenticated transfer channel, not a browser
   warning or an unverified download.
3. Install and explicitly trust the certificate using the platform instructions below. Then choose
   **I've installed it**. This is your acknowledgment; the PC cannot verify that a device trusts it.

Do not obtain the file from an unverified HTTP page, email attachment, or QR linking to an
unauthenticated download. Someone replacing the file during setup could become trusted instead.

### 3. Connect

Choose **Show QR code**, then scan it with the device you just configured. A ready host or visible QR
means the PC has a usable certificate, not that the player's device installed trust. If the browser
shows a certificate warning, return through **Device setup** and check the appropriate instructions.
Choose **Set up another device** to repeat the device steps for another player.

**Help & advanced** contains certificate expiry, removal guidance and **Reset setup**. Reset needs a
separate confirmation because every device must remove the old certificate and install the new one.

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
[Microsoft’s certificate-store guidance](https://learn.microsoft.com/en-us/windows-hardware/drivers/install/trusted-root-certification-authorities-certificate-store)

**macOS Safari/Chrome:** import into Keychain Access, open the certificate, expand Trust, and enable
trust for Secure Sockets Layer (SSL), authenticating if requested. Remove the root from that keychain to
revoke trust. Firefox may require its own import or platform-root setting.
[Apple’s Keychain trust settings](https://support.apple.com/guide/keychain-access/change-the-trust-settings-of-a-certificate-kyca11871/mac)

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

A corrupt or expired CA is never silently replaced. Open **Help & advanced → Reset setup**, read the
warning, and select **Confirm reset**. Remove the old root and install the new public root on every client.
Existing trust stops working after replacement, even when the game address stays the same. If a host
is lost or its private keys may have been exposed, remove that CA from all client devices before
trusting a replacement.

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
