using System.Text.Json;
using System.Text.RegularExpressions;
namespace AiBuddy.Install;

public static class DataPaths {
    public static bool Imported(string value)=>Regex.IsMatch(value,@"\Alocal/data-profiles/import-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\z");
    public static string Registered(string root,string? value,bool mustExist=true) {
        var path=string.IsNullOrEmpty(value)?SafePaths.Under(root,"local/data-v003"):Path.IsPathFullyQualified(value)?SafePaths.Full(value):Imported(value)?SafePaths.Under(root,value):throw new InvalidDataException("Relative data paths must identify an imported profile");
        SafePaths.NoLinks(path);
        if(mustExist&&!string.IsNullOrEmpty(value)&&!Directory.Exists(path))throw new IOException("The registered personal-data directory is missing; restore it before continuing: "+path);
        return path;
    }
    public static Installation? Effective(string root) {
        var record=InstallEngine.RecordPath(root);Installation? previous=File.Exists(record)?Json.Read<Installation>(record):null;
        if(previous is not null&&(previous.SchemaVersion!=1||string.IsNullOrEmpty(previous.Build)||string.IsNullOrEmpty(previous.Runtime)||string.IsNullOrEmpty(previous.Manager)||previous.Characters is null||previous.Characters.Length==0))throw new InvalidDataException("Installation record is damaged; restore it instead of creating a fresh save");
        var marker=SafePaths.Under(root,"local/portable-defaults.json");var pointer=SafePaths.Under(root,"local/current-build.json");
        if(!File.Exists(marker)||!File.Exists(pointer))return previous;
        using var defaults=JsonDocument.Parse(File.ReadAllBytes(marker));using var current=JsonDocument.Parse(File.ReadAllBytes(pointer));
        var m=defaults.RootElement;
        if(!m.TryGetProperty("schemaVersion",out var schema)||schema.GetInt32()!=1||!m.TryGetProperty("pointer",out var binding)||!m.TryGetProperty("installation",out var template))throw new InvalidDataException("Invalid portable defaults");
        foreach(var name in new[]{"version","appVersion","path","runtime","animationProfile","manifestSha256"})if(!binding.TryGetProperty(name,out var b)||!current.RootElement.TryGetProperty(name,out var c)||!JsonElement.DeepEquals(b,c))return previous;
        var value=template.Deserialize<Installation>(Json.Options)??throw new InvalidDataException("Invalid portable installation template");
        if(value.SchemaVersion!=1||value.Build!=binding.GetProperty("path").GetString()||value.Runtime!=binding.GetProperty("runtime").GetProperty("path").GetString()||value.Edition!=binding.GetProperty("animationProfile").GetString()||value.Version!=binding.GetProperty("version").GetString()||value.ManifestSha256!=binding.GetProperty("manifestSha256").GetString()||value.Characters is null||value.Characters.Length==0)throw new InvalidDataException("Portable defaults do not match their program pointer");
        return value with{DataPath=previous?.DataPath,Pipe=previous?.Pipe,DataInitialized=previous?.DataInitialized??value.DataInitialized,InitialCharacter=previous is not null&&value.Characters.Contains(previous.InitialCharacter)?previous.InitialCharacter:value.InitialCharacter};
    }
}
