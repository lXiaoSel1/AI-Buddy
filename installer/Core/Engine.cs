using System.Text.Json;
namespace AiBuddy.Install;

public sealed record InstallOptions(string Root,string Cache,string Edition,string[] Characters,string InitialCharacter,string? OfflineDirectory=null,bool Shortcuts=true,bool Launch=true,string? DataPath=null,string? Pipe=null);
public sealed record StartupStatus(bool SafeMode,JsonElement? StartupFailure,bool Onboarding=false);
public sealed record Installation(int SchemaVersion,string Version,string ManifestSha256,string Edition,string[] Characters,string InitialCharacter,string Build,string Runtime,string Manager,string? DataPath,string? Pipe,DateTimeOffset InstalledAt,Dictionary<string,string> PackageHashes,StartupStatus? Startup=null,bool? DataInitialized=null);
public sealed record InstallDefaults(string Edition,string[] Characters,string InitialCharacter);
public sealed record InstallJournal(string Id,string Phase,string ManifestHash,InstallOptions Options,string? PreviousPointer,string? PreviousInstallation,string Build,string Runtime,string[] RootFiles,string[] PreviouslyExistingRootFiles,string? AppVersion=null);
public sealed record DiskEstimate(long DownloadBytes,long ExpandedBytes,long CacheAdditionalBytes,long InstallAdditionalBytes,long RetainedBytes);
public sealed class IncompatibleRollbackException(string message):IOException(message);
public interface IAppHost {
    StartupStatus? LastStartup=>null;
    Task<string?> DiscoverDataPath(string root,string? pipe,CancellationToken cancel)=>Task.FromResult<string?>(null);
    Task Stop(string root,Installation? previous,IProgress<InstallProgress>? progress,CancellationToken cancel);
    Task StartAndVerify(string root,Installation installed,CancellationToken cancel);
    Task StartImportedAndVerify(string root,Installation installed,string importId,CancellationToken cancel)=>StartAndVerify(root,installed,cancel);
    Task CreateShortcuts(string root,Installation installed,CancellationToken cancel);
    Task RemoveShortcuts(string root,CancellationToken cancel);
}
public sealed class InstallEngine(InstallManifest manifest,byte[] manifestBytes,string manifestHash,Downloader downloader,IAppHost host,string selfExe,Func<Package,Uri>? source=null,Action<string>? checkpoint=null) {
    readonly InstallManifest m=manifest;
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
    public async Task<Installation> Install(InstallOptions requested,IProgress<InstallProgress>? progress,CancellationToken cancel) {
        Manifests.Parse(manifestBytes,manifestHash);
        var root=SafePaths.Full(requested.Root).TrimEnd(Path.DirectorySeparatorChar);SafePaths.NoLinks(root);
        if(Path.GetPathRoot(root)==root+Path.DirectorySeparatorChar || root.Length<4)throw new IOException("Choose a dedicated application folder");
        Directory.CreateDirectory(root);
        var control=SafePaths.Under(root,"local/installer");Directory.CreateDirectory(control);
        await using var installationLock=new FileStream(Path.Combine(control,"install.lock"),FileMode.OpenOrCreate,FileAccess.ReadWrite,FileShare.None);
        var journalPath=Path.Combine(control,"transaction.json");
        await Recover(root,journalPath,progress,cancel);
        var previous=Existing(root);
        var discovered=previous is null&&File.Exists(PointerPath(root))?await host.DiscoverDataPath(root,requested.Pipe,cancel):null;
        var options=requested with {Root=root,DataPath=previous?.DataPath??discovered??requested.DataPath,Pipe=previous?.Pipe??requested.Pipe};
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
        var estimate=Estimate(options);CheckSpace(root,options.Cache,estimate);
        InstallJournal? journal=File.Exists(journalPath)?Json.Read<InstallJournal>(journalPath):null;
        var currentPointer=File.Exists(PointerPath(root))?await File.ReadAllTextAsync(PointerPath(root),cancel):null;
        if(journal is null || journal.Phase!="staging" || journal.PreviousPointer!=currentPointer || journal.ManifestHash!=manifestHash || journal.Options.Edition!=options.Edition || !journal.Options.Characters.SequenceEqual(options.Characters)) {
            var id=Guid.NewGuid().ToString("N");
            var rootFiles=packages.Where(p=>p.Mount=="root").SelectMany(p=>p.Files.Select(f=>f.Path)).ToArray();
            journal=new(id,"staging",manifestHash,options,File.Exists(PointerPath(root))?await File.ReadAllTextAsync(PointerPath(root),cancel):null,File.Exists(RecordPath(root))?await File.ReadAllTextAsync(RecordPath(root),cancel):null,
                $"builds/v{m.AppVersion}-{options.Edition}-{id}",$"runtime/AI-Buddy-v{m.AppVersion}-{id}",rootFiles,rootFiles.Where(f=>File.Exists(SafePaths.Under(root,f))).ToArray(),m.AppVersion);
            Json.Save(journalPath,journal);
        }
        var stage=SafePaths.Under(root,".install-staging/"+journal.Id);Directory.CreateDirectory(stage);
        var downloads=new System.Collections.Concurrent.ConcurrentDictionary<string,string>();
        if(offline is not null)foreach(var item in offline)downloads[item.Key]=item.Value;
        else await Parallel.ForEachAsync(packages,new ParallelOptions{MaxDegreeOfParallelism=2,CancellationToken=cancel},async(p,ct)=>downloads[p.Id]=await downloader.Get(p,m.ReleaseTag,source?.Invoke(p)??Manifests.Url(m,p.AssetName),options.Cache,progress,ct));
        foreach(var p in packages){cancel.ThrowIfCancellationRequested();await Extractor.Extract(p,downloads[p.Id],SafePaths.Under(stage,p.Mount),progress,cancel);}
        checkpoint?.Invoke("extracted");
        // Recheck the entire assembled tree, including files reused after an interrupted extraction.
        foreach(var p in packages)foreach(var f in p.Files)if(!await Hashing.Matches(SafePaths.Under(stage,p.Mount+"/"+f.Path),f.Bytes,f.Sha256,cancel))throw new InvalidDataException("Assembled file mismatch: "+f.Path);
        var managerRelative=$"maintenance/{m.AppVersion}/AI Buddy Setup.exe";
        var installed=new Installation(1,m.AppVersion,manifestHash,options.Edition,options.Characters,options.InitialCharacter,journal.Build,journal.Runtime,managerRelative,options.DataPath,options.Pipe,DateTimeOffset.UtcNow,packages.ToDictionary(p=>p.Id,p=>p.Sha256),DataInitialized:previous?.DataInitialized);
        // Root launcher updates are journaled separately from immutable version trees.
        var backup=SafePaths.Under(control,"backups/"+journal.Id);Directory.CreateDirectory(backup);
        foreach(var f in journal.PreviouslyExistingRootFiles){var target=SafePaths.Under(backup,f);Directory.CreateDirectory(Path.GetDirectoryName(target)!);File.Copy(SafePaths.Under(root,f),target,true);}
        if((File.Exists(PointerPath(root))?await File.ReadAllTextAsync(PointerPath(root),cancel):null)!=journal.PreviousPointer)throw new IOException("Launch pointer changed during download; retry against the new current version");
        await host.Stop(root,previous??installed,progress,cancel);cancel.ThrowIfCancellationRequested();
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
            // A first install's explicit custom folder is a creation request.
            // Never create a missing directory from a prior registered profile.
            if(previous is null&&requested.DataPath is not null&&options.DataPath==requested.DataPath)Directory.CreateDirectory(DataPaths.Registered(root,options.DataPath,false));
            await host.StartAndVerify(root,installed,cancel);
            var confirmed=Json.Read<Installation>(RecordPath(root));
            if(confirmed.SchemaVersion!=installed.SchemaVersion||confirmed.Version!=installed.Version||confirmed.Build!=installed.Build||confirmed.ManifestSha256!=installed.ManifestSha256||confirmed.DataPath!=installed.DataPath||confirmed.Pipe!=installed.Pipe||confirmed.Runtime!=installed.Runtime||confirmed.Manager!=installed.Manager||confirmed.Edition!=installed.Edition||!confirmed.Characters.SequenceEqual(installed.Characters))throw new IOException("Installation identity changed during startup; the newer record will not be overwritten");
            // The app confirms real business initialization before reporting ready.
            // Keep that confirmation instead of restoring this older in-memory flag.
            installed=installed with {Startup=host.LastStartup,DataInitialized=confirmed.DataInitialized??installed.DataInitialized};Json.Save(RecordPath(root),installed);
            if(!options.Launch)await host.Stop(root,installed,progress,cancel);
            checkpoint?.Invoke("launched");
            if(options.Shortcuts)await host.CreateShortcuts(root,installed,cancel);
            journal=journal with {Phase="complete"};Json.Save(journalPath,journal);
            if(journal.PreviousPointer is not null)Json.Save(Path.Combine(control,"rollback.json"),journal);
            try{SafePaths.RemoveOwnedTree(stage,root);}catch(IOException ex){progress?.Report(new("cleanup-pending",stage,Detail:ex.Message));}
            progress?.Report(new("complete",m.AppVersion));return installed;
        } catch(Exception failure) {
            try {await RollbackJournal(root,journal,progress,CancellationToken.None);Json.Save(journalPath,journal with {Phase="rolled-back"});}
            catch(IncompatibleRollbackException compatibility) {
                // A first 1.9 launch can create life/media data before reporting readiness.
                // Never put 1.8 back in charge of those saves. Keep both program trees and
                // record a compatible-repair state instead of repeatedly attempting downgrade.
                var receipt=RetainForCompatibleRepair(root,journal,failure,compatibility,progress);
                throw new IOException("AI Buddy did not finish installation. New life/media data prevents an automatic rollback to the older program. Personal data and both program versions were retained; run this 1.9 installer again for compatible repair. Recovery receipt: "+receipt+" / 安装未完成；新人生/媒体数据阻止自动降级，已保留数据及两版程序，请重运行 1.9 安装器修复。",new AggregateException(failure,compatibility));
            }
            throw;
        }
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
        ValidateJournal(journal);
        if(journal.Phase=="recovery-required"){progress?.Report(new("recovery-required",journal.Id,Detail:"Compatible repair will preserve the retained personal data and program backups"));return;}
        if(journal.Phase=="committing"){
            try{await RollbackJournal(root,journal,progress,cancel);Json.Save(path,journal with{Phase="rolled-back"});}
            catch(IncompatibleRollbackException compatibility){RetainForCompatibleRepair(root,journal,new IOException("Interrupted committing transaction discovered during recovery"),compatibility,progress);}
        }
    }
    string RetainForCompatibleRepair(string root,InstallJournal journal,Exception failure,IncompatibleRollbackException compatibility,IProgress<InstallProgress>? progress){
        var control=SafePaths.Under(root,"local/installer");journal=journal with{Phase="recovery-required"};Json.Save(Path.Combine(control,"transaction.json"),journal);
        var receipt=SafePaths.Under(control,"recovery-required/"+journal.Id+".json");
        Json.Save(receipt,new{phase=journal.Phase,journal,failedAt=DateTimeOffset.UtcNow,failure=failure.ToString(),compatibility=compatibility.Message,personalDataRetained=true,previousProgramRetained=true,compatibleRepairVersion=m.AppVersion});
        progress?.Report(new("recovery-required",receipt,Detail:"Personal data and program backups retained; run compatible AI Buddy 1.9 repair"));return receipt;
    }
    async Task RollbackJournal(string root,InstallJournal journal,IProgress<InstallProgress>? progress,CancellationToken cancel) {
        ValidateJournal(journal);
        await host.Stop(root,Existing(root),progress,cancel);
        await GuardDowngrade(root,journal,cancel);
        var backup=SafePaths.Under(root,"local/installer/backups/"+journal.Id);
        foreach(var f in journal.RootFiles){var target=SafePaths.Under(root,f);if(journal.PreviouslyExistingRootFiles.Contains(f)){Directory.CreateDirectory(Path.GetDirectoryName(target)!);ReplaceProgramFile(SafePaths.Under(backup,f),target);}else if(File.Exists(target))File.Delete(target);}
        var selectedData=Existing(root)?.DataPath;var selectedPipe=Existing(root)?.Pipe;var initialized=Existing(root)?.DataInitialized;
        RestoreText(PointerPath(root),journal.PreviousPointer);RestoreText(RecordPath(root),journal.PreviousInstallation);
        // Program rollback must not undo a later, independently selected save.
        if(File.Exists(RecordPath(root))){var restored=Json.Read<Installation>(RecordPath(root));Json.Save(RecordPath(root),restored with{DataPath=selectedData,Pipe=selectedPipe,DataInitialized=initialized});}
        // These uniquely named directories belong only to this failed transaction.
        foreach(var path in new[]{journal.Build,journal.Runtime,".install-staging/"+journal.Id}) {
            try{SafePaths.RemoveOwnedTree(SafePaths.Under(root,path),root);}catch(IOException ex){progress?.Report(new("cleanup-pending",path,Detail:ex.Message));}
        }
        progress?.Report(new("rolled-back",journal.Id,Detail:"Program restored; personal data was not replaced"));
    }
    static void RestoreText(string path,string? value){if(value is null){if(File.Exists(path))File.Delete(path);}else{using var document=JsonDocument.Parse(value);Json.Save(path,document.RootElement);}}
    static void ValidateJournal(InstallJournal journal){
        // Old 1.8.0 journals did not store AppVersion. Only their exact owned layout is accepted.
        var version=journal.AppVersion??"1.8.0";
        if(!ReleaseIdentity.KnownTransactionVersion(version) || !System.Text.RegularExpressions.Regex.IsMatch(journal.Id,"^[a-f0-9]{32}$") || journal.Options.Edition is not ("30fps" or "60fps") || journal.Build!=$"builds/v{version}-{journal.Options.Edition}-{journal.Id}" || journal.Runtime!=$"runtime/AI-Buddy-v{version}-{journal.Id}" || journal.RootFiles.Any(p=>!Manifests.RootFileAllowed(p)) || journal.PreviouslyExistingRootFiles.Except(journal.RootFiles).Any())throw new InvalidDataException("Invalid transaction ownership; no recovery files were changed");
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
        if(version is not "1.8.0" and not "1.7.10" and not "1.7.9")return;
        var data=DataPaths.Registered(root,Existing(root)?.DataPath??journal.Options.DataPath);SafePaths.NoLinks(data);
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
        await RollbackJournal(root,journal,progress,cancel);Json.Save(Path.Combine(control,"transaction.json"),journal with{Phase="rolled-back"});
    }
    public async Task Uninstall(string root,bool deletePersonalData,IProgress<InstallProgress>? progress,CancellationToken cancel) {
        root=SafePaths.Full(root);var installed=Existing(root)??throw new IOException("Installation record is missing");
        if(deletePersonalData&&installed.DataPath is not null)throw new IOException("Custom personal-data path is retained; remove it manually if intended");
        var control=SafePaths.Under(root,"local/installer");
        await using var installationLock=new FileStream(Path.Combine(control,"install.lock"),FileMode.OpenOrCreate,FileAccess.ReadWrite,FileShare.None);
        await host.Stop(root,installed,progress,cancel);await host.RemoveShortcuts(root,cancel);
        // Only indexed program files from this installation are removed. Unknown files are retained.
        var selected=Manifests.Select(m,installed.Edition,installed.Characters,installed.InitialCharacter);
        foreach(var p in selected)foreach(var f in p.Files) {
            var prefix=p.Mount=="root"?"":p.Mount=="build"?installed.Build+"/":installed.Runtime+"/";
            var path=SafePaths.Under(root,prefix+f.Path);if(await Hashing.Matches(path,f.Bytes,f.Sha256,cancel))File.Delete(path);
        }
        if(deletePersonalData) {
            // Custom data directories are not recursively deleted by this maintenance tool.
            if(installed.DataPath is not null)throw new IOException("Custom personal-data path is retained; remove it manually if intended");
            SafePaths.RemoveOwnedTree(SafePaths.Under(root,"local/data-v003"),root);
        }
        File.Delete(PointerPath(root));Json.Save(Path.Combine(control,"uninstalled.json"),installed);File.Delete(RecordPath(root));
        progress?.Report(new("uninstalled",root,Detail:deletePersonalData?"Default personal data removed":"Personal data retained"));
    }
}
