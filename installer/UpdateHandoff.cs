using System.Diagnostics;
using System.IO.Pipes;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;
using AiBuddy.Install;

namespace AiBuddy.Setup;

public sealed record HandoffIdentity(string Pipe,string Nonce,string Version,string ManifestSha256);

// A handoff only opens the verified newer GUI. Installation remains an explicit
// action in that GUI; no application discovery, shutdown or installation occurs here.
public static class UpdateHandoff {
    [System.Runtime.InteropServices.DllImport("kernel32.dll",SetLastError=true)]
    static extern bool GetNamedPipeClientProcessId(Microsoft.Win32.SafeHandles.SafePipeHandle pipe,out uint clientProcessId);
    const string Prefix="--handoff-";
    const int MessageLimit=4096;
    static readonly TimeSpan Timeout=TimeSpan.FromSeconds(45);
    static bool Digest(string value)=>value is not null&&Regex.IsMatch(value,@"\A[a-f0-9]{64}\z",RegexOptions.CultureInvariant);
    static void Text(string value,string name){if(string.IsNullOrWhiteSpace(value)||value.Any(char.IsControl))throw new ArgumentException("Invalid "+name);}

    public static string[] BuildArguments(InstallOptions options,string language,bool shortcuts,bool launch) {
        ArgumentNullException.ThrowIfNull(options);Text(options.Root,"root");Text(options.Cache,"cache");Text(language,"language");
        if(!Regex.IsMatch(language,@"\A[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8}){0,3}\z",RegexOptions.CultureInvariant))throw new ArgumentException("Invalid language");
        if(options.Edition is not ("30fps" or "60fps"))throw new ArgumentException("Invalid edition");
        if(options.Characters is null||options.Characters.Length==0||options.Characters.Distinct(StringComparer.Ordinal).Count()!=options.Characters.Length||options.Characters.Any(c=>c is null||!Regex.IsMatch(c,@"\A[a-z0-9-]{1,100}\z",RegexOptions.CultureInvariant))||!options.Characters.Contains(options.InitialCharacter,StringComparer.Ordinal))throw new ArgumentException("Invalid selected or initial character");
        var result=new List<string>{"--root="+Path.GetFullPath(options.Root),"--cache="+Path.GetFullPath(options.Cache),"--edition="+options.Edition,"--characters="+string.Join(',',options.Characters),"--initial="+options.InitialCharacter,"--language="+language,"--shortcuts="+shortcuts.ToString().ToLowerInvariant(),"--launch="+launch.ToString().ToLowerInvariant()};
        if(options.DataPath is {} data){Text(data,"data");result.Add("--data="+DataPaths.Registered(options.Root,data,false));}
        if(options.Pipe is {} pipe){Text(pipe,"pipe");result.Add("--pipe="+pipe);}
        // Offline mode intentionally has no cross-version handoff: that directory
        // contains the current version's pinned packages, not the newer version's.
        return result.ToArray();
    }

    public static ProcessStartInfo BuildStartInfo(string executable,IEnumerable<string> arguments) {
        Text(executable,"installer path");var full=Path.GetFullPath(executable);
        var start=new ProcessStartInfo(full){UseShellExecute=false,WorkingDirectory=Path.GetDirectoryName(full)!,CreateNoWindow=false};
        foreach(var argument in arguments){Text(argument,"argument");start.ArgumentList.Add(argument);}
        return start;
    }

    public static HandoffIdentity? GetLaunchIdentity(string[] args,string version,string manifestSha) {
        var values=new Dictionary<string,string>(StringComparer.Ordinal);
        foreach(var argument in args.Where(a=>a.StartsWith(Prefix,StringComparison.Ordinal))) {
            var separator=argument.IndexOf('=');
            if(separator<0||!values.TryAdd(argument[..separator],argument[(separator+1)..]))throw new InvalidDataException("Invalid or duplicate installer handoff argument");
        }
        if(values.Count==0)return null;
        if(values.Count!=4||!values.TryGetValue(Prefix+"pipe",out var pipe)||!values.TryGetValue(Prefix+"nonce",out var nonce)||!values.TryGetValue(Prefix+"version",out var target)||!values.TryGetValue(Prefix+"manifest",out var manifest))throw new InvalidDataException("Incomplete installer handoff");
        if(!Regex.IsMatch(pipe,@"\AAI-Buddy-Setup-Handoff-[a-f0-9]{32}\z",RegexOptions.CultureInvariant)||!Digest(nonce)||!Digest(manifest)||target!=version||manifest!=manifestSha)throw new InvalidDataException("Installer handoff does not match this installer's embedded version and manifest");
        if(args.Contains("--headless",StringComparer.Ordinal))throw new InvalidDataException("Installer handoff must open the interactive installer");
        return new(pipe,nonce,target,manifest);
    }

