using System.Diagnostics;
using System.IO.Pipes;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;
using Microsoft.Win32.SafeHandles;
using AiBuddy.Install;

namespace AiBuddy.Setup;

internal sealed record AppUpdateResult(bool Ok,string? Stage=null,string? SelectionId=null,string? Version=null,long? InstallerBytes=null,
    long? DownloadBytes=null,long? InstallBytes=null,string? Code=null,string? Message=null,long? RetryAfterMs=null,string? ReleaseUrl=null,bool? RequiresBootstrap=null,string? Notes=null,bool? RetryOfficial=null,string? Host=null);
internal sealed record AppUpdateSelection(string SourceStamp,UpdateRelease Release);
internal sealed record AppUpdateState(string SourceStamp,AppUpdateResult Result,string? CompletedBuild=null);
internal sealed record AppUpdateWork(string Action,string Root,string Nonce,int AppPid,string SelectionId,AppUpdateSelection Selection,bool Official=false);

internal static class AppUpdate {
    const string Prefix="AI-Buddy-App-Update-";
    const int Protocol=1;
    const int MessageLimit=128*1024;
    internal static readonly JsonSerializerOptions LineJson=new(Json.Options){WriteIndented=false,DefaultIgnoreCondition=System.Text.Json.Serialization.JsonIgnoreCondition.WhenWritingNull};
    static readonly string[] ManagerArguments=["app-update","app-root","app-nonce","app-pid","app-selection","network-official"];
    static readonly string[] WorkerArguments=["app-worker","app-worker-nonce","app-parent"];
    [DllImport("kernel32.dll",SetLastError=true)] static extern bool GetNamedPipeClientProcessId(SafePipeHandle pipe,out uint processId);
    [DllImport("kernel32.dll",SetLastError=true)] static extern bool GetNamedPipeServerProcessId(SafePipeHandle pipe,out uint processId);

    public static bool Requested(string[] args)=>args.Any(a=>a.StartsWith("--app-",StringComparison.Ordinal));

    internal static string SelectionId(AppUpdateSelection selection)=>Hashing.Bytes(JsonSerializer.SerializeToUtf8Bytes(selection,LineJson));
    internal static bool Digest(string? value)=>value is not null&&Regex.IsMatch(value,@"\A[a-f0-9]{64}\z",RegexOptions.CultureInvariant);

    static Dictionary<string,string> Parse(string[] args,string[] allowed) {
        var parsed=new Dictionary<string,string>(StringComparer.Ordinal);
        foreach(var argument in args) {
            var equals=argument.IndexOf('=');
            if(!argument.StartsWith("--",StringComparison.Ordinal)||equals<3||!allowed.Contains(argument[2..equals],StringComparer.Ordinal)||
                !parsed.TryAdd(argument[2..equals],argument[(equals+1)..]))throw new InvalidDataException("Invalid or duplicate application update argument");
        }
        return parsed;
    }
    static string Need(Dictionary<string,string> args,string key)=>args.TryGetValue(key,out var value)&&value.Length>0?value:throw new InvalidDataException("Incomplete application update identity");
    static int Pid(string value)=>int.TryParse(value,System.Globalization.NumberStyles.None,System.Globalization.CultureInfo.InvariantCulture,out var pid)&&pid>0?pid:throw new InvalidDataException("Invalid application update process identity");
    static string StatePath(string root)=>SafePaths.Under(root,"local/installer/app-update-status.json");
    static string SelectionPath(string root)=>SafePaths.Under(root,"local/installer/app-update-selection.json");
    static bool Held(string path) {
        if(!File.Exists(path))return false;
        try {using var handle=new FileStream(path,FileMode.Open,FileAccess.Read,FileShare.ReadWrite);return false;}
        catch(IOException error)when((error.HResult&0xffff) is 32 or 33){return true;}
    }
    static T? ReadOptional<T>(string path) where T:class {
        if(!File.Exists(path))return null;
        if(new FileInfo(path).Length>MessageLimit)throw new InvalidDataException("Application update record is too large");
        return Json.Read<T>(path);
    }
    static string Stamp(Installation i)=>Hashing.Bytes(JsonSerializer.SerializeToUtf8Bytes(new{i.Version,i.Build,i.Runtime,i.Manager,i.ManifestSha256,i.Edition,i.Characters,i.InitialCharacter,i.DataPath,i.Pipe},LineJson));
    static bool Newer(string candidate,string current)=>Version.TryParse(candidate,out var offered)&&Version.TryParse(current,out var installed)&&offered>installed;
    static string ManagerPath(string root,Installation installed) {
        if(installed.ManagerProtocol!=Protocol||!Digest(installed.ManagerSha256)||
            installed.Manager!=$"maintenance/{installed.Version}/AI Buddy Setup.exe")throw new InvalidOperationException("Install the signed bootstrap release before updating from Settings");
        return SafePaths.Under(root,installed.Manager);
    }

