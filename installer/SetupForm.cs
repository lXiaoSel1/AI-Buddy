using AiBuddy.Install;
namespace AiBuddy.Setup;
public sealed class SetupForm:Form {
    readonly ComboBox language=new(){DropDownStyle=ComboBoxStyle.DropDownList};
    readonly TextBox folder=new(),offline=new();
    readonly ComboBox edition=new(){DropDownStyle=ComboBoxStyle.DropDownList},initial=new(){DropDownStyle=ComboBoxStyle.DropDownList};
    readonly CheckedListBox characters=new(){CheckOnClick=true,IntegralHeight=false};
    readonly CheckBox shortcuts=new(){Checked=true,AutoSize=true},launch=new(){Checked=true,AutoSize=true};
    readonly Label estimate=new(){AutoSize=true,MaximumSize=new Size(720,0)},status=new(){AutoSize=true,MaximumSize=new Size(720,0)};
    readonly ProgressBar bar=new(){Minimum=0,Maximum=1000};
    readonly Button install=new(){AutoSize=true},cancel=new(){AutoSize=true,Enabled=false},rollback=new(){AutoSize=true},uninstall=new(){AutoSize=true};
    readonly TableLayoutPanel layout=new(){Dock=DockStyle.Fill,ColumnCount=1,Padding=new Padding(24),AutoScroll=true};
    readonly FlowLayoutPanel footer=new(){Dock=DockStyle.Bottom,AutoSize=true,Padding=new Padding(24,12,24,12),WrapContents=true};
    CancellationTokenSource? cancellation;bool initializing=true;bool english;readonly string[] args;
    string L(string zh,string en)=>english?en:zh;
    public SetupForm(string[] arguments) {
        args=arguments;Text="AI Buddy "+ReleaseIdentity.Version;Icon=Icon.ExtractAssociatedIcon(Environment.ProcessPath!);ClientSize=new Size(780,850);MinimumSize=new Size(640,740);StartPosition=FormStartPosition.CenterScreen;AutoScaleMode=AutoScaleMode.Dpi;Font=new Font("Segoe UI",10);
        language.Items.AddRange(["简体中文","English"]);language.SelectedIndex=System.Globalization.CultureInfo.CurrentUICulture.Name.StartsWith("zh")?0:1;english=language.SelectedIndex==1;
        folder.Text=Program.Argument(args,"root")??Program.DefaultRoot;edition.Items.AddRange(["30fps","60fps"]);edition.SelectedItem="30fps";
        foreach(var c in Program.Manifest.Characters){characters.Items.Add(new Role(c.Id,c.Name),true);initial.Items.Add(new Role(c.Id,c.Name));}initial.SelectedIndex=0;
        characters.Height=160;folder.Width=550;offline.Width=550;edition.Width=150;initial.Width=180;
        var existing=InstallEngine.Defaults(folder.Text,Program.Manifest);edition.SelectedItem=existing.Edition;for(int i=0;i<characters.Items.Count;i++)characters.SetItemChecked(i,existing.Characters.Contains(((Role)characters.Items[i]).Id));SelectInitial(existing.InitialCharacter);
        var requested=(Program.Argument(args,"characters-add")??Program.Argument(args,"character")??"").Split(',');for(int i=0;i<characters.Items.Count;i++)if(requested.Contains(((Role)characters.Items[i]).Id))characters.SetItemChecked(i,true);
        language.SelectedIndexChanged+=(_,_)=>{english=language.SelectedIndex==1;Render();};
        folder.Leave+=(_,_)=>ReadExisting();edition.SelectedIndexChanged+=(_,_)=>UpdateEstimate();
        characters.ItemCheck+=(_,_)=>{if(!initializing)BeginInvoke(UpdateInitial);};
        initial.SelectedIndexChanged+=(_,_)=>UpdateEstimate();
        install.Click+=async(_,_)=>await Run("install");cancel.Click+=(_,_)=>{cancellation?.Cancel();status.Text=L("正在安全停止；已下载内容可继续。","Stopping safely; downloaded data can be resumed.");};
        rollback.Click+=async(_,_)=>await Run("rollback");uninstall.Click+=async(_,_)=>await Run("uninstall");
        FormClosing+=(_,e)=>{if(cancellation is not null){e.Cancel=true;cancellation.Cancel();status.Text=L("正在停止，完成后可关闭。","Stopping; close once the operation has stopped.");}};
        Controls.Add(layout);Controls.Add(footer);initializing=false;UpdateInitial();Render();
    }
    sealed record Role(string Id,string Name){public override string ToString()=>Name;}
    void SelectInitial(string id){for(int i=0;i<initial.Items.Count;i++)if(((Role)initial.Items[i]!).Id==id){initial.SelectedIndex=i;return;}}
    void ReadExisting(){try{var e=InstallEngine.Defaults(folder.Text,Program.Manifest);initializing=true;edition.SelectedItem=e.Edition;for(int i=0;i<characters.Items.Count;i++)characters.SetItemChecked(i,e.Characters.Contains(((Role)characters.Items[i]).Id));UpdateInitial();SelectInitial(e.InitialCharacter);}catch(Exception ex){status.Text=ex.Message;}finally{initializing=false;}UpdateEstimate();}
    void UpdateInitial(){var id=(initial.SelectedItem as Role)?.Id;initial.Items.Clear();foreach(var role in characters.CheckedItems.Cast<Role>())initial.Items.Add(role);if(initial.Items.Count>0){initial.SelectedIndex=0;if(id is not null)SelectInitial(id);}UpdateEstimate();}
    void Add(Control c,int height=0){c.Dock=DockStyle.Top;layout.Controls.Add(c);if(height>0)layout.RowStyles.Add(new RowStyle(SizeType.Absolute,height));else layout.RowStyles.Add(new RowStyle(SizeType.AutoSize));layout.RowCount++;}
    Label Heading(string text)=>new(){Text=text,AutoSize=true,Margin=new Padding(0,16,0,7)};
    FlowLayoutPanel Row(params Control[] controls){var row=new FlowLayoutPanel{AutoSize=true,WrapContents=true,Margin=new Padding(0,0,0,6)};row.Controls.AddRange(controls);return row;}
    Button Browse(TextBox target){var b=new Button{Text=L("浏览…","Browse…"),AutoSize=true};b.Click+=(_,_)=>{using var picker=new FolderBrowserDialog{UseDescriptionForTitle=true,Description=L("选择文件夹","Choose folder"),SelectedPath=target.Text};if(picker.ShowDialog(this)==DialogResult.OK){target.Text=picker.SelectedPath;if(target==folder)ReadExisting();UpdateEstimate();}};return b;}
    void Render(){layout.SuspendLayout();layout.Controls.Clear();layout.RowStyles.Clear();layout.RowCount=0;
        Add(new Label{Text="AI Buddy "+ReleaseIdentity.Version,Font=new Font(Font.FontFamily,23,FontStyle.Bold),AutoSize=true});
        Add(Row(new Label{Text="Language",AutoSize=true,Padding=new Padding(0,7,10,0)},language));
        Add(Heading(L("安装位置","Installation folder")));Add(Row(folder,Browse(folder)));
        Add(Heading(L("动画版本与初始角色","Animation edition and initial character")));Add(Row(edition,initial));
        Add(Heading(L("角色资源 · 可在以后补装","Character resources · add more later")));Add(characters,170);
        Add(Heading(L("离线资源目录（留空则从 GitHub 下载）","Offline resource folder (leave empty for GitHub)")));Add(Row(offline,Browse(offline)));offline.TextChanged+=(_,_)=>UpdateEstimate();
        shortcuts.Text=L("创建桌面和开始菜单入口","Create desktop and Start menu shortcuts");launch.Text=L("验证后保持 AI Buddy 运行","Keep AI Buddy running after verification");Add(Row(shortcuts,launch));
        Add(estimate);Add(bar,28);Add(status);
        install.Text=L("安装 / 补装 / 修复","Install / Add / Repair");cancel.Text=L("取消","Cancel");rollback.Text=L("回退上一版","Roll back");uninstall.Text=L("卸载…","Uninstall…");footer.Controls.Clear();footer.Controls.AddRange([install,cancel,rollback,uninstall]);
        Add(new Label{AutoSize=true,MaximumSize=new Size(720,0),Text=L("不会开启联网聊天、CG 或自动更新。升级和回退保留个人数据。下载中断后重新运行本安装器可继续。","Chat, CG and auto-update stay off. Updates and rollback retain personal data. Run this installer again to resume interrupted downloads."),ForeColor=Color.DimGray,Margin=new Padding(0,14,0,0)});
        layout.ResumeLayout();UpdateEstimate();
    }
    InstallOptions Options()=>new(folder.Text,Program.Cache,(string?)edition.SelectedItem??"30fps",characters.CheckedItems.Cast<Role>().Select(c=>c.Id).ToArray(),(initial.SelectedItem as Role)?.Id??"",string.IsNullOrWhiteSpace(offline.Text)?null:offline.Text,shortcuts.Checked,launch.Checked);
    void UpdateEstimate(){if(initializing||cancellation is not null)return;try{var e=Program.Engine.Estimate(Options());estimate.Text=L($"所选下载 {FormatSize(e.DownloadBytes)} · 解压 {FormatSize(e.ExpandedBytes)}\n额外空间：缓存 {FormatSize(e.CacheAdditionalBytes)}，安装盘 {FormatSize(e.InstallAdditionalBytes)}；保留旧版本 {FormatSize(e.RetainedBytes)}",$"Selected download {FormatSize(e.DownloadBytes)} · Expanded {FormatSize(e.ExpandedBytes)}\nAdditional space: cache {FormatSize(e.CacheAdditionalBytes)}, install disk {FormatSize(e.InstallAdditionalBytes)}; retained version {FormatSize(e.RetainedBytes)}");install.Enabled=true;}catch(Exception ex){estimate.Text=ex.Message;install.Enabled=false;}}
    static string FormatSize(long n)=>n>=1073741824?$"{n/1073741824d:F2} GiB":$"{n/1048576d:F1} MiB";
    async Task Run(string action) {
        if(cancellation is not null)return;bool removeData=false;
        if(action=="uninstall") {
            if(MessageBox.Show(this,L("卸载程序并保留个人数据？","Uninstall the program and keep personal data?"),"AI Buddy",MessageBoxButtons.OKCancel,MessageBoxIcon.Question)!=DialogResult.OK)return;
            using var choice=new Form{Text=L("个人数据","Personal data"),ClientSize=new Size(500,180),StartPosition=FormStartPosition.CenterParent,Font=Font};
            var check=new CheckBox{Text=L("同时删除默认目录中的个人数据（不可恢复）","Also delete default personal data (irreversible)"),AutoSize=true,Location=new Point(20,25),Checked=false};
            var proceed=new Button{Text=L("继续卸载","Uninstall"),DialogResult=DialogResult.OK,Location=new Point(20,100),AutoSize=true};choice.Controls.AddRange([check,proceed]);choice.AcceptButton=proceed;if(choice.ShowDialog(this)!=DialogResult.OK)return;removeData=check.Checked;
        }
        var options=Options();cancellation=new CancellationTokenSource();install.Enabled=rollback.Enabled=uninstall.Enabled=folder.Enabled=edition.Enabled=characters.Enabled=initial.Enabled=language.Enabled=false;cancel.Enabled=true;
        var last=DateTime.MinValue;var progress=new Progress<InstallProgress>(p=>{if((p.Phase=="download"||p.Phase=="extract")&&(DateTime.UtcNow-last).TotalMilliseconds<150)return;last=DateTime.UtcNow;status.Text=$"{Phase(p.Phase)} · {p.Item}\n{p.Detail??(p.Total>0?FormatSize(p.Completed)+" / "+FormatSize(p.Total):"")}";bar.Value=p.Total>0?(int)Math.Clamp(p.Completed*1000d/p.Total,0,1000):0;});
        try {
            if(action=="rollback")await Program.Engine.Rollback(options.Root,progress,cancellation.Token);
            else if(action=="uninstall")await Program.Engine.Uninstall(options.Root,removeData,progress,cancellation.Token);
            else await Program.Engine.Install(options,progress,cancellation.Token);
            var startup=InstallEngine.Existing(options.Root)?.Startup;status.Text=startup?.SafeMode==true?L("程序已安装并进入安全模式：","Installed in safe mode: ")+startup.StartupFailure?.ToString():L("已完成。","Completed.");bar.Value=1000;
        }catch(OperationCanceledException){status.Text=L("已取消；保留已验证下载，下次可继续。","Cancelled; verified downloads are retained for resuming.");}
        catch(Exception ex){status.Text=L("未完成：","Not completed: ")+ex.Message;MessageBox.Show(this,status.Text,"AI Buddy",MessageBoxButtons.OK,MessageBoxIcon.Error);}
        finally{cancellation.Dispose();cancellation=null;install.Enabled=rollback.Enabled=uninstall.Enabled=folder.Enabled=edition.Enabled=characters.Enabled=initial.Enabled=language.Enabled=true;cancel.Enabled=false;UpdateEstimate();}
    }
    string Phase(string phase)=>phase switch{"download"=>L("下载中","Downloading"),"extract"=>L("解压与校验","Extracting and verifying"),"cached"=>L("复用已验证下载","Verified cache"),"retry"=>L("重试当前包","Retrying package"),"waiting"=>L("等待安全退出","Waiting for safe exit"),"complete"=>L("完成","Complete"),"rolled-back"=>L("已回退程序","Program restored"),_=>phase};
}
