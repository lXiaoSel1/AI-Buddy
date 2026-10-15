using System.Text.Json;
namespace AiBuddy.Install;

public sealed record InstallOptions(string Root,string Cache,string Edition,string[] Characters,string InitialCharacter,string? OfflineDirectory=null,bool Shortcuts=true,bool Launch=true,string? DataPath=null,string? Pipe=null);
public sealed record Installation(int SchemaVersion,string Version,string ManifestSha256,string Edition,string[] Characters,string InitialCharacter,string Build,string Runtime,string Manager,string? DataPath,string? Pipe,DateTimeOffset InstalledAt,Dictionary<string,string> PackageHashes);
public sealed record InstallJournal(string Id,string Phase,string ManifestHash,InstallOptions Options,string? PreviousPointer,string? PreviousInstallation,string Build,string Runtime,string[] RootFiles,string[] PreviouslyExistingRootFiles);
public sealed record DiskEstimate(long DownloadBytes,long ExpandedBytes,long CacheAdditionalBytes,long InstallAdditionalBytes,long RetainedBytes);
public interface IAppHost {
    Task<string?> DiscoverDataPath(string root,CancellationToken cancel)=>Task.FromResult<string?>(null);
    Task Stop(string root,Installation? previous,IProgress<InstallProgress>? progress,CancellationToken cancel);
    Task StartAndVerify(string root,Installation installed,CancellationToken cancel);
    Task CreateShortcuts(string root,Installation installed,CancellationToken cancel);
    Task RemoveShortcuts(string root,CancellationToken cancel);
}
public sealed class InstallEngine(InstallManifest manifest,byte[] manifestBytes,string manifestHash,Downloader downloader,IAppHost host,string selfExe,Func<Package,Uri>? source=null,Action<string>? checkpoint=null) {
    readonly InstallManifest m=manifest;
    public static string RecordPath(string root)=>SafePaths.Under(root,"local/installation.json");
    static string PointerPath(string root)=>SafePaths.Under(root,"local/current-build.json");
    public static Installation? Existing(string root)=>File.Exists(RecordPath(root))?Json.Read<Installation>(RecordPath(root)):null;
    public DiskEstimate Estimate(InstallOptions options) {
        var packages=Manifests.Select(m,options.Edition,options.Characters,options.InitialCharacter);
        long download=packages.Sum(p=>p.Bytes),expanded=packages.Sum(p=>p.UnpackedBytes);
        long missing=packages.Where(p=>!File.Exists(Path.Combine(options.Cache,p.Sha256+".zip"))).Sum(p=>p.Bytes);
        long retained=0;var previous=Existing(options.Root);
        if(previous is not null)foreach(var dir in new[]{previous.Build,previous.Runtime}){var path=SafePaths.Under(options.Root,dir);if(Directory.Exists(path))retained+=Directory.EnumerateFiles(path,"*",SearchOption.AllDirectories).Sum(p=>new FileInfo(p).Length);}
        // Existing files remain until a validated new version has started. The stage becomes the final tree by rename.
        return new(download,expanded,options.OfflineDirectory is null?missing:0,expanded+64*1024*1024,retained);
    }
    public async Task<Installation> Install(InstallOptions requested,IProgress<InstallProgress>? progress,CancellationToken cancel) {
        Manifests.Parse(manifestBytes,manifestHash);
        var root=Path.GetFullPath(requested.Root).TrimEnd(Path.DirectorySeparatorChar);SafePaths.NoLinks(root);
        if(Path.GetPathRoot(root)==root+Path.DirectorySeparatorChar || root.Length<4)throw new IOException("Choose a dedicated application folder");
        Directory.CreateDirectory(root);
        var control=SafePaths.Under(root,"local/installer");Directory.CreateDirectory(control);
        await using var installationLock=new FileStream(Path.Combine(control,"install.lock"),FileMode.OpenOrCreate,FileAccess.ReadWrite,FileShare.None);
        var journalPath=Path.Combine(control,"transaction.json");
        await Recover(root,journalPath,progress,cancel);
        var previous=Existing(root);
        var discovered=previous is null&&File.Exists(PointerPath(root))?await host.DiscoverDataPath(root,cancel):null;
        var options=requested with {Root=root,DataPath=previous?.DataPath??discovered??requested.DataPath,Pipe=previous?.Pipe??requested.Pipe};
        var packages=Manifests.Select(m,options.Edition,options.Characters,options.InitialCharacter);
        Dictionary<string,string>? offline=null;
        if(options.OfflineDirectory is {} folder) {
            SafePaths.NoLinks(folder);
            var supplied=SafePaths.Under(folder,"install-manifest-1.8.0.json");
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
                $"builds/v{m.AppVersion}-{options.Edition}-{id}",$"runtime/AI-Buddy-v{m.AppVersion}-{id}",rootFiles,rootFiles.Where(f=>File.Exists(SafePaths.Under(root,f))).ToArray());
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
        var installed=new Installation(1,m.AppVersion,manifestHash,options.Edition,options.Characters,options.InitialCharacter,journal.Build,journal.Runtime,managerRelative,options.DataPath,options.Pipe,DateTimeOffset.UtcNow,packages.ToDictionary(p=>p.Id,p=>p.Sha256));
        // Root launcher updates are journaled separately from immutable version trees.
        var backup=SafePaths.Under(control,"backups/"+journal.Id);Directory.CreateDirectory(backup);
        foreach(var f in journal.PreviouslyExistingRootFiles){var target=SafePaths.Under(backup,f);Directory.CreateDirectory(Path.GetDirectoryName(target)!);File.Copy(SafePaths.Under(root,f),target,true);}
        if((File.Exists(PointerPath(root))?await File.ReadAllTextAsync(PointerPath(root),cancel):null)!=journal.PreviousPointer)throw new IOException("Launch pointer changed during download; retry against the new current version");
        await host.Stop(root,previous,progress,cancel);cancel.ThrowIfCancellationRequested();
        journal=journal with {Phase="committing"};Json.Save(journalPath,journal);
        try {
            foreach(var (mount,target) in new[]{("build",journal.Build),("runtime",journal.Runtime)}) {
                var destination=SafePaths.Under(root,target);Directory.CreateDirectory(Path.GetDirectoryName(destination)!);
                await RetryLocal(()=>Directory.Move(SafePaths.Under(stage,mount),destination),cancel);
            }
            foreach(var f in journal.RootFiles){var target=SafePaths.Under(root,f);Directory.CreateDirectory(Path.GetDirectoryName(target)!);await RetryLocal(()=>File.Copy(SafePaths.Under(stage,"root/"+f),target,true),cancel);}
            checkpoint?.Invoke("root-files");
            var manager=SafePaths.Under(root,managerRelative);Directory.CreateDirectory(Path.GetDirectoryName(manager)!);
            if(!string.Equals(Path.GetFullPath(selfExe),manager,StringComparison.OrdinalIgnoreCase))File.Copy(selfExe,manager,true);
            var savedManifest=SafePaths.Under(root,"local/install-manifests/"+manifestHash+".json");Directory.CreateDirectory(Path.GetDirectoryName(savedManifest)!);await File.WriteAllBytesAsync(savedManifest,manifestBytes,cancel);
            Json.Save(RecordPath(root),installed);
            Json.Save(PointerPath(root),new {version=m.AppVersion,appVersion=m.AppVersion,path=journal.Build,runtime=new{path=journal.Runtime,executable=m.Runtime.Executable,sha256=m.Runtime.Sha256},animationProfile=options.Edition,installedAt=installed.InstalledAt});
            checkpoint?.Invoke("pointer");
            await host.StartAndVerify(root,installed,cancel);
            if(!options.Launch)await host.Stop(root,installed,progress,cancel);
            checkpoint?.Invoke("launched");
            if(options.Shortcuts)await host.CreateShortcuts(root,installed,cancel);
            journal=journal with {Phase="complete"};Json.Save(journalPath,journal);
            if(journal.PreviousPointer is not null)Json.Save(Path.Combine(control,"rollback.json"),journal);
            try{SafePaths.RemoveOwnedTree(stage,root);}catch(IOException ex){progress?.Report(new("cleanup-pending",stage,Detail:ex.Message));}
            progress?.Report(new("complete",m.AppVersion));return installed;
        } catch {
            await RollbackJournal(root,journal,progress,CancellationToken.None);Json.Save(journalPath,journal with {Phase="rolled-back"});throw;
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
        if(journal.Phase=="committing"){await RollbackJournal(root,journal,progress,cancel);Json.Save(path,journal with{Phase="rolled-back"});}
    }
    async Task RollbackJournal(string root,InstallJournal journal,IProgress<InstallProgress>? progress,CancellationToken cancel) {
        ValidateJournal(journal);
        await host.Stop(root,Existing(root),progress,cancel);
        var backup=SafePaths.Under(root,"local/installer/backups/"+journal.Id);
        foreach(var f in journal.RootFiles){var target=SafePaths.Under(root,f);if(journal.PreviouslyExistingRootFiles.Contains(f)){Directory.CreateDirectory(Path.GetDirectoryName(target)!);File.Copy(SafePaths.Under(backup,f),target,true);}else if(File.Exists(target))File.Delete(target);}
        RestoreText(PointerPath(root),journal.PreviousPointer);RestoreText(RecordPath(root),journal.PreviousInstallation);
        // These uniquely named directories belong only to this failed transaction.
        foreach(var path in new[]{journal.Build,journal.Runtime,".install-staging/"+journal.Id}) {
            try{SafePaths.RemoveOwnedTree(SafePaths.Under(root,path),root);}catch(IOException ex){progress?.Report(new("cleanup-pending",path,Detail:ex.Message));}
        }
        progress?.Report(new("rolled-back",journal.Id,Detail:"Program restored; personal data was not replaced"));
    }
    static void RestoreText(string path,string? value){if(value is null){if(File.Exists(path))File.Delete(path);}else{using var document=JsonDocument.Parse(value);Json.Save(path,document.RootElement);}}
    static void ValidateJournal(InstallJournal journal){
        if(!System.Text.RegularExpressions.Regex.IsMatch(journal.Id,"^[a-f0-9]{32}$") || journal.Options.Edition is not ("30fps" or "60fps") || journal.Build!=$"builds/v1.8.0-{journal.Options.Edition}-{journal.Id}" || journal.Runtime!=$"runtime/AI-Buddy-v1.8.0-{journal.Id}" || journal.RootFiles.Any(p=>!Manifests.RootFileAllowed(p)) || journal.PreviouslyExistingRootFiles.Except(journal.RootFiles).Any())throw new InvalidDataException("Invalid transaction ownership; no recovery files were changed");
    }
    public async Task Rollback(string root,IProgress<InstallProgress>? progress,CancellationToken cancel) {
        root=Path.GetFullPath(root);var control=SafePaths.Under(root,"local/installer");
        await using var installationLock=new FileStream(Path.Combine(control,"install.lock"),FileMode.OpenOrCreate,FileAccess.ReadWrite,FileShare.None);
        var journal=Json.Read<InstallJournal>(Path.Combine(control,"rollback.json"));
        if(journal.PreviousPointer is null)throw new IOException("No previous version is available");
        await RollbackJournal(root,journal,progress,cancel);Json.Save(Path.Combine(control,"transaction.json"),journal with{Phase="rolled-back"});
    }
    public async Task Uninstall(string root,bool deletePersonalData,IProgress<InstallProgress>? progress,CancellationToken cancel) {
        root=Path.GetFullPath(root);var installed=Existing(root)??throw new IOException("Installation record is missing");
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
