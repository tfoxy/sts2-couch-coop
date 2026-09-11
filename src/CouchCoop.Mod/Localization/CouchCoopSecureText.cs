namespace CouchCoop.Mod.Localization;

public static class CouchCoopSecureText
{
    public static CouchCoopText Pending => new("couchcoop_option_secure_pending");
    public static CouchCoopText Checking => new("couchcoop_secure_checking");
    public static CouchCoopText Disabled(string setting) => CouchCoopText.Create("couchcoop_secure_disabled", ("setting", setting));
    public static CouchCoopText AddressIneligible => new("couchcoop_secure_address_ineligible");
    public static CouchCoopText PortFailed => new("couchcoop_secure_port_failed");
    public static CouchCoopText SetupFailed => new("couchcoop_secure_setup_failed");
    public static CouchCoopText ProviderUnavailable => new("couchcoop_secure_provider_unavailable");
    public static CouchCoopText Cancelled => new("couchcoop_secure_cancelled");
    public static CouchCoopText CertificateKeyMismatch => new("couchcoop_secure_certificate_key_mismatch");
    public static CouchCoopText CertificateNotValidYet => new("couchcoop_secure_certificate_not_valid_yet");
    public static CouchCoopText CertificateExpired => new("couchcoop_secure_certificate_expired");
    public static CouchCoopText CertificateLoadFailed => new("couchcoop_secure_certificate_load_failed");
    public static CouchCoopText SetupException(string exceptionType)
        => CouchCoopText.Create("couchcoop_secure_setup_exception", ("type", exceptionType));
    public static CouchCoopText Ready => new("couchcoop_secure_ready");
}