    static async Task<(Installation Installed,AppUpdateHost Host)> Instance(string root,string executable,int pid,string nonce,CancellationToken cancel) {
        if(!Path.IsPathFullyQualified(root))throw new InvalidDataException("Invalid application update root");
        SafePaths.NoLinks(root);
        var installed=InstallEngine.Existing(root)??throw new InvalidOperationException("Managed installation required");
        if(!InstallProfile.SamePath(ManagerPath(root,installed),executable)||
            await Hashing.FileHash(executable,cancel)!=installed.ManagerSha256)throw new InvalidDataException("Installed update manager identity differs");
        var build=SafePaths.Under(root,installed.Build);
        var pointer=Json.Read<JsonElement>(SafePaths.Under(root,"local/current-build.json"));
        if(pointer.GetProperty("path").GetString()!=installed.Build||pointer.GetProperty("version").GetString()!=installed.Version||
            pointer.GetProperty("animationProfile").GetString()!=installed.Edition||pointer.GetProperty("runtime").GetProperty("path").GetString()!=installed.Runtime)
            throw new InvalidDataException("Installed update pointer differs from the manager's registered installation");
        var identity=new AppUpdateHost(build,DataPaths.Registered(root,installed.DataPath),installed.Version,pid,nonce);
        await WindowsHost.RequireUpdateInstance(root,installed,identity,cancel);
        return (installed,identity);
    }
    static void VerifySelection(UpdateDiscovery discovery,AppUpdateSelection selection,string id,Installation installed) {
        if(selection.SourceStamp!=Stamp(installed)||SelectionId(selection)!=id||!Newer(selection.Release.Version,installed.Version))
            throw new InvalidOperationException("The selected update no longer belongs to this installation");
        if(!discovery.VerifySelected(selection.Release))throw new IOException("The selected installer does not support the application update protocol");
    }
    static string? SignedNotes(UpdateRelease release) {
        var payload=release.SignedPayload;
        if(payload is null)return null;
        var separator=payload.IndexOf("\n\n",StringComparison.Ordinal);
        if(separator<0)return null;
        string[] metadata=["Source:","Installer SHA-256:","Manifest SHA-256:","Checksums SHA-256:","App Update Protocol:","App Bootstrap Protocol:"];
        var lines=payload[(separator+2)..].Split('\n',StringSplitOptions.TrimEntries|StringSplitOptions.RemoveEmptyEntries)
            .Where(line=>!metadata.Any(prefix=>line.StartsWith(prefix,StringComparison.Ordinal)))
            .Take(12).Select(line=>line.StartsWith("Notes:",StringComparison.Ordinal)?line[6..].TrimStart():line);
        var plain=string.Join('\n',lines);
        return plain.Length==0?null:plain[..Math.Min(plain.Length,4000)];
    }
    static AppUpdateResult Result(string stage,AppUpdateSelection selection,PreparedUpdate? preparation=null) =>
        new(true,stage,SelectionId(selection),selection.Release.Version,selection.Release.Bytes,preparation?.DownloadBytes,preparation?.InstallBytes,
            ReleaseUrl:selection.Release.ReleaseUrl,Notes:SignedNotes(selection.Release));

