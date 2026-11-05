using System.Text.Json;
namespace AiBuddy.Install;

// A registered null is the default profile, not an absent choice. Only a new,
// empty profile may use the app's explicit --data initialization entry point.
public sealed record InstallProfile(string Action,string ExpectedDataPath,string? DataPath,string? Pipe,bool ResumeInitialization=false) {
    public static bool SamePath(string first,string second)=>string.Equals(Path.TrimEndingDirectorySeparator(SafePaths.Full(first)),Path.TrimEndingDirectorySeparator(SafePaths.Full(second)),StringComparison.OrdinalIgnoreCase);
    public static string NormalizedPipe(string? value){
        var pipe=string.IsNullOrEmpty(value)?"whale-companion-v001":value.StartsWith(@"\\.\pipe\",StringComparison.Ordinal)?value[9..]:value;
        if(!System.Text.RegularExpressions.Regex.IsMatch(pipe,@"\A[a-zA-Z0-9_.-]{1,180}\z"))throw new InvalidDataException("Invalid local control pipe");return pipe;
    }
    public static async Task<InstallProfile> SelectAsync(string root,InstallOptions requested,Installation? previous,string? discovered,InstallJournal? retry,bool existingPointer,Func<string,CancellationToken,Task<string>> hashFile,CancellationToken cancel) {
        var resuming=previous is null&&retry is{ProfileAction:"initialize" or "preserve",PreviousPointer:null,PreviousInstallation:null}&&retry.Phase is "staging" or "committing" or "rolled-back";
        var bound=previous is not null||resuming||existingPointer;
        var selected=previous is not null?previous.DataPath:resuming?retry!.Options.DataPath:existingPointer?discovered:requested.DataPath;
        var pipe=previous is not null?previous.Pipe:resuming?retry!.Options.Pipe:requested.Pipe;
        var expected=DataPaths.Registered(root,selected,false);NormalizedPipe(pipe);
        if(bound&&requested.DataPath is not null&&!SamePath(DataPaths.Registered(root,requested.DataPath,false),expected))throw new IOException("The requested data path conflicts with the existing or interrupted installation; restore or import data explicitly. / 指定存档路径与原安装或中断事务冲突，未切换资料。");
        if(bound&&requested.Pipe is not null&&NormalizedPipe(requested.Pipe)!=NormalizedPipe(pipe))throw new IOException("The requested pipe conflicts with the existing or interrupted installation. / 指定管道与原安装或中断事务冲突。");
        if(resuming&&retry!.ExpectedDataPath is {} saved&&!SamePath(saved,expected))throw new InvalidDataException("Interrupted profile path changed; restore its transaction before retrying");
        var recognized=await RecognizedAsync(expected,hashFile,cancel).ConfigureAwait(false);
        var mustPreserve=previous is not null||existingPointer||resuming&&retry!.ProfileAction=="preserve";
        var resumeInitialization=resuming&&retry!.ProfileAction=="initialize";
        if(!recognized&&(mustPreserve||!CanInitialize(expected,resumeInitialization,cancel)))throw new IOException("The original personal-data directory is missing, empty or unrecognized; restore it or import the original profile before retrying: "+expected+" / 原存档缺失、为空或无法识别，未创建新资料。");
        return new(recognized?"preserve":"initialize",expected,selected,pipe,resumeInitialization);
    }
    public async Task VerifyAsync(Func<string,CancellationToken,Task<string>> hashFile,CancellationToken cancel){
        SafePaths.NoLinks(ExpectedDataPath);
        var valid=Action=="preserve"
            ?await RecognizedAsync(ExpectedDataPath,hashFile,cancel).ConfigureAwait(false)
            :CanInitialize(ExpectedDataPath,ResumeInitialization,cancel);
        if(!valid)throw new IOException("Personal data changed during installation; no new profile was initialized. Restore or review the selected profile and retry: "+ExpectedDataPath);
    }
    static bool CanInitialize(string path,bool resume,CancellationToken cancel){
        cancel.ThrowIfCancellationRequested();
        SafePaths.NoLinks(path);if(File.Exists(path))return false;if(!Directory.Exists(path))return true;
        foreach(var entry in Directory.EnumerateFileSystemEntries(path)){
            cancel.ThrowIfCancellationRequested();
            if(!resume||!Directory.Exists(entry)||Path.GetFileName(entry) is not ("chromium" or "crash-reports"))return false;
            SafePaths.NoLinks(entry);var pending=new Stack<string>();pending.Push(entry);
            while(pending.Count>0)foreach(var child in Directory.EnumerateFileSystemEntries(pending.Pop())){cancel.ThrowIfCancellationRequested();SafePaths.NoLinks(child);if(Directory.Exists(child))pending.Push(child);}
        }
        return true;
    }
    static async Task<bool> ValidJsonAsync(string path,CancellationToken cancel){
        cancel.ThrowIfCancellationRequested();
        if(!File.Exists(path))return false;
        SafePaths.NoLinks(path);
        var bytes=await File.ReadAllBytesAsync(path,cancel).ConfigureAwait(false);
        try{using var document=JsonDocument.Parse(bytes);return document.RootElement.ValueKind==JsonValueKind.Object;}catch(JsonException){return false;}
    }
    static async Task<bool> SnapshotAsync(string path,Func<string,CancellationToken,Task<string>> hashFile,CancellationToken cancel){
        var commits=path+".snapshots/commits.jsonl";
        if(!File.Exists(commits))return await ValidJsonAsync(path,cancel).ConfigureAwait(false);
        SafePaths.NoLinks(commits);
        const int commitLimit=16384;
        var lines=new Queue<string>(commitLimit);
        await foreach(var line in File.ReadLinesAsync(commits,cancel).ConfigureAwait(false)){
            if(lines.Count==commitLimit)lines.Dequeue();
            lines.Enqueue(line);
        }
        foreach(var line in lines.Reverse()){
            cancel.ThrowIfCancellationRequested();
            try{
                using var document=JsonDocument.Parse(line);var value=document.RootElement;if(value.ValueKind!=JsonValueKind.Object)continue;
                if(!value.TryGetProperty("file",out var file)||file.ValueKind!=JsonValueKind.String||!value.TryGetProperty("sha256",out var hash)||hash.ValueKind!=JsonValueKind.String)continue;
                var name=file.GetString();if(string.IsNullOrEmpty(name)||name!=Path.GetFileName(name))continue;var candidate=SafePaths.Under(path+".snapshots",name);
                if(File.Exists(candidate)&&await hashFile(candidate,cancel).ConfigureAwait(false)==hash.GetString()&&await ValidJsonAsync(candidate,cancel).ConfigureAwait(false))return true;
            }catch(JsonException){}catch(InvalidDataException){}
        }
        return false;
    }
    public static async Task<bool> RecognizedAsync(string data,Func<string,CancellationToken,Task<string>> hashFile,CancellationToken cancel){
        cancel.ThrowIfCancellationRequested();
        SafePaths.NoLinks(data);if(!Directory.Exists(data))return false;
        if(await ValidJsonAsync(Path.Combine(data,"profile-initialized.json"),cancel).ConfigureAwait(false))return true;
        foreach(var file in new[]{"settings.json","galgame/companion.json","galgame/storages/dsh-whale-galgame/global.json","model-connections.json","cg-connections.json","cg-jobs.json"})
            if(await SnapshotAsync(Path.Combine(data,file),hashFile,cancel).ConfigureAwait(false))return true;
        return false;
    }
}
