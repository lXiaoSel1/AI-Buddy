using AiBuddy.Install;
using AiBuddy.Setup;
using System.Diagnostics;
using System.Net;
using System.Reflection;
using System.Text.Json;
using static BootstrapFixtures;

internal static class BootstrapTests {
    static readonly string Home=Path.Combine(Environment.GetEnvironmentVariable("AI_BUDDY_INSTALLER_TEST_ROOT")??Path.GetTempPath(),"bootstrap-"+Guid.NewGuid().ToString("N"));
    static readonly List<object> Results=[];
    [STAThread] static int Main(string[] args) {
        if(args is ["--portable-app-update-only"])return RunPortableUpdateOnly().GetAwaiter().GetResult();
        if(args.Length>1&&args[0]=="--fixture-portable-update-check")return PortableUpdateCheck(args[1..]).GetAwaiter().GetResult();
        if(args is ["--fixture-source-host",var sourceRoot])return SourceHost(sourceRoot).GetAwaiter().GetResult();
        if(args.Length>1&&args[0]=="--fixture-bootstrap")return Worker(args[1],args[2..]).GetAwaiter().GetResult();
        if(args.Any(a=>a.StartsWith("--app-",StringComparison.Ordinal))||args.Contains("--headless"))
            return (int)typeof(AiBuddy.Setup.Program).GetMethod("Main",BindingFlags.NonPublic|BindingFlags.Static)!.Invoke(null,[args])!;
        return Run().GetAwaiter().GetResult();
    }
    static void Assert(bool value,string message){if(!value)throw new Exception(message);}
    static async Task Check(string name,Func<Task> run){try{await run();Results.Add(new{name,ok=true});Console.WriteLine("PASS "+name);}catch(Exception e){Results.Add(new{name,ok=false,error=e.ToString()});Console.WriteLine("FAIL "+name+": "+e.Message);}}
    static async Task Reject(Func<Task> run){try{await run();}catch(Exception e)when(e is IOException or InvalidDataException or InvalidOperationException or JsonException){return;}throw new Exception("Expected verification rejection");}
    static Process Child(IEnumerable<string> args,string? executable=null){var start=new ProcessStartInfo(executable??Environment.ProcessPath!){RedirectStandardInput=true,RedirectStandardOutput=true,RedirectStandardError=true,UseShellExecute=false,CreateNoWindow=true};foreach(var a in args)start.ArgumentList.Add(a);return Process.Start(start)!;}
    static string[] Args(string root,string action="prepare",int? pid=null)=>["--app-bootstrap-worker="+action,"--app-root="+root,"--nonce="+Nonce,"--pid="+(pid??Environment.ProcessId)];
    static async Task<JsonElement[]> Finish(Process process){using var timeout=new CancellationTokenSource(TimeSpan.FromSeconds(30));var output=await process.StandardOutput.ReadToEndAsync(timeout.Token);var error=await process.StandardError.ReadToEndAsync(timeout.Token);await process.WaitForExitAsync(timeout.Token);if(error.Length>0)throw new Exception(error);return output.Split('\n',StringSplitOptions.RemoveEmptyEntries).Select(line=>JsonSerializer.Deserialize<JsonElement>(line)).ToArray();}
    static async Task Validate(BootstrapSource source)=>await AppBootstrap.RequireBootstrapSource(source.Root,source,Nonce,new string('b',64),new string('c',64),default);
    static async Task<int> PortableUpdateCheck(string[] args) {
        var root=args.Single(value=>value.StartsWith("--app-root=",StringComparison.Ordinal))[11..];
        using var manifest=typeof(AiBuddy.Setup.Program).Assembly.GetManifestResourceStream("InstallManifest")!;
        using var buffer=new MemoryStream();await manifest.CopyToAsync(buffer);var bytes=buffer.ToArray();var digest=Hashing.Bytes(bytes);
        using var http=new HttpClient(new CurrentRelease(root));
        // Exercise the real manager entry and its live-instance identity checks.
        // Only the external HTTP boundary is substituted. Signature validation
        // retains UpdateDiscovery's production pinned-key implementation.
        return await AppUpdate.Run(args,http,new UpdateDiscovery(http),Manifests.Parse(bytes,digest),bytes,digest,Environment.ProcessPath!);
    }
    sealed class CurrentRelease(string root):HttpMessageHandler {
        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request,CancellationToken cancel) {
            const string latest="https://api.github.com/repos/lXiaoSel1/AI-Buddy/releases/latest";
            Assert(request.RequestUri?.AbsoluteUri==latest&&request.Headers.Authorization is null,"only anonymous release discovery is allowed");
            Json.Save(Path.Combine(root,"discovery-request.json"),new{url=latest});
            return Task.FromResult(new HttpResponseMessage(HttpStatusCode.OK){Content=new StringContent(JsonSerializer.Serialize(new{
                draft=false,prerelease=false,tag_name="v"+ReleaseIdentity.Version,
                html_url="https://github.com/lXiaoSel1/AI-Buddy/releases/tag/v"+ReleaseIdentity.Version,target_commitish=new string('b',40)}))});
        }
    }
    static async Task PortableUpdateChecks() {
        await Check("moved fresh portable checks for updates without an existing installer directory",async()=>{
            var original=Path.Combine(Home,"portable-before-move");await RegisteredSource(original);
            Directory.Delete(SafePaths.Under(original,"local/installer"));
            var moved=Path.Combine(Home,"移动后的 完整包");Directory.Move(original,moved);var source=await Snapshot(moved);
            var control=SafePaths.Under(moved,"local/installer");Assert(!Directory.Exists(control),"fresh portable fixture must have no installer control directory");
            await Serve(source,async()=>{
                var installed=Json.Read<Installation>(InstallEngine.RecordPath(moved));var manager=SafePaths.Under(moved,installed.Manager);
                using(var status=Child(["--app-update=status","--app-root="+moved,"--app-nonce="+Nonce,"--app-pid="+Environment.ProcessId],manager)) {
                    var lines=await Finish(status);Assert(status.ExitCode==0&&lines[^1].GetProperty("stage").GetString()=="idle"&&!Directory.Exists(control),"status must remain read-only for a fresh portable root");
                }
                using var check=Child(["--fixture-portable-update-check","--app-update=check","--app-root="+moved,"--app-nonce="+Nonce,"--app-pid="+Environment.ProcessId],manager);
                var result=await Finish(check);
                Assert(check.ExitCode==0&&result.Length==2&&result[0].GetProperty("type").GetString()=="ready"&&result[^1].GetProperty("stage").GetString()=="current",
                    "check must reach release discovery instead of failing on a missing control directory: "+string.Join(";",result));
                Assert(Directory.Exists(control)&&File.Exists(Path.Combine(moved,"discovery-request.json")),"check creates its control directory and actually queries discovery");
            });
        });
        await Check("fresh portable manager identity mismatch is rejected before discovery or directory creation",async()=>{
            var source=await RegisteredSource(Path.Combine(Home,"portable-identity-mismatch"));Directory.Delete(SafePaths.Under(source.Root,"local/installer"));
            var installed=Json.Read<Installation>(InstallEngine.RecordPath(source.Root));Json.Save(InstallEngine.RecordPath(source.Root),installed with{ManagerSha256=new string('e',64)});
            using var check=Child(["--fixture-portable-update-check","--app-update=check","--app-root="+source.Root,"--app-nonce="+Nonce,"--app-pid="+Environment.ProcessId],SafePaths.Under(source.Root,installed.Manager));
            var result=await Finish(check);Assert(check.ExitCode==1&&result.Length==1&&result[0].GetProperty("code").GetString()=="APP_UPDATE_VERIFICATION_FAILED"&&
                !Directory.Exists(SafePaths.Under(source.Root,"local/installer"))&&!File.Exists(Path.Combine(source.Root,"discovery-request.json")),"identity checks must still precede filesystem mutation and release discovery");
        });
    }
    static async Task<int> RunPortableUpdateOnly() {
        Directory.CreateDirectory(Home);await PortableUpdateChecks();
        var failed=Results.Count(v=>!JsonSerializer.SerializeToElement(v).GetProperty("ok").GetBoolean());
        Json.Save(Path.Combine(Home,"results.json"),new{passed=Results.Count-failed,failed,home=Home,results=Results});
        Console.WriteLine(JsonSerializer.Serialize(new{passed=Results.Count-failed,failed,home=Home}));return failed==0?0:1;
    }
    static async Task<int> Run() {
        Directory.CreateDirectory(Home);
        await PortableUpdateChecks();
        await Check("real installer bootstrap entry rejects malformed first line with JSONL result",async()=>{
            using var child=Child(Args(Home));await child.StandardInput.WriteLineAsync("{}");child.StandardInput.Close();var lines=await Finish(child);
            Assert(child.ExitCode==1&&lines.Length==1&&lines[0].GetProperty("type").GetString()=="result"&&!lines[0].GetProperty("ok").GetBoolean(),"real entry must produce structured rejection");
        });
        await Check("real inspect reports both implemented protocols",async()=>{var receipt=Path.Combine(Home,"inspect.json");using var child=Child(["--headless","--action=inspect","--receipt="+receipt]);await Finish(child);var inspect=Json.Read<JsonElement>(receipt);Assert(child.ExitCode==0&&inspect.GetProperty("appUpdateProtocol").GetInt32()==1&&inspect.GetProperty("appBootstrapProtocol").GetInt32()==1,"actual capability output");});
        await Check("ordinary manager entry still refuses a legacy missing-protocol registration",async()=>{
            var source=await CreateSource(Path.Combine(Home,"ordinary-gate"));using var child=Child(["--app-update=check","--app-root="+source.Root,"--app-nonce="+Nonce,"--app-pid="+Environment.ProcessId]);
            var lines=await Finish(child);Assert(child.ExitCode==1&&lines.Length==1&&lines[0].GetProperty("code").GetString()=="APP_UPDATE_RECHECK_REQUIRED","bootstrap must not relax ordinary manager gates");
        });
        await Check("complete protocol-one installation rejects bootstrap and retains the ordinary manager entry",async()=>{
            var source=await RegisteredSource(Path.Combine(Home,"registered-manager"));
            await Serve(source,async()=>{
                await Reject(()=>Validate(source));
                var installed=Json.Read<Installation>(InstallEngine.RecordPath(source.Root));
                using var child=Child(["--app-update=status","--app-root="+source.Root,"--app-nonce="+Nonce,"--app-pid="+Environment.ProcessId],SafePaths.Under(source.Root,installed.Manager));
                var lines=await Finish(child);Assert(child.ExitCode==0&&lines.Length==2&&lines[0].GetProperty("type").GetString()=="ready"&&lines[^1].GetProperty("ok").GetBoolean()&&lines[^1].GetProperty("stage").GetString()=="idle","complete registration must continue to use the unchanged ordinary manager protocol");
            });
        });
        await Check("healthy legacy missing protocol migrates only with exact live source",async()=>{var source=await CreateSource(Path.Combine(Home,"healthy"));await Serve(source,async()=>{await Validate(source);await Reject(()=>Validate(source with{Pid=source.Pid+1}));await Reject(()=>Validate(source with{DataRoot=Path.Combine(Home,"wrong-profile")}));await Reject(()=>Validate(source with{Build=Path.Combine(source.Root,"builds","other")}));await Reject(()=>Validate(source with{Version="1.9.1"}));});});
        await Check("public legacy pointer may omit manifest digest but registered manifest remains verified",async()=>{
            var source=await CreateSource(Path.Combine(Home,"legacy-manifest"));var record=Json.Read<Installation>(InstallEngine.RecordPath(source.Root));
            var manifest=System.Text.Encoding.UTF8.GetBytes("{\"appVersion\":\"1.9.0\"}\n");var hash=Hashing.Bytes(manifest);
            var path=SafePaths.Under(source.Root,"local/install-manifests/"+hash+".json");Directory.CreateDirectory(Path.GetDirectoryName(path)!);await File.WriteAllBytesAsync(path,manifest);
            Json.Save(InstallEngine.RecordPath(source.Root),record with{ManifestSha256=hash});source=await Snapshot(source.Root);
            await Serve(source,()=>Validate(source));
            var pointer=System.Text.Json.Nodes.JsonNode.Parse(await File.ReadAllTextAsync(SafePaths.Under(source.Root,"local/current-build.json")))!;
            foreach(var value in new string?[]{new string('f',64),null}) {
                pointer["manifestSha256"]=value;await File.WriteAllTextAsync(SafePaths.Under(source.Root,"local/current-build.json"),pointer.ToJsonString());source=await Snapshot(source.Root);await Reject(()=>Validate(source));
            }
            pointer.AsObject().Remove("manifestSha256");await File.WriteAllTextAsync(SafePaths.Under(source.Root,"local/current-build.json"),pointer.ToJsonString());source=await Snapshot(source.Root);
            await File.WriteAllTextAsync(path,"changed manifest");await Reject(()=>Validate(source));
        });
        await Check("a source snapshot change rejects before any transaction",async()=>{var source=await CreateSource(Path.Combine(Home,"changed"));File.AppendAllText(InstallEngine.RecordPath(source.Root),"\r\n");await Reject(()=>Validate(source));Assert(!File.Exists(SafePaths.Under(source.Root,"local/installer/transaction.json")),"no journal created");});
        await Check("an unhealthy actual pipe identity never becomes bootstrap eligibility",async()=>{var source=await CreateSource(Path.Combine(Home,"unhealthy"));await Serve(source,()=>Reject(()=>Validate(source)),new{build=source.Build,dataRoot=source.DataRoot,version=source.Version,processId=source.Pid,ready=true,safeMode=true,onboarding=false});});
        foreach(var phase in new[]{"committing","recovery-required","unknown"})await Check("source rejects "+phase+" transaction",async()=>{var source=await CreateSource(Path.Combine(Home,phase));Json.Save(SafePaths.Under(source.Root,"local/installer/transaction.json"),new{phase});await Reject(()=>Validate(source));});
        await Check("a declared source manager digest cannot be bypassed as missing capability",async()=>{var source=await CreateSource(Path.Combine(Home,"tampered"));var record=Json.Read<Installation>(InstallEngine.RecordPath(source.Root));Json.Save(InstallEngine.RecordPath(source.Root),record with{ManagerSha256=new string('e',64)});source=await Snapshot(source.Root);await Reject(()=>Validate(source));});
        var fixture=CreateManifest(Path.Combine(Home,"packages"));var release=await Release(fixture.Hash);
        using var offline=new HttpClient(new Packages(Path.Combine(Home,"packages"),fixture.Manifest));var trust=new UpdateDiscovery(offline,verifySignature:(_,signature)=>signature==Signature);
        await Check("signed target binds checksums and both protocols without latest resolution",async()=>{
            Assert(trust.VerifyBootstrapSelected(release),"full proof accepted by isolated fixture verifier");
            await Reject(()=>{trust.VerifySelected(release with{ChecksumsSha256=new string('f',64)});return Task.CompletedTask;});
            await Reject(()=>{trust.VerifySelected(release with{ChecksumsSha256=null});return Task.CompletedTask;});
            var ordinary=release with{SignedPayload=release.SignedPayload!.Replace("App Bootstrap Protocol: 1\n","")};
            Assert(!trust.VerifyBootstrapSelected(ordinary)&&trust.VerifySelected(ordinary),"ordinary capability cannot imply bootstrap");
            await Reject(()=>{new UpdateDiscovery(offline).VerifyBootstrapSelected(release);return Task.CompletedTask;});
        });
        await Check("real entry rejects a fixture signature with the production pinned key",async()=>{var source=await CreateSource(Path.Combine(Home,"real-reject"));using var child=Child(Args(source.Root));await child.StandardInput.WriteLineAsync(JsonSerializer.Serialize(new{protocol=1,type="bootstrap",nonce=Nonce,source,release},Compact));var lines=await Finish(child);Assert(child.ExitCode==1&&lines.Length==1&&lines[0].GetProperty("code").GetString()=="APP_UPDATE_VERIFICATION_FAILED","no self-trusting release proof");Assert(!File.Exists(SafePaths.Under(source.Root,"local/installer/app-bootstrap-selection.json")),"invalid proof never saved");});
        await Check("bootstrap cancellation before commit preserves source and data",async()=>{
            var source=await CreateSource(Path.Combine(Home,"cancelled"));var folder=Path.Combine(Home,"packages");File.WriteAllBytes(Path.Combine(folder,"manifest.json"),fixture.Bytes);
            using var child=Child(new[]{"--fixture-bootstrap",folder}.Concat(Args(source.Root)));await child.StandardInput.WriteLineAsync(JsonSerializer.Serialize(new{protocol=1,type="bootstrap",nonce=Nonce,source,release},Compact));await child.StandardInput.WriteLineAsync(JsonSerializer.Serialize(new{command="cancel",nonce=Nonce},Compact));
            var lines=await Finish(child);Assert(child.ExitCode==1&&lines[^1].GetProperty("code").GetString()=="APP_UPDATE_CANCELLED","cancel is reported before source mutation");Assert(await Hashing.FileHash(InstallEngine.RecordPath(source.Root))==source.InstallationSha256&&await Hashing.FileHash(SafePaths.Under(source.Root,"local/current-build.json"))==source.PointerSha256,"cancel preserves registration and pointer");
        });
        await Check("bootstrap worker preparation freezes source and target and preserves data",async()=>{
            var source=await CreateSource(Path.Combine(Home,"worker-prepare"));var folder=Path.Combine(Home,"packages");File.WriteAllBytes(Path.Combine(folder,"manifest.json"),fixture.Bytes);var profile=Path.Combine(source.DataRoot,"settings.json");var before=await Hashing.FileHash(profile);
            await Serve(source,async()=>{using var child=Child(new[]{"--fixture-bootstrap",folder}.Concat(Args(source.Root)));await child.StandardInput.WriteLineAsync(JsonSerializer.Serialize(new{protocol=1,type="bootstrap",nonce=Nonce,source,release},Compact));var lines=await Finish(child);Assert(child.ExitCode==0,"fixture worker prepare succeeds: "+string.Join(";",lines));var ready=lines.Single(v=>v.GetProperty("type").GetString()=="ready");Assert(ready.GetProperty("version").GetString()==release.Version&&ready.GetProperty("manifestSha256").GetString()==release.ManifestSha256&&ready.GetProperty("selectionId").GetString()==AppBootstrap.SelectionId(source,release),"target-bound ready");Assert(lines[^1].GetProperty("stage").GetString()=="ready","preparation result");});
            Assert(await Hashing.FileHash(profile)==before&&await Hashing.FileHash(InstallEngine.RecordPath(source.Root))==source.InstallationSha256&&await Hashing.FileHash(SafePaths.Under(source.Root,"local/current-build.json"))==source.PointerSha256,"prepare preserves source records and data");
            var saved=Json.Read<BootstrapSelection>(SafePaths.Under(source.Root,"local/installer/app-bootstrap-selection.json"));var id=AppBootstrap.SelectionId(source,release);Assert(saved.SelectionId==id&&saved.Source==source,"selection persisted exactly");
            await Serve(source,()=>AppBootstrap.RequireBootstrapSource(source.Root,source,Nonce,id,fixture.Hash,default));
            await Reject(()=>AppBootstrap.RequireBootstrapSource(source.Root,source,Nonce,new string('f',64),fixture.Hash,default));
            // Persisted proof binds source bytes/paths, while each execution
            // authenticates the current pipe PID. Restarting the old app is safe.
            using(var restarted=Child(["--fixture-source-host",source.Root])) {
                try {
                    using var timeout=new CancellationTokenSource(TimeSpan.FromSeconds(15));
                    Assert(await restarted.StandardOutput.ReadLineAsync(timeout.Token)=="fixture-source-ready","restarted fixture pipe ready");
                    var fresh=source with{Pid=restarted.Id};Assert(AppBootstrap.SelectionId(fresh,release)==id,"selection survives PID change");
                    using var apply=Child(new[]{"--fixture-bootstrap",folder}.Concat(Args(source.Root,"apply",restarted.Id)));
                    await apply.StandardInput.WriteLineAsync(JsonSerializer.Serialize(new{protocol=1,type="bootstrap",nonce=Nonce,source=fresh,release},Compact));
                    using var greeting=JsonDocument.Parse((await apply.StandardOutput.ReadLineAsync(timeout.Token))!);
                    Assert(greeting.RootElement.GetProperty("type").GetString()=="ready","apply revalidates a restarted source rather than pinning the old PID");
                    await apply.StandardInput.WriteLineAsync(JsonSerializer.Serialize(new{command="cancel",nonce=Nonce},Compact));
                    var outcome=await Finish(apply);Assert(apply.ExitCode==1&&outcome[^1].GetProperty("code").GetString()=="APP_UPDATE_CANCELLED","busy apply safely cancels after accepting current PID");
                } finally {if(!restarted.HasExited){restarted.Kill();await restarted.WaitForExitAsync();}}
            }
            var host=new TransactionHost();var engine=new InstallEngine(fixture.Manifest,fixture.Bytes,fixture.Hash,new Downloader(offline),host,Environment.ProcessPath!);var options=new InstallOptions(source.Root,SafePaths.Under(source.Root,"local/installer/update-cache/components"),"60fps",["deepseek"],"deepseek",Shortcuts:false,Launch:true,Pipe:source.Pipe);
            var installed=await engine.ApplyUpdate(options,id,null,default);
            Assert(installed.ManagerProtocol==1&&installed.ManagerSha256==release.InstallerSha256&&installed.ManifestSha256==fixture.Hash&&installed.Edition=="60fps"&&installed.DataPath is null&&installed.Pipe==source.Pipe,"real transaction creates capability from actual bytes while preserving selections");Assert(host.Stops==1&&host.Starts==1&&await Hashing.FileHash(profile)==before,"single controlled host stop/start and unchanged data");
        });
        var failed=Results.Count(v=>!JsonSerializer.SerializeToElement(v).GetProperty("ok").GetBoolean());Json.Save(Path.Combine(Home,"results.json"),new{passed=Results.Count-failed,failed,home=Home,results=Results});Console.WriteLine(JsonSerializer.Serialize(new{passed=Results.Count-failed,failed,home=Home}));return failed==0?0:1;
    }
}