    public static async Task<Process> Start(UpdateRelease release,string verifiedExe,string[] args,CancellationToken cancel) {
        ArgumentNullException.ThrowIfNull(release);ArgumentNullException.ThrowIfNull(args);cancel.ThrowIfCancellationRequested();
        if(!Digest(release.InstallerSha256)||!Digest(release.ManifestSha256)||release.Bytes<=0||release.Bytes>UpdateDiscovery.InstallerLimit)throw new InvalidDataException("Invalid verified installer identity");
        if(args.Any(a=>a.StartsWith(Prefix,StringComparison.Ordinal)||a=="--headless"||a.StartsWith("--action=",StringComparison.Ordinal)))throw new InvalidDataException("Handoff arguments cannot choose an action or replace the handshake identity");
        var full=Path.GetFullPath(verifiedExe);SafePaths.NoLinks(full);
        // Keep a read-only handle until acknowledgement so the checked file cannot
        // be replaced or written between hashing and process creation on Windows.
        await using var image=new FileStream(full,FileMode.Open,FileAccess.Read,FileShare.Read,1024*1024,FileOptions.Asynchronous|FileOptions.SequentialScan);
        if(image.Length!=release.Bytes||Convert.ToHexStringLower(await SHA256.HashDataAsync(image,cancel))!=release.InstallerSha256)throw new InvalidDataException("New installer changed after download verification");
        var identity=new HandoffIdentity("AI-Buddy-Setup-Handoff-"+Guid.NewGuid().ToString("N"),Convert.ToHexStringLower(RandomNumberGenerator.GetBytes(32)),release.Version,release.ManifestSha256);
        using var server=new NamedPipeServerStream(identity.Pipe,PipeDirection.In,1,PipeTransmissionMode.Byte,PipeOptions.Asynchronous|PipeOptions.CurrentUserOnly);
        var command=args.Concat(new[]{Prefix+"pipe="+identity.Pipe,Prefix+"nonce="+identity.Nonce,Prefix+"version="+identity.Version,Prefix+"manifest="+identity.ManifestSha256});
        var child=Process.Start(BuildStartInfo(full,command))??throw new IOException("Windows could not open the newer installer");
        using var timeout=CancellationTokenSource.CreateLinkedTokenSource(cancel);timeout.CancelAfter(Timeout);
        Task? acknowledgement=null;Task? exited=null;
        try {
            acknowledgement=ReadAcknowledgement(server,identity,child.Id,timeout.Token);
            exited=child.WaitForExitAsync(timeout.Token);
            if(await Task.WhenAny(acknowledgement,exited)==exited){cancel.ThrowIfCancellationRequested();timeout.Token.ThrowIfCancellationRequested();throw new IOException("The newer installer exited before its interface was ready; the current manager remains available");}
            await acknowledgement;cancel.ThrowIfCancellationRequested();
            if(child.HasExited)throw new IOException("The newer installer closed before handoff completed; the current manager remains available");
            timeout.Cancel();return child;
        }catch(OperationCanceledException) when(!cancel.IsCancellationRequested){child.Dispose();throw new IOException("The newer installer did not confirm readiness within 45 seconds; the current manager remains available");}
        catch{child.Dispose();throw;}
        finally {
            timeout.Cancel();
            // Observe both losing tasks without keeping the caller waiting or
            // leaking an unobserved pipe exception after the other task won.
            if(acknowledgement is not null)try{await acknowledgement;}catch{}
            if(exited is not null)try{await exited;}catch{}
        }
        // Never kill the child or any AI Buddy instance on a handshake failure.
    }

    static async Task ReadAcknowledgement(NamedPipeServerStream server,HandoffIdentity expected,int processId,CancellationToken cancel) {
        await server.WaitForConnectionAsync(cancel);
        if(!GetNamedPipeClientProcessId(server.SafePipeHandle,out var peer)||peer!=(uint)processId)throw new InvalidDataException("Installer readiness connection belongs to another process");
        var bytes=new List<byte>();var buffer=new byte[256];
        while(true) {
            var count=await server.ReadAsync(buffer,cancel);if(count==0)throw new IOException("The newer installer closed its readiness connection");
            var newline=Array.IndexOf(buffer,(byte)'\n',0,count);var length=newline>=0?newline:count;
            if(bytes.Count+length>MessageLimit)throw new InvalidDataException("Installer readiness message exceeds 4096 bytes");
            bytes.AddRange(buffer.AsSpan(0,length).ToArray());
            if(newline<0)continue;
            if(newline!=count-1)throw new InvalidDataException("Unexpected data after installer readiness message");
            break;
        }
        using var document=JsonDocument.Parse(bytes.ToArray());var value=document.RootElement;
        if(value.ValueKind!=JsonValueKind.Object||value.EnumerateObject().Select(p=>p.Name).Distinct(StringComparer.Ordinal).Count()!=value.EnumerateObject().Count()||!value.TryGetProperty("ready",out var ready)||ready.ValueKind!=JsonValueKind.True||!value.TryGetProperty("nonce",out var nonce)||nonce.ValueKind!=JsonValueKind.String||nonce.GetString()!=expected.Nonce||!value.TryGetProperty("version",out var version)||version.ValueKind!=JsonValueKind.String||version.GetString()!=expected.Version||!value.TryGetProperty("manifestSha256",out var manifest)||manifest.ValueKind!=JsonValueKind.String||manifest.GetString()!=expected.ManifestSha256||!value.TryGetProperty("processId",out var pid)||pid.ValueKind!=JsonValueKind.Number||!pid.TryGetInt32(out var actual)||actual!=processId)throw new InvalidDataException("New installer readiness identity mismatch");
    }

    public static async Task SignalReady(string[] args,string version,string manifestSha,CancellationToken cancel=default) {
        var identity=GetLaunchIdentity(args,version,manifestSha);if(identity is null)return;
        using var timeout=CancellationTokenSource.CreateLinkedTokenSource(cancel);timeout.CancelAfter(Timeout);
        using var client=new NamedPipeClientStream(".",identity.Pipe,PipeDirection.Out,PipeOptions.Asynchronous|PipeOptions.CurrentUserOnly);
        await client.ConnectAsync(timeout.Token);
        var bytes=JsonSerializer.SerializeToUtf8Bytes(new{ready=true,nonce=identity.Nonce,version,manifestSha256=manifestSha,processId=Environment.ProcessId});
        if(bytes.Length>MessageLimit)throw new InvalidDataException("Installer readiness message exceeds 4096 bytes");
        await client.WriteAsync(bytes,timeout.Token);await client.WriteAsync(new byte[]{(byte)'\n'},timeout.Token);await client.FlushAsync(timeout.Token);
    }
}
