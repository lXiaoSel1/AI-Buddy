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
    public static InstallProfile Select(string root,InstallOptions requested,Installation? previous,string? discovered,InstallJournal? retry,bool existingPointer) {
        var resuming=previous is null&&retry is{ProfileAction:"initialize" or "preserve",PreviousPointer:null,PreviousInstallation:null}&&retry.Phase is "staging" or "committing" or "rolled-back";
        var bound=previous is not null||resuming||existingPointer;
        var selected=previous is not null?previous.DataPath:resuming?retry!.Options.DataPath:existingPointer?discovered:requested.DataPath;
        var pipe=previous is not null?previous.Pipe:resuming?retry!.Options.Pipe:requested.Pipe;
        var expected=DataPaths.Registered(root,selected,false);NormalizedPipe(pipe);
        if(bound&&requested.DataPath is not null&&!SamePath(DataPaths.Registered(root,requested.DataPath,false),expected))throw new IOException("The requested data path conflicts with the existing or interrupted installation; restore or import data explicitly. / 指定存档路径与原安装或中断事务冲突，未切换资料。");
        if(bound&&requested.Pipe is not null&&NormalizedPipe(requested.Pipe)!=NormalizedPipe(pipe))throw new IOException("The requested pipe conflicts with the existing or interrupted installation. / 指定管道与原安装或中断事务冲突。");
        if(resuming&&retry!.ExpectedDataPath is {} saved&&!SamePath(saved,expected))throw new InvalidDataException("Interrupted profile path changed; restore its transaction before retrying");
        var recognized=Recognized(expected);
        var mustPreserve=previous is not null||existingPointer||resuming&&retry!.ProfileAction=="preserve";
        var resumeInitialization=resuming&&retry!.ProfileAction=="initialize";
        if(!recognized&&(mustPreserve||!CanInitialize(expected,resumeInitialization)))throw new IOException("The original personal-data directory is missing, empty or unrecognized; restore it or import the original profile before retrying: "+expected+" / 原存档缺失、为空或无法识别，未创建新资料。");
        return new(recognized?"preserve":"initialize",expected,selected,pipe,resumeInitialization);
    }
    public void Verify(){
        SafePaths.NoLinks(ExpectedDataPath);
        if(Action=="preserve"?!Recognized(ExpectedDataPath):!CanInitialize(ExpectedDataPath,ResumeInitialization))throw new IOException("Personal data changed during installation; no new profile was initialized. Restore or review the selected profile and retry: "+ExpectedDataPath);
    }
    static bool CanInitialize(string path,bool resume){
        SafePaths.NoLinks(path);if(File.Exists(path))return false;if(!Directory.Exists(path))return true;
        foreach(var entry in Directory.EnumerateFileSystemEntries(path)){
            if(!resume||!Directory.Exists(entry)||Path.GetFileName(entry) is not ("chromium" or "crash-reports"))return false;
            SafePaths.NoLinks(entry);var pending=new Stack<string>();pending.Push(entry);
            while(pending.Count>0)foreach(var child in Directory.EnumerateFileSystemEntries(pending.Pop())){SafePaths.NoLinks(child);if(Directory.Exists(child))pending.Push(child);}
        }
        return true;
    }
    static bool ValidJson(string path){
        if(!File.Exists(path))return false;SafePaths.NoLinks(path);try{using var document=JsonDocument.Parse(File.ReadAllBytes(path));return document.RootElement.ValueKind==JsonValueKind.Object;}catch(JsonException){return false;}
    }
    static bool Snapshot(string path){
        var commits=path+".snapshots/commits.jsonl";
        if(!File.Exists(commits))return ValidJson(path);SafePaths.NoLinks(commits);
        foreach(var line in File.ReadLines(commits).TakeLast(16384).Reverse())try{
            using var document=JsonDocument.Parse(line);var value=document.RootElement;if(value.ValueKind!=JsonValueKind.Object)continue;
            if(!value.TryGetProperty("file",out var file)||file.ValueKind!=JsonValueKind.String||!value.TryGetProperty("sha256",out var hash)||hash.ValueKind!=JsonValueKind.String)continue;
            var name=file.GetString();if(string.IsNullOrEmpty(name)||name!=Path.GetFileName(name))continue;var candidate=SafePaths.Under(path+".snapshots",name);
            if(File.Exists(candidate)&&Hashing.FileHash(candidate).GetAwaiter().GetResult()==hash.GetString()&&ValidJson(candidate))return true;
        }catch(JsonException){}catch(InvalidDataException){}
        return false;
    }
    public static bool Recognized(string data){
        SafePaths.NoLinks(data);if(!Directory.Exists(data))return false;
        if(ValidJson(Path.Combine(data,"profile-initialized.json")))return true;
        foreach(var file in new[]{"settings.json","galgame/companion.json","galgame/storages/dsh-whale-galgame/global.json","model-connections.json","cg-connections.json","cg-jobs.json"})if(Snapshot(Path.Combine(data,file)))return true;
        return false;
    }
}
