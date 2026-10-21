using System;
using System.Runtime.InteropServices;
using System.Threading;
// Windows can stop delivering a secondary button-up outside a frameless HWND.
// Observe only mouse buttons/Escape during an explicitly armed pet gesture.
// No cursor positioning, keyboard hook, file access or network access.
public static class PetButtons {
 [DllImport("user32.dll")] static extern short GetAsyncKeyState(int key);
 static volatile string gesture="";static volatile bool done=false;
 static readonly AutoResetEvent changed=new AutoResetEvent(false);
 public static void Main(){
  var thread=new Thread(Poll);thread.IsBackground=true;thread.Start();
  string line;while((line=Console.ReadLine())!=null){gesture=line.Length<=120?line:"";changed.Set();}
  done=true;changed.Set();thread.Join(100);
 }
 static void Poll(){string previous="";int previousMask=-1;while(!done){
  string id=gesture;if(id.Length==0){previous="";previousMask=-1;changed.WaitOne();continue;}
  int mask=((GetAsyncKeyState(1)&0x8000)!=0?1:0)|((GetAsyncKeyState(2)&0x8000)!=0?2:0)|((GetAsyncKeyState(27)&0x8000)!=0?4:0);
  if(id!=previous||mask!=previousMask){try{Console.WriteLine(id+"|"+mask);Console.Out.Flush();}catch{return;}previous=id;previousMask=mask;}
  changed.WaitOne(16);
 }}
}
