using System.Security.Cryptography;
using System.Text.Json;
using System.Text.RegularExpressions;

namespace AiBuddy.Install;

public sealed record InstallFile(string Path, long Bytes, string Sha256);
public sealed record Package(string Id, string Kind, string Mount, string AssetName, long Bytes,
    long UnpackedBytes, string Sha256, string[] DependsOn, InstallFile[] Files,
    string? CharacterId = null, string? Edition = null,string? FilesSha256=null);
public sealed record Edition(string Id, string Label, string AppPackageId);
public sealed record Character(string Id, string Name, string CommonPackageId, Dictionary<string,string[]> Motions);
public sealed record RuntimeSpec(string Executable, string Sha256);
public sealed record InstallManifest(int SchemaVersion, string AppVersion, string ReleaseTag,
    string Repository, string Platform, string Arch, string MinimumInstallerVersion,
    int ResourceContractVersion, string DefaultEdition, string DefaultCharacterId,
    string[] RequiredPackageIds, RuntimeSpec Runtime, Edition[] Editions,
    Character[] Characters, Package[] Packages);

public static class Json {
    public static readonly JsonSerializerOptions Options = new() { PropertyNamingPolicy=JsonNamingPolicy.CamelCase, PropertyNameCaseInsensitive=false, WriteIndented=true };
    public static T Read<T>(string path) => JsonSerializer.Deserialize<T>(File.ReadAllBytes(path),Options) ?? throw new InvalidDataException("Empty JSON: "+path);
    public static void Save<T>(string path,T value) {
        Directory.CreateDirectory(System.IO.Path.GetDirectoryName(path)!);
        var temporary=path+"."+Guid.NewGuid().ToString("N")+".tmp";
        using(var stream=new FileStream(temporary,FileMode.CreateNew,FileAccess.Write,FileShare.None)) {
            JsonSerializer.Serialize(stream,value,Options);stream.Flush(true);
        }
        // A scanner may briefly hold a just-written transaction/installation file.
        // Keep atomic replacement and retry only transient Windows sharing/access errors.
        for(int n=0;;n++)try{File.Move(temporary,path,true);break;}catch(Exception ex) when(n<20&&ex is IOException or UnauthorizedAccessException&&(ex.HResult&0xffff) is 5 or 32 or 33){Thread.Sleep(100);}
    }
}

public static class Hashing {
    public static string Bytes(ReadOnlySpan<byte> bytes)=>Convert.ToHexStringLower(SHA256.HashData(bytes));
    public static async Task<string> FileHash(string path,CancellationToken cancel=default) {
        await using var stream=new FileStream(path,FileMode.Open,FileAccess.Read,FileShare.Read,1024*1024,FileOptions.Asynchronous|FileOptions.SequentialScan);
        return Convert.ToHexStringLower(await SHA256.HashDataAsync(stream,cancel));
    }
    public static async Task<bool> Matches(string path,long bytes,string hash,CancellationToken cancel=default) =>
        System.IO.File.Exists(path) && new FileInfo(path).Length==bytes && await FileHash(path,cancel)==hash;
}

