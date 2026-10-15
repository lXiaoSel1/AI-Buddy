using AiBuddy.Install;
using System.IO.Compression;
using System.Net;
using System.Net.Http.Headers;
using System.Text;
using System.Text.Json;
var suite=new Suite();await suite.Run();

sealed class Suite {
 readonly string root=Path.Combine(Path.GetTempPath(),"AI Buddy installer tests "+Guid.NewGuid().ToString("N"));int passed;
 void Assert(bool condition,string message){if(!condition)throw new Exception(message);}
 async Task Test(string name,Func<Task> action){await action();passed++;Console.WriteLine("PASS "+name);}
 async Task Reject(Func<Task> action){try{await action();}catch(Exception e) when(e is IOException or InvalidDataException or UnauthorizedAccessException){return;}throw new Exception("Expected rejection");}
 Package Zip(string id,string mount,Dictionary<string,byte[]> files,string? edition=null) {
  Directory.CreateDirectory(root);var path=Path.Combine(root,id+".zip");using(var zip=ZipFile.Open(path,ZipArchiveMode.Create))foreach(var f in files){var entry=zip.CreateEntry(f.Key);using var s=entry.Open();s.Write(f.Value);}
  var index=files.Select(f=>new InstallFile(f.Key,f.Value.Length,Hashing.Bytes(f.Value))).ToArray();return new(id,"test",mount,id+".zip",new FileInfo(path).Length,files.Values.Sum(b=>(long)b.Length),Hashing.FileHash(path).Result,[],index,Edition:edition,FilesSha256:Manifests.IndexHash(index));
 }
 InstallManifest Fixture(Package[] p)=>new(1,"1.8.0","v1.8.0","lXiaoSel1/AI-Buddy","win32","x64","1.8.0",1,"30fps","deepseek",["root","runtime"],new("AI Buddy.exe",p.Single(p=>p.Id=="runtime").Files[0].Sha256),[new("30fps","30fps","app30"),new("60fps","60fps","app60")],[new("deepseek","DeepSeek","character",new(){["30fps"]=["motion30"],["60fps"]=["motion60"]})],p);
 public async Task Run() {
  await Test("real Windows named pipe uses exactly one JSON line",async()=>{
   var name="ai-buddy-pipe-test-"+Guid.NewGuid().ToString("N");
   using var server=new System.IO.Pipes.NamedPipeServerStream(name,System.IO.Pipes.PipeDirection.InOut,1,System.IO.Pipes.PipeTransmissionMode.Byte,System.IO.Pipes.PipeOptions.Asynchronous);
   var serving=Task.Run(async()=>{await server.WaitForConnectionAsync();using var reader=new StreamReader(server,Encoding.UTF8,false,1024,true);var line=await reader.ReadLineAsync();using var doc=JsonDocument.Parse(line!);Assert(doc.RootElement.GetProperty("command").GetString()=="installation-status","JSONL command");await server.WriteAsync("{\"ready\":true}\n"u8.ToArray());await server.FlushAsync();server.Disconnect();});
   var reply=await AiBuddy.Setup.WindowsHost.Request(name,new{command="installation-status"},5000,default);await serving;Assert(reply?.GetProperty("ready").GetBoolean()==true,"pipe response");
  });
  var p=new[]{Zip("root","root",new(){["AI Buddy.exe"]="launcher"u8.ToArray()}),Zip("runtime","runtime",new(){["AI Buddy.exe"]="runtime"u8.ToArray()}),Zip("app30","build",new(){["main.cjs"]="30"u8.ToArray()},"30fps"),Zip("app60","build",new(){["main.cjs"]="60"u8.ToArray()},"60fps"),Zip("character","build",new(){["assets/portrait.webp"]="portrait"u8.ToArray()}),Zip("motion30","build",new(){["assets/motion.webm"]="motion30"u8.ToArray()},"30fps"),Zip("motion60","build",new(){["assets/motion.webm"]="motion60"u8.ToArray()},"60fps")};
  var m=Fixture(p);var bytes=JsonSerializer.SerializeToUtf8Bytes(m,Json.Options);var hash=Hashing.Bytes(bytes);await File.WriteAllBytesAsync(Path.Combine(root,"install-manifest-1.8.0.json"),bytes);
  await Test("fixed manifest and both editions",()=>{Manifests.Parse(bytes,hash);Assert(Manifests.Select(m,"30fps",["deepseek"],"deepseek").Length==5,"dependencies");return Task.CompletedTask;});
  await Test("manifest tamper",()=>Reject(()=>{Manifests.Parse(bytes,new string('0',64));return Task.CompletedTask;}));
  await Test("wrong version",()=>Reject(()=>{Manifests.Validate(m with {AppVersion="latest"});return Task.CompletedTask;}));
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
  await Test("offline install, zero network, verified startup",async()=>{var record=await engine.Install(options,null,default);Assert(record.Edition=="30fps"&&host.Starts==1,"offline installation");});
  var data=Path.Combine(installRoot,"local/data-v003/keep.json");Directory.CreateDirectory(Path.GetDirectoryName(data)!);await File.WriteAllTextAsync(data,"original save");
  await Test("edition switch preserves save",async()=>{await engine.Install(options with {Edition="60fps"},null,default);Assert(File.ReadAllText(data)=="original save","preserve");});
  await File.WriteAllTextAsync(data,"new save after update");
  await Test("rollback keeps newly created data",async()=>{await engine.Rollback(installRoot,null,default);Assert(InstallEngine.Existing(installRoot)!.Edition=="30fps"&&File.ReadAllText(data)=="new save after update","rollback");});
  foreach(var phase in new[]{"extracted","root-files","pointer","launched"})await Test("failure recovery "+phase,async()=>{
   var failure=new InstallEngine(m,bytes,hash,new Downloader(unusedHttp),host,Path.Combine(root,"root.zip"),checkpoint:s=>{if(s==phase)throw new IOException("injected failure");});
   await Reject(()=>failure.Install(options with {Edition="60fps"},null,default));Assert(InstallEngine.Existing(installRoot)!.Edition=="30fps"&&File.ReadAllText(data)=="new save after update","failed commit rollback");
  });
  await Test("startup failure restores program",async()=>{host.FailStart=true;await Reject(()=>engine.Install(options with{Edition="60fps"},null,default));host.FailStart=false;Assert(InstallEngine.Existing(installRoot)!.Edition=="30fps","startup rollback");});
  await Test("disk requirements cover shared drive peak",()=>Reject(()=>{InstallEngine.ValidateSpace(new(100,200,100,200,300),299,299,true);return Task.CompletedTask;}));
  await Test("different cache drive shortage",()=>Reject(()=>{InstallEngine.ValidateSpace(new(100,200,100,200,300),500,99,false);return Task.CompletedTask;}));
  await Test("simultaneous installation lock",async()=>{using var locked=new FileStream(Path.Combine(installRoot,"local/installer/install.lock"),FileMode.Open,FileAccess.ReadWrite,FileShare.None);await Reject(()=>engine.Install(options,null,default));});
  await Test("non-directory destination rejected",async()=>{var file=Path.Combine(root,"not-a-folder");File.WriteAllText(file,"preserve");await Reject(()=>engine.Install(options with{Root=file},null,default));Assert(File.ReadAllText(file)=="preserve","unwritable preserves file");});
  await Test("offline missing packages do not create a launcher",async()=>{var empty=Path.Combine(root,"empty-offline");Directory.CreateDirectory(empty);File.Copy(Path.Combine(root,"install-manifest-1.8.0.json"),Path.Combine(empty,"install-manifest-1.8.0.json"));var target=Path.Combine(root,"missing-install");await Reject(()=>engine.Install(options with{Root=target,OfflineDirectory=empty},null,default));Assert(!File.Exists(Path.Combine(target,"AI Buddy.exe")),"no incomplete shortcut target");});
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
  await Test("uninstall retains personal data and unknown files",async()=>{var unknown=Path.Combine(installRoot,"my-notes.txt");File.WriteAllText(unknown,"user");await engine.Uninstall(installRoot,false,null,default);Assert(File.Exists(data)&&File.Exists(unknown),"uninstall save retention");});
  Console.WriteLine(JsonSerializer.Serialize(new{passed,root},Json.Options));
 }
}
sealed class Handler(Func<HttpRequestMessage,CancellationToken,Task<HttpResponseMessage>> action):HttpMessageHandler {protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request,CancellationToken cancel)=>action(request,cancel);}
sealed class FakeHost:IAppHost {
 public int Starts;public bool FailStart;
 public Task Stop(string root,Installation? previous,IProgress<InstallProgress>? progress,CancellationToken cancel)=>Task.CompletedTask;
 public Task StartAndVerify(string root,Installation installed,CancellationToken cancel){Starts++;if(FailStart)throw new IOException("simulated start failure");return Task.CompletedTask;}
 public Task CreateShortcuts(string root,Installation installed,CancellationToken cancel)=>Task.CompletedTask;
 public Task RemoveShortcuts(string root,CancellationToken cancel)=>Task.CompletedTask;
}
