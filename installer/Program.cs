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
    [STAThread] static int Main(string[] args) {
        ApplicationConfiguration.Initialize();
        try {
            using var input=Assembly.GetExecutingAssembly().GetManifestResourceStream("InstallManifest")??throw new IOException("Embedded manifest missing");
            using var buffer=new MemoryStream();input.CopyTo(buffer);ManifestBytes=buffer.ToArray();
            Manifest=Manifests.Parse(ManifestBytes,BuildIdentity.ManifestSha256);
            Http=new HttpClient(new SocketsHttpHandler{AllowAutoRedirect=true,MaxAutomaticRedirections=8,AutomaticDecompression=System.Net.DecompressionMethods.None,ConnectTimeout=TimeSpan.FromSeconds(30)}){Timeout=Timeout.InfiniteTimeSpan};
            Http.DefaultRequestHeaders.UserAgent.ParseAdd("AI-Buddy-Setup/"+ReleaseIdentity.Version);
            Engine=new(Manifest,ManifestBytes,BuildIdentity.ManifestSha256,new Downloader(Http),new WindowsHost(Argument(args,"roots")),Self);
            if(args.Contains("--headless"))return Task.Run(()=>RunHeadless(args)).GetAwaiter().GetResult();
            Application.Run(new SetupForm(args));return 0;
        } catch(Exception ex) {
            var error=Path.Combine(Path.GetTempPath(),"AI-Buddy-Setup-error.txt");File.WriteAllText(error,ex.ToString());
            if(!args.Contains("--headless"))MessageBox.Show(ex.Message+"\n\n"+error,"AI Buddy",MessageBoxButtons.OK,MessageBoxIcon.Error);
            return 1;
        } finally {Http?.Dispose();}
    }
    public static string? Argument(string[] args,string name)=>args.FirstOrDefault(a=>a.StartsWith("--"+name+"=",StringComparison.Ordinal))?[(name.Length+3)..];
    static async Task<int> RunHeadless(string[] args) {
        var root=Argument(args,"root")??throw new IOException("--root is required for headless maintenance");
        var receipt=Argument(args,"receipt")??Path.Combine(root,"local","installer","headless-result.json");
        var log=new List<InstallProgress>();var progress=new Progress<InstallProgress>(v=>{lock(log){if(v.Phase!="download"&&v.Phase!="extract")log.Add(v);}});
        try {
            var command=Argument(args,"action")??"install";
            if(command=="inspect"){Json.Save(receipt,new{ok=true,version=Manifest.AppVersion,manifestSha256=Hashing.Bytes(ManifestBytes),runtime=System.Runtime.InteropServices.RuntimeInformation.FrameworkDescription});return 0;}
            if(command=="rollback")await Engine.Rollback(root,progress,default);
            else if(command=="uninstall")await Engine.Uninstall(root,false,progress,default);
            else {
                var defaults=InstallEngine.Defaults(root,Manifest);var ids=(Argument(args,"characters")??string.Join(',',defaults.Characters)).Split(',');
                var initial=Argument(args,"initial")??(ids.Contains(defaults.InitialCharacter)?defaults.InitialCharacter:ids.Contains("deepseek")?"deepseek":ids[0]);
                await Engine.Install(new(root,Argument(args,"cache")??Cache,Argument(args,"edition")??defaults.Edition,ids,initial,Argument(args,"offline"),args.Contains("--shortcuts"),!args.Contains("--no-launch"),Argument(args,"data"),Argument(args,"pipe")),progress,default);
            }
            Json.Save(receipt,new{ok=true,version=Manifest.AppVersion,command,installation=InstallEngine.Existing(root),events=log.ToArray(),at=DateTimeOffset.UtcNow});return 0;
        }catch(Exception ex){Json.Save(receipt,new{ok=false,error=ex.ToString(),events=log.ToArray(),at=DateTimeOffset.UtcNow});return 1;}
    }
}
