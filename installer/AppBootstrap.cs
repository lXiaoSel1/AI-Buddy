using System.Diagnostics;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;
using AiBuddy.Install;

namespace AiBuddy.Setup;

internal sealed record BootstrapSource(string Root,string Build,string DataRoot,string Pipe,string Version,int Pid,string InstallationSha256,string PointerSha256);
internal sealed record BootstrapRequest(int Protocol,string Type,string Nonce,BootstrapSource Source,UpdateRelease Release,bool Official=false);
internal sealed record BootstrapSelection(BootstrapSource Source,UpdateRelease Release,string SelectionId);

// This is a separate, target-installer entry. The ordinary installed-manager
// protocol continues to require its registered image, digest and protocol.
internal static class AppBootstrap {
    static readonly string[] Arguments=["app-bootstrap-worker","app-root","nonce","pid"];
    public static bool Requested(string[] args)=>args.Any(a=>a.StartsWith("--app-bootstrap",StringComparison.Ordinal));
    static string SelectionPath(string root)=>SafePaths.Under(root,"local/installer/app-bootstrap-selection.json");
    static string StatePath(string root)=>SafePaths.Under(root,"local/installer/app-update-status.json");
    static string Stamp(BootstrapSource source)=>source.InstallationSha256+":"+source.PointerSha256;
    static T? Read<T>(string path) where T:class {
        if(!File.Exists(path))return null;
        if(new FileInfo(path).Length>128*1024)throw new InvalidDataException("Bootstrap source record is too large");
        return Json.Read<T>(path);
    }
    internal static string SelectionId(BootstrapSource source,UpdateRelease release) => Hashing.Bytes(Encoding.UTF8.GetBytes(string.Join('\n',
        "AI-Buddy-App-Bootstrap-1",source.InstallationSha256,source.PointerSha256,release.Version,release.InstallerSha256,
        release.ManifestSha256,release.ChecksumsSha256,release.SourceCommit,release.TagObjectSha,
        release.Bytes.ToString(System.Globalization.CultureInfo.InvariantCulture),Hashing.Bytes(Encoding.UTF8.GetBytes(release.SignedPayload??"")),
        Hashing.Bytes(Encoding.UTF8.GetBytes(release.Signature??"")))));
    static AppUpdateResult Result(string stage,BootstrapSelection selected,PreparedUpdate? prepared=null)=>
        new(true,stage,selected.SelectionId,selected.Release.Version,selected.Release.Bytes,prepared?.DownloadBytes,prepared?.InstallBytes,ReleaseUrl:selected.Release.ReleaseUrl);
    static Dictionary<string,string> Parse(string[] args) {
        var result=new Dictionary<string,string>(StringComparer.Ordinal);
        foreach(var argument in args) {
            var n=argument.IndexOf('=');
            if(!argument.StartsWith("--",StringComparison.Ordinal)||n<3||!Arguments.Contains(argument[2..n],StringComparer.Ordinal)||
                !result.TryAdd(argument[2..n],argument[(n+1)..]))throw new InvalidDataException("Invalid or duplicate bootstrap argument");
        }
        if(result.Count!=Arguments.Length||result.Values.Any(string.IsNullOrEmpty))throw new InvalidDataException("Incomplete bootstrap request");
        return result;
    }

