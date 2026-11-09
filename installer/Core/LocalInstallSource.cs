namespace AiBuddy.Install;

// A complete portable tree is a source of immutable program bytes, never a source of personal data.
public sealed record LocalInstallSource(string Root,Installation Installation) {
    public static LocalInstallSource? Open(string folder,string manifestHash) {
        folder=SafePaths.Full(folder);SafePaths.NoLinks(folder);
        var installation=InstallEngine.Existing(folder);
        if(installation is null||installation.ManifestSha256!=manifestHash)return null;
        var pin=SafePaths.Under(folder,"local/install-manifests/"+manifestHash+".json");
        if(!File.Exists(pin)||new FileInfo(pin).Length>16*1024*1024||Hashing.Bytes(File.ReadAllBytes(pin))!=manifestHash)throw new InvalidDataException("Local source manifest differs / 本地资源清单不一致");
        return new(folder,installation);
    }
    public static string? Discover(string executable,string manifestHash) {
        for(var folder=Path.GetDirectoryName(Path.GetFullPath(executable));folder is not null;folder=Path.GetDirectoryName(folder))
            if(File.Exists(Path.Combine(folder,"local","install-manifests",manifestHash+".json"))&&Open(folder,manifestHash) is not null)return folder;
        return null;
    }
    public string Mount(Package package)=>package.Mount switch {"root"=>Root,"runtime"=>SafePaths.Under(Root,Installation.Runtime),_=>SafePaths.Under(Root,Installation.Build)};
}
