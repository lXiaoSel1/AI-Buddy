using System.Text.Json;
namespace AiBuddy.Install;

public sealed record InstallOptions(string Root,string Cache,string Edition,string[] Characters,string InitialCharacter,string? OfflineDirectory=null,bool Shortcuts=true,bool Launch=true,string? DataPath=null,string? Pipe=null,bool KeepCache=false);
public sealed record StartupStatus(bool SafeMode,JsonElement? StartupFailure,bool Onboarding=false,JsonElement? Components=null);
public sealed record Installation(int SchemaVersion,string Version,string ManifestSha256,string Edition,string[] Characters,string InitialCharacter,string Build,string Runtime,string Manager,string? DataPath,string? Pipe,DateTimeOffset InstalledAt,Dictionary<string,string> PackageHashes,StartupStatus? Startup=null,bool? DataInitialized=null,string[]? Warnings=null,string? InstallerRevision=null,string? ManagerSha256=null,int? ManagerProtocol=null);
public sealed record InstallDefaults(string Edition,string[] Characters,string InitialCharacter);
public sealed record InstallJournal(string Id,string Phase,string ManifestHash,InstallOptions Options,string? PreviousPointer,string? PreviousInstallation,string Build,string Runtime,string[] RootFiles,string[] PreviouslyExistingRootFiles,string? AppVersion=null,string? ProfileAction=null,string? ExpectedDataPath=null,string? InstallerRevision=null,bool StartupAttempted=false,string? AppSelection=null);
public sealed record PreparedUpdate(string TransactionId,long DownloadBytes,long InstallBytes);
public sealed record DiskEstimate(long DownloadBytes,long ExpandedBytes,long CacheAdditionalBytes,long InstallAdditionalBytes,long RetainedBytes);
public sealed class IncompatibleRollbackException(string message):IOException(message);
public interface IAppHost {
    StartupStatus? LastStartup=>null;
    Task<string?> DiscoverDataPath(string root,string? pipe,CancellationToken cancel)=>Task.FromResult<string?>(null);
    Task Stop(string root,Installation? previous,IProgress<InstallProgress>? progress,CancellationToken cancel);
    Task ReportUpdateLockBusy(string root,IProgress<InstallProgress>? progress,CancellationToken cancel) {
        progress?.Report(new("waiting-safe-point","",Reasons:["storage"]));
        return Task.CompletedTask;
    }
    Task StartAndVerify(string root,Installation installed,CancellationToken cancel);
    Task StartFreshAndVerify(string root,Installation installed,CancellationToken cancel)=>StartAndVerify(root,installed,cancel);
    Task StartInstalledAndVerify(string root,Installation installed,bool initialize,CancellationToken cancel)=>initialize?StartFreshAndVerify(root,installed,cancel):StartAndVerify(root,installed,cancel);
    Task StartImportedAndVerify(string root,Installation installed,string importId,CancellationToken cancel)=>StartAndVerify(root,installed,cancel);
    Task CreateShortcuts(string root,Installation installed,CancellationToken cancel);
    Task RemoveShortcuts(string root,CancellationToken cancel);
}
public sealed class InstallEngine(InstallManifest manifest,byte[] manifestBytes,string manifestHash,Downloader downloader,IAppHost host,string selfExe,Func<Package,Uri>? source=null,Action<string>? checkpoint=null,Func<string,CancellationToken,Task<string>>? profileHash=null) {
    readonly InstallManifest m=manifest;
    readonly Func<string,CancellationToken,Task<string>> hashProfileFile=profileHash??Hashing.FileHash;
    public static string RecordPath(string root)=>SafePaths.Under(root,"local/installation.json");
    static string PointerPath(string root)=>SafePaths.Under(root,"local/current-build.json");
    public static Installation? Existing(string root)=>DataPaths.Effective(root);
    public static InstallDefaults Defaults(string root,InstallManifest manifest){
        var existing=Existing(root);var edition=existing?.Edition??manifest.DefaultEdition;
        string? build=null;
        // Local candidate installs may advance the pointer while retaining an older manager record.
        if(File.Exists(PointerPath(root))){using var pointer=JsonDocument.Parse(File.ReadAllBytes(PointerPath(root)));if(pointer.RootElement.TryGetProperty("path",out var path)&&path.ValueKind==JsonValueKind.String&&Directory.Exists(SafePaths.Under(root,path.GetString()!))){build=SafePaths.Under(root,path.GetString()!);if(pointer.RootElement.TryGetProperty("animationProfile",out var profile)&&profile.GetString() is "30fps" or "60fps")edition=profile.GetString()!;}}
        var characters=existing?.Characters??manifest.Characters.Select(c=>c.Id).ToArray();
        // Portable packages have no manager record. Keep their actual resource selection,
        // including a partly damaged character so repair restores it instead of omitting it.
        string? portableInitial=null;
        if(existing is null&&build is not null&&File.Exists(Path.Combine(build,"assets/install-resource-index.json"))){
            using var index=JsonDocument.Parse(File.ReadAllBytes(Path.Combine(build,"assets/install-resource-index.json")));
            var value=index.RootElement;
            if(value.TryGetProperty("edition",out var ie)&&ie.GetString() is "30fps" or "60fps")edition=ie.GetString()!;
            if(value.TryGetProperty("characters",out var roles)&&roles.ValueKind==JsonValueKind.Object){
                var present=manifest.Characters.Where(c=>roles.TryGetProperty(c.Id,out var files)&&files.ValueKind==JsonValueKind.Array&&files.EnumerateArray().Any(f=>f.TryGetProperty("path",out var fp)&&fp.ValueKind==JsonValueKind.String&&File.Exists(SafePaths.Under(build,fp.GetString()!)))).Select(c=>c.Id).ToArray();
                if(present.Length>0)characters=present;
            }
            if(value.TryGetProperty("defaultCharacter",out var initialId)&&initialId.ValueKind==JsonValueKind.String)portableInitial=initialId.GetString();
        }
        if(characters.Any(id=>!manifest.Characters.Any(c=>c.Id==id)))throw new InvalidDataException("Existing installation lists an unknown resource character; keep the current installation and inspect its record");
        var initial=existing is not null&&characters.Contains(existing.InitialCharacter)?existing.InitialCharacter:portableInitial is not null&&characters.Contains(portableInitial)?portableInitial:characters.Contains(manifest.DefaultCharacterId)?manifest.DefaultCharacterId:characters.First();
        return new(edition,characters,initial);
    }
    public DiskEstimate Estimate(InstallOptions options) {
        var packages=Manifests.Select(m,options.Edition,options.Characters,options.InitialCharacter);
        long download=packages.Sum(p=>p.Bytes),expanded=packages.Sum(p=>p.UnpackedBytes);
        long missing=packages.Where(p=>!File.Exists(Path.Combine(options.Cache,p.Sha256+".zip"))||new FileInfo(Path.Combine(options.Cache,p.Sha256+".zip")).Length!=p.Bytes).Sum(p=>p.Bytes);
        long retained=0;var previous=Existing(options.Root);
        if(previous is not null)foreach(var dir in new[]{previous.Build,previous.Runtime}){var path=SafePaths.Under(options.Root,dir);if(Directory.Exists(path))retained+=Directory.EnumerateFiles(path,"*",SearchOption.AllDirectories).Sum(p=>new FileInfo(p).Length);}
        // Existing files remain until a validated new version has started. The stage becomes the final tree by rename.
        var rootBytes=packages.Where(p=>p.Mount=="root").Sum(p=>p.UnpackedBytes);
        var managerBytes=File.Exists(selfExe)?new FileInfo(selfExe).Length:64L*1024*1024;
        // Root files coexist in staging, the new root and the rollback backup until commit finishes.
        return new(download,expanded,options.OfflineDirectory is null?missing:0,expanded+2*rootBytes+managerBytes+manifestBytes.LongLength+16L*1024*1024,retained);
    }
    public async Task<Installation> Install(InstallOptions requested,IProgress<InstallProgress>? progress,CancellationToken cancel) =>
        (await InstallCore(requested,progress,cancel)).Installed!;
    public async Task<PreparedUpdate> PrepareUpdate(InstallOptions requested,string selectionId,IProgress<InstallProgress>? progress,CancellationToken cancel) =>
        (await InstallCore(requested,progress,cancel,selectionId)).Prepared!;
    public async Task<Installation> ApplyUpdate(InstallOptions requested,string selectionId,IProgress<InstallProgress>? progress,CancellationToken cancel) =>
        (await InstallCore(requested,progress,cancel,selectionId,true)).Installed!;