    // The source identity is an approved public installation boundary, separate
    // from target trust. It never manufactures or repairs registration fields.
    internal static async Task<(Installation Installed,AppUpdateHost Host)> RequireBootstrapSource(string root,BootstrapSource source,string nonce,string selectionId,string manifestHash,CancellationToken cancel) {
        if(!Path.IsPathFullyQualified(root)||!Path.IsPathFullyQualified(source.Root)||!InstallProfile.SamePath(root,source.Root)||
            !Path.IsPathFullyQualified(source.Build)||!Path.IsPathFullyQualified(source.DataRoot)||source.Pid<=0||
            !AppUpdate.Digest(source.InstallationSha256)||!AppUpdate.Digest(source.PointerSha256)||!AppUpdate.Digest(nonce)||!AppUpdate.Digest(selectionId))
            throw new InvalidDataException("Invalid bootstrap source identity");
        SafePaths.NoLinks(root);
        var record=InstallEngine.RecordPath(root);var pointerPath=SafePaths.Under(root,"local/current-build.json");
        if(!File.Exists(record)||!File.Exists(pointerPath))throw new InvalidDataException("Bootstrap requires an existing installation record and pointer");
        if(new FileInfo(record).Length>128*1024||new FileInfo(pointerPath).Length>128*1024)throw new InvalidDataException("Bootstrap source record is too large");
        var rawRecord=await File.ReadAllTextAsync(record,cancel);var rawPointer=await File.ReadAllTextAsync(pointerPath,cancel);
        if(
            await Hashing.FileHash(record,cancel)!=source.InstallationSha256||await Hashing.FileHash(pointerPath,cancel)!=source.PointerSha256)
            throw new InvalidDataException("Bootstrap source snapshot changed");
        var installed=Read<Installation>(record)??throw new InvalidDataException("Missing bootstrap installation record");
        // Do not substitute portable defaults or accept a damaged record as a
        // missing-capability legacy installation.
        if(installed.SchemaVersion!=1||installed.Version!=source.Version||!Regex.IsMatch(installed.Version,@"\A(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\z")||
            installed.Edition is not("30fps" or "60fps")||installed.Characters is null||installed.Characters.Length==0||
            installed.Characters.Distinct(StringComparer.Ordinal).Count()!=installed.Characters.Length||!installed.Characters.Contains(installed.InitialCharacter)||
            installed.PackageHashes is null||installed.PackageHashes.Any(pair=>!AppUpdate.Digest(pair.Value))||
            string.IsNullOrEmpty(installed.Build)||string.IsNullOrEmpty(installed.Runtime)||string.IsNullOrEmpty(installed.Manager)||
            installed.Startup is {SafeMode:true} or {Onboarding:true}||installed.Startup?.StartupFailure is {} failure&&failure.ValueKind!=JsonValueKind.Null)
            throw new InvalidDataException("Bootstrap source installation is damaged or not healthy");
        var build=SafePaths.Under(root,installed.Build);var runtime=SafePaths.Under(root,installed.Runtime);var manager=SafePaths.Under(root,installed.Manager);
        if(!Directory.Exists(build)||!Directory.Exists(runtime)||!File.Exists(manager)||!InstallProfile.SamePath(build,source.Build)||
            !InstallProfile.SamePath(DataPaths.Registered(root,installed.DataPath),source.DataRoot)||
            InstallProfile.NormalizedPipe(installed.Pipe)!=InstallProfile.NormalizedPipe(source.Pipe))throw new InvalidDataException("Bootstrap source selection changed");
        using var pointer=JsonDocument.Parse(rawPointer);var p=pointer.RootElement;
        if(p.GetProperty("path").GetString()!=installed.Build||p.GetProperty("version").GetString()!=installed.Version||
            p.TryGetProperty("appVersion",out var appVersion)&&appVersion.GetString()!=installed.Version||
            p.GetProperty("animationProfile").GetString()!=installed.Edition||p.GetProperty("runtime").GetProperty("path").GetString()!=installed.Runtime)
            throw new InvalidDataException("Bootstrap source pointer differs from the registered installation");
        if(installed.ManagerProtocol is not null)
            throw new InvalidDataException("Bootstrap only accepts legacy installations without a registered update protocol");
        if(installed.ManagerSha256 is {} managerHash&&(!AppUpdate.Digest(managerHash)||await Hashing.FileHash(manager,cancel)!=managerHash))
            throw new InvalidDataException("Bootstrap source manager was modified");
        if(!string.IsNullOrEmpty(installed.ManifestSha256)) {
            // Public legacy pointers predate this field; a present field is
            // still binding, and the registered manifest is always hashed.
            if(!AppUpdate.Digest(installed.ManifestSha256)||p.TryGetProperty("manifestSha256",out var pointerHash)&&pointerHash.GetString()!=installed.ManifestSha256||
                (!File.Exists(SafePaths.Under(root,"local/install-manifests/"+installed.ManifestSha256+".json"))||
                await Hashing.FileHash(SafePaths.Under(root,"local/install-manifests/"+installed.ManifestSha256+".json"),cancel)!=installed.ManifestSha256))
                throw new InvalidDataException("Bootstrap source manifest was modified");
        }
        var journal=Read<InstallJournal>(SafePaths.Under(root,"local/installer/transaction.json"));
        if(journal is not null) {
            if(journal.Phase is "committing" or "recovery-required"||journal.Phase is not("complete" or "rolled-back" or "staging" or "prepared"))
                throw new IncompatibleRollbackException("Recover the existing installation transaction before migration");
            if(journal.Phase is "staging" or "prepared"&&(journal.AppSelection!=selectionId||journal.ManifestHash!=manifestHash||
                journal.PreviousPointer!=rawPointer||journal.PreviousInstallation!=rawRecord))
                throw new InvalidDataException("Bootstrap preparation belongs to a different source or target");
        }
        var imported=Read<DataImportJournal>(SafePaths.Under(root,"local/installer/data-import-transaction.json"));
        if(imported is not null&&imported.Phase is not("complete" or "failed" or "cancelled" or "rolled-back"))
            throw new IncompatibleRollbackException("Recover the personal-data selection before migration");
        var state=Read<AppUpdateState>(StatePath(root));
        if(state?.Result.Stage is "applying" or "recovery-required")throw new IncompatibleRollbackException("Recover the previous application update before migration");
        var identity=new AppUpdateHost(build,source.DataRoot,source.Version,source.Pid,nonce);
        await WindowsHost.RequireUpdateInstance(root,installed,identity,cancel);
        // The pipe request is asynchronous; bind the records again afterwards.
        if(await Hashing.FileHash(record,cancel)!=source.InstallationSha256||await Hashing.FileHash(pointerPath,cancel)!=source.PointerSha256)
            throw new InvalidDataException("Bootstrap source changed during instance verification");
        return (installed,identity);
    }

