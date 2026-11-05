using AiBuddy.Install;
using System.IO.Compression;
using System.Net;
using System.Text.Json;

namespace AiBuddy.Setup;

internal static partial class Program {
 static void CheckSnapshotUpgrades(string output) {
  foreach(var mode in new[]{"valid","bad-hash","cancel"})
   Check("WinForms 2.0.2 snapshot-only upgrade: "+mode,()=>SnapshotUpgrade(output,mode));
 }

 static void SnapshotUpgrade(string output,string mode) {
  var fixture=Path.Combine(output,"snapshot-upgrade-"+mode+"-"+Guid.NewGuid().ToString("N"));
  var root=Path.Combine(fixture,"install");
  var cache=Path.Combine(fixture,"cache");
  var data=DataPaths.Registered(root,null,false);
  var snapshots=Path.Combine(data,"settings.json.snapshots");
  var snapshot=Path.Combine(snapshots,"saved.json");
  var commits=Path.Combine(snapshots,"commits.jsonl");
  var pointer=SafePaths.Under(root,"local/current-build.json");
  var journal=SafePaths.Under(root,"local/installer/transaction.json");
  const string pipe="installer-snapshot-only-ui-fixture";
  var previous=new Installation(1,"2.0.2",new string('a',64),"30fps",["deepseek"],"deepseek",
   "builds/original","runtime/original","maintenance/original/setup.exe",null,pipe,DateTimeOffset.UtcNow,new());
  Directory.CreateDirectory(SafePaths.Under(root,previous.Build));
  Directory.CreateDirectory(SafePaths.Under(root,previous.Runtime));
  Json.Save(pointer,new{version=previous.Version,path=previous.Build,runtime=new{path=previous.Runtime},animationProfile=previous.Edition});
  Json.Save(InstallEngine.RecordPath(root),previous);
  Json.Save(snapshot,new{language="zh-CN",saved="original 2.0.2 settings"});
  var snapshotHash=Hashing.Bytes(File.ReadAllBytes(snapshot));
  File.WriteAllText(commits,JsonSerializer.Serialize(new{file=Path.GetFileName(snapshot),sha256=mode=="bad-hash"?new string('0',64):snapshotHash})+"\n");
  var commitsHash=Hashing.Bytes(File.ReadAllBytes(commits));
  var pointerBefore=File.ReadAllText(pointer);
  var installationBefore=File.ReadAllText(InstallEngine.RecordPath(root));

  var responseBytes=new Dictionary<string,byte[]>();
  Package PackageZip(string id,string mount,string name,string contents,string? edition=null) {
   var bytes=System.Text.Encoding.UTF8.GetBytes(contents);
   using var archive=new MemoryStream();
   using(var zip=new ZipArchive(archive,ZipArchiveMode.Create,true))
    using(var entry=zip.CreateEntry(name).Open())entry.Write(bytes);
   var asset=id+".zip";
   var payload=archive.ToArray();
   responseBytes.Add(asset,payload);
   InstallFile[] files=[new(name,bytes.Length,Hashing.Bytes(bytes))];
   return new(id,"test",mount,asset,payload.Length,bytes.Length,Hashing.Bytes(payload),[],files,Edition:edition,FilesSha256:Manifests.IndexHash(files));
  }
  Package[] packages=[
   PackageZip("root","root","AI Buddy.exe","synthetic launcher; never execute"),
   PackageZip("runtime","runtime","AI Buddy.exe","synthetic runtime; never execute"),
   PackageZip("app30","build","main.cjs","synthetic app 30","30fps"),
   PackageZip("app60","build","main.cjs","synthetic app 60","60fps"),
   PackageZip("character","build","assets/portrait.webp","synthetic portrait")
  ];
  var version=ReleaseIdentity.Version;
  var manifest=new InstallManifest(1,version,"v"+version,"lXiaoSel1/AI-Buddy","win32","x64",version,1,"30fps","deepseek",
   ["root","runtime"],new("AI Buddy.exe",packages[1].Files[0].Sha256),[new("30fps","30fps","app30"),new("60fps","60fps","app60")],
   [new("deepseek","DeepSeek","character",new(){["30fps"]=[],["60fps"]=[]})],packages);
  var manifestBytes=JsonSerializer.SerializeToUtf8Bytes(manifest,Json.Options);
  var hashEntered=new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
  var releaseHash=new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
  var downloadEntered=new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
  var releaseDownload=new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
  var hashCalls=0;
  var downloads=0;
  async Task<string> ProfileHash(string path,CancellationToken cancel) {
   Assert(InstallProfile.SamePath(path,snapshot),"Hash must use the original profile snapshot");
   Assert(cancel.CanBeCanceled,"Install cancellation token must reach snapshot hashing");
   if(Interlocked.Increment(ref hashCalls)>1)return await Hashing.FileHash(path,cancel);
   using var input=new GatedSnapshotStream(path,hashEntered,releaseHash.Task);
   return await Hashing.FileHash(input,cancel);
  }
  using var http=new HttpClient(new Handler(async(request,cancel)=>{
   var asset=Path.GetFileName(request.RequestUri!.AbsolutePath);
   Assert(request.Method==HttpMethod.Get&&request.RequestUri.Host=="github.com"&&!request.Headers.Contains("Authorization"),"Only an anonymous package GET is expected");
   Interlocked.Increment(ref downloads);
   downloadEntered.TrySetResult();
   await releaseDownload.Task.WaitAsync(cancel);
   return new(HttpStatusCode.OK){Content=new ByteArrayContent(responseBytes[asset])};
  }));
  var host=new SnapshotUpgradeHost();
  var saved=(Manifest,ManifestBytes,Engine);
  Manifest=manifest;
  ManifestBytes=manifestBytes;
  Engine=new(manifest,manifestBytes,Hashing.Bytes(manifestBytes),new Downloader(http),host,Environment.ProcessPath!,profileHash:ProfileHash);
  // A regression can block PerformClick itself, before Pump can time out.
  using var watchdog=new System.Threading.Timer(_=>{
   Console.Error.WriteLine($"Timed out in WinForms snapshot upgrade ({mode}); snapshot read entered={hashEntered.Task.IsCompleted}; download entered={downloadEntered.Task.IsCompleted}");
   Environment.Exit(1);
  },null,TimeSpan.FromSeconds(25),Timeout.InfiniteTimeSpan);
  try {
   using var form=new SetupForm(["--skip-update-check","--language=en","--root="+root,"--cache="+cache,"--shortcuts=false"]);
   var completed=false;
   Exception? failure=null;
   form.Shown+=async(_,_)=>{
    static async Task WaitFor(Func<bool> done,string reason) {
     var timeout=Environment.TickCount64+10000;
     while(!done()){
      if(Environment.TickCount64>=timeout)throw new TimeoutException(reason);
      await Task.Delay(10);
     }
    }
    Task Ready()=>WaitFor(()=>Field<CancellationTokenSource?>(form,"cancellation") is null&&Field<Button>(form,"install").Enabled,"asynchronous estimate and install ready");
    try {
     await Ready();
     var ui=SynchronizationContext.Current as WindowsFormsSynchronizationContext;
     Assert(ui is not null,"Install must run with an actual WinForms synchronization context");
     Assert(((InstallOptions)Invoke(form,"Options")!).OfflineDirectory is null,"Install must use the online download path");

     Task<Installation>? invalid=null;
     using var invalidCancel=new CancellationTokenSource();
     if(mode=="bad-hash") {
      // Exercise the same install without opening the form's native error dialog.
      invalid=Engine.Install((InstallOptions)Invoke(form,"Options")!,null,invalidCancel.Token);
     } else Field<Button>(form,"install").PerformClick();

     await hashEntered.Task.WaitAsync(TimeSpan.FromSeconds(10));
     var heartbeat=new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
     ui!.Post(_=>heartbeat.TrySetResult(),null);
     await heartbeat.Task.WaitAsync(TimeSpan.FromSeconds(10));
     Assert(!releaseHash.Task.IsCompleted&&!downloadEntered.Task.IsCompleted&&!File.Exists(journal),"Before snapshot validation, hashing remains pending and no download or transaction can start");
     if(mode=="cancel") {
      Assert(Field<Button>(form,"cancel").Enabled,"Cancel must be available while hashing");
      Field<Button>(form,"cancel").PerformClick();
      await Ready();
      Assert(Field<Label>(form,"status").Text.StartsWith("Cancelled;"),"Cancel should settle without releasing the held read");
      Assert(!releaseHash.Task.IsCompleted,"Cancellation must interrupt the pending hash");
     } else {
      releaseHash.TrySetResult();
      if(invalid is not null) {
       try { await invalid.WaitAsync(TimeSpan.FromSeconds(10));throw new InvalidOperationException("A wrong snapshot digest was accepted"); }
       catch(IOException e) when(e.Message.Contains("original personal-data directory",StringComparison.Ordinal)){}
      } else {
       await downloadEntered.Task.WaitAsync(TimeSpan.FromSeconds(10));
       var staged=Json.Read<InstallJournal>(journal);
       Assert(staged.Phase=="staging"&&staged.ProfileAction=="preserve"&&staged.ExpectedDataPath==data&&staged.Options.DataPath is null&&staged.Options.Pipe==pipe,"Staging must bind the registered default save and pipe");
       releaseDownload.TrySetResult();
       await Ready();
       var installed=Json.Read<Installation>(InstallEngine.RecordPath(root));
       Assert(Json.Read<InstallJournal>(journal).Phase=="complete"&&installed.Version==version&&installed.InstallerRevision==ReleaseIdentity.InstallerRevision&&installed.DataPath is null&&installed.Pipe==pipe,"UI must complete upgrade with original profile binding");
       Assert(downloads==4&&hashCalls>=3&&host.Stops==1&&host.Starts==1&&host.Fresh==0&&host.StartedData==data,"Expected verified package downloads, snapshot rechecks and normal startup");
      }
     }
     if(mode!="valid")Assert(downloads==0&&host.Stops==0&&host.Starts==0&&host.Fresh==0&&!File.Exists(journal)&&File.ReadAllText(pointer)==pointerBefore&&File.ReadAllText(InstallEngine.RecordPath(root))==installationBefore,"Invalid/cancelled snapshot preflight must leave 2.0.2 installed without a download or transaction");
     Assert(Directory.GetFiles(data,"*",SearchOption.AllDirectories).Order().SequenceEqual(new[]{commits,snapshot}.Order())&&
      Hashing.Bytes(File.ReadAllBytes(snapshot))==snapshotHash&&Hashing.Bytes(File.ReadAllBytes(commits))==commitsHash,
      "Existing snapshot-only profile must remain byte-identical, without a new initialization marker");
     completed=true;
    } catch(Exception ex) { failure=ex; }
    finally { if(completed)form.Close();else Application.ExitThread(); }
   };
   Application.Run(form);
   if(failure is not null)System.Runtime.ExceptionServices.ExceptionDispatchInfo.Capture(failure).Throw();
   Assert(completed,"WinForms message loop exited before the regression finished");
  } finally {
   releaseHash.TrySetResult();
   releaseDownload.TrySetResult();
   (Manifest,ManifestBytes,Engine)=saved;
  }
 }

