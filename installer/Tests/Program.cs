using AiBuddy.Install;
using System.IO.Compression;
using System.Net;
using System.Net.Http.Headers;
using System.Text;
using System.Text.Json;
var suite=new Suite();await suite.Run();

sealed class Suite {
 [System.Runtime.InteropServices.DllImport("kernel32.dll",CharSet=System.Runtime.InteropServices.CharSet.Unicode)] static extern uint GetShortPathName(string path,System.Text.StringBuilder buffer,uint size);
 [System.Runtime.InteropServices.DllImport("kernel32.dll",CharSet=System.Runtime.InteropServices.CharSet.Unicode,SetLastError=true)] static extern bool CreateHardLink(string file,string existing,IntPtr security);
 readonly string root=Path.Combine(Environment.GetEnvironmentVariable("AI_BUDDY_INSTALLER_TEST_ROOT")??Path.GetTempPath(),"AI Buddy installer tests "+Guid.NewGuid().ToString("N"));int passed;
 void Assert(bool condition,string message){if(!condition)throw new Exception(message);}
 async Task Test(string name,Func<Task> action){await action();passed++;Console.WriteLine("PASS "+name);}
 async Task Reject(Func<Task> action){try{await action();}catch(Exception e) when(e is IOException or InvalidDataException or UnauthorizedAccessException){return;}throw new Exception("Expected rejection");}
 Package Zip(string id,string mount,Dictionary<string,byte[]> files,string? edition=null) {
  Directory.CreateDirectory(root);var path=Path.Combine(root,id+".zip");using(var zip=ZipFile.Open(path,ZipArchiveMode.Create))foreach(var f in files){var entry=zip.CreateEntry(f.Key);using var s=entry.Open();s.Write(f.Value);}
  var index=files.Select(f=>new InstallFile(f.Key,f.Value.Length,Hashing.Bytes(f.Value))).ToArray();return new(id,"test",mount,id+".zip",new FileInfo(path).Length,files.Values.Sum(b=>(long)b.Length),Hashing.FileHash(path).Result,[],index,Edition:edition,FilesSha256:Manifests.IndexHash(index));
 }
 InstallManifest Fixture(Package[] p)=>new(1,"1.9.0","v1.9.0","lXiaoSel1/AI-Buddy","win32","x64","1.9.0",1,"30fps","deepseek",["root","runtime"],new("AI Buddy.exe",p.Single(p=>p.Id=="runtime").Files[0].Sha256),[new("30fps","30fps","app30"),new("60fps","60fps","app60")],[new("deepseek","DeepSeek","character",new(){["30fps"]=["motion30"],["60fps"]=["motion60"]})],p);
 public async Task Run() {
  await Test("real Windows named pipe uses exactly one JSON line",async()=>{
   var name="ai-buddy-pipe-test-"+Guid.NewGuid().ToString("N");
   using var server=new System.IO.Pipes.NamedPipeServerStream(name,System.IO.Pipes.PipeDirection.InOut,1,System.IO.Pipes.PipeTransmissionMode.Byte,System.IO.Pipes.PipeOptions.Asynchronous);
   var serving=Task.Run(async()=>{await server.WaitForConnectionAsync();using var reader=new StreamReader(server,Encoding.UTF8,false,1024,true);var line=await reader.ReadLineAsync();using var doc=JsonDocument.Parse(line!);Assert(doc.RootElement.GetProperty("command").GetString()=="installation-status","JSONL command");await server.WriteAsync("{\"ready\":true}\n"u8.ToArray());await server.FlushAsync();server.Disconnect();});
   var reply=await AiBuddy.Setup.WindowsHost.Request(name,new{command="installation-status"},5000,default);await serving;Assert(reply?.GetProperty("ready").GetBoolean()==true,"pipe response");
  });
  await Test("Windows short user-profile aliases normalize consistently",()=>{var longPath=Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);var buffer=new System.Text.StringBuilder(32768);var count=GetShortPathName(longPath,buffer,(uint)buffer.Capacity);if(count>0&&count<buffer.Capacity)Assert(SafePaths.Full(buffer.ToString())==SafePaths.Full(longPath),"short path identity");return Task.CompletedTask;});
  await Test("atomic metadata replacement waits for a short sharing lock",async()=>{
   var path=Path.Combine(root,"atomic-metadata.json");Json.Save(path,new{value="old"});var held=new FileStream(path,FileMode.Open,FileAccess.Read,FileShare.Read);var saving=Task.Run(()=>Json.Save(path,new{value="new"}));await Task.Delay(250);held.Dispose();await saving;using var doc=JsonDocument.Parse(File.ReadAllBytes(path));Assert(doc.RootElement.GetProperty("value").GetString()=="new","metadata rename recovers after transient sharing lock");
  });
  await Test("legacy app is retained for tray exit without sending unverified quit",async()=>{
   var name="ai-buddy-legacy-stop-"+Guid.NewGuid().ToString("N");var commands=new List<string>();var target=Path.Combine(root,"legacy-stop");var build=Path.Combine(target,"builds/old");Directory.CreateDirectory(build);
   var serving=Task.Run(async()=>{for(int n=0;n<2;n++){using var server=new System.IO.Pipes.NamedPipeServerStream(name,System.IO.Pipes.PipeDirection.InOut,1,System.IO.Pipes.PipeTransmissionMode.Byte,System.IO.Pipes.PipeOptions.Asynchronous);await server.WaitForConnectionAsync();using var reader=new StreamReader(server,Encoding.UTF8,false,1024,true);using var doc=JsonDocument.Parse((await reader.ReadLineAsync())!);commands.Add(doc.RootElement.GetProperty("command").GetString()!);var response=n==0?JsonSerializer.Serialize(new{error="Unsupported local command"}):JsonSerializer.Serialize(new{build,settings=new{modelConnections=new{busy=false},cgConnections=new{busy=false}}});await server.WriteAsync(Encoding.UTF8.GetBytes(response+"\n"));await server.FlushAsync();}});
   var installed=new Installation(1,"1.8.0",new string('0',64),"30fps",["deepseek"],"deepseek","builds/old","runtime/old","maintenance/old.exe",null,name,DateTimeOffset.UtcNow,new());await Reject(()=>new AiBuddy.Setup.WindowsHost().Stop(target,installed,null,default));await serving;Assert(commands.SequenceEqual(new[]{"installation-status","snapshot"}),"only inspect legacy process, never issue quit");
  });
  await Test("connected but stalled app blocks commit without a quit acknowledgement",async()=>{
   var name="ai-buddy-stalled-stop-"+Guid.NewGuid().ToString("N");using var server=new System.IO.Pipes.NamedPipeServerStream(name,System.IO.Pipes.PipeDirection.InOut,1,System.IO.Pipes.PipeTransmissionMode.Byte,System.IO.Pipes.PipeOptions.Asynchronous);var commands=new List<string>();
   var serving=Task.Run(async()=>{await server.WaitForConnectionAsync();using var reader=new StreamReader(server,Encoding.UTF8,false,1024,true);using var doc=JsonDocument.Parse((await reader.ReadLineAsync())!);commands.Add(doc.RootElement.GetProperty("command").GetString()!);await Task.Delay(2200);});
   var installed=new Installation(1,"1.8.0",new string('0',64),"30fps",["deepseek"],"deepseek","builds/old","runtime/old","maintenance/old.exe",null,name,DateTimeOffset.UtcNow,new());await Reject(()=>new AiBuddy.Setup.WindowsHost().Stop(root,installed,null,default));await serving;Assert(commands.SequenceEqual(new[]{"installation-status"}),"stalled process was not told to quit and cannot count as stopped");
  });
  var p=new[]{Zip("root","root",new(){["AI Buddy.exe"]="launcher"u8.ToArray()}),Zip("runtime","runtime",new(){["AI Buddy.exe"]="runtime"u8.ToArray()}),Zip("app30","build",new(){["main.cjs"]="30"u8.ToArray()},"30fps"),Zip("app60","build",new(){["main.cjs"]="60"u8.ToArray()},"60fps"),Zip("character","build",new(){["assets/portrait.webp"]="portrait"u8.ToArray()}),Zip("motion30","build",new(){["assets/motion.webm"]="motion30"u8.ToArray()},"30fps"),Zip("motion60","build",new(){["assets/motion.webm"]="motion60"u8.ToArray()},"60fps")};
  var m=Fixture(p);var bytes=JsonSerializer.SerializeToUtf8Bytes(m,Json.Options);var hash=Hashing.Bytes(bytes);await File.WriteAllBytesAsync(Path.Combine(root,"install-manifest-1.9.0.json"),bytes);
  await Test("fixed manifest and both editions",()=>{Manifests.Parse(bytes,hash);Assert(Manifests.Select(m,"30fps",["deepseek"],"deepseek").Length==5,"dependencies");return Task.CompletedTask;});
  await Test("manifest tamper",()=>Reject(()=>{Manifests.Parse(bytes,new string('0',64));return Task.CompletedTask;}));
  await Test("wrong version",()=>Reject(()=>{Manifests.Validate(m with {AppVersion="latest"});return Task.CompletedTask;}));
  await Test("old fixed manifest is not accepted as 1.9",()=>Reject(()=>{Manifests.Validate(m with {AppVersion="1.8.0",ReleaseTag="v1.8.0",MinimumInstallerVersion="1.8.0"});return Task.CompletedTask;}));
  await Test("dependency cycle",()=>Reject(()=>{Manifests.Validate(m with{Packages=p.Select(x=>x.Id=="root"?x with{DependsOn=["root"]}:x).ToArray()});return Task.CompletedTask;}));
  await Test("mixed edition dependency",()=>Reject(()=>{Manifests.Validate(m with{RequiredPackageIds=["root","runtime","app60"]});return Task.CompletedTask;}));
  await Test("initial character must be installed",()=>Reject(()=>{Manifests.Select(m,"30fps",[],"deepseek");return Task.CompletedTask;}));
  await Test("no duplicate target",()=>Reject(()=>{Manifests.Validate(m with{RequiredPackageIds=["root","runtime","app30","app60"]});return Task.CompletedTask;}));
  await Test("packages <=1GiB",()=>Reject(()=>{Manifests.Validate(m with{Packages=p.Select((x,i)=>i==0?x with{Bytes=Manifests.PackageLimit+1}:x).ToArray()});return Task.CompletedTask;}));
  foreach(var path in new[]{"../outside","a/../../b","C:/windows","/root","a\\b","CON.txt","a:stream","a/ b.","a//b"})await Test("reject path "+path,()=>Reject(()=>{SafePaths.Relative(path);return Task.CompletedTask;}));
  await Test("safe extraction and restart",async()=>{var dest=Path.Combine(root,"extract");await Extractor.Extract(p[4],Path.Combine(root,p[4].AssetName),dest,null,default);await Extractor.Extract(p[4],Path.Combine(root,p[4].AssetName),dest,null,default);Assert(File.ReadAllText(Path.Combine(dest,"assets/portrait.webp"))=="portrait","extracted");});
  var malicious=Zip("zip-slip","build",new(){["../outside"]=[1]});await Test("ZIP traversal blocked",()=>Reject(()=>Extractor.Extract(malicious,Path.Combine(root,malicious.AssetName),Path.Combine(root,"malicious"),null,default)));
  var wrong=p[4] with {Files=[p[4].Files[0] with {Sha256=new string('0',64)}]};await Test("expanded file integrity",()=>Reject(()=>Extractor.Extract(wrong,Path.Combine(root,p[4].AssetName),Path.Combine(root,"wrong"),null,default)));
  var body=await File.ReadAllBytesAsync(Path.Combine(root,p[4].AssetName));var url=new Uri("https://example.test/package");
  foreach(var mode in new[]{"200","206","200-resume","checkpoint","416","etag-change","429","timeout","truncated","hash-mismatch","404","invalid-range"})await Test("HTTP "+mode,async()=>{
   int calls=0;var cache=Path.Combine(root,"http-"+mode);Directory.CreateDirectory(cache);int offset=body.Length/2;
   if(mode is "206" or "200-resume" or "checkpoint" or "416" or "etag-change" or "invalid-range"){
    var partial=Path.Combine(cache,p[4].Sha256+".zip.partial");await File.WriteAllBytesAsync(partial,body[..(mode=="checkpoint"?offset+3:offset)]);Json.Save(partial+".json",new DownloadState(p[4].Id,m.ReleaseTag,p[4].Bytes,p[4].Sha256,offset,"\"old\"",null));
   }
   using var http=new HttpClient(new Handler(async(req,ct)=>{
    calls++;var start=req.Headers.Range?.Ranges.First().From??0;
    if(mode=="404")return new(HttpStatusCode.NotFound);
    if(mode=="429"&&calls==1){var limited=new HttpResponseMessage(HttpStatusCode.TooManyRequests);limited.Headers.RetryAfter=new RetryConditionHeaderValue(TimeSpan.FromMilliseconds(1));return limited;}
    if(mode=="timeout"&&calls==1)await Task.Delay(1000,ct);
    if(mode=="416"&&calls==1)return new(HttpStatusCode.RequestedRangeNotSatisfiable);
    bool range=start>0&&mode!="200-resume";var chunk=range?body[(int)start..]:body;
    if(mode=="hash-mismatch")chunk=chunk.Select(b=>(byte)(b^1)).ToArray();
    var response=new HttpResponseMessage(range?HttpStatusCode.PartialContent:HttpStatusCode.OK){Content=new ByteArrayContent(chunk)};
    response.Headers.ETag=new EntityTagHeaderValue(mode=="etag-change"?"\"new\"":"\"old\"");
    if(range)response.Content.Headers.ContentRange=new ContentRangeHeaderValue(mode=="invalid-range"?start+1:start,body.Length-1,body.Length);
    if(mode=="truncated"&&calls==1){response.Content=new ByteArrayContent(body[..offset]);response.Content.Headers.ContentLength=body.Length;}
    return response;
   }));
   var download=new Downloader(http,TimeSpan.FromMilliseconds(150));
   if(mode is "404" or "invalid-range" or "hash-mismatch")await Reject(()=>download.Get(p[4],m.ReleaseTag,url,cache,null,default));
   else {var file=await download.Get(p[4],m.ReleaseTag,url,cache,null,default);Assert(await Hashing.FileHash(file)==p[4].Sha256,"download hash");}
   if(mode=="404")Assert(calls==1,"nonretryable");if(mode=="hash-mismatch")Assert(calls==3,"bounded retries");
  });
  using var unusedHttp=new HttpClient(new Handler((_,_)=>throw new Exception("offline must not request network")));
  var host=new FakeHost();var engine=new InstallEngine(m,bytes,hash,new Downloader(unusedHttp),host,Path.Combine(root,"root.zip"));var installRoot=Path.Combine(root,"中文 安装");
  var options=new InstallOptions(installRoot,Path.Combine(root,"cache"),"30fps",["deepseek"],"deepseek",root,false,true);
  await Test("space estimate reserves staging, root backup and manager",()=>{var e=engine.Estimate(options);var selected=Manifests.Select(m,"30fps",["deepseek"],"deepseek");Assert(e.InstallAdditionalBytes>e.ExpandedBytes+2*selected.Where(x=>x.Mount=="root").Sum(x=>x.UnpackedBytes)+new FileInfo(Path.Combine(root,"root.zip")).Length+bytes.Length,"all simultaneous copies reserved");return Task.CompletedTask;});
  await Test("offline install, zero network, verified startup",async()=>{var record=await engine.Install(options,null,default);Assert(record.Edition=="30fps"&&host.Starts==1,"offline installation");});
  var data=Path.Combine(installRoot,"local/data-v003/keep.json");Directory.CreateDirectory(Path.GetDirectoryName(data)!);await File.WriteAllTextAsync(data,"original save");
  await Test("edition switch preserves save",async()=>{await engine.Install(options with {Edition="60fps"},null,default);Assert(File.ReadAllText(data)=="original save","preserve");});
  await File.WriteAllTextAsync(data,"new save after update");
  await Test("rollback keeps newly created data",async()=>{await engine.Rollback(installRoot,null,default);Assert(InstallEngine.Existing(installRoot)!.Edition=="30fps"&&File.ReadAllText(data)=="new save after update","rollback");});
  foreach(var phase in new[]{"extracted","root-files","pointer","launched"})await Test("failure recovery "+phase,async()=>{
   var failure=new InstallEngine(m,bytes,hash,new Downloader(unusedHttp),host,Path.Combine(root,"root.zip"),checkpoint:s=>{if(s==phase)throw new IOException("injected failure");});
   await Reject(()=>failure.Install(options with {Edition="60fps"},null,default));Assert(InstallEngine.Existing(installRoot)!.Edition=="30fps"&&File.ReadAllText(data)=="new save after update","failed commit rollback");
  });
  await Test("compatible startup failure restores program",async()=>{host.FailStart=true;await Reject(()=>engine.Install(options with{Edition="60fps"},null,default));host.FailStart=false;Assert(InstallEngine.Existing(installRoot)!.Edition=="30fps","startup rollback");});
  await Test("disk requirements cover shared drive peak",()=>Reject(()=>{InstallEngine.ValidateSpace(new(100,200,100,200,300),299,299,true);return Task.CompletedTask;}));
  await Test("different cache drive shortage",()=>Reject(()=>{InstallEngine.ValidateSpace(new(100,200,100,200,300),500,99,false);return Task.CompletedTask;}));
  await Test("simultaneous installation lock",async()=>{using var locked=new FileStream(Path.Combine(installRoot,"local/installer/install.lock"),FileMode.Open,FileAccess.ReadWrite,FileShare.None);await Reject(()=>engine.Install(options,null,default));});
  await Test("non-directory destination rejected",async()=>{var file=Path.Combine(root,"not-a-folder");File.WriteAllText(file,"preserve");await Reject(()=>engine.Install(options with{Root=file},null,default));Assert(File.ReadAllText(file)=="preserve","unwritable preserves file");});
  await Test("offline missing packages do not create a launcher",async()=>{var empty=Path.Combine(root,"empty-offline");Directory.CreateDirectory(empty);File.Copy(Path.Combine(root,"install-manifest-1.9.0.json"),Path.Combine(empty,"install-manifest-1.9.0.json"));var target=Path.Combine(root,"missing-install");await Reject(()=>engine.Install(options with{Root=target,OfflineDirectory=empty},null,default));Assert(!File.Exists(Path.Combine(target,"AI Buddy.exe")),"no incomplete shortcut target");});
  await Test("cancel before commit preserves previous program",async()=>{using var cancel=new CancellationTokenSource();cancel.Cancel();try{await engine.Install(options with{Edition="60fps"},null,cancel.Token);throw new Exception("Expected cancellation");}catch(OperationCanceledException){}Assert(InstallEngine.Existing(installRoot)!.Edition=="30fps","cancel old pointer");});
  await Test("persisted committing journal recovery",async()=>{
   var control=Path.Combine(installRoot,"local/installer");var journal=Json.Read<InstallJournal>(Path.Combine(control,"transaction.json"));
   Json.Save(Path.Combine(control,"transaction.json"),journal with{Phase="committing"});
   File.WriteAllText(Path.Combine(installRoot,"local/current-build.json"),"{\"path\":\"interrupted-target\"}");
   await engine.Install(options,null,default);Assert(InstallEngine.Existing(installRoot)!.Edition=="30fps"&&File.ReadAllText(data)=="new save after update","recovery plus retry");
  });
  await Test("transaction path injection rejected",async()=>{var path=Path.Combine(installRoot,"local/installer/transaction.json");var journal=Json.Read<InstallJournal>(path);Json.Save(path,journal with{Build="local/data-v003",Phase="committing"});await Reject(()=>engine.Install(options,null,default));Assert(File.ReadAllText(data)=="new save after update","no data mutation");Json.Save(path,journal);});
  await Test("real loopback HTTP redirect and range",async()=>{
   using var probe=new System.Net.Sockets.TcpListener(IPAddress.Loopback,0);probe.Start();int port=((IPEndPoint)probe.LocalEndpoint).Port;probe.Stop();
   using var server=new HttpListener();server.Prefixes.Add($"http://127.0.0.1:{port}/");server.Start();
   var cache=Path.Combine(root,"real-http");Directory.CreateDirectory(cache);var partial=Path.Combine(cache,p[4].Sha256+".zip.partial");int offset=body.Length/2;File.WriteAllBytes(partial,body[..offset]);Json.Save(partial+".json",new DownloadState(p[4].Id,m.ReleaseTag,p[4].Bytes,p[4].Sha256,offset,"\"old\"",null));
   var serving=Task.Run(async()=>{for(int i=0;i<2;i++){var c=await server.GetContextAsync();if(c.Request.Url!.AbsolutePath=="/redirect"){c.Response.StatusCode=302;c.Response.RedirectLocation=$"http://127.0.0.1:{port}/data";}else{Assert(c.Request.Headers["Range"]==$"bytes={offset}-","actual HTTP Range");c.Response.StatusCode=206;c.Response.Headers["ETag"]="\"old\"";c.Response.Headers["Content-Range"]=$"bytes {offset}-{body.Length-1}/{body.Length}";c.Response.ContentLength64=body.Length-offset;await c.Response.OutputStream.WriteAsync(body.AsMemory(offset));}c.Response.Close();}});
   using var http=new HttpClient();var got=await new Downloader(http).Get(p[4],m.ReleaseTag,new Uri($"http://127.0.0.1:{port}/redirect"),cache,null,default);await serving;Assert(await Hashing.FileHash(got)==p[4].Sha256,"real HTTP verified");
  });
  await Test("valid current pointer edition wins over stale installation record",()=>{
   var pointer=Path.Combine(installRoot,"local/current-build.json");var old=File.ReadAllText(pointer);using var doc=JsonDocument.Parse(old);var target=doc.RootElement.GetProperty("path").GetString();Json.Save(pointer,new{path=target,animationProfile="60fps"});Assert(InstallEngine.Defaults(installRoot,m).Edition=="60fps","actual current edition");File.WriteAllText(pointer,old);return Task.CompletedTask;
  });
  await Test("missing pointer target cannot change selected edition",()=>{
   var pointer=Path.Combine(installRoot,"local/current-build.json");var old=File.ReadAllText(pointer);Json.Save(pointer,new{path="builds/missing",animationProfile="60fps"});Assert(InstallEngine.Defaults(installRoot,m).Edition=="30fps","ignore missing target");File.WriteAllText(pointer,old);return Task.CompletedTask;
  });
  await Test("portable resource index retains actual selected roles and edition",()=>{
   var portable=Path.Combine(root,"portable-defaults");var build=Path.Combine(portable,"builds/old");Directory.CreateDirectory(Path.Combine(build,"assets"));File.WriteAllText(Path.Combine(build,"assets/portrait.webp"),"partial role");Json.Save(Path.Combine(portable,"local/current-build.json"),new{path="builds/old",animationProfile="30fps"});Json.Save(Path.Combine(build,"assets/install-resource-index.json"),new{version=1,appVersion="1.8.0",edition="60fps",defaultCharacter="deepseek",characters=new{deepseek=new[]{new{path="assets/portrait.webp",bytes=123,sha256=new string('0',64)}}}});
   var extra=m.Characters[0] with{Id="claude",Name="Claude"};var defaults=InstallEngine.Defaults(portable,m with{Characters=[m.Characters[0],extra]});Assert(defaults.Edition=="60fps"&&defaults.Characters.SequenceEqual(new[]{"deepseek"}),"portable defaults preserve present role, even if damaged");return Task.CompletedTask;
  });
  await Test("unknown recorded role rejects rather than silently dropping it",()=>Reject(()=>{var target=Path.Combine(root,"unknown-record");Json.Save(InstallEngine.RecordPath(target),InstallEngine.Existing(installRoot)! with{Characters=["unknown"]});InstallEngine.Defaults(target,m);return Task.CompletedTask;}));
  await Test("recorded custom data and pipe survive upgrade and rollback",async()=>{
   var target=Path.Combine(root,"custom-install");var custom=Path.Combine(root,"custom data");Directory.CreateDirectory(custom);File.WriteAllText(Path.Combine(custom,"keep.txt"),"custom saved");
   var first=await engine.Install(options with{Root=target,DataPath=custom,Pipe="isolated-old-pipe"},null,default);var next=await engine.Install(options with{Root=target,Edition="60fps",DataPath="ignored",Pipe="ignored"},null,default);Assert(next.DataPath==custom&&next.Pipe=="isolated-old-pipe","recorded configuration kept");await engine.Rollback(target,null,default);Assert(File.ReadAllText(Path.Combine(custom,"keep.txt"))=="custom saved"&&InstallEngine.Existing(target)!.Pipe=="isolated-old-pipe","custom rollback retained");
  });
  await Test("unrecorded portable discovers custom data on requested isolated pipe",async()=>{
   var target=Path.Combine(root,"portable-takeover");Json.Save(Path.Combine(target,"local/current-build.json"),new{version="1.8.0",path="builds/portable"});host.DiscoveredData=Path.Combine(root,"portable data");var installed=await engine.Install(options with{Root=target,Pipe="portable-test-pipe"},null,default);Assert(installed.DataPath==host.DiscoveredData&&installed.Pipe=="portable-test-pipe"&&host.DiscoveryPipe=="portable-test-pipe"&&host.LastStoppedPipe=="portable-test-pipe","portable takeover discovery and stop isolated");host.DiscoveredData=null;
  });
  await Test("atomic root replacement preserves historical hardlinks",async()=>{
   var target=Path.Combine(root,"hardlink-install");await engine.Install(options with{Root=target},null,default);var source=Path.Combine(target,"AI Buddy.exe");File.WriteAllText(source,"historical launcher");var archive=Path.Combine(root,"historical-launcher.exe");Assert(CreateHardLink(archive,source,IntPtr.Zero),"create test hardlink");await engine.Install(options with{Root=target,Edition="60fps"},null,default);Assert(File.ReadAllText(archive)=="historical launcher"&&File.ReadAllText(source)=="launcher","upgrade replaced directory entry");await engine.Rollback(target,null,default);Assert(File.ReadAllText(archive)=="historical launcher"&&File.ReadAllText(source)=="historical launcher","rollback replaced directory entry");
  });
  await Test("ready safe mode is recorded without treating it as complete feature startup",async()=>{
   host.Startup=new(true,JsonSerializer.SerializeToElement(new{scope="companion",message="fixture failure"}));var installed=await engine.Install(options with{Root=Path.Combine(root,"safe-mode")},null,default);Assert(installed.Startup?.SafeMode==true&&installed.Startup.StartupFailure?.GetProperty("scope").GetString()=="companion","safe mode receipt");host.Startup=null;
  });
  await Test("legacy 1.8 transaction layout recovers without AppVersion",async()=>{
   var target=Path.Combine(root,"legacy-journal");var id=Guid.NewGuid().ToString("N");var oldOptions=options with{Root=target};var journal=new InstallJournal(id,"committing",new string('0',64),oldOptions,null,null,$"builds/v1.8.0-30fps-{id}",$"runtime/AI-Buddy-v1.8.0-{id}",["AI Buddy.exe"],[]);
   Directory.CreateDirectory(Path.Combine(target,journal.Build));Directory.CreateDirectory(Path.Combine(target,journal.Runtime));File.WriteAllText(Path.Combine(target,"AI Buddy.exe"),"interrupted");Json.Save(Path.Combine(target,"local/installer/transaction.json"),journal);await engine.Install(oldOptions,null,default);Assert(InstallEngine.Existing(target)!.Version=="1.9.0"&&!Directory.Exists(Path.Combine(target,journal.Build)),"legacy recovery and install");
  });
  await Test("first upgrade startup failure after new life data retains controlled compatible repair",async()=>{
   var target=Path.Combine(root,"first-upgrade-life-failure");var prior=await engine.Install(options with{Root=target},null,default);var pointer=Path.Combine(target,"local/current-build.json");using(var doc=JsonDocument.Parse(File.ReadAllBytes(pointer))){var old=doc.RootElement.Deserialize<Dictionary<string,JsonElement>>(Json.Options)!;old["appVersion"]=JsonSerializer.SerializeToElement("1.8.0");old["version"]=JsonSerializer.SerializeToElement("1.8.0");Json.Save(pointer,old);}Json.Save(InstallEngine.RecordPath(target),prior with{Version="1.8.0"});
   var snapshots=Path.Combine(target,"local/data-v003/galgame/companion.json.snapshots");var payload=Encoding.UTF8.GetBytes("{\"schema\":1,\"lives\":{\"deepseek\":{\"id\":\"new-life-on-first-start\"}}}");
   var failing=new InstallEngine(m,bytes,hash,new Downloader(unusedHttp),host,Path.Combine(root,"root.zip"),checkpoint:phase=>{if(phase!="pointer")return;Directory.CreateDirectory(snapshots);File.WriteAllBytes(Path.Combine(snapshots,"first-start.json"),payload);File.WriteAllText(Path.Combine(snapshots,"commits.jsonl"),JsonSerializer.Serialize(new{file="first-start.json",sha256=Hashing.Bytes(payload)}));throw new IOException("injected first-start failure after life snapshot");});
   await Reject(()=>failing.Install(options with{Root=target,Edition="60fps"},null,default));var journal=Json.Read<InstallJournal>(Path.Combine(target,"local/installer/transaction.json"));Assert(journal.Phase=="recovery-required"&&InstallEngine.Existing(target)!.Version=="1.9.0","never hand new data to old 1.8; explicit controlled recovery");Assert(Directory.Exists(Path.Combine(target,prior.Build))&&Directory.Exists(Path.Combine(target,journal.Build)),"both program versions retained");Assert(File.Exists(Path.Combine(target,"local/installer/recovery-required",journal.Id+".json")),"recoverable receipt retained");Assert(File.ReadAllBytes(Path.Combine(snapshots,"first-start.json")).SequenceEqual(payload),"new life data unchanged");await engine.Install(options with{Root=target,Edition="60fps"},null,default);Assert(Json.Read<InstallJournal>(Path.Combine(target,"local/installer/transaction.json")).Phase=="complete"&&File.ReadAllBytes(Path.Combine(snapshots,"first-start.json")).SequenceEqual(payload),"compatible repair proceeds without downgrade or data replacement");
  });
  await Test("persisted committing crash with new life data proceeds through compatible repair",async()=>{
   var target=Path.Combine(root,"interrupted-first-upgrade");var prior=await engine.Install(options with{Root=target},null,default);var pointer=Path.Combine(target,"local/current-build.json");using(var doc=JsonDocument.Parse(File.ReadAllBytes(pointer))){var old=doc.RootElement.Deserialize<Dictionary<string,JsonElement>>(Json.Options)!;old["appVersion"]=JsonSerializer.SerializeToElement("1.8.0");old["version"]=JsonSerializer.SerializeToElement("1.8.0");Json.Save(pointer,old);}var oldPointer=File.ReadAllText(pointer);var oldRecord=JsonSerializer.Serialize(prior with{Version="1.8.0"},Json.Options);
   var id=Guid.NewGuid().ToString("N");var failedBuild=$"builds/v1.9.0-60fps-{id}";var failedRuntime=$"runtime/AI-Buddy-v1.9.0-{id}";Directory.CreateDirectory(Path.Combine(target,failedBuild));Directory.CreateDirectory(Path.Combine(target,failedRuntime));File.WriteAllText(Path.Combine(target,failedBuild,"main.cjs"),"interrupted new build");var crash=new InstallJournal(id,"committing",hash,options with{Root=target,Edition="60fps"},oldPointer,oldRecord,failedBuild,failedRuntime,["AI Buddy.exe"],["AI Buddy.exe"],"1.9.0");
   Json.Save(Path.Combine(target,"local/installer/transaction.json"),crash);Json.Save(InstallEngine.RecordPath(target),prior with{Edition="60fps",Build=failedBuild,Runtime=failedRuntime});Json.Save(pointer,new{version="1.9.0",appVersion="1.9.0",path=failedBuild,animationProfile="60fps"});var snapshots=Path.Combine(target,"local/data-v003/galgame/companion.json.snapshots");Directory.CreateDirectory(snapshots);var payload=Encoding.UTF8.GetBytes("{\"schema\":1,\"lives\":{\"deepseek\":{\"id\":\"life-before-power-loss\"}}}");File.WriteAllBytes(Path.Combine(snapshots,"power-loss.json"),payload);File.WriteAllText(Path.Combine(snapshots,"commits.jsonl"),JsonSerializer.Serialize(new{file="power-loss.json",sha256=Hashing.Bytes(payload)}));
   await engine.Install(options with{Root=target,Edition="60fps"},null,default);Assert(Json.Read<InstallJournal>(Path.Combine(target,"local/installer/transaction.json")).Phase=="complete"&&InstallEngine.Existing(target)!.Version=="1.9.0","interrupted upgrade is not stuck in committing and repairs compatibly");Assert(File.Exists(Path.Combine(target,"local/installer/recovery-required",id+".json"))&&Directory.Exists(Path.Combine(target,prior.Build))&&Directory.Exists(Path.Combine(target,failedBuild)),"controlled crash receipt and both prior trees retained");Assert(File.ReadAllBytes(Path.Combine(snapshots,"power-loss.json")).SequenceEqual(payload),"new life data byte unchanged after crash recovery");
  });
  foreach(var danger in new[]{"media","lives","unknown-commit"})await Test("incompatible old-version rollback is refused: "+danger,async()=>{
   var target=Path.Combine(root,"downgrade-"+danger);var current=await engine.Install(options with{Root=target},null,default);var pp=Path.Combine(target,"local/current-build.json");using(var doc=JsonDocument.Parse(File.ReadAllBytes(pp))){var pointer=doc.RootElement.Deserialize<Dictionary<string,JsonElement>>(Json.Options)!;pointer["appVersion"]=JsonSerializer.SerializeToElement("1.8.0");pointer["version"]=JsonSerializer.SerializeToElement("1.8.0");Json.Save(pp,pointer);}Json.Save(InstallEngine.RecordPath(target),current with{Version="1.8.0"});
   await engine.Install(options with{Root=target,Edition="60fps"},null,default);var before=File.ReadAllText(pp);var state=Path.Combine(target,"local/data-v003/galgame");Directory.CreateDirectory(state);
   if(danger=="media"){Directory.CreateDirectory(Path.Combine(state,"media"));File.WriteAllText(Path.Combine(state,"media/new.png"),"new media");}
   else {var snapshots=Path.Combine(state,"companion.json.snapshots");Directory.CreateDirectory(snapshots);var payload=Encoding.UTF8.GetBytes("{\"schema\":1,\"lives\":{\"deepseek\":{\"id\":\"new-life\"}}}");File.WriteAllBytes(Path.Combine(snapshots,"new.json"),payload);File.WriteAllText(Path.Combine(snapshots,"commits.jsonl"),danger=="unknown-commit"?"torn-unverifiable":JsonSerializer.Serialize(new{file="new.json",sha256=Hashing.Bytes(payload)}));}
   var paths=Directory.GetFiles(state,"*",SearchOption.AllDirectories).ToDictionary(x=>x,x=>Hashing.FileHash(x).Result);await Reject(()=>engine.Rollback(target,null,default));Assert(File.ReadAllText(pp)==before&&paths.All(x=>Hashing.FileHash(x.Key).Result==x.Value),"refusal retains current program and all new data");
  });
  await Test("uninstall retains personal data and unknown files",async()=>{var unknown=Path.Combine(installRoot,"my-notes.txt");File.WriteAllText(unknown,"user");await engine.Uninstall(installRoot,false,null,default);Assert(File.Exists(data)&&File.Exists(unknown),"uninstall save retention");});
  Console.WriteLine(JsonSerializer.Serialize(new{passed,root},Json.Options));
 }
}
sealed class Handler(Func<HttpRequestMessage,CancellationToken,Task<HttpResponseMessage>> action):HttpMessageHandler {protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request,CancellationToken cancel)=>action(request,cancel);}
sealed class FakeHost:IAppHost {
 public int Starts;public bool FailStart;
 public StartupStatus? Startup;public StartupStatus? LastStartup=>Startup;
 public string? DiscoveredData,DiscoveryPipe,LastStoppedPipe;
 public Task<string?> DiscoverDataPath(string root,string? pipe,CancellationToken cancel){DiscoveryPipe=pipe;return Task.FromResult(DiscoveredData);}
 public Task Stop(string root,Installation? previous,IProgress<InstallProgress>? progress,CancellationToken cancel){LastStoppedPipe=previous?.Pipe;return Task.CompletedTask;}
 public Task StartAndVerify(string root,Installation installed,CancellationToken cancel){Starts++;if(FailStart)throw new IOException("simulated start failure");return Task.CompletedTask;}
 public Task CreateShortcuts(string root,Installation installed,CancellationToken cancel)=>Task.CompletedTask;
 public Task RemoveShortcuts(string root,CancellationToken cancel)=>Task.CompletedTask;
}
