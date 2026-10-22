namespace AiBuddy.Install;

// Resource downloads remain pinned. UpdateDiscovery delegates newer versions to
// their own verified installer instead of feeding future manifests to this engine.
public static class ReleaseIdentity {
    public const string Version="1.9.0";
    public static string ManifestFileName=>"install-manifest-"+Version+".json";
    public static bool KnownTransactionVersion(string version,string currentVersion=Version) {
        static bool Stable(string value)=>System.Text.RegularExpressions.Regex.IsMatch(value,@"\A(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\z");
        return Stable(version)&&Stable(currentVersion)&&System.Version.TryParse(version,out var previous)&&System.Version.TryParse(currentVersion,out var current)&&previous>=new System.Version(1,8,0)&&previous<=current;
    }
}
