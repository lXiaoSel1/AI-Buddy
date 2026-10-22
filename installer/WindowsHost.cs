using System.Diagnostics;
using System.IO.Pipes;
using System.Text;
using System.Text.Json;
using System.Runtime.InteropServices;
using AiBuddy.Install;
namespace AiBuddy.Setup;

public sealed class WindowsHost(string? rootsFile=null) : IAppHost {
    public StartupStatus? LastStartup {get;private set;}
    public static string PipeName(Installation? installed)=>installed?.Pipe??"whale-companion-v001";
    [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool WaitNamedPipe(string name,uint timeout);
    static bool PipeExists(string pipe)=>WaitNamedPipe(@"\\.\pipe\"+pipe.Replace(@"\\.\pipe\",""),0)||Marshal.GetLastWin32Error()!=2;
    public static async Task<JsonElement?> Request(string pipe,object request,int milliseconds,CancellationToken cancel,bool requireReply=false) {
        using var timeout=CancellationTokenSource.CreateLinkedTokenSource(cancel);timeout.CancelAfter(milliseconds);
        using var client=new NamedPipeClientStream(".",pipe.Replace(@"\\.\pipe\",""),PipeDirection.InOut,PipeOptions.Asynchronous);
        bool connected=false;
        try {
            await client.ConnectAsync(timeout.Token);connected=true;
            // The app control protocol is JSONL: indentation would split one request into invalid fragments.
            var bytes=Encoding.UTF8.GetBytes(JsonSerializer.Serialize(request,new JsonSerializerOptions(Json.Options){WriteIndented=false})+"\n");await client.WriteAsync(bytes,timeout.Token);await client.FlushAsync(timeout.Token);
            using var result=new MemoryStream();var buffer=new byte[16384];
            while(true){var n=await client.ReadAsync(buffer,timeout.Token);if(n==0)break;if(result.Length+n>32*1024*1024)throw new IOException("Local status response is too large");result.Write(buffer,0,n);if(buffer.AsSpan(0,n).Contains((byte)'\n'))break;}
            using var document=JsonDocument.Parse(result.ToArray());return document.RootElement.Clone();
        }catch(OperationCanceledException) when(!cancel.IsCancellationRequested){if(requireReply&&connected)throw new IOException("Existing AI Buddy connected but did not answer; keep the current program and retry after it responds. / 已连接旧实例但未获回应，已保留当前程序，请待响应后重试。");return null;}catch(TimeoutException){if(requireReply&&connected)throw new IOException("Existing AI Buddy did not answer safely");return null;}catch(IOException) when(!requireReply||!connected){return null;}
    }
    static bool Belongs(JsonElement value,string root) {
        if(!value.TryGetProperty("build",out var build)||build.ValueKind!=JsonValueKind.String)return false;
        return SafePaths.Full(build.GetString()!).StartsWith(SafePaths.Full(root).TrimEnd(Path.DirectorySeparatorChar)+Path.DirectorySeparatorChar,StringComparison.OrdinalIgnoreCase);
    }
    public async Task<string?> DiscoverDataPath(string root,string? pipe,CancellationToken cancel) {
        var status=await Request(pipe??PipeName(null),new{command="snapshot"},5000,cancel);
        if(status is {} s&&Belongs(s,root)&&s.TryGetProperty("dataRoot",out var data)) {
            var actual=Path.GetFullPath(data.GetString()!);return string.Equals(actual,Path.Combine(root,"local","data-v003"),StringComparison.OrdinalIgnoreCase)?null:actual;
        }
        return null;
    }
    public async Task Stop(string root,Installation? previous,IProgress<InstallProgress>? progress,CancellationToken cancel) {
        var pipe=PipeName(previous);
        while(true) {
            cancel.ThrowIfCancellationRequested();var existed=PipeExists(pipe);var status=await Request(pipe,new{command="installation-status"},1800,cancel,true);
            if(status is null){if(existed||PipeExists(pipe))throw new IOException("An existing AI Buddy control pipe is not responding; finish its work or quit it from the tray, then retry. No program files were replaced. / 现有实例管道未响应，请完成任务或从托盘退出后重试，未替换程序文件。");return;}
            bool legacy=status.Value.TryGetProperty("error",out _);
            if(legacy)status=await Request(pipe,new{command="snapshot"},5000,cancel,true);
            if(status is null)throw new IOException("Cannot verify the existing AI Buddy identity; quit it from the tray before retrying");
            if(!Belongs(status.Value,root))return;
            if(legacy) {
                throw new IOException("This older app does not support verified installation-quit. Please finish chat/CG and quit it from its tray, then retry. / 此旧版不支持安装器核对身份后退出，请完成聊天绘图后从托盘退出再重试。");
            }
            if(status.Value.TryGetProperty("busy",out var busy)&&busy.GetBoolean()) {progress?.Report(new("waiting",root,Detail:"Waiting for chat and CG to finish / 正在等待聊天与绘图收尾"));await Task.Delay(1500,cancel);continue;}
            var answer=await Request(pipe,new{command="installation-quit",expectedBuild=status.Value.GetProperty("build").GetString()},4000,cancel);
            if(answer is null)throw new IOException("Application did not acknowledge safe exit");
            if(!answer.Value.TryGetProperty("ok",out var ok)||!ok.GetBoolean()){await Task.Delay(1000,cancel);continue;}
            int pid=status.Value.GetProperty("processId").GetInt32();
            try {using var process=Process.GetProcessById(pid);using var timeout=CancellationTokenSource.CreateLinkedTokenSource(cancel);timeout.CancelAfter(TimeSpan.FromSeconds(45));await process.WaitForExitAsync(timeout.Token);}catch(ArgumentException){}
            return;
        }
    }
    public Task StartAndVerify(string root,Installation installed,CancellationToken cancel)=>StartCore(root,installed,null,cancel);
    public Task StartImportedAndVerify(string root,Installation installed,string importId,CancellationToken cancel)=>StartCore(root,installed,importId,cancel);
    public static StartupStatus? MatchStartup(string root,Installation installed,JsonElement value,bool importVerification=false){
        var build=SafePaths.Under(root,installed.Build);var data=DataPaths.Registered(root,installed.DataPath);
        if(!value.TryGetProperty("version",out var version)||version.ValueKind!=JsonValueKind.String||version.GetString()!=installed.Version||!value.TryGetProperty("build",out var returned)||returned.ValueKind!=JsonValueKind.String||!string.Equals(SafePaths.Full(returned.GetString()!),build,StringComparison.OrdinalIgnoreCase)||!value.TryGetProperty("dataRoot",out var returnedData)||returnedData.ValueKind!=JsonValueKind.String||!string.Equals(SafePaths.Full(returnedData.GetString()!),data,StringComparison.OrdinalIgnoreCase))return null;
        var ready=value.TryGetProperty("ready",out var r)&&r.ValueKind==JsonValueKind.True;
        var onboarding=value.TryGetProperty("onboarding",out var o)&&o.ValueKind==JsonValueKind.True;
        var safe=value.TryGetProperty("safeMode",out var s)&&s.ValueKind==JsonValueKind.True;
        var failure=value.TryGetProperty("startupFailure",out var f)&&f.ValueKind!=JsonValueKind.Null?f.Clone():(JsonElement?)null;
        if(importVerification&&(onboarding||ready&&(safe||failure is not null)))throw new IOException("Imported profile did not start normally (safe mode or empty welcome); the previous profile will be restored");
        if(ready&&!onboarding)return new(safe,failure);
        // Welcome is deliberately not game-ready: no business save is initialized
        // until the user chooses create/import. It is nevertheless a healthy
        // completed program launch for a genuinely fresh ordinary installation.
        if(!importVerification&&installed.DataInitialized!=true&&onboarding&&!safe&&failure is null)return new(false,null,true);
        return null;
    }
    async Task StartCore(string root,Installation installed,string? importId,CancellationToken cancel) {
        LastStartup=null;
        var executable=SafePaths.Under(root,"AI Buddy.exe");
        var start=new ProcessStartInfo(executable){WorkingDirectory=root,UseShellExecute=false,CreateNoWindow=true};
        if(importId is not null)start.ArgumentList.Add("--data-import-verify="+importId);
        if(rootsFile is not null){var path=Path.GetFullPath(rootsFile);SafePaths.NoLinks(path);using var roots=JsonDocument.Parse(File.ReadAllBytes(path));if(roots.RootElement.ValueKind!=JsonValueKind.Array)throw new InvalidDataException("Validation roots must be a JSON array");start.ArgumentList.Add("--roots="+path);}
        using var child=Process.Start(start)??throw new IOException("Windows could not start AI Buddy");
        var end=DateTime.UtcNow.AddSeconds(90);
        while(DateTime.UtcNow<end) {
            cancel.ThrowIfCancellationRequested();var status=await Request(PipeName(installed),new{command="installation-status"},1500,cancel);
            if(status is {} s&&MatchStartup(root,installed,s,importId is not null) is {} startup){LastStartup=startup;return;}
            await Task.Delay(800,cancel);
        }
        throw new IOException("AI Buddy did not become ready within 90 seconds; installation recovery will retain personal data");
    }
    public Task CreateShortcuts(string root,Installation installed,CancellationToken cancel) {
        cancel.ThrowIfCancellationRequested();
        foreach(var folder in new[]{Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory),Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.Programs),"AI Buddy")}) {
            Directory.CreateDirectory(folder);var path=Path.Combine(folder,"AI Buddy.lnk");
            var shellType=Type.GetTypeFromProgID("WScript.Shell")??throw new IOException("Windows shortcut service unavailable");
            dynamic shell=Activator.CreateInstance(shellType)!;
            try {dynamic link=shell.CreateShortcut(path);try{link.TargetPath=SafePaths.Under(root,"AI Buddy.exe");link.WorkingDirectory=root;link.Description="AI Buddy";link.IconLocation=SafePaths.Under(root,"assets/branding/app.ico")+",0";link.Save();}finally{Marshal.FinalReleaseComObject(link);}}finally{Marshal.FinalReleaseComObject(shell);}
        }
        return Task.CompletedTask;
    }
    public Task RemoveShortcuts(string root,CancellationToken cancel) {
        foreach(var folder in new[]{Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory),Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.Programs),"AI Buddy")}) {
            var path=Path.Combine(folder,"AI Buddy.lnk");if(!File.Exists(path))continue;
            dynamic shell=Activator.CreateInstance(Type.GetTypeFromProgID("WScript.Shell")!)!;
            try{dynamic link=shell.CreateShortcut(path);try{if(string.Equals((string)link.TargetPath,SafePaths.Under(root,"AI Buddy.exe"),StringComparison.OrdinalIgnoreCase))File.Delete(path);}finally{Marshal.FinalReleaseComObject(link);}}finally{Marshal.FinalReleaseComObject(shell);}
        }
        return Task.CompletedTask;
    }
}
