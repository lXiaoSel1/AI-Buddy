using System.Diagnostics;
using System.IO.Pipes;
using System.Text;
using System.Text.Json;
using System.Runtime.InteropServices;
using AiBuddy.Install;
namespace AiBuddy.Setup;

public sealed class WindowsHost : IAppHost {
    public static string PipeName(Installation? installed)=>installed?.Pipe??"whale-companion-v001";
    public static async Task<JsonElement?> Request(string pipe,object request,int milliseconds,CancellationToken cancel) {
        using var timeout=CancellationTokenSource.CreateLinkedTokenSource(cancel);timeout.CancelAfter(milliseconds);
        using var client=new NamedPipeClientStream(".",pipe.Replace(@"\\.\pipe\",""),PipeDirection.InOut,PipeOptions.Asynchronous);
        try {
            await client.ConnectAsync(timeout.Token);
            // The app control protocol is JSONL: indentation would split one request into invalid fragments.
            var bytes=Encoding.UTF8.GetBytes(JsonSerializer.Serialize(request,new JsonSerializerOptions(Json.Options){WriteIndented=false})+"\n");await client.WriteAsync(bytes,timeout.Token);await client.FlushAsync(timeout.Token);
            using var result=new MemoryStream();var buffer=new byte[16384];
            while(true){var n=await client.ReadAsync(buffer,timeout.Token);if(n==0)break;if(result.Length+n>32*1024*1024)throw new IOException("Local status response is too large");result.Write(buffer,0,n);if(buffer.AsSpan(0,n).Contains((byte)'\n'))break;}
            using var document=JsonDocument.Parse(result.ToArray());return document.RootElement.Clone();
        }catch(OperationCanceledException) when(!cancel.IsCancellationRequested){return null;}catch(TimeoutException){return null;}catch(IOException){return null;}
    }
    static bool Belongs(JsonElement value,string root) {
        if(!value.TryGetProperty("build",out var build)||build.ValueKind!=JsonValueKind.String)return false;
        return Path.GetFullPath(build.GetString()!).StartsWith(Path.GetFullPath(root).TrimEnd(Path.DirectorySeparatorChar)+Path.DirectorySeparatorChar,StringComparison.OrdinalIgnoreCase);
    }
    public async Task<string?> DiscoverDataPath(string root,CancellationToken cancel) {
        var status=await Request(PipeName(null),new{command="snapshot"},5000,cancel);
        if(status is {} s&&Belongs(s,root)&&s.TryGetProperty("dataRoot",out var data)) {
            var actual=Path.GetFullPath(data.GetString()!);return string.Equals(actual,Path.Combine(root,"local","data-v003"),StringComparison.OrdinalIgnoreCase)?null:actual;
        }
        return null;
    }
    public async Task Stop(string root,Installation? previous,IProgress<InstallProgress>? progress,CancellationToken cancel) {
        var pipe=PipeName(previous);
        while(true) {
            cancel.ThrowIfCancellationRequested();var status=await Request(pipe,new{command="installation-status"},1800,cancel);
            if(status is null)return;
            bool legacy=status.Value.TryGetProperty("error",out _);
            if(legacy)status=await Request(pipe,new{command="snapshot"},5000,cancel);
            if(status is null||!Belongs(status.Value,root))return;
            if(legacy) {
                if(!status.Value.TryGetProperty("settings",out var settings)||!settings.TryGetProperty("modelConnections",out var model)||!model.TryGetProperty("busy",out var mb)||!settings.TryGetProperty("cgConnections",out var cg)||!cg.TryGetProperty("busy",out var cb))throw new IOException("Please finish chat/CG and quit the existing AI Buddy from its tray, then retry. / 请完成聊天绘图后从托盘退出旧版再重试。");
                if(mb.GetBoolean()||cb.GetBoolean()){progress?.Report(new("waiting",root,Detail:"Waiting for existing chat/CG"));await Task.Delay(1500,cancel);continue;}
            }
            if(status.Value.TryGetProperty("busy",out var busy)&&busy.GetBoolean()) {progress?.Report(new("waiting",root,Detail:"Waiting for chat and CG to finish / 正在等待聊天与绘图收尾"));await Task.Delay(1500,cancel);continue;}
            var answer=await Request(pipe,new{command=legacy?"quit":"installation-quit",expectedBuild=status.Value.GetProperty("build").GetString()},4000,cancel);
            if(answer is null)throw new IOException("Application did not acknowledge safe exit");
            if(!answer.Value.TryGetProperty("ok",out var ok)||!ok.GetBoolean()){await Task.Delay(1000,cancel);continue;}
            int pid=status.Value.GetProperty("processId").GetInt32();
            try {using var process=Process.GetProcessById(pid);using var timeout=CancellationTokenSource.CreateLinkedTokenSource(cancel);timeout.CancelAfter(TimeSpan.FromSeconds(45));await process.WaitForExitAsync(timeout.Token);}catch(ArgumentException){}
            return;
        }
    }
    public async Task StartAndVerify(string root,Installation installed,CancellationToken cancel) {
        var executable=SafePaths.Under(root,"AI Buddy.exe");
        using var child=Process.Start(new ProcessStartInfo(executable){WorkingDirectory=root,UseShellExecute=false,CreateNoWindow=true})??throw new IOException("Windows could not start AI Buddy");
        var build=SafePaths.Under(root,installed.Build);var end=DateTime.UtcNow.AddSeconds(90);
        while(DateTime.UtcNow<end) {
            cancel.ThrowIfCancellationRequested();var status=await Request(PipeName(installed),new{command="installation-status"},1500,cancel);
            if(status is {} s&&s.TryGetProperty("version",out var version)&&version.GetString()==installed.Version&&s.TryGetProperty("build",out var returned)&&string.Equals(Path.GetFullPath(returned.GetString()!),build,StringComparison.OrdinalIgnoreCase)&&s.TryGetProperty("ready",out var ready)&&ready.GetBoolean())return;
            await Task.Delay(800,cancel);
        }
        throw new IOException("AI Buddy did not become ready within 90 seconds; previous program will be restored");
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