    async Task<(Installation? Installed,PreparedUpdate? Prepared)> InstallCore(InstallOptions requested,IProgress<InstallProgress>? progress,CancellationToken cancel,string? selectionId=null,bool applying=false) {
        var appUpdate=selectionId is not null;
        if(appUpdate&&!System.Text.RegularExpressions.Regex.IsMatch(selectionId!,@"\A[a-f0-9]{64}\z"))throw new InvalidDataException("Invalid application update selection");
        Manifests.Parse(manifestBytes,manifestHash);
        var root=SafePaths.Full(requested.Root).TrimEnd(Path.DirectorySeparatorChar);SafePaths.NoLinks(root);
        if(Path.GetPathRoot(root)==root+Path.DirectorySeparatorChar || root.Length<4)throw new IOException("Choose a dedicated application folder");
        Directory.CreateDirectory(root);
        var control=SafePaths.Under(root,"local/installer");Directory.CreateDirectory(control);
        await using var installationLock=await AcquireInstallLock(root,control,applying,progress,cancel);
        var journalPath=Path.Combine(control,"transaction.json");
        var retry=File.Exists(journalPath)?Json.Read<InstallJournal>(journalPath):null;
        if(retry is not null)ValidateJournal(retry,root);
        if(appUpdate&&retry?.Phase is "committing" or "recovery-required")throw new IOException("Use the installation manager to recover the interrupted installation first");
        if(!appUpdate)await Recover(root,journalPath,progress,cancel);
        var previous=Existing(root);
        if(appUpdate&&(previous is null||!File.Exists(PointerPath(root))))throw new IOException("Application updates require an existing managed installation");
        var discovered=previous is null&&File.Exists(PointerPath(root))?await host.DiscoverDataPath(root,requested.Pipe,cancel):null;
        var profile=await InstallProfile.SelectAsync(root,requested,previous,discovered,retry,File.Exists(PointerPath(root)),hashProfileFile,cancel);
        cancel.ThrowIfCancellationRequested();
        if(appUpdate&&profile.Action!="preserve")throw new InvalidDataException("Application updates require a preserved profile");
        var options=requested with {Root=root,DataPath=profile.DataPath,Pipe=profile.Pipe};
        var packages=Manifests.Select(m,options.Edition,options.Characters,options.InitialCharacter);
        Dictionary<string,string>? offline=null;
        if(options.OfflineDirectory is {} folder) {
            SafePaths.NoLinks(folder);
            var supplied=SafePaths.Under(folder,ReleaseIdentity.ManifestFileName);
            Manifests.Parse(await File.ReadAllBytesAsync(supplied,cancel),manifestHash);
            var missing=packages.Where(p=>!File.Exists(SafePaths.Under(folder,p.AssetName))).Select(p=>p.AssetName).ToArray();
            if(missing.Length>0)throw new FileNotFoundException("Offline packages missing:\n"+string.Join("\n",missing));
            offline=packages.ToDictionary(p=>p.Id,p=>SafePaths.Under(folder,p.AssetName));
        }
        var estimate=Estimate(options);
        InstallJournal? journal=File.Exists(journalPath)?Json.Read<InstallJournal>(journalPath):null;
        var currentPointer=File.Exists(PointerPath(root))?await File.ReadAllTextAsync(PointerPath(root),cancel):null;
        var currentRecord=File.Exists(RecordPath(root))?await File.ReadAllTextAsync(RecordPath(root),cancel):null;
        var stageMatches=journal is not null&&journal.PreviousPointer==currentPointer&&journal.ManifestHash==manifestHash&&journal.Options.Edition==options.Edition&&journal.Options.Characters.SequenceEqual(options.Characters)&&journal.Options.InitialCharacter==options.InitialCharacter&&journal.Options.DataPath==options.DataPath&&journal.Options.Pipe==options.Pipe&&journal.ProfileAction==profile.Action&&journal.ExpectedDataPath==profile.ExpectedDataPath&&journal.AppSelection==selectionId&&(!appUpdate||journal.PreviousInstallation==currentRecord);
        if(applying&&(!stageMatches||journal?.Phase!="prepared"))throw new InvalidDataException("Application update preparation is stale or missing");
        if(!stageMatches || journal!.Phase!="staging" && (!appUpdate||journal.Phase!="prepared")) {
            var id=Guid.NewGuid().ToString("N");
            var rootFiles=packages.Where(p=>p.Mount=="root").SelectMany(p=>p.Files.Select(f=>f.Path)).ToArray();
            journal=new(id,"staging",manifestHash,options,currentPointer,currentRecord,
                $"builds/v{m.AppVersion}-{options.Edition}-{id}",$"runtime/AI-Buddy-v{m.AppVersion}-{id}",rootFiles,rootFiles.Where(f=>File.Exists(SafePaths.Under(root,f))).ToArray(),m.AppVersion,profile.Action,profile.ExpectedDataPath,ReleaseIdentity.InstallerRevision,AppSelection:selectionId);
            Json.Save(journalPath,journal);
        }
        var stage=SafePaths.Under(root,".install-staging/"+journal!.Id);
        if(applying) {
            CheckSpace(root,options.Cache,estimate with{CacheAdditionalBytes=0,InstallAdditionalBytes=estimate.InstallAdditionalBytes-estimate.ExpandedBytes});
        } else {
            if(appUpdate)progress?.Report(new("preparing",""));
            var remaining=new List<Package>();
            var reusable=new Dictionary<string,string>();
            foreach(var package in packages) {
                if(appUpdate&&await PackageMatches(package,SafePaths.Under(stage,package.Mount),cancel))continue;
                if(appUpdate&&previous!.PackageHashes.TryGetValue(package.Id,out var oldHash)&&oldHash==package.Sha256) {
                    var original=package.Mount switch{"root"=>root,"runtime"=>SafePaths.Under(root,previous.Runtime),_=>SafePaths.Under(root,previous.Build)};
                    if(await PackageMatches(package,original,cancel)){reusable.Add(package.Id,original);continue;}
                }
                remaining.Add(package);
            }
            var downloadBytes=estimate.CacheAdditionalBytes;
            if(appUpdate) {
                downloadBytes=0;
                if(offline is null)foreach(var p in remaining)
                    if(!await Hashing.Matches(SafePaths.Under(options.Cache,p.Sha256+".zip"),p.Bytes,p.Sha256,cancel))downloadBytes+=p.Bytes;
                estimate=estimate with{CacheAdditionalBytes=downloadBytes};
                progress?.Report(new("estimate","",downloadBytes,estimate.InstallAdditionalBytes));
            }
            CheckSpace(root,options.Cache,estimate);
            Directory.CreateDirectory(stage);
            foreach(var package in packages.Where(p=>reusable.ContainsKey(p.Id))) {
                var original=reusable[package.Id];
                foreach(var file in package.Files) {
                    cancel.ThrowIfCancellationRequested();
                    var target=SafePaths.Under(stage,package.Mount+"/"+file.Path);
                    Directory.CreateDirectory(Path.GetDirectoryName(target)!);
                    ReplaceProgramFile(SafePaths.Under(original,file.Path),target);
                }
            }
            var downloads=new System.Collections.Concurrent.ConcurrentDictionary<string,string>();
            if(offline is not null)foreach(var item in offline)downloads[item.Key]=item.Value;
            else await Parallel.ForEachAsync(remaining,new ParallelOptions{MaxDegreeOfParallelism=2,CancellationToken=cancel},async(p,ct)=>downloads[p.Id]=await downloader.Get(p,m.ReleaseTag,source?.Invoke(p)??Manifests.Url(m,p.AssetName),options.Cache,progress,ct));
            foreach(var p in remaining){cancel.ThrowIfCancellationRequested();await Extractor.Extract(p,downloads[p.Id],SafePaths.Under(stage,p.Mount),progress,cancel);}
            checkpoint?.Invoke("extracted");
        }
        // Recheck the assembled tree after extraction and before applying a saved preparation.
        foreach(var p in packages)if(!await PackageMatches(p,SafePaths.Under(stage,p.Mount),cancel))throw new InvalidDataException("Assembled package mismatch: "+p.Id);
        if(appUpdate&&!applying) {
            await profile.VerifyAsync(hashProfileFile,cancel);
            cancel.ThrowIfCancellationRequested();
            journal=journal with{Phase="prepared"};
            Json.Save(journalPath,journal);
            return (null,new(journal.Id,estimate.CacheAdditionalBytes,estimate.InstallAdditionalBytes));
        }
        var managerRelative=$"maintenance/{m.AppVersion}/AI Buddy Setup.exe";
        var installed=new Installation(1,m.AppVersion,manifestHash,options.Edition,options.Characters,options.InitialCharacter,journal.Build,journal.Runtime,managerRelative,options.DataPath,options.Pipe,DateTimeOffset.UtcNow,packages.ToDictionary(p=>p.Id,p=>p.Sha256),DataInitialized:previous?.DataInitialized,InstallerRevision:ReleaseIdentity.InstallerRevision,ManagerSha256:await Hashing.FileHash(selfExe,cancel),ManagerProtocol:1);
        // Root launcher updates are journaled separately from immutable version trees.
        var backup=SafePaths.Under(control,"backups/"+journal.Id);Directory.CreateDirectory(backup);
        foreach(var f in journal.PreviouslyExistingRootFiles){var target=SafePaths.Under(backup,f);Directory.CreateDirectory(Path.GetDirectoryName(target)!);File.Copy(SafePaths.Under(root,f),target,true);}
        if((File.Exists(PointerPath(root))?await File.ReadAllTextAsync(PointerPath(root),cancel):null)!=journal.PreviousPointer)throw new IOException("Launch pointer changed during download; retry against the new current version");
        var selected=Existing(root);
        if(previous is not null&&(selected is null||!InstallProfile.SamePath(DataPaths.Registered(root,selected.DataPath,false),profile.ExpectedDataPath)||InstallProfile.NormalizedPipe(selected.Pipe)!=InstallProfile.NormalizedPipe(profile.Pipe)))throw new IOException("Personal-data selection changed during download; retry against the current profile");
        await profile.VerifyAsync(hashProfileFile,cancel);
        cancel.ThrowIfCancellationRequested();
        await host.Stop(root,previous??installed,progress,cancel);
        if(applying)cancel=CancellationToken.None;
        cancel.ThrowIfCancellationRequested();
        await profile.VerifyAsync(hashProfileFile,cancel);
        cancel.ThrowIfCancellationRequested();
        journal=journal with {Phase="committing"};Json.Save(journalPath,journal);
        try {
            foreach(var (mount,target) in new[]{("build",journal.Build),("runtime",journal.Runtime)}) {
                var destination=SafePaths.Under(root,target);Directory.CreateDirectory(Path.GetDirectoryName(destination)!);
                await RetryLocal(()=>Directory.Move(SafePaths.Under(stage,mount),destination),cancel);
            }
            foreach(var f in journal.RootFiles){var target=SafePaths.Under(root,f);Directory.CreateDirectory(Path.GetDirectoryName(target)!);await RetryLocal(()=>ReplaceProgramFile(SafePaths.Under(stage,"root/"+f),target),cancel);}
            checkpoint?.Invoke("root-files");
            var manager=SafePaths.Under(root,managerRelative);Directory.CreateDirectory(Path.GetDirectoryName(manager)!);
            if(!string.Equals(Path.GetFullPath(selfExe),manager,StringComparison.OrdinalIgnoreCase))ReplaceProgramFile(selfExe,manager);
            var savedManifest=SafePaths.Under(root,"local/install-manifests/"+manifestHash+".json");Directory.CreateDirectory(Path.GetDirectoryName(savedManifest)!);await File.WriteAllBytesAsync(savedManifest,manifestBytes,cancel);
            Json.Save(RecordPath(root),installed);
            Json.Save(PointerPath(root),new {version=m.AppVersion,appVersion=m.AppVersion,path=journal.Build,runtime=new{path=journal.Runtime,executable=m.Runtime.Executable,sha256=m.Runtime.Sha256},animationProfile=options.Edition,installedAt=installed.InstalledAt});
            checkpoint?.Invoke("pointer");
            journal=journal with {StartupAttempted=true};Json.Save(journalPath,journal);
            if(applying)progress?.Report(new("verifying",""));
            await host.StartInstalledAndVerify(root,installed,profile.Action=="initialize",cancel);
            if(host.LastStartup is { } startup&&(startup.Onboarding||startup.SafeMode||startup.StartupFailure is not null))throw new IOException("AI Buddy did not start normally; welcome, safe mode or startup failure cannot complete installation");
            var confirmed=Json.Read<Installation>(RecordPath(root));
            if(confirmed.SchemaVersion!=installed.SchemaVersion||confirmed.Version!=installed.Version||confirmed.Build!=installed.Build||confirmed.ManifestSha256!=installed.ManifestSha256||confirmed.DataPath!=installed.DataPath||confirmed.Pipe!=installed.Pipe||confirmed.Runtime!=installed.Runtime||confirmed.Manager!=installed.Manager||confirmed.ManagerSha256!=installed.ManagerSha256||confirmed.ManagerProtocol!=installed.ManagerProtocol||confirmed.Edition!=installed.Edition||!confirmed.Characters.SequenceEqual(installed.Characters))throw new IOException("Installation identity changed during startup; the newer record will not be overwritten");
            // The app confirms real business initialization before reporting ready.
            // Keep that confirmation instead of restoring this older in-memory flag.
            // Stopping a "don't launch" install happens after the commit below.
            installed=installed with {Startup=host.LastStartup,DataInitialized=confirmed.DataInitialized??installed.DataInitialized};Json.Save(RecordPath(root),installed);
            checkpoint?.Invoke("launched");
            // The new version started and was verified: the transaction is committed here.
            journal=journal with {Phase="complete"};Json.Save(journalPath,journal);
            if(journal.PreviousPointer is not null)Json.Save(Path.Combine(control,"rollback.json"),journal);
        } catch(Exception failure) {
            try {journal=await RollbackJournal(root,journal,progress,CancellationToken.None);Json.Save(journalPath,journal with {Phase="rolled-back"});}
            catch(IncompatibleRollbackException compatibility) {
                var receipt=RetainForCompatibleRepair(root,journal,failure,compatibility,progress);
                throw new IOException("AI Buddy did not finish installation. "+compatibility.Message+" Run this installer again for compatible repair. / 安装未完成，请重运行本安装器修复。 Recovery receipt: "+receipt,new AggregateException(failure,compatibility));
            }
            throw;
        }
        // After commit nothing is rolled back. A failed stop or shortcut is reported as a
        // warning; it must not stop or replace a program that already started correctly.
        var warnings=new List<string>();
        async Task AfterCommit(string step,Func<Task> action){try{await action();}catch(Exception ex){warnings.Add(step+": "+ex.Message);progress?.Report(new("warning",step,Detail:ex.Message));}}
        if(!options.Launch)await AfterCommit("stop",()=>host.Stop(root,installed,progress,CancellationToken.None));
        if(options.Shortcuts)await AfterCommit("shortcuts",()=>host.CreateShortcuts(root,installed,CancellationToken.None));
        // Cleanup never fails a committed install; anything left is reported.
        try{var data=PersonalDataProtection.Read(root,journal,installed);data.RemoveTree(stage,root,progress);RemoveVersions(root,KeptVersions(root,journal),progress,data);if(!options.KeepCache)CleanCache(options.Cache,progress,data);}
        catch(Exception ex){progress?.Report(new("cleanup-pending",root,Detail:ex.Message));}
        if(warnings.Count>0){installed=installed with{Warnings=warnings.ToArray()};Json.Save(RecordPath(root),installed);}
        progress?.Report(new("complete",m.AppVersion));return (installed,null);
    }
    async Task<FileStream> AcquireInstallLock(string root,string control,bool wait,IProgress<InstallProgress>? progress,CancellationToken cancel) {
        var path=Path.Combine(control,"install.lock");
        var deadline=DateTime.UtcNow.AddMinutes(10);
        while(true) {
            cancel.ThrowIfCancellationRequested();
            try {return new(path,FileMode.OpenOrCreate,FileAccess.ReadWrite,FileShare.None);}
            catch(IOException error)when(wait&&(error.HResult&0xffff) is 32 or 33) {
                if(DateTime.UtcNow>=deadline)throw new IOException("The application remained busy waiting for the installation lock",error);
                await host.ReportUpdateLockBusy(root,progress,cancel);
                await Task.Delay(1000,cancel);
            }
        }
    }
    static async Task<bool> PackageMatches(Package package,string directory,CancellationToken cancel) {
        foreach(var file in package.Files)
            if(!await Hashing.Matches(SafePaths.Under(directory,file.Path),file.Bytes,file.Sha256,cancel))return false;
        return true;
    }
    // Version trees this installer created carry the transaction id in their name.
    static readonly System.Text.RegularExpressions.Regex OwnedBuild=new(@"\Av(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)-(?:30fps|60fps)-[a-f0-9]{32}\z"),
        OwnedRuntime=new(@"\AAI-Buddy-v(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)-[a-f0-9]{32}\z"),
        OwnedStage=new(@"\A[a-f0-9]{32}\z"),
        CacheFile=new(@"\A[a-f0-9]{64}\.zip(?:\.partial(?:\.json)?|\.lock)?\z");
    static string Relative(string path)=>path.Replace('\\','/').Trim('/');
    // The current version, its rollback target, and every tree a recovery receipt names.
    // Null means a receipt could not be read: then nothing is removed.
    static HashSet<string>? KeptVersions(string root,InstallJournal journal){
        var keep=new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        void Pointer(string? text){if(text is null)return;using var d=JsonDocument.Parse(text);var r=d.RootElement;if(r.TryGetProperty("path",out var p)&&p.ValueKind==JsonValueKind.String)Add(p.GetString());if(r.TryGetProperty("runtime",out var rt)&&rt.ValueKind==JsonValueKind.Object&&rt.TryGetProperty("path",out var rp)&&rp.ValueKind==JsonValueKind.String)Add(rp.GetString());}
        void Add(string? path){if(!string.IsNullOrWhiteSpace(path))keep.Add(Relative(path));}
        void Record(string? text){if(text is null)return;var i=JsonSerializer.Deserialize<Installation>(text,Json.Options);Add(i?.Build);Add(i?.Runtime);}
        void Journal(InstallJournal j){Add(j.Build);Add(j.Runtime);Pointer(j.PreviousPointer);Record(j.PreviousInstallation);}
        try{
            Journal(journal);
            var receipts=SafePaths.Under(root,"local/installer/recovery-required");
            if(Directory.Exists(receipts))foreach(var file in Directory.EnumerateFiles(receipts,"*.json")){using var d=JsonDocument.Parse(File.ReadAllBytes(file));if(d.RootElement.TryGetProperty("journal",out var j)&&j.Deserialize<InstallJournal>(Json.Options) is {} r)Journal(r);}
        }catch(Exception){return null;}
        return keep;
    }
    // Removes installer-created version trees except those kept, and abandoned staging.
    // Folders without a transaction id (portable packages, manual copies) are never touched.
    static void RemoveVersions(string root,HashSet<string>? keep,IProgress<InstallProgress>? progress,PersonalDataProtection data){
        if(keep is null){progress?.Report(new("cleanup-pending","versions",Detail:"A recovery receipt could not be read; older versions were kept"));return;}
        foreach(var (folder,pattern) in new[]{("builds",OwnedBuild),("runtime",OwnedRuntime),(".install-staging",OwnedStage)}){
            var parent=SafePaths.Under(root,folder);if(!Directory.Exists(parent))continue;
            foreach(var directory in Directory.EnumerateDirectories(parent)){
                var relative=folder+"/"+Path.GetFileName(directory);if(!pattern.IsMatch(Path.GetFileName(directory))||keep.Contains(relative))continue;
                try{var path=SafePaths.Under(root,relative);if(!data.Allows(path,progress))continue;SafePaths.RemoveOwnedTree(path,root);progress?.Report(new("pruned",relative));}
                catch(Exception ex) when(ex is IOException or UnauthorizedAccessException){progress?.Report(new("cleanup-pending",relative,Detail:ex.Message));}
            }
        }
    }
    // Downloaded packages are only needed until the new version is in place. Only names this
    // installer writes (<sha256>.zip and its .partial, .partial.json and .lock files) are removed.
    static void CleanCache(string cache,IProgress<InstallProgress>? progress,PersonalDataProtection data){
        if(!Directory.Exists(cache))return;
        foreach(var file in Directory.EnumerateFiles(cache)){
            if(!CacheFile.IsMatch(Path.GetFileName(file)))continue;
            try{if(data.Allows(file,progress))File.Delete(file);}catch(Exception ex) when(ex is IOException or UnauthorizedAccessException){progress?.Report(new("cleanup-pending",file,Detail:ex.Message));}
        }
    }
    // Why "roll back" cannot run now, or null when it can. Reads files only.
    public async Task<string?> RollbackBlocker(string root,CancellationToken cancel){
        const string none="No previous version is available / 没有可回退的上一版";
        try{
            root=SafePaths.Full(root);var path=SafePaths.Under(root,"local/installer/rollback.json");if(!File.Exists(path))return none;
            var journal=Json.Read<InstallJournal>(path);if(journal.PreviousPointer is null)return none;ValidateJournal(journal);
            using(var pointer=JsonDocument.Parse(journal.PreviousPointer))if(!pointer.RootElement.TryGetProperty("path",out var p)||p.ValueKind!=JsonValueKind.String||!Directory.Exists(SafePaths.Under(root,p.GetString()!)))return "The previous program files are no longer present / 上一版程序文件已不存在";
            await GuardDowngrade(root,journal,cancel);return null;
        }catch(IncompatibleRollbackException ex){return ex.Message;}
        catch(Exception ex) when(ex is IOException or InvalidDataException or JsonException or UnauthorizedAccessException){return ex.Message;}
    }
    static async Task RetryLocal(Action action,CancellationToken cancel){
        // Antivirus/indexer handles can briefly prevent a freshly extracted EXE directory rename.
        // Retry only sharing/access errors, with a strict bound; never terminate another process.
        for(int n=0;;n++){cancel.ThrowIfCancellationRequested();try{action();return;}catch(Exception ex) when(n<24 && ex is IOException or UnauthorizedAccessException && (ex.HResult&0xffff) is 5 or 32 or 33){await Task.Delay(500,cancel);}}
    }
    static void CheckSpace(string root,string cache,DiskEstimate estimate) {
        Directory.CreateDirectory(cache);SafePaths.NoLinks(cache);
        var installDrive=new DriveInfo(Path.GetPathRoot(root)!);var cacheDrive=new DriveInfo(Path.GetPathRoot(Path.GetFullPath(cache))!);
        var same=string.Equals(installDrive.Name,cacheDrive.Name,StringComparison.OrdinalIgnoreCase);
        ValidateSpace(estimate,installDrive.AvailableFreeSpace,cacheDrive.AvailableFreeSpace,same);
        // Fail early for read-only folders, before a potentially large download.
        var probe=Path.Combine(root,".write-probe-"+Guid.NewGuid().ToString("N"));using(File.Create(probe)){}File.Delete(probe);
    }
    public static void ValidateSpace(DiskEstimate estimate,long installFree,long cacheFree,bool sameDrive){if(installFree<estimate.InstallAdditionalBytes+(sameDrive?estimate.CacheAdditionalBytes:0)||!sameDrive&&cacheFree<estimate.CacheAdditionalBytes)throw new IOException("Insufficient disk space for download, staging and the retained version");}
    async Task Recover(string root,string path,IProgress<InstallProgress>? progress,CancellationToken cancel) {
        if(!File.Exists(path))return;var journal=Json.Read<InstallJournal>(path);
        ValidateJournal(journal,root);
        if(journal.Phase=="recovery-required"){progress?.Report(new("recovery-required",journal.Id,Detail:"Compatible repair will preserve the retained personal data and program backups"));return;}
        if(journal.Phase=="committing"){
            try{journal=await RollbackJournal(root,journal,progress,cancel);Json.Save(path,journal with{Phase="rolled-back"});}
            catch(IncompatibleRollbackException compatibility){RetainForCompatibleRepair(root,journal,new IOException("Interrupted committing transaction discovered during recovery"),compatibility,progress);}
        }
    }
    string RetainForCompatibleRepair(string root,InstallJournal journal,Exception failure,IncompatibleRollbackException compatibility,IProgress<InstallProgress>? progress){
        var control=SafePaths.Under(root,"local/installer");journal=journal with{Phase="recovery-required"};Json.Save(Path.Combine(control,"transaction.json"),journal);
        var receipt=SafePaths.Under(control,"recovery-required/"+journal.Id+".json");
        Json.Save(receipt,new{installerRevision=ReleaseIdentity.InstallerRevision,phase=journal.Phase,journal,failedAt=DateTimeOffset.UtcNow,failure=failure.ToString(),compatibility=compatibility.Message,personalDataRetained=true,previousProgramRetained=true,compatibleRepairVersion=m.AppVersion});
        progress?.Report(new("recovery-required",receipt,Detail:$"Personal data and program backups retained; run this AI Buddy {m.AppVersion} installer again for compatible repair"));return receipt;
    }
    async Task<InstallJournal> RollbackJournal(string root,InstallJournal journal,IProgress<InstallProgress>? progress,CancellationToken cancel) {
        ValidateJournal(journal,root);
        var data=PersonalDataProtection.Read(root,journal);
        await host.Stop(root,Existing(root),progress,cancel);
        // Initialization may finish before readiness or before a power loss. Once
        // real data exists, every later retry must preserve that same profile.
        if(journal.ProfileAction=="initialize"&&journal.ExpectedDataPath is {} expected&&await InstallProfile.RecognizedAsync(expected,hashProfileFile,cancel)){
            cancel.ThrowIfCancellationRequested();
            journal=journal with{ProfileAction="preserve"};Json.Save(SafePaths.Under(root,"local/installer/transaction.json"),journal);
        }
        await GuardDowngrade(root,journal,cancel);
        cancel.ThrowIfCancellationRequested();
        var backup=SafePaths.Under(root,"local/installer/backups/"+journal.Id);
        foreach(var f in journal.RootFiles){var target=SafePaths.Under(root,f);if(!data.Allows(target,progress))continue;if(journal.PreviouslyExistingRootFiles.Contains(f)){Directory.CreateDirectory(Path.GetDirectoryName(target)!);ReplaceProgramFile(SafePaths.Under(backup,f),target);}else if(File.Exists(target))File.Delete(target);}
        var selectedData=Existing(root)?.DataPath;var selectedPipe=Existing(root)?.Pipe;var initialized=Existing(root)?.DataInitialized;
        RestoreText(PointerPath(root),journal.PreviousPointer);RestoreText(RecordPath(root),journal.PreviousInstallation);
        // Program rollback must not undo a later, independently selected save.
        if(File.Exists(RecordPath(root))){var restored=Json.Read<Installation>(RecordPath(root));Json.Save(RecordPath(root),restored with{DataPath=selectedData,Pipe=selectedPipe,DataInitialized=initialized});}
        // These uniquely named directories belong only to this failed transaction.
        foreach(var path in new[]{journal.Build,journal.Runtime,".install-staging/"+journal.Id}) {
            try{data.RemoveTree(SafePaths.Under(root,path),root,progress);}catch(IOException ex){progress?.Report(new("cleanup-pending",path,Detail:ex.Message));}
        }
        progress?.Report(new("rolled-back",journal.Id,Detail:"Program restored; personal data was not replaced"));
        return journal;
    }
    static void RestoreText(string path,string? value){if(value is null){if(File.Exists(path))File.Delete(path);}else{using var document=JsonDocument.Parse(value);Json.Save(path,document.RootElement);}}
    static void ValidateJournal(InstallJournal journal,string? root=null){
        // Old 1.8.0 journals did not store AppVersion. Only their exact owned layout is accepted.
        var version=journal.AppVersion??"1.8.0";
        if(!ReleaseIdentity.KnownTransactionVersion(version) || !System.Text.RegularExpressions.Regex.IsMatch(journal.Id,"^[a-f0-9]{32}$") || journal.Options.Edition is not ("30fps" or "60fps") || journal.Build!=$"builds/v{version}-{journal.Options.Edition}-{journal.Id}" || journal.Runtime!=$"runtime/AI-Buddy-v{version}-{journal.Id}" || journal.RootFiles.Any(p=>!Manifests.RootFileAllowed(p)) || journal.PreviouslyExistingRootFiles.Except(journal.RootFiles).Any())throw new InvalidDataException("Invalid transaction ownership; no recovery files were changed");
        var active=journal.Phase is "staging" or "prepared" or "committing" or "recovery-required"||journal.Phase=="rolled-back"&&journal.PreviousPointer is null&&journal.PreviousInstallation is null;
        if(journal.ProfileAction is not null||journal.ExpectedDataPath is not null){if(journal.ProfileAction is not ("initialize" or "preserve")||journal.ExpectedDataPath is null||!Path.IsPathFullyQualified(journal.ExpectedDataPath)||root is not null&&active&&!InstallProfile.SamePath(journal.ExpectedDataPath,DataPaths.Registered(root,journal.Options.DataPath,false)))throw new InvalidDataException("Invalid transaction profile binding; no recovery files were changed");}
    }
    static void ReplaceProgramFile(string source,string target){
        // Replace the directory entry, never mutate an existing hard-linked historical file.
        var temporary=target+"."+Guid.NewGuid().ToString("N")+".tmp";
        try {File.Copy(source,temporary,false);File.Move(temporary,target,true);}
        finally {if(File.Exists(temporary))File.Delete(temporary);}
    }
    static async Task GuardDowngrade(string root,InstallJournal journal,CancellationToken cancel){
        if(journal.PreviousPointer is null)return;
        using var previous=JsonDocument.Parse(journal.PreviousPointer);
        var p=previous.RootElement;var version=p.TryGetProperty("appVersion",out var av)?av.GetString():p.TryGetProperty("version",out var v)?v.GetString():null;
        var previousVersion=System.Version.TryParse(version,out var parsed)?parsed:null;
        var installed=Existing(root);
        var data=DataPaths.Registered(root,installed is null?journal.Options.DataPath:installed.DataPath);
        var walletVersion=new System.Version(2,0,4);
        if((previousVersion is null||previousVersion<walletVersion)&&journal.StartupAttempted&&System.Version.TryParse(journal.AppVersion,out var attempted)&&attempted>=walletVersion){
            // Wallet migration can commit before startup reports readiness.
            var wallet=Path.Combine(data,"companion-economy-v1","economy.sqlite");
            SafePaths.NoLinks(wallet);
            if(File.Exists(wallet)||File.Exists(wallet+"-wal"))throw new IncompatibleRollbackException("The wallet may already use schema 2. Personal data and both program versions were retained. / 钱包可能已升级到格式 2，已保留资料和两版程序，请使用兼容版本。");
        }
        // Only 1.9.0 and later read 1.9 media and life data; older or unknown versions are checked.
        if(previousVersion is not null&&version is not null&&System.Text.RegularExpressions.Regex.IsMatch(version,@"\A(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\z")&&previousVersion>=new System.Version(1,9,0))return;
        SafePaths.NoLinks(data);
        var galgame=Path.Combine(data,"galgame");
        if(Directory.Exists(Path.Combine(galgame,"media"))&&Directory.EnumerateFiles(Path.Combine(galgame,"media")).Any() || Directory.Exists(Path.Combine(galgame,"life-archives"))&&Directory.EnumerateFiles(Path.Combine(galgame,"life-archives")).Any())throw new IncompatibleRollbackException("Rollback to this older program requires media/life compatibility review. Personal data was retained; no media-revert or maintenance apply was executed. / 旧版无法识别新媒体或人生数据；请先确认兼容与 media-revert planId，未修改个人数据。");
        var snapshots=Path.Combine(galgame,"companion.json.snapshots");var commits=Path.Combine(snapshots,"commits.jsonl");if(!File.Exists(commits))return;
        var lines=await File.ReadAllLinesAsync(commits,cancel);
        for(int n=lines.Length-1;n>=0;n--){
            JsonDocument commit;try{commit=JsonDocument.Parse(lines[n]);}catch(JsonException){continue;}
            using(commit){var c=commit.RootElement;if(!c.TryGetProperty("file",out var file)||!c.TryGetProperty("sha256",out var hash))continue;var name=file.GetString();if(name is null||Path.GetFileName(name)!=name)continue;var path=SafePaths.Under(snapshots,name);if(!File.Exists(path))continue;var bytes=await File.ReadAllBytesAsync(path,cancel);if(Hashing.Bytes(bytes)!=hash.GetString())continue;
                using var state=JsonDocument.Parse(bytes);if(System.Text.Encoding.UTF8.GetString(bytes).Contains("buddy-media://",StringComparison.Ordinal)||state.RootElement.TryGetProperty("lives",out var lives)&&lives.ValueKind==JsonValueKind.Object&&lives.EnumerateObject().Any())throw new IncompatibleRollbackException("Current companion data uses AI Buddy 1.9 memory/life/media features. Downgrade was stopped without replacing data; use a compatible 1.9 rollback build or review migration first. / 当前记忆、人生或媒体数据与旧版不兼容，已停止回退且保留数据。");return;
            }
        }
        if(lines.Any(line=>!string.IsNullOrWhiteSpace(line)))throw new IncompatibleRollbackException("Cannot verify companion data for a safe downgrade; program and personal data were retained");
    }
    public async Task Rollback(string root,IProgress<InstallProgress>? progress,CancellationToken cancel) {
        root=SafePaths.Full(root);var control=SafePaths.Under(root,"local/installer");
        await using var installationLock=new FileStream(Path.Combine(control,"install.lock"),FileMode.OpenOrCreate,FileAccess.ReadWrite,FileShare.None);
        var journal=Json.Read<InstallJournal>(Path.Combine(control,"rollback.json"));
        if(journal.PreviousPointer is null)throw new IOException("No previous version is available");
        journal=await RollbackJournal(root,journal,progress,cancel);Json.Save(Path.Combine(control,"transaction.json"),journal with{Phase="rolled-back"});
    }
    public async Task Uninstall(string root,bool deletePersonalData,IProgress<InstallProgress>? progress,CancellationToken cancel,string? cache=null) {
        root=SafePaths.Full(root);var installed=Existing(root)??throw new IOException("Installation record is missing");
        if(deletePersonalData&&installed.DataPath is not null)throw new IOException("Custom personal-data path is retained; remove it manually if intended");
        var control=SafePaths.Under(root,"local/installer");
        await using var installationLock=new FileStream(Path.Combine(control,"install.lock"),FileMode.OpenOrCreate,FileAccess.ReadWrite,FileShare.None);
        var data=PersonalDataProtection.Read(root,installed:installed);
        await host.Stop(root,installed,progress,cancel);await host.RemoveShortcuts(root,cancel);
        // Only indexed program files from this installation are removed. Unknown files are retained.
        var selected=Manifests.Select(m,installed.Edition,installed.Characters,installed.InitialCharacter);
        foreach(var p in selected)foreach(var f in p.Files) {
            var prefix=p.Mount=="root"?"":p.Mount=="build"?installed.Build+"/":installed.Runtime+"/";
            var path=SafePaths.Under(root,prefix+f.Path);if(data.Allows(path,progress)&&await Hashing.Matches(path,f.Bytes,f.Sha256,cancel))File.Delete(path);
        }
        // Older versions kept for rollback, abandoned staging and downloaded packages go too.
        RemoveVersions(root,new HashSet<string>(),progress,data);
        if(cache is not null)CleanCache(cache,progress,data);
        if(deletePersonalData) {
            // Custom data directories are not recursively deleted by this maintenance tool.
            if(installed.DataPath is not null)throw new IOException("Custom personal-data path is retained; remove it manually if intended");
            SafePaths.RemoveOwnedTree(SafePaths.Under(root,"local/data-v003"),root);
        }
        if(data.Allows(PointerPath(root),progress))File.Delete(PointerPath(root));Json.Save(Path.Combine(control,"uninstalled.json"),installed);if(data.Allows(RecordPath(root),progress))File.Delete(RecordPath(root));
        progress?.Report(new("uninstalled",root,Detail:deletePersonalData?"Default personal data removed":"Personal data retained"));
    }
}