    internal static AppUpdateResult Failure(Exception error) => error switch {
        MirrorMismatchException mirror=>new(false,Code:"NETWORK_MIRROR_MISMATCH",Message:mirror.Message,RetryOfficial:true,Host:mirror.Host),
        OperationCanceledException=>new(false,Code:"APP_UPDATE_CANCELLED",Message:"Update cancelled before commit"),
        DownloadException failure=>new(false,Code:failure.Wait is null?"APP_UPDATE_DOWNLOAD_FAILED":"APP_UPDATE_RATE_LIMITED",
            Message:failure.Wait is null?"The release server did not complete the update request":"The release server requested a delay",
            RetryAfterMs:failure.Wait is {} wait?(long)Math.Clamp(wait.TotalMilliseconds,0,24*60*60*1000):null),
        HttpRequestException=>new(false,Code:"APP_UPDATE_NETWORK_FAILED",Message:"The release server is unreachable"),
        IncompatibleRollbackException=>new(false,Code:"APP_UPDATE_RECOVERY_REQUIRED",Message:"Compatible recovery is required. Your personal data was kept"),
        InvalidDataException=>new(false,Code:"APP_UPDATE_VERIFICATION_FAILED",Message:"The update identity or prepared files could not be verified"),
        InvalidOperationException=>new(false,Code:"APP_UPDATE_RECHECK_REQUIRED",Message:"Reopen Settings or use the official installer before retrying"),
        IOException failure when failure.Message.StartsWith("Insufficient disk space",StringComparison.Ordinal)=>new(false,Code:"APP_UPDATE_DISK_SPACE",Message:"Insufficient space for the update and the retained version"),
        IOException failure when failure.Message.StartsWith("The application remained busy",StringComparison.Ordinal)=>new(false,Code:"APP_UPDATE_BUSY",Message:"The app did not become idle before the update deadline"),
        IOException failure when failure.Message.Contains("does not support the application update protocol",StringComparison.Ordinal)=>new(false,Code:"APP_UPDATE_BOOTSTRAP",Message:"This release requires the official installer once"),
        _=>new(false,Code:"APP_UPDATE_FAILED",Message:"The update could not complete. Check the installation recovery status before retrying")
    };

    public static async Task<int> Run(string[] args,HttpClient http,UpdateDiscovery discovery,InstallManifest manifest,byte[] manifestBytes,string manifestHash,string self) {
        if(args.Any(a=>a.StartsWith("--app-worker=",StringComparison.Ordinal)))return await RunWorker(args,http,discovery,manifest,manifestBytes,manifestHash,self);
        var parsed=Parse(args,ManagerArguments);
        var rawOfficial=parsed.GetValueOrDefault("network-official");if(rawOfficial is not null&&rawOfficial is not ("true" or "false"))throw new InvalidDataException("Invalid official download override");
        using var officialScope=rawOfficial=="true"?InstallerNetwork.UseOfficial():null;
        var action=Need(parsed,"app-update");var root=Need(parsed,"app-root");var nonce=Need(parsed,"app-nonce");var pid=Pid(Need(parsed,"app-pid"));
        var id=parsed.GetValueOrDefault("app-selection");
        if(!Digest(nonce)||action is not("check" or "prepare" or "apply" or "status")||
            (action is "prepare" or "apply"?!Digest(id):id is not null))throw new InvalidDataException("Invalid application update request");

        using var output=Console.OpenStandardOutput();
        using var stdin=Console.OpenStandardInput();
        using var cancellation=new CancellationTokenSource();
        var progress=new ProgressSink(value=>Emit(output,nonce,"progress",new{
            phase=value.Phase,bytes=value.Completed,total=value.Total,reasons=value.Reasons
        }));
        _=ListenCancel(new Lines(stdin),nonce,cancellation,action!="apply");
        try {
            var (installed,_)=await Instance(root,self,pid,nonce,cancellation.Token);
            if(installed.Version!=manifest.AppVersion||installed.ManifestSha256!=manifestHash)throw new InvalidDataException("Installed manager does not match this release");
            Emit(output,nonce,"ready",new{version=installed.Version,manifestSha256=manifestHash});
            var result=await Manage(action,root,nonce,pid,id,installed,discovery,progress,cancellation.Token);
            Emit(output,nonce,"result",result);
            return result.Ok?0:1;
        } catch(Exception error) {
            Emit(output,nonce,"result",Failure(error));return 1;
        } finally {cancellation.Cancel();}
    }

