using System.Text.Json;
using System.Text.RegularExpressions;
namespace AiBuddy.Install;

public sealed record DataImportPlan(int SchemaVersion,string Id,string Root,string ExpectedInstallationSha256,string ExpectedBuild,string Pipe,string TargetDataPath,string SourceIdentity,string FilesSha256,InstallFile[] Files,string State);
public sealed record DataImportJournal(string Id,string Phase,DataImportPlan Plan,Installation Previous,DateTimeOffset At,string? Error=null);
public sealed record DataImportResult(string Id,string Phase,bool RestoredPrevious,StartupStatus? Startup);

// Copies are prepared by the application. This manager only accepts a root-bound,
// hashed complete tree, then switches the profile while holding the install lock.
public sealed class DataImportManager(IAppHost host,Action<string>? checkpoint=null) {
    static bool Digest(string? value)=>value is not null&&Regex.IsMatch(value,@"\A[a-f0-9]{64}\z");
    static bool Id(string? value)=>value is not null&&Guid.TryParseExact(value,"D",out var id)&&id.ToString("D")==value;
    static string Pipe(string? value)=>(value??"whale-companion-v001").Replace(@"\\.\pipe\","");
    static string JournalPath(string root)=>SafePaths.Under(root,"local/installer/data-import-transaction.json");
    static string PlanPath(string root,string id)=>SafePaths.Under(root,"local/data-imports/"+id+"/commit-plan.json");
    static void Status(string root,DataImportPlan plan,string phase,bool canCancel,string? error=null)=>Json.Save(SafePaths.Under(root,"local/data-imports/"+plan.Id+"/commit-status.json"),new{schemaVersion=1,id=plan.Id,phase,canCancel,error,at=DateTimeOffset.UtcNow});
    static void Validate(string root,DataImportPlan plan) {
        if(plan.SchemaVersion!=1||!Id(plan.Id)||plan.State!="ready"||!string.Equals(SafePaths.Full(plan.Root),root,StringComparison.OrdinalIgnoreCase)||!Digest(plan.ExpectedInstallationSha256)||!Digest(plan.SourceIdentity)||!Digest(plan.FilesSha256)||plan.TargetDataPath!="local/data-profiles/import-"+plan.Id||plan.Files is null||plan.Files.Length==0)throw new InvalidDataException("Invalid root-bound data import plan");
        SafePaths.Under(root,plan.ExpectedBuild);SafePaths.Under(root,plan.TargetDataPath);
        if(!Regex.IsMatch(Pipe(plan.Pipe),@"\A[a-zA-Z0-9_.-]{1,180}\z"))throw new InvalidDataException("Invalid import pipe");
        var names=new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        foreach(var f in plan.Files){SafePaths.Relative(f.Path);if(f.Bytes<0||!Digest(f.Sha256)||!names.Add(f.Path))throw new InvalidDataException("Invalid or duplicate imported file");}
        if(Manifests.IndexHash(plan.Files.OrderBy(f=>f.Path,StringComparer.Ordinal).ToArray())!=plan.FilesSha256)throw new InvalidDataException("Import file index changed");
    }
    static async Task VerifyTree(string root,DataImportPlan plan,CancellationToken cancel) {
        var target=SafePaths.Under(root,plan.TargetDataPath);if(!Directory.Exists(target))throw new DirectoryNotFoundException("Imported data tree is missing");
        var declared=plan.Files.ToDictionary(f=>f.Path,StringComparer.OrdinalIgnoreCase);int count=0;
        var directories=new Stack<string>();directories.Push(target);
        while(directories.Count>0)foreach(var file in Directory.EnumerateFileSystemEntries(directories.Pop())){
            cancel.ThrowIfCancellationRequested();SafePaths.NoLinks(file);
            if(Directory.Exists(file)){directories.Push(file);continue;}
            var name=Path.GetRelativePath(target,file).Replace('\\','/');
            if(!declared.TryGetValue(name,out var expected)||!await Hashing.Matches(file,expected.Bytes,expected.Sha256,cancel))throw new InvalidDataException("Imported file changed: "+name);count++;
        }
        if(count!=declared.Count)throw new InvalidDataException("Imported file set is incomplete");
    }
    static async Task<Installation> VerifyCurrent(string root,DataImportPlan plan,CancellationToken cancel){
        var record=InstallEngine.RecordPath(root);if(!File.Exists(record)||await Hashing.FileHash(record,cancel)!=plan.ExpectedInstallationSha256)throw new IOException("Installation record changed after import preview");
        var previous=Json.Read<Installation>(record);
        using var pointer=JsonDocument.Parse(await File.ReadAllBytesAsync(SafePaths.Under(root,"local/current-build.json"),cancel));
        if(previous.Version!=ReleaseIdentity.Version||previous.Build!=plan.ExpectedBuild||pointer.RootElement.GetProperty("path").GetString()!=plan.ExpectedBuild||Pipe(previous.Pipe)!=Pipe(plan.Pipe))throw new InvalidDataException("Import plan belongs to a different program or instance");
        DataPaths.Registered(root,previous.DataPath);return previous;
    }
    public async Task<DataImportResult> Commit(string requestedRoot,string requestedPlan,IProgress<InstallProgress>? progress,CancellationToken cancel){
        var root=SafePaths.Full(requestedRoot);SafePaths.NoLinks(root);var path=SafePaths.Full(requestedPlan);SafePaths.NoLinks(path);
        var bytes=await File.ReadAllBytesAsync(path,cancel);var plan=JsonSerializer.Deserialize<DataImportPlan>(bytes,Json.Options)??throw new InvalidDataException("Empty import plan");Validate(root,plan);
        if(!string.Equals(path,PlanPath(root,plan.Id),StringComparison.OrdinalIgnoreCase))throw new InvalidDataException("Import plan is outside the selected installation");
        var control=SafePaths.Under(root,"local/installer");Directory.CreateDirectory(control);
        await using var installationLock=new FileStream(Path.Combine(control,"install.lock"),FileMode.OpenOrCreate,FileAccess.ReadWrite,FileShare.None);
        await RecoverLocked(root,progress,cancel);
        var previous=await VerifyCurrent(root,plan,cancel);await VerifyTree(root,plan,cancel);
        var journal=new DataImportJournal(plan.Id,"prepared",plan,previous,DateTimeOffset.UtcNow);Json.Save(JournalPath(root),journal);
        Status(root,plan,"waiting",true);bool switched=false,stopped=false;
        using var waiting=CancellationTokenSource.CreateLinkedTokenSource(cancel);var cancelFile=SafePaths.Under(root,"local/data-imports/"+plan.Id+"/cancel.request");
        var watcher=Task.Run(async()=>{while(!waiting.IsCancellationRequested){if(File.Exists(cancelFile)){waiting.Cancel();return;}try{await Task.Delay(50,waiting.Token);}catch(OperationCanceledException){return;}}});
        try {
            await host.Stop(root,previous,new ImportProgress(p=>{progress?.Report(p);Status(root,plan,"waiting",true);}),waiting.Token);stopped=true;waiting.Cancel();await watcher;
            cancel.ThrowIfCancellationRequested();if(File.Exists(cancelFile))throw new OperationCanceledException("Import cancelled before switching");
            if(Hashing.Bytes(await File.ReadAllBytesAsync(path,cancel))!=Hashing.Bytes(bytes))throw new IOException("Import plan changed before commit");
            await VerifyCurrent(root,plan,cancel);await VerifyTree(root,plan,cancel);
            Json.Save(SafePaths.Under(root,"local/installation-backups/import-"+plan.Id+".json"),previous);
            journal=journal with{Phase="switching"};Json.Save(JournalPath(root),journal);Status(root,plan,"switching",false);checkpoint?.Invoke("import-switching");
            var selected=previous with{DataPath=plan.TargetDataPath,DataInitialized=true};Json.Save(InstallEngine.RecordPath(root),selected);switched=true;
            journal=journal with{Phase="switched"};Json.Save(JournalPath(root),journal);checkpoint?.Invoke("import-switched");Status(root,plan,"verifying",false);
            // A precise verification token lets only this child start the selected
            // profile while ordinary restart recovers the previous profile.
            await host.StartImportedAndVerify(root,selected,plan.Id,CancellationToken.None);
            if(host.LastStartup?.SafeMode==true||host.LastStartup?.Onboarding==true)throw new IOException("Imported profile entered safe mode or empty welcome; the previous profile will be restored");
            journal=journal with{Phase="complete"};Json.Save(JournalPath(root),journal);Status(root,plan,"complete",false);return new(plan.Id,"complete",false,host.LastStartup);
        }catch(Exception failure){
            waiting.Cancel();await watcher;
            if(switched||journal.Phase=="switching"){
                try{await Restore(root,journal,progress,CancellationToken.None);}catch(Exception recovery){Json.Save(JournalPath(root),journal with{Error=failure+"\nRecovery: "+recovery});Status(root,plan,"failed",false,failure.Message+"; recovery required: "+recovery.Message);throw new AggregateException(failure,recovery);}
            }else if(stopped){await host.StartAndVerify(root,previous,CancellationToken.None);}
            var phase=failure is OperationCanceledException?"cancelled":"failed";Json.Save(JournalPath(root),journal with{Phase=phase,Error=failure.ToString()});Status(root,plan,phase,false,failure.Message);throw;
        }finally{waiting.Cancel();await watcher;}
    }
    public async Task<DataImportResult?> Recover(string requestedRoot,IProgress<InstallProgress>? progress,CancellationToken cancel){
        var root=SafePaths.Full(requestedRoot);var control=SafePaths.Under(root,"local/installer");Directory.CreateDirectory(control);
        await using var installationLock=new FileStream(Path.Combine(control,"install.lock"),FileMode.OpenOrCreate,FileAccess.ReadWrite,FileShare.None);return await RecoverLocked(root,progress,cancel);
    }
    async Task<DataImportResult?> RecoverLocked(string root,IProgress<InstallProgress>? progress,CancellationToken cancel){
        var path=JournalPath(root);if(!File.Exists(path))return null;var journal=Json.Read<DataImportJournal>(path);
        // Terminal records are historical evidence, not an active recovery plan.
        // They may refer to the old root after a portable folder has been moved.
        // Never reinterpret their paths or block a fresh import in the new root.
        if(journal.Phase is "prepared" or "complete" or "failed" or "cancelled" or "rolled-back")return null;
        if(journal.Phase is not ("switching" or "switched" or "verifying"))throw new InvalidDataException("Unknown import transaction phase; recovery needs review");
        Validate(root,journal.Plan);if(journal.Id!=journal.Plan.Id)throw new InvalidDataException("Invalid import transaction identity");
        await Restore(root,journal,progress,cancel);Status(root,journal.Plan,"failed",false,"Interrupted import restored the previous profile; imported files were retained");return new(journal.Id,"rolled-back",true,host.LastStartup);
    }
    async Task Restore(string root,DataImportJournal journal,IProgress<InstallProgress>? progress,CancellationToken cancel){
        var current=Json.Read<Installation>(InstallEngine.RecordPath(root));
        if(current.Build!=journal.Plan.ExpectedBuild)throw new IOException("Program changed during interrupted import; recovery needs review");
        await host.Stop(root,current,progress,cancel);
        // Preserve any current program fields; only undo this transaction's profile.
        var restored=current with{DataPath=journal.Previous.DataPath,Pipe=journal.Previous.Pipe,DataInitialized=journal.Previous.DataInitialized};Json.Save(InstallEngine.RecordPath(root),restored);
        Json.Save(JournalPath(root),journal with{Phase="rolled-back"});await host.StartAndVerify(root,restored,cancel);
    }
    sealed class ImportProgress(Action<InstallProgress> action):IProgress<InstallProgress>{public void Report(InstallProgress value)=>action(value);}
}
