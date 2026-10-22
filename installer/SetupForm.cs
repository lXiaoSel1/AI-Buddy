using AiBuddy.Install;
namespace AiBuddy.Setup;
public sealed class SetupForm:Form {
    readonly ComboBox language=new(){DropDownStyle=ComboBoxStyle.DropDownList};
    readonly TextBox folder=new(),offline=new();
    readonly ComboBox edition=new(){DropDownStyle=ComboBoxStyle.DropDownList},initial=new(){DropDownStyle=ComboBoxStyle.DropDownList};
    readonly CheckedListBox characters=new(){CheckOnClick=true,IntegralHeight=false};
    readonly CheckBox shortcuts=new(){Checked=true,AutoSize=true},launch=new(){Checked=true,AutoSize=true};
    readonly Label estimate=new(){AutoSize=true,MaximumSize=new Size(720,0)},status=new(){AutoSize=true,MaximumSize=new Size(720,0)},rollbackNote=new(){AutoSize=true,MaximumSize=new Size(720,0),ForeColor=Color.DimGray};
    readonly ProgressBar bar=new(){Minimum=0,Maximum=1000};
    readonly Button install=new(){AutoSize=true},cancel=new(){AutoSize=true,Enabled=false},rollback=new(){AutoSize=true},uninstall=new(){AutoSize=true};
    readonly Button checkUpdate=new(){AutoSize=true},openUpdate=new(){AutoSize=true,Visible=false};
    readonly Label updateStatus=new(){AutoSize=true,MaximumSize=new Size(720,0)};
    readonly List<Button> browseButtons=[];
    readonly TableLayoutPanel layout=new(){Dock=DockStyle.Fill,ColumnCount=1,Padding=new Padding(24),AutoScroll=true};
    readonly FlowLayoutPanel footer=new(){Dock=DockStyle.Bottom,AutoSize=true,Padding=new Padding(24,12,24,12),WrapContents=true};
    CancellationTokenSource? cancellation;bool initializing=true;bool english;bool shown;int estimateRevision;readonly string[] args;UpdateRelease? availableUpdate;string? selectionError;string lastDefaultsRoot="";string? rollbackBlocked;
    string L(string zh,string en)=>english?en:zh;
    public SetupForm(string[] arguments) {
        args=arguments;Text="AI Buddy "+ReleaseIdentity.Version;Icon=Icon.ExtractAssociatedIcon(Environment.ProcessPath!);ClientSize=new Size(780,850);MinimumSize=new Size(640,740);StartPosition=FormStartPosition.CenterScreen;AutoScaleMode=AutoScaleMode.Dpi;Font=new Font("Segoe UI",10);
        language.Items.AddRange(["简体中文","English"]);language.SelectedIndex=System.Globalization.CultureInfo.CurrentUICulture.Name.StartsWith("zh")?0:1;english=language.SelectedIndex==1;
        if(Program.Argument(args,"language") is {} locale){if(locale is not ("en" or "zh-CN"))throw new InvalidDataException("Unsupported installer language");language.SelectedIndex=locale=="en"?1:0;english=language.SelectedIndex==1;}
        folder.Text=Program.Argument(args,"root")??Program.DefaultRoot;edition.Items.AddRange(["30fps","60fps"]);edition.SelectedItem="30fps";
        foreach(var c in Program.Manifest.Characters){characters.Items.Add(new Role(c.Id,c.Name),true);initial.Items.Add(new Role(c.Id,c.Name));}initial.SelectedIndex=0;
        characters.Height=160;folder.Width=550;offline.Width=550;edition.Width=150;initial.Width=180;
        try{var existing=InstallEngine.Defaults(folder.Text,Program.Manifest);edition.SelectedItem=existing.Edition;for(int i=0;i<characters.Items.Count;i++)characters.SetItemChecked(i,existing.Characters.Contains(((Role)characters.Items[i]).Id));SelectInitial(existing.InitialCharacter);}catch(Exception ex){selectionError=ex.Message;}
        if(Program.Argument(args,"edition") is {} requestedEdition){if(requestedEdition is not ("30fps" or "60fps"))throw new InvalidDataException("Invalid edition");edition.SelectedItem=requestedEdition;}
        if(Program.Argument(args,"characters") is {} requestedRoles){var ids=requestedRoles.Split(',');if(ids.Length==0||ids.Distinct().Count()!=ids.Length||ids.Any(id=>!Program.Manifest.Characters.Any(c=>c.Id==id)))throw new InvalidDataException("Invalid selected characters");for(int i=0;i<characters.Items.Count;i++)characters.SetItemChecked(i,ids.Contains(((Role)characters.Items[i]).Id));}
        lastDefaultsRoot=Path.GetFullPath(folder.Text);offline.Text=Program.Argument(args,"offline")??"";shortcuts.Checked=BooleanArgument("shortcuts",true);launch.Checked=BooleanArgument("launch",!args.Contains("--no-launch"));
        var requested=(Program.Argument(args,"characters-add")??Program.Argument(args,"character")??"").Split(',');for(int i=0;i<characters.Items.Count;i++)if(requested.Contains(((Role)characters.Items[i]).Id))characters.SetItemChecked(i,true);
        language.SelectedIndexChanged+=(_,_)=>{english=language.SelectedIndex==1;Render();};
        folder.Leave+=(_,_)=>ReadExisting();edition.SelectedIndexChanged+=(_,_)=>UpdateEstimate();
        characters.ItemCheck+=(_,_)=>{if(!initializing)BeginInvoke(UpdateInitial);};
        initial.SelectedIndexChanged+=(_,_)=>UpdateEstimate();
        offline.TextChanged+=(_,_)=>UpdateEstimate();
        install.Click+=async(_,_)=>await Run("install");cancel.Click+=(_,_)=>{cancellation?.Cancel();status.Text=L("正在安全停止；已下载内容可继续。","Stopping safely; downloaded data can be resumed.");};
        rollback.Click+=async(_,_)=>await Run("rollback");uninstall.Click+=async(_,_)=>await Run("uninstall");
        checkUpdate.Click+=async(_,_)=>await CheckUpdate();openUpdate.Click+=async(_,_)=>await OpenUpdate();
        FormClosing+=(_,e)=>{if(cancellation is not null){e.Cancel=true;cancellation.Cancel();status.Text=L("正在停止，完成后可关闭。","Stopping; close once the operation has stopped.");}};
        Controls.Add(layout);Controls.Add(footer);initializing=false;UpdateInitial();if(Program.Argument(args,"initial") is {} requestedInitial){if(!initial.Items.Cast<Role>().Any(r=>r.Id==requestedInitial))throw new InvalidDataException("Initial character must be selected");SelectInitial(requestedInitial);}Render();
        Shown+=async(_,_)=>{shown=true;try{await UpdateHandoff.SignalReady(args,Program.Manifest.AppVersion,Hashing.Bytes(Program.ManifestBytes));}catch(Exception ex){updateStatus.Text=ex.Message;}UpdateEstimate();if(!args.Contains("--skip-update-check")&&!args.Any(a=>a.StartsWith("--handoff-"))&&string.IsNullOrWhiteSpace(offline.Text))await CheckUpdate();};
    }
    bool BooleanArgument(string name,bool fallback)=>Program.Argument(args,name) is {} value?(bool.TryParse(value,out var parsed)?parsed:throw new InvalidDataException("Invalid "+name)):fallback;
    sealed record Role(string Id,string Name){public override string ToString()=>Name;}
    void SelectInitial(string id){for(int i=0;i<initial.Items.Count;i++)if(((Role)initial.Items[i]!).Id==id){initial.SelectedIndex=i;return;}}
    void ReadExisting(){try{var root=Path.GetFullPath(folder.Text);if(string.Equals(root,lastDefaultsRoot,StringComparison.OrdinalIgnoreCase))return;var e=InstallEngine.Defaults(folder.Text,Program.Manifest);lastDefaultsRoot=root;selectionError=null;initializing=true;edition.SelectedItem=e.Edition;for(int i=0;i<characters.Items.Count;i++)characters.SetItemChecked(i,e.Characters.Contains(((Role)characters.Items[i]).Id));UpdateInitial();SelectInitial(e.InitialCharacter);}catch(Exception ex){selectionError=ex.Message;status.Text=ex.Message;}finally{initializing=false;}UpdateEstimate();}
    void UpdateInitial(){var id=(initial.SelectedItem as Role)?.Id;initial.Items.Clear();foreach(var role in characters.CheckedItems.Cast<Role>())initial.Items.Add(role);if(initial.Items.Count>0){initial.SelectedIndex=0;if(id is not null)SelectInitial(id);}UpdateEstimate();}
    void Add(Control c,int height=0){c.Dock=DockStyle.Top;layout.Controls.Add(c);if(height>0)layout.RowStyles.Add(new RowStyle(SizeType.Absolute,height));else layout.RowStyles.Add(new RowStyle(SizeType.AutoSize));layout.RowCount++;}
    Label Heading(string text)=>new(){Text=text,AutoSize=true,Margin=new Padding(0,16,0,7)};
    FlowLayoutPanel Row(params Control[] controls){var row=new FlowLayoutPanel{AutoSize=true,WrapContents=true,Margin=new Padding(0,0,0,6)};row.Controls.AddRange(controls);return row;}
    Button Browse(TextBox target){var b=new Button{Text=L("浏览…","Browse…"),AutoSize=true};browseButtons.Add(b);b.Click+=(_,_)=>{if(cancellation is not null)return;using var picker=new FolderBrowserDialog{UseDescriptionForTitle=true,Description=L("选择文件夹","Choose folder"),SelectedPath=target.Text};if(picker.ShowDialog(this)==DialogResult.OK){target.Text=picker.SelectedPath;if(target==folder)ReadExisting();UpdateEstimate();}};return b;}
    void Render(){layout.SuspendLayout();layout.Controls.Clear();layout.RowStyles.Clear();layout.RowCount=0;browseButtons.Clear();
        Add(new Label{Text="AI Buddy "+ReleaseIdentity.Version,Font=new Font(Font.FontFamily,23,FontStyle.Bold),AutoSize=true});
        Add(Row(new Label{Text="Language",AutoSize=true,Padding=new Padding(0,7,10,0)},language));
        checkUpdate.Text=L("检查新版本","Check for updates");openUpdate.Text=L("下载并打开新版","Download and open update");Add(Row(checkUpdate,openUpdate));Add(updateStatus);
        Add(Heading(L("安装位置","Installation folder")));Add(Row(folder,Browse(folder)));
        Add(Heading(L("动画版本与初始角色","Animation edition and initial character")));Add(Row(edition,initial));
        Add(Heading(L("角色资源 · 可在以后补装","Character resources · add more later")));Add(characters,170);
        Add(Heading(L("离线资源目录（留空则从 GitHub 下载）","Offline resource folder (leave empty for GitHub)")));Add(Row(offline,Browse(offline)));
        shortcuts.Text=L("创建桌面和开始菜单入口","Create desktop and Start menu shortcuts");launch.Text=L("验证后保持 AI Buddy 运行","Keep AI Buddy running after verification");Add(Row(shortcuts,launch));
        Add(estimate);Add(bar,28);Add(status);Add(rollbackNote);
        install.Text=L("安装 / 补装 / 修复","Install / Add / Repair");cancel.Text=L("取消","Cancel");rollback.Text=L("回退上一版","Roll back");uninstall.Text=L("卸载…","Uninstall…");footer.Controls.Clear();footer.Controls.AddRange([install,cancel,rollback,uninstall]);
        Add(new Label{AutoSize=true,MaximumSize=new Size(720,0),Text=L("打开安装器时检查正式新版本；下载和安装需你点击确认。每次安装使用固定版本清单，保留个人数据。检查失败仍可离线安装、修复或回退。","The installer checks for stable updates when opened. Download and installation require your action. Each install uses a pinned manifest and retains personal data; offline install, repair and rollback remain available if checking fails."),ForeColor=Color.DimGray,Margin=new Padding(0,14,0,0)});
        layout.ResumeLayout();UpdateEstimate();
    }
    InstallOptions Options()=>new(folder.Text,Program.Argument(args,"cache")??Program.Cache,(string?)edition.SelectedItem??"30fps",characters.CheckedItems.Cast<Role>().Select(c=>c.Id).ToArray(),(initial.SelectedItem as Role)?.Id??"",string.IsNullOrWhiteSpace(offline.Text)?null:offline.Text,shortcuts.Checked,launch.Checked,Program.Argument(args,"data"),Program.Argument(args,"pipe"));
    async void UpdateEstimate(){if(initializing||cancellation is not null||!shown)return;RefreshRollback();var revision=++estimateRevision;install.Enabled=false;try{if(selectionError is not null)throw new InvalidDataException(selectionError);var options=Options();var e=await Task.Run(()=>Program.Engine.Estimate(options));if(IsDisposed||revision!=estimateRevision||cancellation is not null)return;estimate.Text=L($"所选下载 {FormatSize(e.DownloadBytes)} · 解压 {FormatSize(e.ExpandedBytes)}\n额外空间：缓存 {FormatSize(e.CacheAdditionalBytes)}，安装盘 {FormatSize(e.InstallAdditionalBytes)}；保留旧版本 {FormatSize(e.RetainedBytes)}",$"Selected download {FormatSize(e.DownloadBytes)} · Expanded {FormatSize(e.ExpandedBytes)}\nAdditional space: cache {FormatSize(e.CacheAdditionalBytes)}, install disk {FormatSize(e.InstallAdditionalBytes)}; retained version {FormatSize(e.RetainedBytes)}");install.Enabled=true;}catch(Exception ex){if(IsDisposed||revision!=estimateRevision||cancellation is not null)return;estimate.Text=ex.Message;install.Enabled=false;}}
    void Busy(bool value){estimateRevision++;install.Enabled=uninstall.Enabled=folder.Enabled=edition.Enabled=characters.Enabled=initial.Enabled=language.Enabled=checkUpdate.Enabled=offline.Enabled=shortcuts.Enabled=launch.Enabled=!value;rollback.Enabled=!value&&rollbackBlocked is null;foreach(var b in browseButtons)b.Enabled=!value;openUpdate.Enabled=!value&&availableUpdate is not null;cancel.Enabled=value;}
    string CurrentVersion(){var versions=new List<System.Version>{System.Version.Parse(ReleaseIdentity.Version)};foreach(var p in new[]{Path.Combine(folder.Text,"local","current-build.json"),Path.Combine(folder.Text,"local","installation.json")})if(File.Exists(p)){using var d=System.Text.Json.JsonDocument.Parse(File.ReadAllBytes(p));var r=d.RootElement;var raw=r.TryGetProperty("appVersion",out var av)?av.GetString():r.TryGetProperty("version",out var v)?v.GetString():null;if(raw is null)continue;if(!System.Text.RegularExpressions.Regex.IsMatch(raw,@"\A(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\z")||!System.Version.TryParse(raw,out var parsed))throw new InvalidDataException("Cannot determine installed version");versions.Add(parsed);}return versions.Max()!.ToString(3);}
    async Task CheckUpdate(){if(cancellation is not null)return;cancellation=new(TimeSpan.FromSeconds(20));Busy(true);updateStatus.Text=L("正在检查正式新版本…","Checking for stable updates…");try{availableUpdate=await Program.Updates.Check(CurrentVersion(),cancellation.Token);openUpdate.Visible=availableUpdate is not null;updateStatus.Text=availableUpdate is null?L("当前没有更高的正式版本。","No newer stable version is available."):L($"发现 {availableUpdate.Version}，可校验并打开新版安装器。",$"Version {availableUpdate.Version} is available. Verify and open its installer.");}catch(OperationCanceledException){updateStatus.Text=L("检查已取消；当前维护功能仍可使用。","Update check cancelled; current maintenance remains available.");}catch(Exception ex){updateStatus.Text=L("检查未完成：","Update check failed: ")+ex.Message;}finally{cancellation.Dispose();cancellation=null;Busy(false);UpdateEstimate();}}
    async Task OpenUpdate(){if(cancellation is not null||availableUpdate is null)return;var selected=availableUpdate;var options=Options();cancellation=new();Busy(true);var opened=false;try{var path=await Program.Updates.Download(selected,options.Cache,new Progress<InstallProgress>(p=>{updateStatus.Text=L("正在校验新版安装器：","Verifying newer installer: ")+p.Item;bar.Value=p.Total>0?(int)Math.Clamp(p.Completed*1000d/p.Total,0,1000):0;}),cancellation.Token);await UpdateHandoff.Start(selected,path,UpdateHandoff.BuildArguments(options,english?"en":"zh-CN",shortcuts.Checked,launch.Checked),cancellation.Token);opened=true;}catch(OperationCanceledException){updateStatus.Text=L("已取消；当前版本未变。","Cancelled; the current version is unchanged.");}catch(Exception ex){updateStatus.Text=L("新版未确认打开，当前安装器保留：","The newer installer did not confirm readiness; this installer remains open: ")+ex.Message;}finally{cancellation.Dispose();cancellation=null;if(opened)Close();else{Busy(false);UpdateEstimate();}}}
    // A slow check for a folder the user has since changed must not overwrite the newer folder's state.
    async void RefreshRollback(){
        var root=folder.Text;
        try{var reason=await Task.Run(()=>Program.Engine.RollbackBlocker(root,default));if(IsDisposed||cancellation is not null||folder.Text!=root)return;
            rollbackBlocked=reason;rollback.Enabled=reason is null;rollbackNote.Text=reason is null?"":L("暂时不能回退：","Roll back unavailable: ")+reason;}
        catch(Exception ex){if(!IsDisposed&&folder.Text==root){rollbackBlocked=ex.Message;rollback.Enabled=false;}}
    }
    static string FormatSize(long n)=>n>=1073741824?$"{n/1073741824d:F2} GiB":$"{n/1048576d:F1} MiB";
    async Task Run(string action) {
        if(cancellation is not null)return;bool removeData=false;
        try{if(action=="install"&&System.Version.Parse(CurrentVersion())>System.Version.Parse(ReleaseIdentity.Version)){status.Text=L("此安装器低于已安装版本，请先检查并打开新版。","This installer is older than the installed version; check and open its newer installer first.");return;}}catch(Exception ex){status.Text=L("无法确认安装版本，未执行任何安装操作：","Cannot confirm the installed version; no installation was started: ")+ex.Message;return;}
        if(action=="uninstall") {
            if(MessageBox.Show(this,L("卸载程序并保留个人数据？","Uninstall the program and keep personal data?"),"AI Buddy",MessageBoxButtons.OKCancel,MessageBoxIcon.Question)!=DialogResult.OK)return;
            using var choice=new Form{Text=L("个人数据","Personal data"),ClientSize=new Size(500,180),StartPosition=FormStartPosition.CenterParent,Font=Font};
            var check=new CheckBox{Text=L("同时删除默认目录中的个人数据（不可恢复）","Also delete default personal data (irreversible)"),AutoSize=true,Location=new Point(20,25),Checked=false};
            var proceed=new Button{Text=L("继续卸载","Uninstall"),DialogResult=DialogResult.OK,Location=new Point(20,100),AutoSize=true};choice.Controls.AddRange([check,proceed]);choice.AcceptButton=proceed;if(choice.ShowDialog(this)!=DialogResult.OK)return;removeData=check.Checked;
        }
        var options=Options();cancellation=new CancellationTokenSource();Busy(true);
        var last=DateTime.MinValue;var progress=new Progress<InstallProgress>(p=>{if((p.Phase=="download"||p.Phase=="extract")&&(DateTime.UtcNow-last).TotalMilliseconds<150)return;last=DateTime.UtcNow;status.Text=$"{Phase(p.Phase)} · {p.Item}\n{p.Detail??(p.Total>0?FormatSize(p.Completed)+" / "+FormatSize(p.Total):"")}";bar.Value=p.Total>0?(int)Math.Clamp(p.Completed*1000d/p.Total,0,1000):0;});
        try {
            if(action=="rollback")await Program.Engine.Rollback(options.Root,progress,cancellation.Token);
            else if(action=="uninstall")await Program.Engine.Uninstall(options.Root,removeData,progress,cancellation.Token,options.Cache);
            else await Program.Engine.Install(options,progress,cancellation.Token);
            var record=InstallEngine.Existing(options.Root);var startup=record?.Startup;status.Text=startup?.SafeMode==true?L("程序已安装并进入安全模式：","Installed in safe mode: ")+startup.StartupFailure?.ToString():L("已完成。","Completed.");bar.Value=1000;
            if(action=="install"&&record?.Warnings is {Length:>0} warnings)status.Text+="\n"+L("已安装，但有一步没有完成：","Installed, but one step did not finish: ")+string.Join("; ",warnings);
        }catch(OperationCanceledException){status.Text=L("已取消；保留已验证下载，下次可继续。","Cancelled; verified downloads are retained for resuming.");}
        catch(Exception ex){status.Text=L("未完成：","Not completed: ")+ex.Message;MessageBox.Show(this,status.Text,"AI Buddy",MessageBoxButtons.OK,MessageBoxIcon.Error);}
        finally{cancellation.Dispose();cancellation=null;Busy(false);UpdateEstimate();}
    }
    string Phase(string phase)=>phase switch{"download"=>L("下载中","Downloading"),"extract"=>L("解压与校验","Extracting and verifying"),"cached"=>L("复用已验证下载","Verified cache"),"retry"=>L("重试当前包","Retrying package"),"waiting"=>L("等待安全退出","Waiting for safe exit"),"complete"=>L("完成","Complete"),"rolled-back"=>L("已回退程序","Program restored"),"warning"=>L("提醒","Note"),"pruned"=>L("清理旧版本","Removed an older version"),"cleanup-pending"=>L("稍后清理","Cleanup pending"),_=>phase};
}
