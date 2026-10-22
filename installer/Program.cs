using System.Reflection;
using System.Text.Json;
using AiBuddy.Install;
namespace AiBuddy.Setup;
internal static class Program {
    public static byte[] ManifestBytes=[];
    public static InstallManifest Manifest=null!;
    public static readonly string Self=Environment.ProcessPath??throw new IOException("Installer path unavailable");
    public static readonly string Cache=Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),"AI Buddy","InstallerCache");
    public static readonly string DefaultRoot=Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),"Programs","AI Buddy");
    public static HttpClient Http=null!;
    public static InstallEngine Engine=null!;
    public static UpdateDiscovery Updates=null!;
    [STAThread] static int Main(string[] args) {
        ApplicationConfiguration.Initialize();
        try {
            var headlessAction=args.Contains("--headless")?HeadlessAction(args):null;
            using var input=Assembly.GetExecutingAssembly().GetManifestResourceStream("InstallManifest")??throw new IOException("Embedded manifest missing");
            using var buffer=new MemoryStream();input.CopyTo(buffer);ManifestBytes=buffer.ToArray();
            Manifest=Manifests.Parse(ManifestBytes,BuildIdentity.ManifestSha256);
            Http=new HttpClient(new SocketsHttpHandler{AllowAutoRedirect=true,MaxAutomaticRedirections=8,AutomaticDecompression=System.Net.DecompressionMethods.None,ConnectTimeout=TimeSpan.FromSeconds(30)}){Timeout=Timeout.InfiniteTimeSpan};
            Http.DefaultRequestHeaders.UserAgent.ParseAdd("AI-Buddy-Setup/"+ReleaseIdentity.Version);
            Updates=new(Http);
            Engine=new(Manifest,ManifestBytes,BuildIdentity.ManifestSha256,new Downloader(Http),new WindowsHost(Argument(args,"roots")),Self);
            if(headlessAction is not null)return Task.Run(()=>RunHeadless(args,headlessAction)).GetAwaiter().GetResult();
            UpdateHandoff.GetLaunchIdentity(args,Manifest.AppVersion,BuildIdentity.ManifestSha256);
            Application.Run(new SetupForm(args));return 0;
        } catch(Exception ex) {
            var error=Path.Combine(Path.GetTempPath(),"AI-Buddy-Setup-error.txt");File.WriteAllText(error,ex.ToString());
            if(args.Contains("--headless")&&Argument(args,"receipt") is {} receipt)Json.Save(receipt,new{ok=false,error=ex.Message,events=Array.Empty<InstallProgress>()});
            // The parent manager reports handoff failures and remains available.
            // A failed child must exit instead of stranding a modal error window.
            if(!args.Contains("--headless")&&!args.Any(a=>a.StartsWith("--handoff-",StringComparison.Ordinal)))MessageBox.Show(ex.Message+"\n\n"+error,"AI Buddy",MessageBoxButtons.OK,MessageBoxIcon.Error);
            return 1;
        } finally {Http?.Dispose();}
    }
    public static string? Argument(string[] args,string name)=>args.FirstOrDefault(a=>a.StartsWith("--"+name+"=",StringComparison.Ordinal))?[(name.Length+3)..];
    static string HeadlessAction(string[] args) {
        var actions=args.Where(a=>a.StartsWith("--action",StringComparison.OrdinalIgnoreCase)).ToArray();
        if(actions.Length>1||actions.Length==1&&!actions[0].StartsWith("--action=",StringComparison.Ordinal))throw new InvalidDataException("Use exactly one --action=<operation>");
        var command=actions.Length==0?"install":actions[0][9..];
        if(command is not ("inspect" or "check-update" or "install" or "rollback" or "uninstall" or "data-import-commit" or "data-import-recover"))throw new InvalidDataException("Unknown installer action: "+command);
        return command;
    }
    static async Task<int> RunHeadless(string[] args,string command) {
        var readOnly=command is "inspect" or "check-update";
        var root=Argument(args,"root")??(readOnly?DefaultRoot:throw new IOException("--root is required for headless maintenance"));
        var receipt=Argument(args,"receipt")??(readOnly?Path.Combine(Path.GetTempPath(),"AI-Buddy-Setup-"+Guid.NewGuid().ToString("N")+".json"):Path.Combine(root,"local","installer","headless-result.json"));
        var log=new List<InstallProgress>();var progress=new Progress<InstallProgress>(v=>{lock(log){if(v.Phase!="download"&&v.Phase!="extract")log.Add(v);}});
        try {
            if(command=="inspect"){Json.Save(receipt,new{ok=true,version=Manifest.AppVersion,manifestSha256=Hashing.Bytes(ManifestBytes),runtime=System.Runtime.InteropServices.RuntimeInformation.FrameworkDescription});return 0;}
            if(command=="check-update") {using var timeout=new CancellationTokenSource(TimeSpan.FromSeconds(90));var update=await Updates.Check(ReleaseIdentity.Version,timeout.Token);Json.Save(receipt,new{ok=true,command,currentVersion=ReleaseIdentity.Version,available=update is not null,release=update});return 0;}
            if(command is "data-import-commit" or "data-import-recover"){
                var importer=new DataImportManager(new WindowsHost(Argument(args,"roots")));
                var result=command=="data-import-commit"?await importer.Commit(root,Argument(args,"import-plan")??throw new IOException("--import-plan is required"),progress,default):await importer.Recover(root,progress,default);
                Json.Save(receipt,new{ok=true,command,result,installation=InstallEngine.Existing(root),events=log.ToArray(),at=DateTimeOffset.UtcNow});return 0;
            }
            if(command=="rollback")await Engine.Rollback(root,progress,default);
            else if(command=="uninstall")await Engine.Uninstall(root,false,progress,default,Argument(args,"cache")??Cache);
            else if(command=="install") {
                var defaults=InstallEngine.Defaults(root,Manifest);var ids=(Argument(args,"characters")??string.Join(',',defaults.Characters)).Split(',');
                var initial=Argument(args,"initial")??(ids.Contains(defaults.InitialCharacter)?defaults.InitialCharacter:ids.Contains("deepseek")?"deepseek":ids[0]);
                await Engine.Install(new(root,Argument(args,"cache")??Cache,Argument(args,"edition")??defaults.Edition,ids,initial,Argument(args,"offline"),args.Contains("--shortcuts"),!args.Contains("--no-launch"),Argument(args,"data"),Argument(args,"pipe"),KeepCache:args.Contains("--keep-cache")),progress,default);
            }
            else throw new InvalidDataException("Unknown installer action: "+command);
            Json.Save(receipt,new{ok=true,version=Manifest.AppVersion,command,installation=InstallEngine.Existing(root),events=log.ToArray(),at=DateTimeOffset.UtcNow});return 0;
        }catch(Exception ex){Json.Save(receipt,new{ok=false,error=ex.ToString(),events=log.ToArray(),at=DateTimeOffset.UtcNow});return 1;}
    }
}