    static async Task<AppUpdateResult> Manage(string action,string root,string nonce,int pid,string? id,Installation installed,UpdateDiscovery discovery,ProgressSink progress,CancellationToken cancel) {
        var stamp=Stamp(installed);var statePath=StatePath(root);
        var journalPath=SafePaths.Under(root,"local/installer/transaction.json");
        var operationLock=SafePaths.Under(root,"local/installer/app-update.lock");
        if(action=="status") {
            var journal=ReadOptional<InstallJournal>(journalPath);
            var state=ReadOptional<AppUpdateState>(statePath);
            if(journal?.Phase=="recovery-required")return new(true,"recovery-required");
            if(journal is {Phase:"committing",AppSelection:not null}) {
                if(state?.Result.Stage=="applying"&&state.Result.SelectionId==journal.AppSelection&&
                    (Held(operationLock)||Held(SafePaths.Under(root,"local/installer/install.lock"))))return state.Result;
                return new(true,"recovery-required");
            }
            if(state is null)return new(true,"idle");
            if(state.Result.Stage=="completed")return state.Result.Version==installed.Version&&state.CompletedBuild==installed.Build?state.Result:new(true,"idle");
            if(state.Result.Stage=="applying"&&journal is {Phase:"complete",AppSelection:not null}&&journal.AppSelection==state.Result.SelectionId&&journal.Build==installed.Build&&installed.Version==state.Result.Version)
                return state.Result with{Stage="completed"};
            if(state.SourceStamp!=stamp)return new(true,"idle");
            if(state.Result.Stage=="ready"&&(journal?.Phase!="prepared"||journal.AppSelection!=state.Result.SelectionId))return new(true,"idle");
            if(state.Result.Stage=="applying"&&journal?.Phase=="prepared")return state.Result with{Stage="ready"};
            return state.Result;
        }

        await using var held=new FileStream(operationLock,FileMode.OpenOrCreate,FileAccess.ReadWrite,FileShare.None);
        if(action=="check") {
            var prepared=ReadOptional<AppUpdateState>(statePath);
            if(prepared is {Result.Stage:"ready"}&&prepared.SourceStamp==stamp&&
                ReadOptional<InstallJournal>(journalPath) is {Phase:"prepared"} pending&&pending.AppSelection==prepared.Result.SelectionId)
                return prepared.Result;
            using var timeout=CancellationTokenSource.CreateLinkedTokenSource(cancel);
            timeout.CancelAfter(TimeSpan.FromSeconds(90));
            UpdateRelease? release;
            try {release=await discovery.Check(installed.Version,timeout.Token);}
            catch(OperationCanceledException) when(!cancel.IsCancellationRequested){throw new HttpRequestException("Release check timed out");}
            if(release is null)return new(true,"current",Version:installed.Version);
            var selection=new AppUpdateSelection(stamp,release);
            Json.Save(SelectionPath(root),selection);
            return Result("available",selection) with{RequiresBootstrap=!discovery.VerifySelected(release)};
        }

        var selected=ReadOptional<AppUpdateSelection>(SelectionPath(root))??throw new InvalidOperationException("Check for an update again");
        VerifySelection(discovery,selected,id!,installed);
        var ready=ReadOptional<AppUpdateState>(statePath);
        if(action=="apply"&&(ready?.Result.Stage!="ready"||ready.Result.SelectionId!=id||ready.SourceStamp!=stamp))
            throw new InvalidOperationException("This update must be prepared before it can be applied");
        var cache=SafePaths.Under(root,"local/installer/update-cache");
        var releaseCache=SafePaths.Under(cache,"manager");
        string executable;
        if(action=="prepare") {
            if(!await Hashing.Matches(SafePaths.Under(releaseCache,selected.Release.InstallerSha256+"-"+selected.Release.InstallerName),selected.Release.Bytes,selected.Release.InstallerSha256,cancel)&&
                new DriveInfo(Path.GetPathRoot(root)!).AvailableFreeSpace<selected.Release.Bytes)
                throw new IOException("Insufficient disk space for the update installer");
            executable=await discovery.Download(selected.Release,releaseCache,progress,cancel);
        } else executable=SafePaths.Under(releaseCache,selected.Release.InstallerSha256+"-"+selected.Release.InstallerName);

        var work=new AppUpdateWork(action,root,nonce,pid,id!,selected,InstallerNetwork.OfficialOnly);
        try {
            var response=await Worker(executable,work,new ProgressSink(value=>{
                if(action=="apply"&&value.Phase=="committing")Json.Save(statePath,new AppUpdateState(stamp,ready!.Result with{Stage="applying"}));
                progress.Report(value);
            }),cancel);
            if(response.Ok)Json.Save(statePath,new AppUpdateState(stamp,response,response.Stage=="completed"?InstallEngine.Existing(root)?.Build:null));
            else if(action=="apply")RecordApplyFailure(root,statePath,journalPath,stamp,ready!,response);
            return response;
        } catch(Exception error) {
            var response=Failure(cancel.IsCancellationRequested?new OperationCanceledException(cancel):error);
            if(action=="apply")RecordApplyFailure(root,statePath,journalPath,stamp,ready!,response);
            return response;
        }
    }