public static class Manifests {
    public const long PackageLimit=1073741824;
    public static string IndexHash(InstallFile[] files)=>Hashing.Bytes(System.Text.Encoding.UTF8.GetBytes(string.Concat(files.Select(f=>$"{f.Path}\t{f.Bytes.ToString(System.Globalization.CultureInfo.InvariantCulture)}\t{f.Sha256}\n"))));
    public static InstallManifest Parse(byte[] bytes,string expectedHash) {
        if(bytes.Length>16*1024*1024 || Hashing.Bytes(bytes)!=expectedHash)throw new InvalidDataException("Manifest SHA-256 mismatch");
        using var document=JsonDocument.Parse(bytes);
        if(document.RootElement.TryGetProperty("templateOnly",out _))throw new InvalidDataException("Template is not installable");
        var m=JsonSerializer.Deserialize<InstallManifest>(bytes,Json.Options)??throw new InvalidDataException("Empty manifest");
        Validate(m);return m;
    }
    public static void Validate(InstallManifest m) {
        if(m.SchemaVersion!=1 || m.ResourceContractVersion!=1 || m.AppVersion!=ReleaseIdentity.Version || m.ReleaseTag!="v"+m.AppVersion ||
            m.Repository!="lXiaoSel1/AI-Buddy" || m.Platform!="win32" || m.Arch!="x64" || m.MinimumInstallerVersion!=ReleaseIdentity.Version)throw new InvalidDataException("Unsupported manifest version or platform");
        static bool Digest(string s)=>s is not null && Regex.IsMatch(s,"^[a-f0-9]{64}$");
        if(m.Packages is null || m.Packages.Length is <1 or >900 || m.Characters is null || m.Characters.Length==0 || m.Editions is null)throw new InvalidDataException("Missing packages");
        if(!Digest(m.Runtime.Sha256)||m.Runtime.Executable!="AI Buddy.exe")throw new InvalidDataException("Invalid runtime identity");
        var ids=new HashSet<string>(StringComparer.Ordinal);var assets=new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        foreach(var p in m.Packages) {
            if(!Regex.IsMatch(p.Id,"^[a-z0-9-]{1,100}$")||!ids.Add(p.Id)||!assets.Add(p.AssetName))throw new InvalidDataException("Duplicate package");
            SafePaths.Relative(p.AssetName);if(p.AssetName.Contains('/')||!p.AssetName.EndsWith(".zip")||p.Bytes<=0||p.Bytes>PackageLimit||!Digest(p.Sha256))throw new InvalidDataException("Invalid package identity");
            if(p.Mount is not ("root" or "build" or "runtime") || p.Files.Length is <1 or >20000 || p.UnpackedBytes<0)throw new InvalidDataException("Invalid package layout");
            var paths=new HashSet<string>(StringComparer.OrdinalIgnoreCase);long sum=0;
            foreach(var f in p.Files) {
                SafePaths.Relative(f.Path);if(!paths.Add(f.Path)||f.Bytes<0||!Digest(f.Sha256))throw new InvalidDataException("Invalid file index");
                if(p.Mount=="root" && !RootFileAllowed(f.Path))throw new InvalidDataException("Package targets user data or an undeclared root location");
                sum=checked(sum+f.Bytes);
            }
            if(sum!=p.UnpackedBytes)throw new InvalidDataException("Invalid expanded size");
            if(p.FilesSha256!=IndexHash(p.Files))throw new InvalidDataException("File index hash mismatch");
        }
        foreach(var p in m.Packages)if(p.DependsOn.Any(id=>!ids.Contains(id)))throw new InvalidDataException("Missing dependency");
        var dependencyMap=m.Packages.ToDictionary(p=>p.Id);var checking=new HashSet<string>();var checkedIds=new HashSet<string>();
        void CheckGraph(string id){if(checkedIds.Contains(id))return;if(!checking.Add(id))throw new InvalidDataException("Dependency cycle");foreach(var d in dependencyMap[id].DependsOn)CheckGraph(d);checking.Remove(id);checkedIds.Add(id);}
        foreach(var p in m.Packages)CheckGraph(p.Id);
        if(m.Characters.Select(c=>c.Id).Distinct().Count()!=m.Characters.Length || m.Editions.Select(e=>e.Id).Order().SequenceEqual(new[]{"30fps","60fps"})==false)throw new InvalidDataException("Invalid catalogue");
        foreach(var c in m.Characters)if(!Regex.IsMatch(c.Id,"^[a-z0-9-]+$")||!ids.Contains(c.CommonPackageId)||m.Editions.Any(e=>!c.Motions.ContainsKey(e.Id)||c.Motions[e.Id].Any(id=>!ids.Contains(id))))throw new InvalidDataException("Invalid character dependency");
        if(!m.Characters.Any(c=>c.Id==m.DefaultCharacterId))throw new InvalidDataException("Default character missing");
        foreach(var e in m.Editions)Select(m,e.Id,m.Characters.Select(c=>c.Id).ToArray(),m.DefaultCharacterId);
    }
    public static bool RootFileAllowed(string path)=>path is "AI Buddy.exe" or "AI Buddy.cmd" or "AI Buddy.vbs" or "Start-AI-Buddy.ps1" or "LICENSE.md" or "README.md" or "README.en.md" or "THIRD_PARTY_NOTICES.md" or "THIRD_PARTY_MONITOR.md" or "CG_API_GUIDE.md" || path.StartsWith("licenses/")||path.StartsWith("docs/")||path.StartsWith("assets/branding/");
    public static Package[] Select(InstallManifest m,string edition,string[] characters,string initial) {
        var e=m.Editions.SingleOrDefault(e=>e.Id==edition)??throw new InvalidDataException("Unknown edition");
        if(characters.Length==0 || !characters.Contains(initial) || characters.Distinct().Count()!=characters.Length || characters.Any(id=>!m.Characters.Any(c=>c.Id==id)))throw new InvalidDataException("Select at least the initial character");
        var selected=m.RequiredPackageIds.Concat(new[]{e.AppPackageId}).Concat(m.Characters.Where(c=>characters.Contains(c.Id)).SelectMany(c=>new[]{c.CommonPackageId}.Concat(c.Motions[edition])));
        var map=m.Packages.ToDictionary(p=>p.Id);var visiting=new HashSet<string>();var visited=new HashSet<string>();var result=new List<Package>();
        void Visit(string id) {
            if(visited.Contains(id))return;
            if(!visiting.Add(id)||!map.TryGetValue(id,out var p))throw new InvalidDataException("Cyclic or missing dependency");
            if(p.Edition is not null && p.Edition!=edition)throw new InvalidDataException("Mixed editions");
            foreach(var d in p.DependsOn)Visit(d);visiting.Remove(id);visited.Add(id);result.Add(p);
        }
        foreach(var id in selected)Visit(id);
        var paths=new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        foreach(var p in result)foreach(var f in p.Files)if(!paths.Add(p.Mount+"/"+f.Path))throw new InvalidDataException("Overlapping package files");
        return result.ToArray();
    }
    public static Uri Url(InstallManifest m,string asset)=>new($"https://github.com/{m.Repository}/releases/download/{Uri.EscapeDataString(m.ReleaseTag)}/{Uri.EscapeDataString(asset)}");
}
