using AiBuddy.Install;
using System.Reflection;
namespace AiBuddy.Setup;
internal static class Program {
 public static InstallManifest Manifest=null!;
 public static string Cache=Path.Combine(Path.GetTempPath(),"AI Buddy UI Cache"),DefaultRoot=Path.Combine(Path.GetTempPath(),"AI Buddy UI install");
 public static InstallEngine Engine=null!;
 public static string? Argument(string[] args,string name)=>args.FirstOrDefault(x=>x.StartsWith("--"+name+"="))?.Split('=',2)[1];
 static T Field<T>(SetupForm f,string name)=>(T)typeof(SetupForm).GetField(name,BindingFlags.NonPublic|BindingFlags.Instance)!.GetValue(f)!;
 static IEnumerable<Control> Controls(Control c)=>c.Controls.Cast<Control>().SelectMany(x=>new[]{x}.Concat(Controls(x)));
 [STAThread] static int Main(string[] args){
  Application.SetHighDpiMode(HighDpiMode.PerMonitorV2);Application.EnableVisualStyles();Application.SetCompatibleTextRenderingDefault(false);
  var bytes=File.ReadAllBytes(args[0]);Manifest=Manifests.Parse(bytes,Hashing.Bytes(bytes));
  using var http=new HttpClient();Engine=new(Manifest,bytes,Hashing.Bytes(bytes),new Downloader(http),null!,Environment.ProcessPath!);
  Directory.CreateDirectory(args[1]);using var form=new SetupForm([]);form.Show();Application.DoEvents();
  var language=Field<ComboBox>(form,"language");var edition=Field<ComboBox>(form,"edition");var initial=Field<ComboBox>(form,"initial");var roles=Field<CheckedListBox>(form,"characters");
  if(roles.CheckedItems.Count!=11||edition.SelectedItem?.ToString()!="30fps"||initial.SelectedItem?.ToString()!="DeepSeek")throw new Exception("Wrong defaults");
  foreach(var locale in new[]{0,1}){language.SelectedIndex=locale;Application.DoEvents();if(!Controls(form).Any(c=>c.Text==(locale==0?"安装位置":"Installation folder")))throw new Exception("Locale failed");using var bitmap=new Bitmap(form.Width,form.Height);form.DrawToBitmap(bitmap,new Rectangle(Point.Empty,form.Size));bitmap.Save(Path.Combine(args[1],$"installer-ui-{locale}.png"));}
  roles.SetItemChecked(0,false);Application.DoEvents();if(initial.Items.Count!=10||initial.SelectedItem?.ToString()=="DeepSeek")throw new Exception("Initial list must follow selected roles");
  for(int i=0;i<roles.Items.Count;i++)roles.SetItemChecked(i,false);Application.DoEvents();if(Field<Button>(form,"install").Enabled)throw new Exception("Empty selection must reject");
  Json.Save(Path.Combine(args[1],"installer-ui.json"),new{ok=true,locales=2,roles=11,defaultEdition="30fps",defaultInitial="DeepSeek",dpi=form.DeviceDpi,size=new{form.Width,form.Height},emptySelectionRejected=true});form.Close();Console.WriteLine("PASS WinForms languages, defaults and role dependencies");return 0;
 }
}