    static void RecordApplyFailure(string root,string statePath,string journalPath,string stamp,AppUpdateState ready,AppUpdateResult result) {
        var journal=ReadOptional<InstallJournal>(journalPath);
        if(journal?.Phase is "committing" or "recovery-required")Json.Save(statePath,new AppUpdateState(stamp,new(true,"recovery-required",ready.Result.SelectionId,ready.Result.Version,Code:result.Code,Message:result.Message)));
        else if(journal?.Phase=="prepared")Json.Save(statePath,ready);
        else if(journal?.Phase=="complete"&&journal.AppSelection==ready.Result.SelectionId&&InstallEngine.Existing(root)?.Build==journal.Build)
            Json.Save(statePath,new AppUpdateState(stamp,ready.Result with{Stage="completed"},journal.Build));
        else Json.Save(statePath,new AppUpdateState(stamp,new(true,"idle",Code:result.Code,Message:result.Message)));
    }

    static async Task<AppUpdateResult> Worker(string executable,AppUpdateWork work,ProgressSink progress,CancellationToken cancel) {
        var release=work.Selection.Release;
        await using var image=new FileStream(executable,FileMode.Open,FileAccess.Read,FileShare.Read,1024*1024,FileOptions.Asynchronous|FileOptions.SequentialScan);
        if(image.Length!=release.Bytes||await Hashing.FileHash(image,cancel)!=release.InstallerSha256)throw new InvalidDataException("The selected update executable was modified");
        var pipeName=Prefix+Guid.NewGuid().ToString("N");
        var secret=Convert.ToHexStringLower(RandomNumberGenerator.GetBytes(32));
        using var pipe=new NamedPipeServerStream(pipeName,PipeDirection.InOut,1,PipeTransmissionMode.Byte,PipeOptions.Asynchronous|PipeOptions.CurrentUserOnly);
        var start=UpdateHandoff.BuildStartInfo(executable,["--app-worker="+pipeName,"--app-worker-nonce="+secret,"--app-parent="+Environment.ProcessId]);
        start.CreateNoWindow=true;
        using var child=Process.Start(start)??throw new IOException("The update worker could not start");
        using var handshake=CancellationTokenSource.CreateLinkedTokenSource(cancel);
        handshake.CancelAfter(TimeSpan.FromSeconds(45));
        var lines=new Lines(pipe);
        try {
            await pipe.WaitForConnectionAsync(handshake.Token);
            if(!GetNamedPipeClientProcessId(pipe.SafePipeHandle,out var peer)||peer!=(uint)child.Id)throw new InvalidDataException("The update worker pipe belongs to a different process");
            var hello=await lines.Read(handshake.Token);
            if(hello is not {} greeting||greeting.GetProperty("nonce").GetString()!=secret||greeting.GetProperty("protocol").GetInt32()!=Protocol||
                greeting.GetProperty("processId").GetInt32()!=child.Id||greeting.GetProperty("version").GetString()!=release.Version||
                greeting.GetProperty("manifestSha256").GetString()!=release.ManifestSha256)throw new InvalidDataException("The update worker's signed version or manifest differs");
            Write(pipe,work);
        } catch(OperationCanceledException) when(!cancel.IsCancellationRequested) {
            throw new IOException("The selected installer does not support the application update protocol or did not become ready");
        }
        using var relayStop=new CancellationTokenSource();
        var relay=RelayCancel(pipe,work.Nonce,cancel,relayStop.Token);
        try {
            while(await lines.Read(CancellationToken.None) is {} line) {
                switch(line.GetProperty("type").GetString()) {
                    case "progress":progress.Report(line.GetProperty("value").Deserialize<InstallProgress>(LineJson)??throw new InvalidDataException("Invalid update progress"));break;
                    case "result":return line.GetProperty("value").Deserialize<AppUpdateResult>(LineJson)??throw new InvalidDataException("Invalid update outcome");
                    default:throw new InvalidDataException("Invalid update worker message");
                }
            }
            throw new IOException("The update worker disconnected without a result");
        } finally {relayStop.Cancel();await relay;}
    }

