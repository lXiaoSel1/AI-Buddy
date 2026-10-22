using System.Text.Json;
namespace AiBuddy.Install;

// Cleanup owns program trees, not the personal files somebody registered inside
// them. Keep the path snapshot across pointer changes and fail closed if any
// record needed to establish that boundary cannot be read.
sealed class PersonalDataProtection {
    readonly HashSet<string> roots=new(StringComparer.OrdinalIgnoreCase);
    string? failure;
    static string Full(string path)=>Path.TrimEndingDirectorySeparator(SafePaths.Full(path));
    static bool Within(string path,string directory)=>string.Equals(path,directory,StringComparison.OrdinalIgnoreCase)||path.StartsWith(directory.TrimEnd(Path.DirectorySeparatorChar,Path.AltDirectorySeparatorChar)+Path.DirectorySeparatorChar,StringComparison.OrdinalIgnoreCase);

    public static PersonalDataProtection Read(string root,InstallJournal? journal=null,Installation? installed=null) {
        var protection=new PersonalDataProtection();
        try {
            root=SafePaths.Full(root);
            void Data(string? path)=>protection.roots.Add(Full(DataPaths.Registered(root,path,false)));
            void Record(Installation? record){
                if(record is null||record.SchemaVersion!=1||string.IsNullOrEmpty(record.Build)||string.IsNullOrEmpty(record.Runtime)||string.IsNullOrEmpty(record.Manager)||record.Characters is null||record.Characters.Length==0)throw new InvalidDataException("Invalid installation data protection record");
                Data(record.DataPath);
            }
            void Text(string? text){if(text is not null)Record(JsonSerializer.Deserialize<Installation>(text,Json.Options));}
            void Journal(InstallJournal item){Data(item.Options.DataPath);Text(item.PreviousInstallation);}
            void ReadFile(string relative,Action<JsonElement> read){var path=SafePaths.Under(root,relative);if(!File.Exists(path))return;using var document=JsonDocument.Parse(File.ReadAllBytes(path));read(document.RootElement);}

            // Inactive imported profiles remain independent personal saves.
            Data(null);protection.roots.Add(Full(SafePaths.Under(root,"local/data-profiles")));
            var current=InstallEngine.Existing(root);if(current is not null)Record(current);
            if(installed is not null)Record(installed);
            if(journal is not null)Journal(journal);
            foreach(var relative in new[]{"local/installer/transaction.json","local/installer/rollback.json"})
                ReadFile(relative,value=>Journal(value.Deserialize<InstallJournal>(Json.Options)??throw new InvalidDataException("Missing cleanup journal")));
            ReadFile("local/installer/data-import-transaction.json",value=>{
                var item=value.Deserialize<DataImportJournal>(Json.Options)??throw new InvalidDataException("Missing data import journal");
                Record(item.Previous);Data(item.Plan.TargetDataPath);
            });
            var recovery=SafePaths.Under(root,"local/installer/recovery-required");
            if(Directory.Exists(recovery))foreach(var path in Directory.EnumerateFiles(recovery,"*.json")){
                SafePaths.NoLinks(path);using var document=JsonDocument.Parse(File.ReadAllBytes(path));
                Journal(document.RootElement.GetProperty("journal").Deserialize<InstallJournal>(Json.Options)??throw new InvalidDataException("Missing recovery journal"));
                if(document.RootElement.TryGetProperty("previousDataPaths",out var previous)){
                    if(previous.ValueKind!=JsonValueKind.Array)throw new InvalidDataException("Invalid previous personal-data paths");
                    foreach(var value in previous.EnumerateArray()){
                        if(value.ValueKind!=JsonValueKind.String||string.IsNullOrWhiteSpace(value.GetString()))throw new InvalidDataException("Invalid previous personal-data path");
                        Data(value.GetString());
                    }
                }
            }
            var backups=SafePaths.Under(root,"local/installation-backups");
            if(Directory.Exists(backups))foreach(var path in Directory.EnumerateFiles(backups,"*.json")){
                SafePaths.NoLinks(path);Text(File.ReadAllText(path));
            }
        }catch(Exception ex){protection.failure=ex.Message;}
        return protection;
    }

    public bool Allows(string path,IProgress<InstallProgress>? progress) {
        try {
            if(failure is not null)throw new IOException("Personal-data locations could not be verified: "+failure);
            SafePaths.NoLinks(path);var candidate=Full(path);
            if(roots.Any(data=>Within(candidate,data)||Within(data,candidate))){
                progress?.Report(new("cleanup-pending",path,Detail:"Personal data retained / 此位置包含或属于个人存档，已保留"));return false;
            }
            return true;
        }catch(Exception ex){progress?.Report(new("cleanup-pending",path,Detail:ex.Message));return false;}
    }

    public void RemoveTree(string path,string root,IProgress<InstallProgress>? progress) {
        if(Allows(path,progress))SafePaths.RemoveOwnedTree(path,root);
    }
}
