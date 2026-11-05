using AiBuddy.Install;
using AiBuddy.Setup;
using System.IO.Compression;
using System.Reflection;
using System.Text.Json;

return await new R1Suite().Run();
sealed class R1Suite {
 readonly string root=Path.Combine(Environment.GetEnvironmentVariable("AI_BUDDY_INSTALLER_TEST_ROOT")??Path.GetTempPath(),"AI Buddy installer r1 "+Guid.NewGuid().ToString("N"));
 readonly List<object> results=[];InstallManifest manifest=null!;byte[] bytes=[];string digest="";InstallOptions options=null!;
 readonly HttpClient http=new(new NeverNetwork());
 static void Assert(bool condition,string why){if(!condition)throw new Exception(why);}
 async Task Check(string name,Func<Task> action){try{await action();results.Add(new{name,ok=true});Console.WriteLine("PASS "+name);}catch(Exception e){results.Add(new{name,ok=false,error=e.ToString()});Console.WriteLine("FAIL "+name+": "+e.Message);}}
 static async Task Reject(Func<Task> action){try{await action();}catch(Exception e) when(e is IOException or InvalidDataException){return;}throw new Exception("Expected installer rejection");}
 Package Zip(string id,string mount,string file,string content,string? edition=null){
  var payload=System.Text.Encoding.UTF8.GetBytes(content);var path=Path.Combine(root,id+".zip");using(var zip=ZipFile.Open(path,ZipArchiveMode.Create)){using var stream=zip.CreateEntry(file).Open();stream.Write(payload);}
  InstallFile[] files=[new(file,payload.Length,Hashing.Bytes(payload))];return new(id,"test",mount,id+".zip",new FileInfo(path).Length,payload.Length,Hashing.FileHash(path).Result,[],files,Edition:edition,FilesSha256:Manifests.IndexHash(files));
 }
 InstallEngine Engine(R1Host host,Action<string>? checkpoint=null)=>new(manifest,bytes,digest,new Downloader(http),host,Path.Combine(root,"root.zip"),checkpoint:checkpoint);
 static void Seed(string data){Directory.CreateDirectory(data);Json.Save(Path.Combine(data,"settings.json"),new{language="zh-CN",preserved="original profile"});}
 async Task<(string target,Installation installed,R1Host host)> Existing(string name,string kind){
  var target=Path.Combine(root,name);string? selected=kind=="absolute"?Path.Combine(root,name+" original data"):kind=="import"?"local/data-profiles/import-"+Guid.NewGuid().ToString("D"):null;
  var data=DataPaths.Registered(target,selected,false);Seed(data);var host=new R1Host();var installed=await Engine(host).Install(options with{Root=target,DataPath=selected,Pipe="r1-"+name},null,default);host.Reset();return(target,installed,host);
 }
 static JsonElement Status(string target,Installation installed,bool ready=true,bool onboarding=false,bool safe=false,bool failed=false)=>JsonSerializer.SerializeToElement(new{version=installed.Version,build=SafePaths.Under(target,installed.Build),dataRoot=DataPaths.Registered(target,installed.DataPath,false),ready,onboarding,safeMode=safe,startupFailure=failed?new{message="injected failure"}:null});
 public async Task<int> Run(){
  Directory.CreateDirectory(root);var packages=new[]{Zip("root","root","AI Buddy.exe","synthetic launcher; never execute"),Zip("runtime","runtime","AI Buddy.exe","synthetic runtime; never execute"),Zip("app30","build","main.cjs","30","30fps"),Zip("app60","build","main.cjs","60","60fps"),Zip("character","build","assets/portrait.webp","portrait")};
  manifest=new(1,ReleaseIdentity.Version,"v"+ReleaseIdentity.Version,"lXiaoSel1/AI-Buddy","win32","x64",ReleaseIdentity.Version,1,"30fps","deepseek",["root","runtime"],new("AI Buddy.exe",packages[1].Files[0].Sha256),[new("30fps","30fps","app30"),new("60fps","60fps","app60")],[new("deepseek","DeepSeek","character",new(){["30fps"]=[],["60fps"]=[]})],packages);
  bytes=JsonSerializer.SerializeToUtf8Bytes(manifest,Json.Options);digest=Hashing.Bytes(bytes);File.WriteAllBytes(Path.Combine(root,ReleaseIdentity.ManifestFileName),bytes);options=new("",Path.Combine(root,"cache"),"30fps",["deepseek"],"deepseek",root,false,true);
  foreach(var custom in new[]{false,true})await Check("fresh "+(custom?"custom":"default")+" uses explicit initialization and records transaction identity",async()=>{
   var target=Path.Combine(root,"fresh-"+custom);var data=custom?Path.Combine(root,"fresh external data"):null;var host=new R1Host();var installed=await Engine(host).Install(options with{Root=target,DataPath=data},null,default);
   Assert(host.Fresh==1&&host.Ordinary==0,"fresh installer must request real initialization, not accept welcome");Assert(installed.DataInitialized==true,"app confirmation retained");Assert(installed.DataPath==data,"default remains null and custom remains registered");
   using var journal=JsonDocument.Parse(File.ReadAllBytes(SafePaths.Under(target,"local/installer/transaction.json")));Assert(journal.RootElement.GetProperty("profileAction").GetString()=="initialize"&&journal.RootElement.GetProperty("expectedDataPath").GetString()==DataPaths.Registered(target,data),"profile action and absolute expected path persisted");Assert(journal.RootElement.GetProperty("installerRevision").GetString()==ReleaseIdentity.InstallerRevision,"revision receipt persisted");
  });
  foreach(var kind in new[]{"default","absolute","import"}){
   await Check("update retains "+kind+" profile and ordinary startup",async()=>{var x=await Existing("retain-"+kind,kind);var marker=Path.Combine(DataPaths.Registered(x.target,x.installed.DataPath),"settings.json");var before=await Hashing.FileHash(marker);var next=await Engine(x.host).Install(options with{Root=x.target,Edition="60fps"},null,default);Assert(next.DataPath==x.installed.DataPath&&next.Pipe==x.installed.Pipe&&x.host.Fresh==0&&x.host.Ordinary==1,"registered null/absolute/import and pipe retained");Assert(await Hashing.FileHash(marker)==before,"original profile unchanged");});
   await Check("conflicting data parameter rejects "+kind+" before stop",async()=>{var x=await Existing("conflict-data-"+kind,kind);var before=await Hashing.FileHash(InstallEngine.RecordPath(x.target));await Reject(()=>Engine(x.host).Install(options with{Root=x.target,DataPath=Path.Combine(root,"other profile")},null,default));Assert(x.host.Stops==0&&await Hashing.FileHash(InstallEngine.RecordPath(x.target))==before,"conflict does not stop or switch installation");});
   foreach(var state in new[]{"missing","empty","unrecognized"})await Check("registered "+kind+" "+state+" rejects without initializing",async()=>{
    var x=await Existing("invalid-"+kind+"-"+state,kind);var data=DataPaths.Registered(x.target,x.installed.DataPath);File.Delete(Path.Combine(data,"settings.json"));if(state=="missing")Directory.Delete(data);else if(state=="unrecognized")File.WriteAllText(Path.Combine(data,"notes.txt"),"not a recognized profile");
    var before=await Hashing.FileHash(InstallEngine.RecordPath(x.target));await Reject(()=>Engine(x.host).Install(options with{Root=x.target},null,default));Assert(x.host.Stops==0&&x.host.Fresh==0&&x.host.Ordinary==0&&await Hashing.FileHash(InstallEngine.RecordPath(x.target))==before,"bad original profile never starts or changes pointer");Assert(!File.Exists(Path.Combine(data,"profile-initialized.json")),"bad original profile never recreated");
   });
  }
  await Check("conflicting pipe parameter rejects before stop",async()=>{var x=await Existing("conflict-pipe","default");await Reject(()=>Engine(x.host).Install(options with{Root=x.target,Pipe="other-instance"},null,default));Assert(x.host.Stops==0,"pipe conflict does not stop original instance");});
  await Check("equivalent explicit default and normalized pipe retain null registration",async()=>{var x=await Existing("equivalent","default");var next=await Engine(x.host).Install(options with{Root=x.target,DataPath=DataPaths.Registered(x.target,null).ToUpperInvariant(),Pipe=@"\\.\pipe\"+x.installed.Pipe},null,default);Assert(next.DataPath is null&&next.Pipe==x.installed.Pipe&&x.host.Fresh==0,"comparison normalizes without rewriting registration");});
  foreach(var tuple in new[]{(false,true,false,false),(true,true,false,false),(true,false,true,false),(true,false,false,true)})await Check("strict startup rejects "+tuple,async()=>{
   var x=await Existing("strict-"+results.Count,"default");try{var match=WindowsHost.MatchStartup(x.target,x.installed,Status(x.target,x.installed,tuple.Item1,tuple.Item2,tuple.Item3,tuple.Item4));Assert(match is null,"non-ready/onboarding/safe/failure never acknowledged");}catch(IOException){}await Task.CompletedTask;
  });
  await Check("fresh welcome is never accepted as successful installation",async()=>{var x=await Existing("fresh-welcome","default");var match=WindowsHost.MatchStartup(x.target,x.installed with{DataInitialized=false},Status(x.target,x.installed,false,true));Assert(match is null,"fresh welcome cannot complete installation");});
  await Check("healthy ready startup remains accepted",async()=>{var x=await Existing("healthy","default");Assert(WindowsHost.MatchStartup(x.target,x.installed,Status(x.target,x.installed)) is{SafeMode:false,Onboarding:false,StartupFailure:null},"healthy startup accepted");});
  await Check("staging retry is bound to original creation path",async()=>{
   var target=Path.Combine(root,"retry-bound");var custom=Path.Combine(root,"retry original profile");var host=new R1Host();await Reject(()=>Engine(host,phase=>{if(phase=="extracted")throw new IOException("injected staging interruption");}).Install(options with{Root=target,DataPath=custom},null,default));
   var journalPath=SafePaths.Under(target,"local/installer/transaction.json");var before=File.ReadAllText(journalPath);await Reject(()=>Engine(host).Install(options with{Root=target,DataPath=custom+"-conflict"},null,default));Assert(File.ReadAllText(journalPath)==before&&host.Fresh==0,"retry conflict leaves original journal and profile untouched");
   await Engine(host).Install(options with{Root=target,DataPath=custom},null,default);Assert(host.Fresh==1,"same retry initializes once");
  });
  foreach(var custom in new[]{false,true})await Check("retry after failed fresh start retains "+(custom?"custom":"default")+" initialized profile without reinitializing",async()=>{
   var target=Path.Combine(root,"retry-initialized-"+custom);var selected=custom?Path.Combine(root,"interrupted custom profile"):null;var host=new R1Host{FailFresh=true};await Reject(()=>Engine(host).Install(options with{Root=target,DataPath=selected},null,default));var data=DataPaths.Registered(target,selected,false);var marker=Path.Combine(data,"settings.json");Assert(File.Exists(marker),"failed first start retains initialized data");var before=await Hashing.FileHash(marker);host.FailFresh=false;host.Reset();var installed=await Engine(host).Install(options with{Root=target},null,default);Assert(host.Fresh==0&&host.Ordinary==1&&await Hashing.FileHash(marker)==before&&installed.DataPath==selected,"retry without explicit --data preserves real data using ordinary startup");
  });
  await Check("repeated interrupted custom retry keeps preserve binding without explicit parameters",async()=>{
   var target=Path.Combine(root,"retry-three-times");var custom=Path.Combine(root,"three attempt original profile");var host=new R1Host{FailFresh=true};await Reject(()=>Engine(host).Install(options with{Root=target,DataPath=custom,Pipe="r1-three-attempts"},null,default));var marker=Path.Combine(custom,"settings.json");var before=await Hashing.FileHash(marker);host.FailFresh=false;host.Reset();
   await Reject(()=>Engine(host,phase=>{if(phase=="extracted")throw new IOException("second interrupted attempt");}).Install(options with{Root=target},null,default));var installed=await Engine(host).Install(options with{Root=target},null,default);Assert(installed.DataPath==custom&&installed.Pipe=="r1-three-attempts"&&host.Fresh==0&&host.Ordinary==1&&await Hashing.FileHash(marker)==before,"preserve transaction retains original custom profile across every retry");Assert(!Directory.Exists(DataPaths.Registered(target,null,false)),"no default profile created on third attempt");
  });
  foreach(var unknown in new[]{false,true})await Check("interrupted fresh scaffolding "+(unknown?"rejects unknown data":"continues initialization"),async()=>{
   var target=Path.Combine(root,"retry-scaffolding-"+unknown);var custom=Path.Combine(root,"scaffolding original profile "+unknown);var host=new R1Host{FailBeforeInitialization=true};await Reject(()=>Engine(host).Install(options with{Root=target,DataPath=custom},null,default));host.FailBeforeInitialization=false;host.Reset();
   if(unknown){File.WriteAllText(Path.Combine(custom,"unknown.json"),"{\"preserve\":true}");await Reject(()=>Engine(host).Install(options with{Root=target},null,default));Assert(host.Fresh==0&&host.Ordinary==0,"unknown data cannot authorize initialization");}
   else{var installed=await Engine(host).Install(options with{Root=target},null,default);Assert(installed.DataPath==custom&&host.Fresh==1&&File.Exists(Path.Combine(custom,"settings.json")),"known scaffold resumes the bound first initialization");}
  });
  await Check("completed installation can move and retain default profile on repair",async()=>{
   var x=await Existing("move-completed","default");var moved=x.target+" moved";Directory.Move(x.target,moved);var marker=Path.Combine(DataPaths.Registered(moved,null),"settings.json");var before=await Hashing.FileHash(marker);var installed=await Engine(x.host).Install(options with{Root=moved,Edition="60fps"},null,default);Assert(installed.DataPath is null&&x.host.Fresh==0&&await Hashing.FileHash(marker)==before,"historical absolute journal binding does not block moved relative/default data");
  });
  await Check("portable pointer without original profile cannot become fresh",async()=>{var target=Path.Combine(root,"portable-missing");Json.Save(SafePaths.Under(target,"local/current-build.json"),new{path="builds/old",version=ReleaseIdentity.Version});var host=new R1Host();await Reject(()=>Engine(host).Install(options with{Root=target},null,default));Assert(host.Stops==0&&host.Fresh==0,"existing portable cannot silently create new save");});
  await Check("launch construction initializes only explicit fresh request",()=>{
   var installed=new Installation(1,ReleaseIdentity.Version,"hash","30fps",["deepseek"],"deepseek","builds/current","runtime/current","maintenance/setup.exe",null,"r1-launch",DateTimeOffset.UtcNow,new());
   var method=typeof(WindowsHost).GetMethod("CreateStartInfo",BindingFlags.Public|BindingFlags.Static);Assert(method is not null,"launch construction has pure regression entry point");var target=Path.Combine(root,"launch arguments");
   var fresh=(System.Diagnostics.ProcessStartInfo)method!.Invoke(null,[target,installed,true,null,null])!;var preserve=(System.Diagnostics.ProcessStartInfo)method.Invoke(null,[target,installed,false,null,null])!;Assert(fresh.ArgumentList.Contains("--data="+DataPaths.Registered(target,null,false))&&!preserve.ArgumentList.Any(a=>a.StartsWith("--data=")),"--data only on fresh startup");Assert(fresh.ArgumentList.Contains("--pipe=r1-launch")&&preserve.ArgumentList.Contains("--pipe=r1-launch"),"registered isolated pipe passed to child");return Task.CompletedTask;
  });
  var failed=results.Count(value=>!JsonSerializer.SerializeToElement(value).GetProperty("ok").GetBoolean());Json.Save(Path.Combine(root,"r1-results.json"),new{passed=results.Count-failed,failed,root,results});Console.WriteLine(JsonSerializer.Serialize(new{passed=results.Count-failed,failed,root},Json.Options));http.Dispose();return failed==0?0:1;
 }
 sealed class NeverNetwork:HttpMessageHandler{protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request,CancellationToken cancel)=>throw new Exception("R1 fixture must remain offline");}
 sealed class R1Host:IAppHost {
  public int Fresh,Ordinary,Stops;public bool FailFresh,FailBeforeInitialization;public StartupStatus? LastStartup=>new(false,null);
  public void Reset(){Fresh=Ordinary=Stops=0;}
  public Task Stop(string root,Installation? previous,IProgress<InstallProgress>? progress,CancellationToken cancel){Stops++;return Task.CompletedTask;}
  public Task StartAndVerify(string root,Installation installed,CancellationToken cancel){Ordinary++;return Task.CompletedTask;}
  public Task StartFreshAndVerify(string root,Installation installed,CancellationToken cancel){Fresh++;var data=DataPaths.Registered(root,installed.DataPath,false);if(FailBeforeInitialization){Directory.CreateDirectory(Path.Combine(data,"chromium"));File.WriteAllText(Path.Combine(data,"chromium","Preferences"),"{}");throw new IOException("injected first start failure before initialization");}Seed(data);Json.Save(InstallEngine.RecordPath(root),installed with{DataInitialized=true});if(FailFresh)throw new IOException("injected first start failure after initialization");return Task.CompletedTask;}
  public Task CreateShortcuts(string root,Installation installed,CancellationToken cancel)=>Task.CompletedTask;
  public Task RemoveShortcuts(string root,CancellationToken cancel)=>Task.CompletedTask;
 }
}