    static async Task<int> RunWorker(string[] args,HttpClient http,UpdateDiscovery discovery,InstallManifest manifest,byte[] manifestBytes,string manifestHash,string self) {
        var parsed=Parse(args,WorkerArguments);var pipeName=Need(parsed,"app-worker");var secret=Need(parsed,"app-worker-nonce");var parent=Pid(Need(parsed,"app-parent"));
        if(!Regex.IsMatch(pipeName,@"\AAI-Buddy-App-Update-[a-f0-9]{32}\z",RegexOptions.CultureInvariant)||!Digest(secret))throw new InvalidDataException("Invalid private update handoff");
        using var deadline=new CancellationTokenSource(TimeSpan.FromSeconds(45));
        using var pipe=new NamedPipeClientStream(".",pipeName,PipeDirection.InOut,PipeOptions.Asynchronous|PipeOptions.CurrentUserOnly);
        await pipe.ConnectAsync(deadline.Token);
        if(!GetNamedPipeServerProcessId(pipe.SafePipeHandle,out var server)||server!=(uint)parent)throw new InvalidDataException("Invalid update manager pipe identity");
        Write(pipe,new{protocol=Protocol,nonce=secret,processId=Environment.ProcessId,version=manifest.AppVersion,manifestSha256=manifestHash});
        var lines=new Lines(pipe);var request=await lines.Read(deadline.Token);
        var work=request?.Deserialize<AppUpdateWork>(LineJson)??throw new InvalidDataException("Missing verified update selection");
        if(work.Action is not("prepare" or "apply")||!Digest(work.Nonce)||!Digest(work.SelectionId))throw new InvalidDataException("Invalid prepared update operation");
        using var cancellation=new CancellationTokenSource();
        var committing=false;
        _=ListenCancel(lines,work.Nonce,cancellation,true);
        try {
            using var manager=Process.GetProcessById(parent);
            var executable=manager.MainModule?.FileName??throw new InvalidDataException("Cannot verify the update manager process image");
            var (previous,identity)=await Instance(work.Root,executable,work.AppPid,work.Nonce,cancellation.Token);
            InstallerNetwork.Configure(InstallerNetwork.Load(work.Root));
            using var officialScope=work.Official?InstallerNetwork.UseOfficial():null;
            VerifySelection(discovery,work.Selection,work.SelectionId,previous);
            if(work.Selection.Release.Version!=manifest.AppVersion||work.Selection.Release.ManifestSha256!=manifestHash||
                !await Hashing.Matches(self,work.Selection.Release.Bytes,work.Selection.Release.InstallerSha256,cancellation.Token))
                throw new InvalidDataException("Update worker does not match the signed release");
            var host=new WindowsHost(appUpdate:identity);
            var engine=new InstallEngine(manifest,manifestBytes,manifestHash,new Downloader(http),host,self);
            var options=new InstallOptions(work.Root,SafePaths.Under(work.Root,"local/installer/update-cache/components"),previous.Edition,previous.Characters,previous.InitialCharacter,
                Shortcuts:false,Launch:true,DataPath:previous.DataPath,Pipe:previous.Pipe);
            var progress=new ProgressSink(value=>{
                if(value.Phase=="committing")committing=true;
                try{Write(pipe,new{type="progress",value});}
                catch(IOException) when(committing){}
            });
            AppUpdateResult result;
            if(work.Action=="prepare")result=Result("ready",work.Selection,await engine.PrepareUpdate(options,work.SelectionId,progress,cancellation.Token));
            else {
                try {await engine.ApplyUpdate(options,work.SelectionId,progress,cancellation.Token);}
                catch {
                    if(host.UpdateProcessStopped&&InstallEngine.Existing(work.Root) is {} restored&&restored.Build==previous.Build&&restored.Version==previous.Version) {
                        try{await host.StartInstalledAndVerify(work.Root,restored,false,CancellationToken.None);}catch(IOException){}
                    }
                    throw;
                }
                result=Result("completed",work.Selection);
            }
            Write(pipe,new{type="result",value=result});
            return 0;
        } catch(Exception error) {
            try {Write(pipe,new{type="result",value=Failure(error)});}catch(IOException){}
            return 1;
        } finally {cancellation.Cancel();}
    }