    public static async Task<int> Run(string[] args,HttpClient http,UpdateDiscovery discovery,InstallManifest manifest,byte[] manifestBytes,string manifestHash,string self) {
        using var output=Console.OpenStandardOutput();using var stdin=Console.OpenStandardInput();
        using var cancellation=new CancellationTokenSource();
        var nonce=Program.Argument(args,"nonce")??"";
        BootstrapSelection? selected=null;string? root=null;Installation? previous=null;WindowsHost? host=null;bool committing=false;
        try {
            var parsed=Parse(args);root=parsed["app-root"];nonce=parsed["nonce"];var action=parsed["app-bootstrap-worker"];
            if(action is not("prepare" or "apply")||!AppUpdate.Digest(nonce)||
                !int.TryParse(parsed["pid"],System.Globalization.NumberStyles.None,System.Globalization.CultureInfo.InvariantCulture,out var pid)||pid<=0)
                throw new InvalidDataException("Invalid bootstrap operation identity");
            using var deadline=new CancellationTokenSource(TimeSpan.FromSeconds(15));
            var lines=new AppUpdate.Lines(stdin);
            var first=await lines.Read(deadline.Token);
            var request=first?.Deserialize<BootstrapRequest>(AppUpdate.LineJson)??throw new InvalidDataException("Missing bootstrap proof");
            if(request.Protocol!=1||request.Type!="bootstrap"||request.Nonce!=nonce||request.Source is null||request.Source.Pid!=pid||request.Release is null)
                throw new InvalidDataException("Invalid bootstrap proof envelope");
            _=AppUpdate.ListenCancel(lines,nonce,cancellation,action!="apply");
            if(!discovery.VerifyBootstrapSelected(request.Release))throw new InvalidDataException("The signed release does not declare both update protocols");
            if(request.Release.Version!=manifest.AppVersion||manifest.AppVersion!=ReleaseIdentity.Version||request.Release.ManifestSha256!=manifestHash||
                Hashing.Bytes(manifestBytes)!=manifestHash||!Version.TryParse(request.Source.Version,out var sourceVersion)||
                !Version.TryParse(manifest.AppVersion,out var targetVersion)||targetVersion<=sourceVersion||
                !await Hashing.Matches(self,request.Release.Bytes,request.Release.InstallerSha256,cancellation.Token))
                throw new InvalidDataException("Bootstrap worker does not match the exact signed increasing target");
            var selectionId=SelectionId(request.Source,request.Release);
            selected=new(request.Source,request.Release,selectionId);
            var source=await RequireBootstrapSource(root,request.Source,nonce,selectionId,manifestHash,cancellation.Token);
            using var officialScope=request.Official?InstallerNetwork.UseOfficial():null;
            previous=source.Installed;
            InstallerNetwork.Configure(InstallerNetwork.Load(root));
            // Share the ordinary app-update lock, then recheck the live source.
            Directory.CreateDirectory(SafePaths.Under(root,"local/installer"));
            await using var operationLock=new FileStream(SafePaths.Under(root,"local/installer/app-update.lock"),FileMode.OpenOrCreate,FileAccess.ReadWrite,FileShare.None);
            source=await RequireBootstrapSource(root,request.Source,nonce,selectionId,manifestHash,cancellation.Token);
            var saved=Read<BootstrapSelection>(SelectionPath(root));
            var ready=Read<AppUpdateState>(StatePath(root));
            if(action=="apply"&&(saved is null||saved.Source with{Pid=request.Source.Pid}!=request.Source||saved.Release!=request.Release||saved.SelectionId!=selectionId||SelectionId(saved.Source,saved.Release)!=selectionId||
                ready?.Result.Stage!="ready"||ready.Result.SelectionId!=selectionId||ready.SourceStamp!=Stamp(request.Source)))
                throw new InvalidDataException("The exact bootstrap target must be prepared before apply");
            if(action=="prepare")Json.Save(SelectionPath(root),selected);
            AppUpdate.Emit(output,nonce,"ready",new{version=manifest.AppVersion,manifestSha256=manifestHash,selectionId,appUpdateProtocol=1,appBootstrapProtocol=1});
            host=new WindowsHost(appUpdate:source.Host);
            var engine=new InstallEngine(manifest,manifestBytes,manifestHash,new Downloader(http),host,self);
            var options=new InstallOptions(root,SafePaths.Under(root,"local/installer/update-cache/components"),previous.Edition,previous.Characters,previous.InitialCharacter,
                Shortcuts:false,Launch:true,DataPath:previous.DataPath,Pipe:previous.Pipe);
            var progress=new AppUpdate.ProgressSink(value=>{
                if(value.Phase=="committing") {committing=true;Json.Save(StatePath(root),new AppUpdateState(Stamp(request.Source),Result("applying",selected)));}
                AppUpdate.Emit(output,nonce,"progress",new{phase=value.Phase,bytes=value.Completed,total=value.Total,reasons=value.Reasons});
            });
            AppUpdateResult result;
            if(action=="prepare")result=Result("ready",selected,await engine.PrepareUpdate(options,selectionId,progress,cancellation.Token));
            else {await engine.ApplyUpdate(options,selectionId,progress,cancellation.Token);result=Result("completed",selected);}
            Json.Save(StatePath(root),new AppUpdateState(Stamp(request.Source),result,result.Stage=="completed"?InstallEngine.Existing(root)?.Build:null));
            AppUpdate.Emit(output,nonce,"result",result);return 0;
        } catch(Exception error) {
            var result=AppUpdate.Failure(error);
            if(committing&&root is not null&&previous is not null&&selected is not null) {
                var journal=Read<InstallJournal>(SafePaths.Under(root,"local/installer/transaction.json"));
                if(host?.UpdateProcessStopped==true&&InstallEngine.Existing(root) is {} restored&&restored.Build==previous.Build&&restored.Version==previous.Version) {
                    try{await host.StartInstalledAndVerify(root,restored,false,CancellationToken.None);}catch(IOException){}
                }
                if(journal?.Phase is "committing" or "recovery-required")Json.Save(StatePath(root),new AppUpdateState(Stamp(selected.Source),new(true,"recovery-required",selected.SelectionId,selected.Release.Version,Code:result.Code,Message:result.Message)));
                else if(journal?.Phase=="prepared")Json.Save(StatePath(root),new AppUpdateState(Stamp(selected.Source),Result("ready",selected)));
                else if(journal?.Phase=="complete"&&journal.AppSelection==selected.SelectionId&&InstallEngine.Existing(root)?.Build==journal.Build)
                    Json.Save(StatePath(root),new AppUpdateState(Stamp(selected.Source),Result("completed",selected),journal.Build));
                else Json.Save(StatePath(root),new AppUpdateState(Stamp(selected.Source),new(true,"idle",Code:result.Code,Message:result.Message)));
            }
            AppUpdate.Emit(output,nonce,"result",result);return 1;
        } finally {cancellation.Cancel();}
    }
}
