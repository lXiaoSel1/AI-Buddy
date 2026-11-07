using System;
using System.Globalization;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

// Read-only foreground window observation. The helper exits when its parent closes stdin.
public static class PetFullscreen {
 const uint WmQuit=0x12,WmTimer=0x113,WmSample=0x8001;
 [StructLayout(LayoutKind.Sequential)] struct Rect { public int Left,Top,Right,Bottom; }
 [StructLayout(LayoutKind.Sequential)] struct Point { public int X,Y; }
 [StructLayout(LayoutKind.Sequential)] struct MonitorInfo { public int Size; public Rect Monitor,Work; public uint Flags; }
 [StructLayout(LayoutKind.Sequential)] struct Message { public IntPtr Hwnd;public uint Id;public UIntPtr WParam;public IntPtr LParam;public uint Time;public Point Pt;public uint Private; }
 delegate void WinEvent(IntPtr hook,uint evt,IntPtr hwnd,int objectId,int childId,uint thread,uint time);
 [DllImport("user32.dll")] static extern bool SetProcessDpiAwarenessContext(IntPtr value);
 [DllImport("user32.dll")] static extern IntPtr SetThreadDpiAwarenessContext(IntPtr value);
 [DllImport("user32.dll")] static extern bool SetProcessDPIAware();
 [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
 [DllImport("user32.dll")] static extern IntPtr GetDesktopWindow();
 [DllImport("user32.dll")] static extern IntPtr GetShellWindow();
 [DllImport("user32.dll")] static extern IntPtr GetWindow(IntPtr hwnd,uint relation);
 [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hwnd,out uint pid);
 [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr hwnd,out Rect rect);
 [DllImport("user32.dll")] static extern bool GetClientRect(IntPtr hwnd,out Rect rect);
 [DllImport("user32.dll")] static extern bool ClientToScreen(IntPtr hwnd,ref Point point);
 [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr hwnd);
 [DllImport("user32.dll")] static extern bool IsIconic(IntPtr hwnd);
 [DllImport("user32.dll")] static extern bool IsZoomed(IntPtr hwnd);
 [DllImport("user32.dll",EntryPoint="GetWindowLongW")] static extern int GetWindowLong(IntPtr hwnd,int index);
 [DllImport("user32.dll",CharSet=CharSet.Unicode)] static extern int GetClassName(IntPtr hwnd,StringBuilder value,int length);
 [DllImport("user32.dll")] static extern IntPtr MonitorFromWindow(IntPtr hwnd,uint flags);
 [DllImport("user32.dll",CharSet=CharSet.Unicode)] static extern bool GetMonitorInfo(IntPtr monitor,ref MonitorInfo info);
 [DllImport("dwmapi.dll")] static extern int DwmGetWindowAttribute(IntPtr hwnd,uint attribute,out uint value,uint bytes);
 [DllImport("dwmapi.dll",EntryPoint="DwmGetWindowAttribute")] static extern int DwmGetRect(IntPtr hwnd,uint attribute,out Rect rect,uint bytes);
 [DllImport("user32.dll")] static extern IntPtr SetWinEventHook(uint first,uint last,IntPtr module,WinEvent callback,uint pid,uint thread,uint flags);
 [DllImport("user32.dll")] static extern bool UnhookWinEvent(IntPtr hook);
 [DllImport("user32.dll",EntryPoint="PeekMessageW")] static extern bool PeekMessage(out Message message,IntPtr hwnd,uint first,uint last,uint remove);
 [DllImport("user32.dll",EntryPoint="GetMessageW")] static extern int GetMessage(out Message message,IntPtr hwnd,uint first,uint last);
 [DllImport("user32.dll")] static extern UIntPtr SetTimer(IntPtr hwnd,UIntPtr id,uint delay,IntPtr callback);
 [DllImport("user32.dll")] static extern bool KillTimer(IntPtr hwnd,UIntPtr id);
 [DllImport("user32.dll",EntryPoint="PostThreadMessageW")] static extern bool PostThreadMessage(uint thread,uint message,UIntPtr wParam,IntPtr lParam);
 [DllImport("kernel32.dll")] static extern uint GetCurrentThreadId();

 static string Bool(bool value){return value?"true":"false";}
 static string Handle(IntPtr value){return "\""+unchecked((ulong)value.ToInt64()).ToString(CultureInfo.InvariantCulture)+"\"";}
 static string Bounds(Rect rect){return "{\"x\":"+rect.Left+",\"y\":"+rect.Top+",\"width\":"+(rect.Right-rect.Left)+",\"height\":"+(rect.Bottom-rect.Top)+"}";}
 static bool SystemWindow(IntPtr hwnd){
  if(hwnd==GetDesktopWindow()||hwnd==GetShellWindow())return true;
  var name=new StringBuilder(128);GetClassName(hwnd,name,name.Capacity);
  switch(name.ToString()){case "Shell_TrayWnd":case "Shell_SecondaryTrayWnd":case "Progman":case "WorkerW":case "#32768":return true;default:return false;}
 }
 static string Client(IntPtr hwnd){
  Rect rect;if(!GetClientRect(hwnd,out rect))return "null";
  Point left=new Point{X=rect.Left,Y=rect.Top},right=new Point{X=rect.Right,Y=rect.Bottom};
  if(!ClientToScreen(hwnd,ref left)||!ClientToScreen(hwnd,ref right))return "null";
  return Bounds(new Rect{Left=left.X,Top=left.Y,Right=right.X,Bottom=right.Y});
 }
 static string Window(IntPtr hwnd,IntPtr monitor){
  uint pid;if(hwnd==IntPtr.Zero||GetWindowThreadProcessId(hwnd,out pid)==0)return "null";
  uint cloaked;int cloakStatus=DwmGetWindowAttribute(hwnd,14,out cloaked,4); // DWMWA_CLOAKED
  Rect rect;string bounds=GetWindowRect(hwnd,out rect)?Bounds(rect):"null";
  string frame=DwmGetRect(hwnd,9,out rect,16)==0?Bounds(rect):"null"; // DWMWA_EXTENDED_FRAME_BOUNDS, physical pixels
  return "{\"handle\":"+Handle(hwnd)+",\"pid\":"+pid+",\"monitor\":"+(monitor==IntPtr.Zero?"null":Handle(monitor))+
   ",\"visible\":"+Bool(IsWindowVisible(hwnd))+",\"minimized\":"+Bool(IsIconic(hwnd))+",\"maximized\":"+Bool(IsZoomed(hwnd))+
   ",\"framed\":"+Bool((GetWindowLong(hwnd,-16)&0x00c40000)!=0)+ // WS_CAPTION | WS_THICKFRAME
   ",\"cloaked\":"+(cloakStatus==0?Bool(cloaked!=0):"null")+",\"system\":"+Bool(SystemWindow(hwnd))+
   ",\"topmost\":"+Bool((GetWindowLong(hwnd,-20)&8)!=0)+",\"bounds\":"+bounds+",\"frame\":"+frame+",\"client\":"+Client(hwnd)+"}";
 }
 static bool Above(IntPtr top,IntPtr bottom){
  if(top==IntPtr.Zero||bottom==IntPtr.Zero||top==bottom)return false;
  for(int i=0;i<64&&top!=IntPtr.Zero;i++){top=GetWindow(top,2);if(top==bottom)return true;} // GW_HWNDNEXT
  return false;
 }
 static void Sample(IntPtr pet,bool diagnostic=false){
  IntPtr foreground=GetForegroundWindow(),monitor=MonitorFromWindow(foreground,0),petMonitor=MonitorFromWindow(pet,0);
  var info=new MonitorInfo{Size=Marshal.SizeOf(typeof(MonitorInfo))};
  string bounds=monitor!=IntPtr.Zero&&GetMonitorInfo(monitor,ref info)?Bounds(info.Monitor):"null";
  string zOrder=diagnostic?",\"foregroundAbovePet\":"+(Above(foreground,pet)?"true":Above(pet,foreground)?"false":"null"):"";
  Console.WriteLine("{\"foreground\":"+Window(foreground,monitor)+",\"pet\":"+Window(pet,petMonitor)+",\"monitor\":"+bounds+zOrder+"}");Console.Out.Flush();
 }
 public static int Main(string[] args){
  ulong pet;if(args.Length<1||args.Length>2||!UInt64.TryParse(args[0],NumberStyles.None,CultureInfo.InvariantCulture,out pet)||pet==0||args.Length==2&&args[1]!="watch")return 2;
  Thread.CurrentThread.CurrentCulture=CultureInfo.InvariantCulture;
  try { if(!SetProcessDpiAwarenessContext(new IntPtr(-4)))SetThreadDpiAwarenessContext(new IntPtr(-4)); }catch(EntryPointNotFoundException){SetProcessDPIAware();}
  IntPtr hwnd=new IntPtr(unchecked((long)pet));
  if(args.Length==1){Sample(hwnd,true);return 0;}
  Message message;PeekMessage(out message,IntPtr.Zero,0,0,0);
  uint thread=GetCurrentThreadId();
  WinEvent callback=(hook,evt,window,objectId,childId,eventThread,time)=>PostThreadMessage(thread,WmSample,UIntPtr.Zero,IntPtr.Zero);
  IntPtr foregroundHook=SetWinEventHook(3,3,IntPtr.Zero,callback,0,0,0); // EVENT_SYSTEM_FOREGROUND, out of context
  UIntPtr timer=SetTimer(IntPtr.Zero,UIntPtr.Zero,400,IntPtr.Zero);
  if(timer==UIntPtr.Zero){if(foregroundHook!=IntPtr.Zero)UnhookWinEvent(foregroundHook);return 3;}
  var parent=new Thread(()=>{try{while(Console.ReadLine()!=null)PostThreadMessage(thread,WmSample,UIntPtr.Zero,IntPtr.Zero);}finally{PostThreadMessage(thread,WmQuit,UIntPtr.Zero,IntPtr.Zero);}});
  parent.IsBackground=true;parent.Start();
  try{Sample(hwnd);while(GetMessage(out message,IntPtr.Zero,0,0)>0)if(message.Id==WmTimer||message.Id==WmSample)Sample(hwnd);}
  finally{KillTimer(IntPtr.Zero,timer);if(foregroundHook!=IntPtr.Zero)UnhookWinEvent(foregroundHook);GC.KeepAlive(callback);}
  return 0;
 }
}