    internal static void Emit(Stream output,string nonce,string type,object value) {
        var envelope=new Dictionary<string,JsonElement>{
            ["protocol"]=JsonSerializer.SerializeToElement(Protocol),["nonce"]=JsonSerializer.SerializeToElement(nonce),
            ["processId"]=JsonSerializer.SerializeToElement(Environment.ProcessId),["type"]=JsonSerializer.SerializeToElement(type)};
        foreach(var property in JsonSerializer.SerializeToElement(value,LineJson).EnumerateObject())envelope[property.Name]=property.Value;
        try{Write(output,envelope);}catch(IOException){} // The parent exits during a successful apply.
    }

    internal static async Task ListenCancel(Lines input,string nonce,CancellationTokenSource cancellation,bool cancelOnEof) {
        try {
            var line=await input.Read(cancellation.Token);
            if(line is null&&cancelOnEof||line is {} value&&value.TryGetProperty("command",out var command)&&command.GetString()=="cancel"&&
                value.TryGetProperty("nonce",out var token)&&token.GetString()==nonce)cancellation.Cancel();
        }catch(OperationCanceledException){}catch(IOException){if(cancelOnEof)cancellation.Cancel();}catch(JsonException){}catch(InvalidOperationException){}
    }

    static async Task RelayCancel(Stream pipe,string nonce,CancellationToken cancel,CancellationToken done) {
        using var linked=CancellationTokenSource.CreateLinkedTokenSource(cancel,done);
        try{await Task.Delay(Timeout.InfiniteTimeSpan,linked.Token);}catch(OperationCanceledException){}
        if(cancel.IsCancellationRequested&&!done.IsCancellationRequested)try{Write(pipe,new{command="cancel",nonce});}catch(IOException){}
    }

    static void Write(Stream output,object value) {
        var bytes=JsonSerializer.SerializeToUtf8Bytes(value,LineJson);
        if(bytes.Length>MessageLimit)throw new InvalidDataException("Application update message is too large");
        lock(output){output.Write(bytes);output.WriteByte((byte)'\n');output.Flush();}
    }

    internal sealed class Lines(Stream stream) {
        readonly byte[] buffer=new byte[4096];
        int offset,length;
        public async Task<JsonElement?> Read(CancellationToken cancel) {
            using var line=new MemoryStream();
            while(true) {
                if(offset==length){offset=0;length=await stream.ReadAsync(buffer,cancel);if(length==0)return line.Length==0?null:throw new IOException("Truncated application update message");}
                var newline=Array.IndexOf(buffer,(byte)'\n',offset,length-offset);
                var end=newline<0?length:newline;
                if(line.Length+end-offset>MessageLimit)throw new InvalidDataException("Application update message is too large");
                line.Write(buffer,offset,end-offset);offset=newline<0?length:newline+1;
                if(newline>=0){using var document=JsonDocument.Parse(line.ToArray());return document.RootElement.Clone();}
            }
        }
    }

    internal sealed class ProgressSink(Action<InstallProgress> write):IProgress<InstallProgress> {
        string? phase;
        long next;
        public void Report(InstallProgress value) {
            lock(this) {
                var now=Environment.TickCount64;
                if(value.Phase==phase&&now<next&&value.Completed!=value.Total)return;
                phase=value.Phase;next=now+250;
                write(value with{Item="",Detail=null});
            }
        }
    }
}
