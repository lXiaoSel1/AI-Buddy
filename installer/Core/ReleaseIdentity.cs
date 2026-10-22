namespace AiBuddy.Install;

// Fixed at build time. Downloads never select "latest" or change this identity.
public static class ReleaseIdentity {
    public const string Version="1.9.0";
    public static string ManifestFileName=>"install-manifest-"+Version+".json";
    public static bool KnownTransactionVersion(string version)=>version is "1.8.0" or Version;
}
