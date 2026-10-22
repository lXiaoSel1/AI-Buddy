using AiBuddy.Install;
using System.Diagnostics;
using System.IO.Pipes;
using System.Net;
using System.Text;
using System.Text.Json;

// Regressions for the installer review of 2026-10-22
// (integration/ai-buddy-190-installer-review-20261022/REVIEW.md).
static class ReviewFixTests {
 static void Assert(bool condition,string message){if(!condition)throw new Exception(message);}
 static int Trees(string dir)=>Directory.Exists(dir)?Directory.GetDirectories(dir).Length:0;
 static int Files(string dir)=>Directory.Exists(dir)?Directory.EnumerateFiles(dir,"*",SearchOption.AllDirectories).Count():0;
 // Makes the installed version look like an older release, as for a real upgrade.
 static void MarkPrevious(string target,Installation current,string? version) {
  var path=Path.Combine(target,"local/current-build.json");
  using(var doc=JsonDocument.Parse(File.ReadAllBytes(path))){var pointer=doc.RootElement.Deserialize<Dictionary<string,JsonElement>>(Json.Options)!;pointer.Remove("appVersion");pointer.Remove("version");if(version is not null){pointer["appVersion"]=JsonSerializer.SerializeToElement(version);pointer["version"]=JsonSerializer.SerializeToElement(version);}Json.Save(path,pointer);}
  Json.Save(InstallEngine.RecordPath(target),current with{Version=version??"1.7.0"});
 }
 // What 1.9 writes on its first start: a verified companion snapshot with lives.
 static void WriteLives(string target) {
  var snapshots=Path.Combine(target,"local/data-v003/galgame/companion.json.snapshots");Directory.CreateDirectory(snapshots);
  var payload=Encoding.UTF8.GetBytes("{\"schema\":1,\"lives\":{\"deepseek\":{\"id\":\"first-start\"}}}");
  File.WriteAllBytes(Path.Combine(snapshots,"first.json"),payload);File.WriteAllText(Path.Combine(snapshots,"commits.jsonl"),JsonSerializer.Serialize(new{file="first.json",sha256=Hashing.Bytes(payload)}));
 }
 static string SshKey(byte[] raw)=>"ssh-ed25519 "+Convert.ToBase64String([..Field("ssh-ed25519"u8.ToArray()),..Field(raw)]);
 static byte[] Field(byte[] value)=>[(byte)(value.Length>>24),(byte)(value.Length>>16),(byte)(value.Length>>8),(byte)value.Length,..value];