 sealed class GatedSnapshotStream(string path,TaskCompletionSource entered,Task released):Stream {
  readonly FileStream file=new(path,FileMode.Open,FileAccess.Read,FileShare.Read,4096,FileOptions.Asynchronous);
  public override bool CanRead=>true;
  public override bool CanSeek=>false;
  public override bool CanWrite=>false;
  public override long Length=>file.Length;
  public override long Position {get=>throw new NotSupportedException();set=>throw new NotSupportedException();}
  public override int Read(byte[] buffer,int offset,int count)=>throw new InvalidOperationException("Snapshot hashing must use asynchronous reads");
  public override Task<int> ReadAsync(byte[] buffer,int offset,int count,CancellationToken cancel)=>ReadAsync(buffer.AsMemory(offset,count),cancel).AsTask();
  public override async ValueTask<int> ReadAsync(Memory<byte> buffer,CancellationToken cancel=default) {
   entered.TrySetResult();
   await released.WaitAsync(cancel);
   return await file.ReadAsync(buffer,cancel);
  }
  public override void Flush()=>throw new NotSupportedException();
  public override long Seek(long offset,SeekOrigin origin)=>throw new NotSupportedException();
  public override void SetLength(long value)=>throw new NotSupportedException();
  public override void Write(byte[] buffer,int offset,int count)=>throw new NotSupportedException();
  protected override void Dispose(bool disposing){if(disposing)file.Dispose();base.Dispose(disposing);}
 }

 sealed class SnapshotUpgradeHost:IAppHost {
  public int Stops,Starts,Fresh;
  public string? StartedData;
  public StartupStatus? LastStartup=>new(false,null);
  public Task Stop(string root,Installation? previous,IProgress<InstallProgress>? progress,CancellationToken cancel){Stops++;return Task.CompletedTask;}
  public Task StartAndVerify(string root,Installation installed,CancellationToken cancel){Starts++;StartedData=DataPaths.Registered(root,installed.DataPath);return Task.CompletedTask;}
  public Task StartFreshAndVerify(string root,Installation installed,CancellationToken cancel){Fresh++;throw new InvalidOperationException("Existing snapshot profile cannot be initialized as new");}
  public Task CreateShortcuts(string root,Installation installed,CancellationToken cancel)=>throw new InvalidOperationException("Real shortcuts are outside the fixture");
  public Task RemoveShortcuts(string root,CancellationToken cancel)=>throw new InvalidOperationException("Real shortcuts are outside the fixture");
 }
}
