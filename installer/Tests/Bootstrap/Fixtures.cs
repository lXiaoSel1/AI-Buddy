using AiBuddy.Install;
using AiBuddy.Setup;
using System.IO.Compression;
using System.IO.Pipes;
using System.Net;
using System.Text;
using System.Text.Json;

internal static class BootstrapFixtures {
    internal const string Nonce="aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    internal const string Signature="-----BEGIN SSH SIGNATURE-----\nfixture\n-----END SSH SIGNATURE-----\n";
    internal static readonly JsonSerializerOptions Compact=new(Json.Options){WriteIndented=false};
    internal static async Task<BootstrapSource> CreateSource(string root) {
        Directory.CreateDirectory(Path.Combine(root,"builds","old"));Directory.CreateDirectory(Path.Combine(root,"runtime","old"));
        var manager=SafePaths.Under(root,"maintenance/old/AI Buddy Setup.exe");Directory.CreateDirectory(Path.GetDirectoryName(manager)!);File.WriteAllText(manager,"synthetic old manager; never executed");
        var data=DataPaths.Registered(root,null,false);Directory.CreateDirectory(data);Json.Save(Path.Combine(data,"settings.json"),new{preserved="profile"});
        Json.Save(InstallEngine.RecordPath(root),new Installation(1,"1.9.0",null!,"60fps",["deepseek"],"deepseek","builds/old","runtime/old","maintenance/old/AI Buddy Setup.exe",null,"bootstrap-"+Guid.NewGuid().ToString("N"),DateTimeOffset.UtcNow,new()));
        Json.Save(SafePaths.Under(root,"local/current-build.json"),new{path="builds/old",version="1.9.0",appVersion="1.9.0",animationProfile="60fps",runtime=new{path="runtime/old"}});
        Directory.CreateDirectory(SafePaths.Under(root,"local/installer"));return await Snapshot(root);
    }
    internal static async Task<BootstrapSource> Snapshot(string root) {
        var i=Json.Read<Installation>(InstallEngine.RecordPath(root));
        return new(root,SafePaths.Under(root,i.Build),DataPaths.Registered(root,i.DataPath),InstallProfile.NormalizedPipe(i.Pipe),i.Version,Environment.ProcessId,await Hashing.FileHash(InstallEngine.RecordPath(root)),await Hashing.FileHash(SafePaths.Under(root,"local/current-build.json")));
    }
    internal static async Task<BootstrapSource> RegisteredSource(string root) {
        await CreateSource(root);
        var installed=Json.Read<Installation>(InstallEngine.RecordPath(root));
        var relative=$"maintenance/{ReleaseIdentity.Version}/AI Buddy Setup.exe";var manager=SafePaths.Under(root,relative);
        Directory.CreateDirectory(Path.GetDirectoryName(manager)!);
        // Copy the framework-dependent test executable and its runtime companions
        // so the ordinary manager entry runs from its actual registered path.
        foreach(var file in Directory.EnumerateFiles(Path.GetDirectoryName(Environment.ProcessPath!)!))
            File.Copy(file,Path.Combine(Path.GetDirectoryName(manager)!,Path.GetFileName(file)),true);
        File.Copy(Environment.ProcessPath!,manager,true);
        using var manifest=typeof(AiBuddy.Setup.Program).Assembly.GetManifestResourceStream("InstallManifest")!;
        using var buffer=new MemoryStream();await manifest.CopyToAsync(buffer);var bytes=buffer.ToArray();var digest=Hashing.Bytes(bytes);
        var saved=SafePaths.Under(root,"local/install-manifests/"+digest+".json");Directory.CreateDirectory(Path.GetDirectoryName(saved)!);await File.WriteAllBytesAsync(saved,bytes);
        Json.Save(InstallEngine.RecordPath(root),installed with{Version=ReleaseIdentity.Version,Manager=relative,ManagerProtocol=1,ManagerSha256=await Hashing.FileHash(manager),ManifestSha256=digest});
        Json.Save(SafePaths.Under(root,"local/current-build.json"),new{path=installed.Build,version=ReleaseIdentity.Version,appVersion=ReleaseIdentity.Version,animationProfile=installed.Edition,runtime=new{path=installed.Runtime},manifestSha256=digest});
        return await Snapshot(root);
    }
    internal static async Task Serve(BootstrapSource source,Func<Task> run,object? changed=null) {
        using var stop=new CancellationTokenSource();
        using var pipe=new NamedPipeServerStream(source.Pipe,PipeDirection.InOut,1,PipeTransmissionMode.Byte,PipeOptions.Asynchronous|PipeOptions.CurrentUserOnly);
        var task=Task.Run(async()=>{try{while(!stop.IsCancellationRequested){
            await pipe.WaitForConnectionAsync(stop.Token);using var reader=new StreamReader(pipe,Encoding.UTF8,false,1024,true);
            var line=await reader.ReadLineAsync(stop.Token);if(line is null){pipe.Disconnect();continue;}
            using var request=JsonDocument.Parse(line);
            if(request.RootElement.GetProperty("command").GetString()!="installation-status")throw new Exception("source validation must never stop the fixture host");
            var status=changed??new{build=source.Build,dataRoot=source.DataRoot,version=source.Version,processId=source.Pid,ready=true,safeMode=false,onboarding=false,startupFailure=(object?)null};
            await pipe.WriteAsync(Encoding.UTF8.GetBytes(JsonSerializer.Serialize(status,Compact)+"\n"),stop.Token);await pipe.FlushAsync(stop.Token);pipe.Disconnect();
        }}catch(OperationCanceledException){}catch(IOException)when(stop.IsCancellationRequested){}});
        try{await run();}finally{stop.Cancel();await task;}
    }
    static Package Zip(string folder,string id,string mount,string file,string text,string? edition=null) {
        var payload=Encoding.UTF8.GetBytes(text);var path=Path.Combine(folder,id+".zip");
        using(var zip=ZipFile.Open(path,ZipArchiveMode.Create)){using var stream=zip.CreateEntry(file).Open();stream.Write(payload);}
        InstallFile[] files=[new(file,payload.Length,Hashing.Bytes(payload))];
        return new(id,"test",mount,id+".zip",new FileInfo(path).Length,payload.Length,Hashing.FileHash(path).Result,[],files,Edition:edition,FilesSha256:Manifests.IndexHash(files));
    }
    internal static (InstallManifest Manifest,byte[] Bytes,string Hash) CreateManifest(string folder) {
        Directory.CreateDirectory(folder);
        var files=new[]{Zip(folder,"root","root","AI Buddy.exe","synthetic launcher"),Zip(folder,"runtime","runtime","AI Buddy.exe","synthetic runtime"),Zip(folder,"app30","build","main.cjs","thirty","30fps"),Zip(folder,"app60","build","main.cjs","sixty","60fps"),Zip(folder,"character","build","assets/portrait.webp","portrait")};
        var manifest=new InstallManifest(1,ReleaseIdentity.Version,"v"+ReleaseIdentity.Version,UpdateDiscovery.Repository,"win32","x64",ReleaseIdentity.Version,1,"30fps","deepseek",["root","runtime"],new("AI Buddy.exe",files[1].Files[0].Sha256),[new("30fps","30fps","app30"),new("60fps","60fps","app60")],[new("deepseek","DeepSeek","character",new(){["30fps"]=[],["60fps"]=[]})],files);
        var bytes=JsonSerializer.SerializeToUtf8Bytes(manifest,Json.Options);return(manifest,bytes,Hashing.Bytes(bytes));
    }
    internal static async Task<UpdateRelease> Release(string manifestHash) {
        var version=ReleaseIdentity.Version;var source=new string('b',40);var checksum=new string('c',64);var image=await Hashing.FileHash(Environment.ProcessPath!);
        var payload=$"object {source}\ntype commit\ntag v{version}\ntagger fixture <test@example.invalid> 0 +0000\n\nSource: {source}\nInstaller SHA-256: {image}\nManifest SHA-256: {manifestHash}\nChecksums SHA-256: {checksum}\nApp Update Protocol: 1\nApp Bootstrap Protocol: 1\n";
        return new(version,"v"+version,"https://github.com/"+UpdateDiscovery.Repository+"/releases/tag/v"+version,"https://github.com/"+UpdateDiscovery.Repository+"/releases/download/v"+version+"/AI-Buddy-Setup-"+version+"-win-x64.exe","AI-Buddy-Setup-"+version+"-win-x64.exe",new FileInfo(Environment.ProcessPath!).Length,image,manifestHash,source,new string('d',40),payload,Signature,checksum);
    }
    internal static async Task<int> Worker(string folder,string[] args) {
        var bytes=await File.ReadAllBytesAsync(Path.Combine(folder,"manifest.json"));var manifest=JsonSerializer.Deserialize<InstallManifest>(bytes,Json.Options)!;
        using var http=new HttpClient(new Packages(folder,manifest));
        return await AppBootstrap.Run(args,http,new UpdateDiscovery(http,verifySignature:(_,signature)=>signature==Signature),manifest,bytes,Hashing.Bytes(bytes),Environment.ProcessPath!);
    }
    // A separate real PID owns the source pipe after a fixture app restart.
    // It stays busy, allowing apply identity/reservation to be tested without quit.
    internal static async Task<int> SourceHost(string root) {
        var source=await Snapshot(root);
        using var pipe=new NamedPipeServerStream(source.Pipe,PipeDirection.InOut,1,PipeTransmissionMode.Byte,PipeOptions.Asynchronous|PipeOptions.CurrentUserOnly);
        Console.WriteLine("fixture-source-ready");Console.Out.Flush();
        while(true) {
            await pipe.WaitForConnectionAsync();using var reader=new StreamReader(pipe,Encoding.UTF8,false,1024,true);
            var line=await reader.ReadLineAsync();if(line is null){pipe.Disconnect();continue;}
            using var request=JsonDocument.Parse(line);var command=request.RootElement.GetProperty("command").GetString();
            object response=command switch {
                "installation-status"=>new{build=source.Build,dataRoot=source.DataRoot,version=source.Version,processId=Environment.ProcessId,ready=true,safeMode=false,onboarding=false,updateBusy=new{busy=true,reasons=new[]{"chat"}}},
                "installation-reserve" or "installation-release"=>new{ok=true},
                _=>throw new Exception("busy fixture source must never quit")
            };
            await pipe.WriteAsync(Encoding.UTF8.GetBytes(JsonSerializer.Serialize(response,Compact)+"\n"));await pipe.FlushAsync();pipe.Disconnect();
        }
    }
    internal sealed class Packages(string folder,InstallManifest manifest):HttpMessageHandler {
        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request,CancellationToken cancel) {
            var package=manifest.Packages.SingleOrDefault(p=>Manifests.Url(manifest,p.AssetName)==request.RequestUri)??throw new Exception("No real network/latest in bootstrap fixtures: "+request.RequestUri);
            return Task.FromResult(new HttpResponseMessage(HttpStatusCode.OK){Content=new ByteArrayContent(File.ReadAllBytes(Path.Combine(folder,package.AssetName)))});
        }
    }
    internal sealed class TransactionHost:IAppHost {
        public int Stops,Starts;
        public Task Stop(string root,Installation? previous,IProgress<InstallProgress>? progress,CancellationToken cancel){Stops++;return Task.CompletedTask;}
        public Task StartAndVerify(string root,Installation installed,CancellationToken cancel){Starts++;return Task.CompletedTask;}
        public Task CreateShortcuts(string root,Installation installed,CancellationToken cancel)=>Task.CompletedTask;
        public Task RemoveShortcuts(string root,CancellationToken cancel)=>Task.CompletedTask;
    }
}