 public static async Task Run(Func<string,Func<Task>,Task> test,InstallManifest m,byte[] bytes,string hash,InstallOptions options,string root,HttpClient unusedHttp) {
  var engine=new InstallEngine(m,bytes,hash,new Downloader(unusedHttp),new FakeHost(),Path.Combine(root,"root.zip"));

  await test("repairs and edition switches keep only the current and the rollback version",async()=>{
   var target=Path.Combine(root,"review-prune");
   for(int n=0;n<3;n++)await engine.Install(options with{Root=target,Edition=n==2?"60fps":"30fps"},null,default);
   Assert(Trees(Path.Combine(target,"builds"))==2&&Trees(Path.Combine(target,"runtime"))==2,"two versions kept");
   Assert(Directory.Exists(Path.Combine(target,InstallEngine.Existing(target)!.Build)),"current version kept");
   await engine.Rollback(target,null,default);Assert(InstallEngine.Existing(target)!.Edition=="30fps","the kept version still rolls back");
  });
  foreach(var tree in new[]{"build","runtime"})await test("third repair preserves a registered custom save inside an older installer "+tree,async()=>{
   var target=Path.Combine(root,"review-protect-old-save-"+tree);
   var first=await engine.Install(options with{Root=target},null,default);
   var owned=tree=="build"?first.Build:first.Runtime;
   var custom=SafePaths.Under(target,owned+"/custom-save");Directory.CreateDirectory(custom);
   var marker=Path.Combine(custom,"memory.json");File.WriteAllText(marker,"saved chat, relationships and memories");var before=await Hashing.FileHash(marker);
   Json.Save(InstallEngine.RecordPath(target),first with{DataPath=custom,DataInitialized=true});
   Assert(DataPaths.Registered(target,InstallEngine.Existing(target)!.DataPath)==custom,"nested absolute custom-data path is supported");
   await engine.Install(options with{Root=target,Edition="60fps"},null,default);
   await engine.Install(options with{Root=target},null,default);
   Assert(File.Exists(marker)&&await Hashing.FileHash(marker)==before,"third repair must not delete or alter registered personal data in an older "+tree);
   Assert(InstallEngine.Existing(target)!.DataPath==custom,"registered save selection retained");
  });
  foreach(var tree in new[]{"build","runtime"})await test("uninstall without deleting data preserves a custom save inside the installer "+tree,async()=>{
   var target=Path.Combine(root,"review-uninstall-nested-save-"+tree);
   var installed=await engine.Install(options with{Root=target},null,default);
   var custom=SafePaths.Under(target,(tree=="build"?installed.Build:installed.Runtime)+"/custom-save");Directory.CreateDirectory(custom);
   var marker=Path.Combine(custom,"life-archive.zip");File.WriteAllText(marker,"personal life archive fixture");var before=await Hashing.FileHash(marker);
   Json.Save(InstallEngine.RecordPath(target),installed with{DataPath=custom,DataInitialized=true});
   await engine.Uninstall(target,false,null,default);
   Assert(File.Exists(marker)&&await Hashing.FileHash(marker)==before,"uninstall(false) must preserve the nested personal-data file");
  });
  foreach(var relative in new[]{false,true})await test("repair and uninstall retain "+(relative?"imported relative":"default")+" personal data",async()=>{
   var target=Path.Combine(root,"review-personal-baseline-"+relative);
   var installed=await engine.Install(options with{Root=target},null,default);
   var selected=relative?"local/data-profiles/import-"+Guid.NewGuid().ToString():null;
   var personal=selected is null?SafePaths.Under(target,"local/data-v003"):SafePaths.Under(target,selected);Directory.CreateDirectory(personal);
   var marker=Path.Combine(personal,"complete-original.bin");File.WriteAllText(marker,"full original and archived provenance");var before=await Hashing.FileHash(marker);
   Json.Save(InstallEngine.RecordPath(target),installed with{DataPath=selected,DataInitialized=true});
   await engine.Install(options with{Root=target,Edition="60fps"},null,default);
   await engine.Install(options with{Root=target},null,default);
   await engine.Uninstall(target,false,null,default);
   Assert(File.Exists(marker)&&await Hashing.FileHash(marker)==before,"default/imported data retained byte-for-byte");
  });
  await test("cleanup preserves an owned tree when the registered data root is its ancestor",async()=>{
   var target=Path.Combine(root,"review-personal-ancestor");
   var installed=await engine.Install(options with{Root=target},null,default);
   var marker=SafePaths.Under(target,installed.Build+"/personal-original.txt");File.WriteAllText(marker,"save root includes this earlier program tree");var before=await Hashing.FileHash(marker);
   Json.Save(InstallEngine.RecordPath(target),installed with{DataPath=target,DataInitialized=true});
   await engine.Install(options with{Root=target,Edition="60fps"},null,default);
   await engine.Install(options with{Root=target},null,default);
   Assert(File.Exists(marker)&&await Hashing.FileHash(marker)==before,"registered ancestor roots protect their descendants");
  });
  foreach(var metadata in new[]{"recovery","recovery-path-list","backup","import-previous"})await test("cleanup preserves custom saves recorded in "+metadata+" metadata",async()=>{
   var target=Path.Combine(root,"review-protect-recorded-"+metadata);
   var installed=await engine.Install(options with{Root=target},null,default);
   var orphan="builds/v1.9.0-30fps-"+Guid.NewGuid().ToString("N");
   var custom=SafePaths.Under(target,orphan+"/old-personal-save");Directory.CreateDirectory(custom);
   var marker=Path.Combine(custom,"original-chat.json");File.WriteAllText(marker,"previous independent personal profile");var before=await Hashing.FileHash(marker);
   var previous=installed with{DataPath=custom,DataInitialized=true};
   if(metadata is "recovery" or "recovery-path-list"){
    var journal=Json.Read<InstallJournal>(Path.Combine(target,"local/installer/transaction.json"));
    Json.Save(SafePaths.Under(target,"local/installer/recovery-required/retained.json"),new{journal=journal with{PreviousInstallation=JsonSerializer.Serialize(metadata=="recovery"?previous:installed,Json.Options)},previousDataPaths=metadata=="recovery-path-list"?new[]{custom}:Array.Empty<string>()});
   }else if(metadata=="backup")Json.Save(SafePaths.Under(target,"local/installation-backups/previous-profile.json"),previous);
   else {
    var id=Guid.NewGuid().ToString();
    var imported="local/data-profiles/import-"+id;Directory.CreateDirectory(SafePaths.Under(target,imported));
    var plan=new DataImportPlan(1,id,target,await Hashing.FileHash(InstallEngine.RecordPath(target)),installed.Build,installed.Pipe??"review-only",imported,new string('d',64),Manifests.IndexHash([]),[],"ready");
    Json.Save(SafePaths.Under(target,"local/installer/data-import-transaction.json"),new DataImportJournal(id,"complete",plan,previous,DateTimeOffset.UtcNow));
   }
   await engine.Install(options with{Root=target,Edition="60fps"},null,default);
   await engine.Uninstall(target,false,null,default);
   Assert(File.Exists(marker)&&await Hashing.FileHash(marker)==before,"recorded previous personal data survives repair and uninstall");
  });
  await test("a cache inside registered personal data is retained through install and uninstall",async()=>{
   var target=Path.Combine(root,"review-personal-cache");var custom=Path.Combine(target,"local","custom-cache-save");Directory.CreateDirectory(custom);
   var marker=Path.Combine(custom,new string('b',64)+".zip");File.WriteAllText(marker,"personal archived data, not a download");var before=await Hashing.FileHash(marker);
   await engine.Install(options with{Root=target,Cache=custom,DataPath=custom},null,default);
   await engine.Uninstall(target,false,null,default,custom);
   Assert(File.Exists(marker)&&await Hashing.FileHash(marker)==before,"cache filename alone cannot authorize deletion of personal files");
  });
  await test("abandoned staging cleanup retains a registered personal profile",async()=>{
   var target=Path.Combine(root,"review-personal-stage");var installed=await engine.Install(options with{Root=target},null,default);
   var custom=SafePaths.Under(target,".install-staging/"+Guid.NewGuid().ToString("N")+"/personal-profile");Directory.CreateDirectory(custom);
   var marker=Path.Combine(custom,"memories.txt");File.WriteAllText(marker,"personal data stored in a stale staging directory");var before=await Hashing.FileHash(marker);
   Json.Save(InstallEngine.RecordPath(target),installed with{DataPath=custom,DataInitialized=true});
   await engine.Install(options with{Root=target,Edition="60fps"},null,default);await engine.Uninstall(target,false,null,default);
   Assert(File.Exists(marker)&&await Hashing.FileHash(marker)==before,"staging cleanup also observes registered data boundaries");
  });
  await test("custom data comparison ignores Windows path case",async()=>{
   var target=Path.Combine(root,"review-personal-case");var installed=await engine.Install(options with{Root=target},null,default);
   var custom=SafePaths.Under(target,installed.Runtime+"/Mixed-Case-Save");Directory.CreateDirectory(custom);
   var marker=Path.Combine(custom,"original.txt");File.WriteAllText(marker,"case insensitive registered data");var before=await Hashing.FileHash(marker);
   Json.Save(InstallEngine.RecordPath(target),installed with{DataPath=custom.ToUpperInvariant(),DataInitialized=true});
   await engine.Install(options with{Root=target,Edition="60fps"},null,default);await engine.Install(options with{Root=target},null,default);
   Assert(File.Exists(marker)&&await Hashing.FileHash(marker)==before,"Windows case variants refer to the same protected profile");
  });
  await test("similarly prefixed cache siblings remain eligible for normal cleanup",async()=>{
   var target=Path.Combine(root,"review-personal-boundary");var custom=Path.Combine(target,"local","profile");var cache=custom+"-cache";Directory.CreateDirectory(custom);Directory.CreateDirectory(cache);
   var personal=Path.Combine(custom,"original.txt");File.WriteAllText(personal,"retain personal data");var before=await Hashing.FileHash(personal);
   var downloaded=Path.Combine(cache,new string('c',64)+".zip");File.WriteAllText(downloaded,"stale downloaded package");
   await engine.Install(options with{Root=target,Cache=cache,DataPath=custom},null,default);
   Assert(File.Exists(personal)&&await Hashing.FileHash(personal)==before&&!File.Exists(downloaded),"directory boundary protects the profile without protecting unrelated prefix siblings");
  });
  await test("malformed historical data metadata fails cleanup closed",async()=>{
   var target=Path.Combine(root,"review-personal-bad-metadata");await engine.Install(options with{Root=target},null,default);
   var orphan=SafePaths.Under(target,"builds/v1.9.0-30fps-"+Guid.NewGuid().ToString("N"));Directory.CreateDirectory(orphan);
   var marker=Path.Combine(orphan,"possibly-personal.txt");File.WriteAllText(marker,"cannot safely classify with damaged profile metadata");var before=await Hashing.FileHash(marker);
   var backup=SafePaths.Under(target,"local/installation-backups/damaged.json");Directory.CreateDirectory(Path.GetDirectoryName(backup)!);File.WriteAllText(backup,"{}");
   var events=new List<InstallProgress>();var progress=new ReviewProgress(events);
   await engine.Install(options with{Root=target,Edition="60fps"},progress,default);await engine.Uninstall(target,false,progress,default);
   Assert(File.Exists(marker)&&await Hashing.FileHash(marker)==before,"uncertain data locations must never permit recursive cleanup");
   Assert(events.Any(p=>p.Phase=="cleanup-pending"),"cleanup uncertainty is reported");
  });
  await test("failed-install rollback preserves a newly selected save inside the failed version",async()=>{
   var target=Path.Combine(root,"review-personal-failed-tree");var prior=await engine.Install(options with{Root=target},null,default);
   string? custom=null,marker=null,expected=null;
   var failing=new InstallEngine(m,bytes,hash,new Downloader(unusedHttp),new FakeHost(),Path.Combine(root,"root.zip"),checkpoint:phase=>{
    if(phase!="launched")return;var changed=InstallEngine.Existing(target)!;
    custom=SafePaths.Under(target,changed.Build+"/newly-selected-personal-profile");Directory.CreateDirectory(custom);
    marker=Path.Combine(custom,"original.txt");File.WriteAllText(marker,"new data selected before installation finalization");expected=Hashing.FileHash(marker).GetAwaiter().GetResult();
    Json.Save(InstallEngine.RecordPath(target),changed with{DataPath=custom,DataInitialized=true});throw new IOException("injected failure after profile selection");
   });
   try{await failing.Install(options with{Root=target,Edition="60fps"},null,default);throw new Exception("expected injected installation failure");}catch(IOException e){Assert(e.Message.Contains("injected failure"),"the intended failure was reached");}
   Assert(marker is not null&&File.Exists(marker)&&await Hashing.FileHash(marker)==expected,"rollback must preserve new personal files in the failed program tree");
   Assert(InstallEngine.Existing(target)!.Build==prior.Build&&InstallEngine.Existing(target)!.DataPath==custom,"program rollback retains current personal-data selection");
  });
  await test("folders without a transaction id are never pruned",async()=>{
   var target=Path.Combine(root,"review-portable");string[] keep=["builds/v1.9.0-30fps/main.cjs","builds/my-copy/notes.txt","runtime/AI-Buddy-v1.9.0/x.dll"];
   foreach(var file in keep){var path=Path.Combine(target,file);Directory.CreateDirectory(Path.GetDirectoryName(path)!);File.WriteAllText(path,"keep");}
   for(int n=0;n<3;n++)await engine.Install(options with{Root=target},null,default);
   Assert(keep.All(file=>File.Exists(Path.Combine(target,file))),"portable and manual folders stay");
  });
  await test("uninstall removes every installer-created version, abandoned staging and cached packages",async()=>{
   var target=Path.Combine(root,"review-uninstall");var cache=Path.Combine(root,"review-uninstall-cache");Directory.CreateDirectory(cache);
   for(int n=0;n<3;n++)await engine.Install(options with{Root=target,Edition=n==1?"60fps":"30fps"},null,default);
   Directory.CreateDirectory(Path.Combine(target,".install-staging",Guid.NewGuid().ToString("N")));
   var package=Path.Combine(cache,new string('a',64)+".zip");File.WriteAllText(package,"old package");File.WriteAllText(Path.Combine(cache,"notes.txt"),"user file");
   await engine.Uninstall(target,false,null,default,cache);
   Assert(Files(Path.Combine(target,"builds"))==0&&Files(Path.Combine(target,"runtime"))==0&&Trees(Path.Combine(target,".install-staging"))==0,"no program trees left");
   Assert(!File.Exists(package)&&File.Exists(Path.Combine(cache,"notes.txt")),"only installer cache files removed");
  });
  await test("a successful online install removes downloaded packages unless asked to keep them",async()=>{
   using var http=new HttpClient(new Handler((request,_)=>Task.FromResult(new HttpResponseMessage(HttpStatusCode.OK){Content=new ByteArrayContent(File.ReadAllBytes(Path.Combine(root,Uri.UnescapeDataString(request.RequestUri!.Segments[^1]))))})));
   var online=new InstallEngine(m,bytes,hash,new Downloader(http),new FakeHost(),Path.Combine(root,"root.zip"));
   var cache=Path.Combine(root,"review-cache");Directory.CreateDirectory(cache);File.WriteAllText(Path.Combine(cache,"notes.txt"),"user file");
   await online.Install(options with{Root=Path.Combine(root,"review-online"),Cache=cache,OfflineDirectory=null},null,default);
   Assert(Directory.GetFiles(cache).Select(Path.GetFileName).SequenceEqual(["notes.txt"]),"packages, partial and lock files removed; other files kept");
   var kept=Path.Combine(root,"review-cache-kept");
   await online.Install(options with{Root=Path.Combine(root,"review-online-kept"),Cache=kept,OfflineDirectory=null,KeepCache=true},null,default);
   Assert(Directory.GetFiles(kept,"*.zip").Length>0,"KeepCache keeps packages");
  });
  foreach(var (step,shortcut,stop) in new[]{("shortcuts",true,false),("stop",false,true)})await test("a "+step+" failure after verified start completes the install with a warning",async()=>{
   var target=Path.Combine(root,"review-after-commit-"+step);var prior=await engine.Install(options with{Root=target},null,default);MarkPrevious(target,prior,"1.8.0");
   var host=new PostCommitFailHost(shortcut,stop);
   var upgrader=new InstallEngine(m,bytes,hash,new Downloader(unusedHttp),host,Path.Combine(root,"root.zip"),checkpoint:phase=>{if(phase=="launched")WriteLives(target);});
   var record=await upgrader.Install(options with{Root=target,Edition="60fps",Shortcuts=shortcut,Launch=!stop},null,default);
   Assert(record.Edition=="60fps"&&record.Warnings is {Length:1}&&record.Warnings[0].StartsWith(step+":"),"installed with one warning");
   Assert(InstallEngine.Existing(target)!.Warnings?.Length==1,"warning recorded");
   Assert(Json.Read<InstallJournal>(Path.Combine(target,"local/installer/transaction.json")).Phase=="complete","committed, not recovery-required");
   if(shortcut)Assert(host.StopsAfterStart==0,"the verified program keeps running");
  });
  foreach(var version in new string?[]{"1.7.8","1.6.5",null,"1.9.0-beta"})await test("rollback over 1.9 media is refused when the previous version is "+(version??"unknown"),async()=>{
   var target=Path.Combine(root,"review-guard-"+(version??"unknown"));var current=await engine.Install(options with{Root=target},null,default);MarkPrevious(target,current,version);
   await engine.Install(options with{Root=target,Edition="60fps"},null,default);
   var media=Path.Combine(target,"local/data-v003/galgame/media");Directory.CreateDirectory(media);File.WriteAllText(Path.Combine(media,"new.png"),"1.9 media");
   var pointer=Path.Combine(target,"local/current-build.json");var before=File.ReadAllText(pointer);
   Assert(await engine.RollbackBlocker(target,default) is not null,"blocked before trying");
   try{await engine.Rollback(target,null,default);throw new Exception("rollback must be refused");}catch(IncompatibleRollbackException){}
   Assert(File.ReadAllText(pointer)==before,"current program kept");
  });
  await test("roll back is offered only when it would be accepted",async()=>{
   var target=Path.Combine(root,"review-blocker");Assert(await engine.RollbackBlocker(target,default) is not null,"nothing to roll back to");
   var current=await engine.Install(options with{Root=target},null,default);MarkPrevious(target,current,"1.8.0");await engine.Install(options with{Root=target,Edition="60fps"},null,default);
   Assert(await engine.RollbackBlocker(target,default) is null,"compatible data: allowed");
   WriteLives(target);Assert((await engine.RollbackBlocker(target,default))?.Contains("1.9")==true,"1.9 life data: blocked with the reason");
  });
  await test("an app that acknowledges exit but keeps running is reported, not treated as cancelled",async()=>{
   var target=Path.Combine(root,"review-exit");var build=Path.Combine(target,"builds","x");Directory.CreateDirectory(build);
   // Any process that outlives the wait will do. (powershell.exe started from .NET can stall on some machines.)
   using var sleeper=Process.Start(new ProcessStartInfo("cmd.exe","/c ping -n 61 127.0.0.1 >nul"){CreateNoWindow=true,UseShellExecute=false})!;
   var pipe="ai-buddy-review-"+Guid.NewGuid().ToString("N");using var stopServer=new CancellationTokenSource(TimeSpan.FromSeconds(30));
   var server=Serve(pipe,line=>line.Contains("installation-status")?new{version="1.9.0",build,processId=sleeper.Id,busy=false,ready=true}:new{ok=true},stopServer.Token);
   try{
    await new AiBuddy.Setup.WindowsHost(exitTimeout:TimeSpan.FromSeconds(2)).Stop(target,Installed(pipe),null,default);throw new Exception("Stop must report the running app");
   }catch(IOException e){Assert(e.Message.Contains("still running"),"clear message: "+e.Message);}
   finally{try{sleeper.Kill(true);}catch{}stopServer.Cancel();try{await server;}catch{}}
  });
  await test("an app that stays busy is reported after the waiting limit",async()=>{
   var target=Path.Combine(root,"review-busy");var build=Path.Combine(target,"builds","x");Directory.CreateDirectory(build);
   var pipe="ai-buddy-review-"+Guid.NewGuid().ToString("N");using var stopServer=new CancellationTokenSource(TimeSpan.FromSeconds(30));
   var server=Serve(pipe,_=>new{version="1.9.0",build,processId=Environment.ProcessId,busy=true,ready=true},stopServer.Token);
   try{
    await new AiBuddy.Setup.WindowsHost(busyLimit:TimeSpan.FromSeconds(1)).Stop(target,Installed(pipe),null,default);throw new Exception("Stop must give up while busy");
   }catch(IOException e){Assert(e.Message.Contains("still finishing"),"clear message: "+e.Message);}
   finally{stopServer.Cancel();try{await server;}catch{}}
  });
  await test("Ed25519 verification matches RFC 8032 test vectors",()=>{
   var key1=Convert.FromHexString("d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a");
   var sig1=Convert.FromHexString("e5564300c360ac729086e2cc806e828a84877f1eb8e5d974d873e065224901555fb8821590a33bacc61e39701cf9b46bd25bf5f0595bbe24655141438e7a100b");
   var key2=Convert.FromHexString("3d4017c3e843895a92b70aa74d1b7ebc9c982ccf2ec4968cc0cd55f12af4660c");
   var sig2=Convert.FromHexString("92a009a9f0d4cab8720e820b5f642540a2b27b5416503f8fb3762223ebdb69da085ac1e43e15996e458f3613d0f11d8c387b2eaeb4302aeeb00d291612bb0c00");
   Assert(Ed25519.Verify(key1,[],sig1)&&Ed25519.Verify(key2,[0x72],sig2),"RFC 8032 tests 1 and 2");
   Assert(!Ed25519.Verify(key1,[0x00],sig1)&&!Ed25519.Verify(key2,[0x72],sig1),"wrong message or signature rejected");
   return Task.CompletedTask;
  });
  await test("the published v1.9.0 tag verifies against the pinned release key only",()=>{
   Assert(SshSignature.Verify(PublishedTag.Payload,PublishedTag.Signature,ReleaseIdentity.SigningKey),"published tag, pinned key");
   Assert(!SshSignature.Verify(PublishedTag.Payload.Replace("1.9.0","1.9.1"),PublishedTag.Signature,ReleaseIdentity.SigningKey),"changed payload rejected");
   Assert(!SshSignature.Verify(PublishedTag.Payload,PublishedTag.Signature,SshKey(Convert.FromHexString("d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a"))),"another key rejected");
   Assert(!SshSignature.Verify(PublishedTag.Payload,PublishedTag.Signature,ReleaseIdentity.SigningKey,"file"),"another namespace rejected");
   Assert(!SshSignature.Verify(PublishedTag.Payload,"-----BEGIN SSH SIGNATURE-----\nnot base64\n-----END SSH SIGNATURE-----\n",ReleaseIdentity.SigningKey),"malformed signature rejected");
   return Task.CompletedTask;
  });
 }
 static Installation Installed(string pipe)=>new(1,"1.9.0","x","30fps",["deepseek"],"deepseek","builds/x","runtime/x","m",null,pipe,DateTimeOffset.UtcNow,new());
 // A local control pipe that answers each JSONL request until cancelled.
 static Task Serve(string pipe,Func<string,object> reply,CancellationToken cancel)=>Task.Run(async()=>{
  while(!cancel.IsCancellationRequested){
   using var server=new NamedPipeServerStream(pipe,PipeDirection.InOut,1,PipeTransmissionMode.Byte,PipeOptions.Asynchronous|PipeOptions.CurrentUserOnly);
   await server.WaitForConnectionAsync(cancel);var line=await new StreamReader(server).ReadLineAsync(cancel)??"";
   await server.WriteAsync(Encoding.UTF8.GetBytes(JsonSerializer.Serialize(reply(line))+"\n"),cancel);await server.FlushAsync(cancel);server.WaitForPipeDrain();
  }
 },cancel);
}
sealed class ReviewProgress(List<InstallProgress> events):IProgress<InstallProgress>{public void Report(InstallProgress value)=>events.Add(value);}
// Fails the step after the new version has started and been verified.
sealed class PostCommitFailHost(bool failShortcut,bool failStop):IAppHost {
 public int Starts,StopsAfterStart;
 public Task Stop(string root,Installation? previous,IProgress<InstallProgress>? progress,CancellationToken cancel){if(Starts==0)return Task.CompletedTask;StopsAfterStart++;return failStop?throw new IOException("simulated stop failure"):Task.CompletedTask;}
 public Task StartAndVerify(string root,Installation installed,CancellationToken cancel){Starts++;return Task.CompletedTask;}
 public Task CreateShortcuts(string root,Installation installed,CancellationToken cancel)=>failShortcut?throw new IOException("simulated shortcut failure"):Task.CompletedTask;
 public Task RemoveShortcuts(string root,CancellationToken cancel)=>Task.CompletedTask;
}
// The published v1.9.0 tag (GitHub API git/tags/ae9067200205bdc0c67ff0143f03240c3efe820c): signed payload and SSH signature.
static class PublishedTag {
 public const string Payload="object 713898295dad121eb54420893bb03cd20f6dc7ce\ntype commit\ntag v1.9.0\ntagger lXiaoSel1 <worinige999@gmail.com> 1792644470 -0400\n\nAI Buddy 1.9.0\n\nSource: 713898295dad121eb54420893bb03cd20f6dc7ce\nManifest SHA-256: 253c9930b84bd14f421e7f972adafe4f22e5a498e4a84eb097cb0d5c96b123e1\nInstaller SHA-256: f76a0a1ffb165dbe665622428d1da2a0d89e7ded22f8b253a68d10a5eed8ba8b\n";
 public const string Signature="-----BEGIN SSH SIGNATURE-----\nU1NIU0lHAAAAAQAAADMAAAALc3NoLWVkMjU1MTkAAAAgUuYWgCA5p99MsDA0n5TW/QwriJ\npMdsxn4GNqJ1WVrTkAAAADZ2l0AAAAAAAAAAZzaGE1MTIAAABTAAAAC3NzaC1lZDI1NTE5\nAAAAQNsoZYB5eTepHTPbQGm0ykaJjvs4n51K9rCiZP1oLmzFg7Ahgkuz61O2kcMsuNjCw0\n++65HE3rthrL9ZF6y+gA4=\n-----END SSH SIGNATURE-----\n";
}
