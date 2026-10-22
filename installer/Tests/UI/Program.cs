using AiBuddy.Install;
using System.Reflection;
using System.Net;
using System.Text.Json;
namespace AiBuddy.Setup;
internal static class Program {
 public static InstallManifest Manifest=null!;
 public static byte[] ManifestBytes=[];
 public static UpdateDiscovery Updates=null!;
 public static string Cache=Path.Combine(Path.GetTempPath(),"AI Buddy UI Cache"),DefaultRoot=Path.Combine(Path.GetTempPath(),"AI Buddy UI install");
 public static InstallEngine Engine=null!;
 public static string? Argument(string[] args,string name)=>args.FirstOrDefault(x=>x.StartsWith("--"+name+"="))?.Split('=',2)[1];
 static T Field<T>(SetupForm f,string name)=>(T)typeof(SetupForm).GetField(name,BindingFlags.NonPublic|BindingFlags.Instance)!.GetValue(f)!;
 static IEnumerable<Control> Controls(Control c)=>c.Controls.Cast<Control>().SelectMany(x=>new[]{x}.Concat(Controls(x)));
 static readonly List<object> results=[];
 static void Assert(bool condition,string why){if(!condition)throw new Exception(why);}
 static void Check(string name,Action action){try{action();results.Add(new{name,passed=true});Console.WriteLine("PASS "+name);}catch(Exception ex){results.Add(new{name,passed=false,error=ex.ToString()});throw;}}
 static object? Invoke(SetupForm form,string name,params object[] values)=>typeof(SetupForm).GetMethod(name,BindingFlags.NonPublic|BindingFlags.Instance)!.Invoke(form,values);
 static void Pump(Func<bool> done,string why){var end=Environment.TickCount64+10000;while(!done()){if(Environment.TickCount64>end)throw new Exception("Timed out: "+why);Application.DoEvents();Thread.Sleep(10);}Application.DoEvents();}
 static void Settled(SetupForm f)=>Pump(()=>Field<CancellationTokenSource?>(f,"cancellation") is null&&Field<Button>(f,"install").Enabled,"asynchronous estimate and install ready");
 static void Shot(SetupForm f,string file){using var bitmap=new Bitmap(f.Width,f.Height);f.DrawToBitmap(bitmap,new Rectangle(Point.Empty,f.Size));bitmap.Save(file);}
 static void Reject(Action action){try{action();}catch(InvalidDataException){return;}throw new Exception("Expected argument rejection");}
 static HttpClient Mock(string version,List<string> calls,bool failed=false){
  const string api="https://api.github.com/repos/lXiaoSel1/AI-Buddy",web="https://github.com/lXiaoSel1/AI-Buddy";
  var source=new string('b',40);var tagSha=new string('c',40);var sha=new string('d',64);var manifestSha=new string('e',64);var tag="v"+version;
  var signature="-----BEGIN SSH SIGNATURE-----\nfixture\n-----END SSH SIGNATURE-----\n";var body=$"AI Buddy {version}\n\nSource: {source}\nManifest SHA-256: {manifestSha}\nInstaller SHA-256: {sha}\n";
  object Asset(string name,long size,string hash)=>new{name,size,state="uploaded",digest="sha256:"+hash,browser_download_url=web+"/releases/download/"+tag+"/"+name};
  return new(new Handler((request,cancel)=>{cancel.ThrowIfCancellationRequested();var url=request.RequestUri!.AbsoluteUri;calls.Add(url);Assert(request.Method==HttpMethod.Get&&!request.Headers.Contains("Authorization"),"Anonymous read-only GET required");if(failed)return Task.FromResult(new HttpResponseMessage(HttpStatusCode.ServiceUnavailable));
   object value=url switch{
    api+"/releases/latest"=>new{tag_name=tag,html_url=web+"/releases/tag/"+tag,target_commitish=source,draft=false,prerelease=false,assets=new[]{Asset("AI-Buddy-Setup-"+version+"-win-x64.exe",123,sha),Asset("install-manifest-"+version+".json",12,manifestSha)}},
    var p when p==api+"/git/ref/tags/"+tag=>new{@ref="refs/tags/"+tag,@object=new{type="tag",sha=tagSha}},
    var p when p==api+"/git/tags/"+tagSha=>new{sha=tagSha,tag,@object=new{type="commit",sha=source},message=body+signature,verification=new{verified=true,reason="valid",signature,payload=$"object {source}\ntype commit\ntag {tag}\ntagger fixture <test@example.invalid> 0 +0000\n\n"+body}},
    _=>throw new Exception("Actual download or external request forbidden: "+url)};return Task.FromResult(new HttpResponseMessage(HttpStatusCode.OK){Content=new ByteArrayContent(JsonSerializer.SerializeToUtf8Bytes(value))});}));
 }
 [STAThread] static int Main(string[] args){
  Application.SetHighDpiMode(HighDpiMode.PerMonitorV2);Application.EnableVisualStyles();Application.SetCompatibleTextRenderingDefault(false);
  var output=Path.GetFullPath(args[1]);Directory.CreateDirectory(output);var profile=Path.Combine(output,"isolated nonexisting profile 中文");DefaultRoot=Path.Combine(profile,"install");Cache=Path.Combine(profile,"cache");var host=new NeverHost();
  try{
   ManifestBytes=File.ReadAllBytes(args[0]);Manifest=Manifests.Parse(ManifestBytes,Hashing.Bytes(ManifestBytes));var calls=new List<string>();using var http=Mock("1.9.0",calls);Updates=new(http);Engine=new(Manifest,ManifestBytes,Hashing.Bytes(ManifestBytes),new Downloader(http),host,Environment.ProcessPath!);
   using(var form=new SetupForm(["--skip-update-check"])){
    form.Show();Settled(form);var language=Field<ComboBox>(form,"language");var edition=Field<ComboBox>(form,"edition");var initial=Field<ComboBox>(form,"initial");var roles=Field<CheckedListBox>(form,"characters");
    Check("defaults 11 roles 30fps DeepSeek",()=>Assert(roles.CheckedItems.Count==11&&edition.SelectedItem?.ToString()=="30fps"&&initial.SelectedItem?.ToString()=="DeepSeek","Wrong defaults"));
    foreach(var locale in new[]{0,1})Check("language "+locale,()=>{language.SelectedIndex=locale;Settled(form);Assert(Controls(form).Any(c=>c.Text==(locale==0?"安装位置":"Installation folder")),"Locale failed");Assert(Field<Button>(form,"checkUpdate").Text==(locale==0?"检查新版本":"Check for updates"),"Update locale");Shot(form,Path.Combine(output,$"installer-ui-{locale}.png"));});
    Check("skip check performs no HTTP",()=>Assert(calls.Count==0,"Unexpected HTTP"));
    Check("unchecking initial role updates initial list",()=>{roles.SetItemChecked(0,false);Settled(form);Assert(initial.Items.Count==10&&initial.SelectedItem?.ToString()!="DeepSeek","Initial list must follow selection");});
    Check("empty roles disable install after async estimates",()=>{for(int i=0;i<roles.Items.Count;i++)roles.SetItemChecked(i,false);Pump(()=>initial.Items.Count==0&&Field<Label>(form,"estimate").Text.Contains("initial",StringComparison.OrdinalIgnoreCase),"empty selection");Assert(!Field<Button>(form,"install").Enabled,"Empty selection not rejected");});
    Check("restored selection enables install",()=>{roles.SetItemChecked(0,true);Settled(form);Assert(initial.Items.Count==1&&initial.SelectedItem?.ToString()=="DeepSeek","Initial list recovery");});
    Check("open GUI does not create installation or call app",()=>Assert(!Directory.Exists(profile)&&host.Calls==0,"Unexpected mutation"));form.Close();
   }
   var root=Path.Combine(profile,"custom install & 中文");var cache=Path.Combine(profile,"custom cache");var data=Path.Combine(profile,"custom data");const string pipe="independent-ui-only-test";
   using(var form=new SetupForm(["--skip-update-check","--root="+root,"--cache="+cache,"--data="+data,"--pipe="+pipe,"--edition=60fps","--characters=deepseek,kimi","--initial=kimi","--language=en","--shortcuts=false","--launch=false"])){
    form.Show();Settled(form);var options=(InstallOptions)Invoke(form,"Options")!;
    Check("all ten handoff choices preserved",()=>Assert(options.Root==root&&options.Cache==cache&&options.DataPath==data&&options.Pipe==pipe&&options.Edition=="60fps"&&options.Characters.SequenceEqual(new[]{"deepseek","kimi"})&&options.InitialCharacter=="kimi"&&!options.Shortcuts&&!options.Launch,"Lost handoff options"));
    Check("partial initial list and handoff language",()=>Assert(Field<ComboBox>(form,"initial").Items.Count==2&&Field<ComboBox>(form,"initial").SelectedItem?.ToString()=="Kimi"&&Field<ComboBox>(form,"language").SelectedIndex==1,"Partial or locale incorrect"));
    Check("unchanged folder focus cycle preserves handoff choices",()=>{Field<TextBox>(form,"folder").Focus();Application.DoEvents();Field<ComboBox>(form,"edition").Focus();Settled(form);var after=(InstallOptions)Invoke(form,"Options")!;Assert(after.Edition=="60fps"&&after.Characters.SequenceEqual(new[]{"deepseek","kimi"})&&after.InitialCharacter=="kimi","Leaving unchanged folder discarded the transferred selections");});
    Shot(form,Path.Combine(output,"installer-ui-partial-60fps.png"));form.Close();
   }
   Check("unselected initial rejected",()=>Reject(()=>{using var f=new SetupForm(["--skip-update-check","--characters=deepseek","--initial=kimi"]);}));
   foreach(var bad in new[]{"--shortcuts=perhaps","--edition=24fps","--characters=unknown","--language=xx"})Check("reject "+bad,()=>Reject(()=>{using var f=new SetupForm(["--skip-update-check",bad]);}));
   var failedCalls=new List<string>();using(var failed=Mock("1.9.0",failedCalls,true)){
    Updates=new(failed);using var form=new SetupForm(["--language=en"]);form.Show();Pump(()=>Field<Label>(form,"updateStatus").Text.StartsWith("Update check failed:")&&Field<CancellationTokenSource?>(form,"cancellation") is null,"auto check failure");Settled(form);
    // Roll back follows its own pre-check (nothing to roll back to in this fresh folder), not the update check.
    Check("failed update check retains maintenance UI",()=>Assert(Field<Button>(form,"install").Enabled&&Field<Button>(form,"rollback").Enabled==(Field<string?>(form,"rollbackBlocked") is null)&&Field<Button>(form,"uninstall").Enabled&&Field<Button>(form,"checkUpdate").Enabled&&!Field<Button>(form,"openUpdate").Visible&&failedCalls.Count==1,"Failure disabled maintenance"));Shot(form,Path.Combine(output,"installer-ui-check-failed.png"));form.Close();
   }
   calls.Clear();Updates=new(http);using(var form=new SetupForm(["--skip-update-check","--language=zh-CN"])){
    form.Show();Settled(form);var task=(Task)Invoke(form,"CheckUpdate")!;Pump(()=>task.IsCompleted,"same version check");task.GetAwaiter().GetResult();Settled(form);
    Check("same version hides download",()=>Assert(Field<Label>(form,"updateStatus").Text=="当前没有更高的正式版本。"&&!Field<Button>(form,"openUpdate").Visible&&calls.Count==1,"Same version treated as update"));form.Close();
   }
   calls.Clear();using(var form=new SetupForm(["--offline="+Path.Combine(profile,"offline source"),"--language=en"])){
    form.Show();Settled(form);Check("offline source suppresses automatic version checks",()=>Assert(calls.Count==0&&((InstallOptions)Invoke(form,"Options")!).OfflineDirectory==Path.Combine(profile,"offline source"),"Offline opening performed network discovery"));form.Close();
   }
   var newerCalls=new List<string>();using(var newer=Mock("1.9.1",newerCalls)){
    Updates=new(newer);using var form=new SetupForm(["--language=en"]);form.Show();Pump(()=>Field<Button>(form,"openUpdate").Visible&&Field<CancellationTokenSource?>(form,"cancellation") is null,"signed newer release");Settled(form);
    Check("signed newer release shows download button",()=>Assert(Field<Button>(form,"openUpdate").Enabled&&Field<Label>(form,"updateStatus").Text.Contains("1.9.1")&&newerCalls.Count==3,"New version state incorrect"));
    Check("version discovery never downloads or installs",()=>Assert(newerCalls.All(u=>u.StartsWith("https://api.github.com/",StringComparison.Ordinal))&&host.Calls==0&&!Directory.Exists(profile),"Automatic mutation"));Shot(form,Path.Combine(output,"installer-ui-update-available.png"));form.Close();
   }
   var legacy=Path.Combine(output,"legacy portable pointer fixture");Directory.CreateDirectory(Path.Combine(legacy,"builds","previous"));Json.Save(Path.Combine(legacy,"local","current-build.json"),new{path="builds/previous",animationProfile="60fps"});
   using(var form=new SetupForm(["--skip-update-check","--root="+legacy])){
    form.Show();Settled(form);Check("legacy portable pointer without version is supported",()=>Assert((string)Invoke(form,"CurrentVersion")! ==ReleaseIdentity.Version&&Field<ComboBox>(form,"edition").SelectedItem?.ToString()=="60fps"&&host.Calls==0,"Legacy pointer blocked UI or version check"));form.Close();
   }
   foreach(var malformed in new[]{"bad-json","bad-version"}){
    var badRoot=Path.Combine(output,"preflight failure "+malformed);using var form=new SetupForm(["--skip-update-check","--language=en","--root="+badRoot]);form.Show();Settled(form);var pointer=Path.Combine(badRoot,"local","current-build.json");Directory.CreateDirectory(Path.GetDirectoryName(pointer)!);File.WriteAllText(pointer,malformed=="bad-json"?"{broken":"{\"version\":\"bad-version\"}");
    Check("install preflight safely rejects "+malformed,()=>{var task=(Task)Invoke(form,"Run","install")!;Pump(()=>task.IsCompleted,"invalid pointer preflight");task.GetAwaiter().GetResult();Assert(Field<Label>(form,"status").Text.StartsWith("Cannot confirm the installed version;")&&!form.IsDisposed&&host.Calls==0&&!Directory.Exists(Path.Combine(badRoot,"local","installer")),"Malformed version must not crash or start installation");});Shot(form,Path.Combine(output,"installer-ui-"+malformed+".png"));form.Close();
   }
   Json.Save(Path.Combine(output,"installer-ui.json"),new{ok=true,total=results.Count,tests=results,locales=2,roles=11,defaultEdition="30fps",defaultInitial="DeepSeek",httpMode="in-memory mock only",realNetworkRequests=0,appHostCalls=host.Calls,actualApplicationOrInstallerLaunched=false,at=DateTimeOffset.UtcNow});Console.WriteLine($"PASS {results.Count}/{results.Count}; mock HTTP only; no app or installer launched");return 0;
  }catch(Exception ex){Json.Save(Path.Combine(output,"installer-ui.json"),new{ok=false,total=results.Count,tests=results,error=ex.ToString(),appHostCalls=host.Calls,at=DateTimeOffset.UtcNow});Console.Error.WriteLine(ex);return 1;}
 }
}
sealed class Handler(Func<HttpRequestMessage,CancellationToken,Task<HttpResponseMessage>> action):HttpMessageHandler {protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request,CancellationToken cancel)=>action(request,cancel);}
sealed class NeverHost:IAppHost {
 public int Calls;Task Called(){Calls++;throw new Exception("App operations forbidden in GUI tests");}
 public Task Stop(string root,Installation? previous,IProgress<InstallProgress>? progress,CancellationToken cancel)=>Called();
 public Task StartAndVerify(string root,Installation installed,CancellationToken cancel)=>Called();
 public Task CreateShortcuts(string root,Installation installed,CancellationToken cancel)=>Called();
 public Task RemoveShortcuts(string root,CancellationToken cancel)=>Called();
}
