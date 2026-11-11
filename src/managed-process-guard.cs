using System;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Threading.Tasks;
using System.IO;
using System.Text;
using System.Collections.Generic;

// A scoped Windows Job Object owns one managed native runtime and descendants.
// Closing the host pipe or losing the exact owner process closes its only handle.
internal static class ManagedProcessGuard {
  [StructLayout(LayoutKind.Sequential)] struct Basic { public long ProcessTime, JobTime; public uint Flags; public UIntPtr Min,Max; public uint Active; public UIntPtr Affinity; public uint Priority,Scheduling; }
  [StructLayout(LayoutKind.Sequential)] struct IO { public ulong ReadOps,WriteOps,OtherOps,ReadBytes,WriteBytes,OtherBytes; }
  [StructLayout(LayoutKind.Sequential)] struct Limits { public Basic Basic; public IO IO; public UIntPtr ProcessMemory,JobMemory,PeakProcess,PeakJob; }
  [StructLayout(LayoutKind.Sequential)] struct Accounting { public long User,Kernel,PeriodUser,PeriodKernel; public uint Faults,Total,Active,Terminated; }
  [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern IntPtr CreateJobObject(IntPtr attributes,string name);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool SetInformationJobObject(IntPtr job,int info,IntPtr value,uint length);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool AssignProcessToJobObject(IntPtr job,IntPtr process);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool QueryInformationJobObject(IntPtr job,int info,out Accounting value,uint length,IntPtr returned);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool TerminateJobObject(IntPtr job,uint code);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
  [DllImport("psapi.dll",SetLastError=true)] static extern bool EnumProcesses([Out] uint[] ids,uint bytes,out uint used);
  [DllImport("kernel32.dll",SetLastError=true)] static extern IntPtr OpenProcess(uint access,bool inherit,uint pid);
  [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool QueryFullProcessImageName(IntPtr process,uint flags,StringBuilder path,ref uint size);
  [StructLayout(LayoutKind.Sequential)] struct NativeTime { public uint Low,High; }
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool GetProcessTimes(IntPtr process,out NativeTime created,out NativeTime exited,out NativeTime kernel,out NativeTime user);
  [StructLayout(LayoutKind.Sequential)] struct ProcessBasic { public IntPtr Reserved1,Peb,Reserved2a,Reserved2b; public UIntPtr Pid,ParentPid; }
  [DllImport("ntdll.dll")] static extern int NtQueryInformationProcess(IntPtr process,int type,out ProcessBasic info,int size,out int returned);
  [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern IntPtr CreateFile(string path,uint access,uint share,IntPtr security,uint disposition,uint flags,IntPtr template);
  [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();
  [DllImport("advapi32.dll",SetLastError=true)] static extern bool OpenProcessToken(IntPtr process,uint access,out IntPtr token);
  [DllImport("advapi32.dll",SetLastError=true)] static extern bool GetTokenInformation(IntPtr token,int kind,IntPtr value,uint size,out uint needed);
  [DllImport("advapi32.dll")] static extern IntPtr GetSidSubAuthorityCount(IntPtr sid);
  [DllImport("advapi32.dll")] static extern IntPtr GetSidSubAuthority(IntPtr sid,uint index);
  [DllImport("advapi32.dll")] static extern bool IsTokenRestricted(IntPtr token);
  static int ValidationAccess(string[] args) {
    if(args.Length!=3)throw new Exception("Expected --validation-access manifest result");
    IntPtr token=IntPtr.Zero,info=Marshal.AllocHGlobal(4096);uint needed;uint integrity=0;bool restricted=false;
    try {if(!OpenProcessToken(GetCurrentProcess(),8,out token)||!GetTokenInformation(token,25,info,4096,out needed))throw new Exception("Validation token identity unavailable");IntPtr sid=Marshal.ReadIntPtr(info);byte count=Marshal.ReadByte(GetSidSubAuthorityCount(sid));integrity=(uint)Marshal.ReadInt32(GetSidSubAuthority(sid,(uint)(count-1)));restricted=IsTokenRestricted(token);}
    finally {if(token!=IntPtr.Zero)CloseHandle(token);Marshal.FreeHGlobal(info);}
    if(integrity!=4096||!restricted)throw new Exception("Validation access checks require the actual restricted Low token");
    string[] rows=File.ReadAllLines(Path.GetFullPath(args[1]),new UTF8Encoding(false,true));if(rows.Length>200020||rows.Length==0||rows[0]!="buddy-validation-access-v1")throw new Exception("Invalid bounded validation access manifest");
    int checkedPaths=0,checks=0;var allowed=new List<string>();var errors=new List<string>();uint[] rights={2,4,16,256,65536,262144,524288};var seen=new HashSet<string>(StringComparer.OrdinalIgnoreCase);
    for(int i=1;i<rows.Length;i++){string row=rows[i];if(row.Length<3||row.Length>65536||row[1]!='|'||(row[0]!='F'&&row[0]!='D'))throw new Exception("Invalid validation access row");string path=new UTF8Encoding(false,true).GetString(Convert.FromBase64String(row.Substring(2)));if(!Path.IsPathRooted(path)||!seen.Add(path))throw new Exception("Validation access path is not unique and absolute");bool directory=row[0]=='D';FileAttributes attrs=File.GetAttributes(path);if((attrs&FileAttributes.ReparsePoint)!=0||directory!=((attrs&FileAttributes.Directory)!=0))throw new Exception("Validation source changed type or became linked");checkedPaths++;
      foreach(uint access in rights){IntPtr file=CreateFile(path,access,7,IntPtr.Zero,3,directory?0x02000000u:0x80u,IntPtr.Zero);int error=Marshal.GetLastWin32Error();checks++;if(file!=new IntPtr(-1)){CloseHandle(file);allowed.Add("{\"path\":"+Json(path)+",\"access\":"+access+"}");}else if(error!=5)errors.Add("{\"path\":"+Json(path)+",\"access\":"+access+",\"win32\":"+error+"}");}
      if(directory){IntPtr file=CreateFile(path,64,7,IntPtr.Zero,3,0x02000000,IntPtr.Zero);int error=Marshal.GetLastWin32Error();checks++;if(file!=new IntPtr(-1)){CloseHandle(file);allowed.Add("{\"path\":"+Json(path)+",\"access\":64}");}else if(error!=5)errors.Add("{\"path\":"+Json(path)+",\"access\":64,\"win32\":"+error+"}");}
      if(allowed.Count>0||errors.Count>0)break;
    }
    bool safe=allowed.Count==0&&errors.Count==0;string output="{\"version\":1,\"safe\":"+(safe?"true":"false")+",\"integrityRid\":"+integrity+",\"restricted\":true,\"checkedPaths\":"+checkedPaths+",\"checks\":"+checks+",\"allowed\":["+string.Join(",",allowed.ToArray())+"],\"errors\":["+string.Join(",",errors.ToArray())+"]}";
    using(var file=new FileStream(Path.GetFullPath(args[2]),FileMode.CreateNew,FileAccess.Write,FileShare.None)){byte[] bytes=new UTF8Encoding(false).GetBytes(output);file.Write(bytes,0,bytes.Length);file.Flush(true);}return safe?0:3;
  }
  static string Json(string value) {
    var text=new StringBuilder("\"");foreach(char c in value){switch(c){case '\\':text.Append("\\\\");break;case '"':text.Append("\\\"");break;case '\n':text.Append("\\n");break;case '\r':text.Append("\\r");break;case '\t':text.Append("\\t");break;default:if(c<32)text.Append("\\u"+((int)c).ToString("x4"));else text.Append(c);break;}}return text.Append('"').ToString();
  }
  // Read-only mode: no Job Object, no admission and no filesystem writes.
  // The same opened process handle supplies birth, image and parent identity.
  static string ProcessRow(uint pid) {
    if(pid==0)return null;IntPtr process=OpenProcess(0x1000,false,pid);if(process==IntPtr.Zero)return null;
    try {
      NativeTime created,exited,kernel,user;ProcessBasic info;int returned;
      if(!GetProcessTimes(process,out created,out exited,out kernel,out user))return null;
      if(NtQueryInformationProcess(process,0,out info,Marshal.SizeOf(typeof(ProcessBasic)),out returned)!=0||info.Pid.ToUInt64()!=pid)return null;
      var path=new StringBuilder(32768);uint length=(uint)path.Capacity;if(!QueryFullProcessImageName(process,0,path,ref length)||length==0)return null;
      long fileTime=(long)(((ulong)created.High<<32)|created.Low),ticks=DateTime.FromFileTimeUtc(fileTime).Ticks;
      ulong parent=info.ParentPid.ToUInt64();if(parent>int.MaxValue)return null;
      return "{\"pid\":"+pid+",\"parentPid\":"+parent+",\"creationTime\":"+Json(ticks.ToString(System.Globalization.CultureInfo.InvariantCulture))+",\"exeRealPath\":"+Json(path.ToString())+"}";
    }finally{CloseHandle(process);}
  }
  static int Snapshot(string[] args) {
    if(args.Length>2)throw new Exception("Expected --snapshot [pid]");Console.OutputEncoding=new UTF8Encoding(false);var rows=new List<string>();
    if(args.Length==2){uint pid;if(!uint.TryParse(args[1],out pid)||pid==0||pid>int.MaxValue)throw new Exception("Invalid snapshot PID");string row=ProcessRow(pid);if(row!=null)rows.Add(row);}
    else{uint[] ids=new uint[1024];uint used;for(;;){if(!EnumProcesses(ids,(uint)(ids.Length*4),out used))throw new Exception("EnumProcesses failed "+Marshal.GetLastWin32Error());if(used<ids.Length*4)break;if(ids.Length>=1048576)throw new Exception("Process inventory exceeds limit");ids=new uint[ids.Length*2];}var seen=new HashSet<uint>();for(int index=0;index<used/4;index++)if(seen.Add(ids[index])){string row=ProcessRow(ids[index]);if(row!=null)rows.Add(row);}}
    Console.WriteLine("["+string.Join(",",rows.ToArray())+"]");return 0;
  }
  static void RetryReceiptIo(Action operation) {
    int[] delays={50,150,350};
    for(int attempt=0;;attempt++) {
      try {operation();return;}
      catch(IOException error) {
        int win32=error.HResult&0xffff;
        if((win32!=32&&win32!=33)||attempt==delays.Length)throw;
        System.Threading.Thread.Sleep(delays[attempt]);
      }
    }
  }
  static string FlushStopReceipt(string path,string receipt) {
    RetryReceiptIo(()=>Directory.CreateDirectory(Path.GetDirectoryName(path)));
    string pending=path+".pending";
    byte[] bytes=new UTF8Encoding(false).GetBytes(receipt);
    FileStream output=null;
    RetryReceiptIo(()=>{output=new FileStream(pending,FileMode.CreateNew,FileAccess.Write,FileShare.None);});
    using(output) {
      RetryReceiptIo(()=>{
        output.Position=0;
        output.SetLength(0);
        output.Write(bytes,0,bytes.Length);
        output.Flush(true);
      });
    }
    return pending;
  }
  static int Main(string[] args) {
    IntPtr job=IntPtr.Zero,memory=IntPtr.Zero;
    int ownerPid=0,rootPid=0;
    long ownerTicks=0,rootTicks=0;
    Guid guardId=Guid.Empty;
    string guardStage="before-assignment";
    try {
      if(args.Length>0&&args[0]=="--snapshot")return Snapshot(args);
      if(args.Length>0&&args[0]=="--validation-access")return ValidationAccess(args);
      if(args.Length!=6)throw new Exception("Expected owner/runtime identities and a private stop receipt");
      ownerPid=int.Parse(args[0]);rootPid=int.Parse(args[2]);
      ownerTicks=long.Parse(args[1]);rootTicks=long.Parse(args[3]);
      if(!Guid.TryParse(args[5],out guardId))throw new Exception("Invalid private guard identity");
      using(var owner=Process.GetProcessById(ownerPid))using(var root=Process.GetProcessById(rootPid)) {
        if(owner.StartTime.ToUniversalTime().Ticks!=ownerTicks||root.StartTime.ToUniversalTime().Ticks!=rootTicks)throw new Exception("Process identity changed");
        job=CreateJobObject(IntPtr.Zero,null);if(job==IntPtr.Zero)throw new Exception("CreateJobObject failed "+Marshal.GetLastWin32Error());
        var limits=new Limits();limits.Basic.Flags=0x2000; // JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE; breakaway is not allowed.
        int size=Marshal.SizeOf(typeof(Limits));memory=Marshal.AllocHGlobal(size);Marshal.StructureToPtr(limits,memory,false);
        if(!SetInformationJobObject(job,9,memory,(uint)size))throw new Exception("SetInformationJobObject failed "+Marshal.GetLastWin32Error());
        if(!AssignProcessToJobObject(job,root.Handle))throw new Exception("AssignProcessToJobObject failed "+Marshal.GetLastWin32Error());
        guardStage="assigned";
        Console.WriteLine("{\"ready\":true,\"ownerPid\":"+ownerPid+",\"rootPid\":"+rootPid+",\"killOnOwnerExit\":true,\"breakawayAllowed\":false}");Console.Out.Flush();
        Task<string> line=Console.In.ReadLineAsync();string trigger="owner-exited";
        while(!owner.HasExited&&owner.StartTime.ToUniversalTime().Ticks==ownerTicks) {
          if(line.Wait(250)){string text=line.Result;if(text==null||text=="close"){trigger=text==null?"owner-pipe-closed":"host-stop";break;}if(text.StartsWith("status:")){string id=text.Substring(7);Guid parsed;if(!Guid.TryParse(id,out parsed))throw new Exception("Invalid status request");Accounting value;if(!QueryInformationJobObject(job,1,out value,(uint)Marshal.SizeOf(typeof(Accounting)),IntPtr.Zero))throw new Exception("QueryInformationJobObject failed "+Marshal.GetLastWin32Error());Console.WriteLine("{\"requestId\":\""+parsed.ToString()+"\",\"activeProcesses\":"+value.Active+"}");Console.Out.Flush();}line=Console.In.ReadLineAsync();}
        }
        if(!TerminateJobObject(job,137))throw new Exception("TerminateJobObject failed "+Marshal.GetLastWin32Error());
        for(;;){Accounting state;if(!QueryInformationJobObject(job,1,out state,(uint)Marshal.SizeOf(typeof(Accounting)),IntPtr.Zero))throw new Exception("Job stop proof unavailable");if(state.Active==0)break;System.Threading.Thread.Sleep(50);}
        guardStage="receipt-persist";
        string receipt="{\"schemaVersion\":1,\"guardId\":\""+guardId.ToString()+"\",\"ownerPid\":"+ownerPid+",\"ownerCreationTime\":\""+ownerTicks+"\",\"rootPid\":"+rootPid+",\"rootCreationTime\":\""+rootTicks+"\",\"activeProcesses\":0,\"trigger\":\""+trigger+"\",\"stoppedAt\":\""+DateTime.UtcNow.ToString("o")+"\"}";
        string path=Path.GetFullPath(args[4]),pending=FlushStopReceipt(path,receipt);
        guardStage="receipt-publish";
        // A publication failure leaves the complete, flushed proof available for retry.
        RetryReceiptIo(()=>File.Move(pending,path));
        guardStage="receipt-committed";
      }
      CloseHandle(job);job=IntPtr.Zero;
      try{Console.WriteLine("{\"closed\":true}");}catch(IOException){}return 0;
    }catch(Exception error){
      try{Console.WriteLine("{\"ready\":false,\"guardStage\":"+Json(guardStage)+",\"guardId\":"+Json(guardId.ToString())+",\"ownerPid\":"+ownerPid+",\"ownerCreationTime\":"+Json(ownerTicks.ToString())+",\"rootPid\":"+rootPid+",\"rootCreationTime\":"+Json(rootTicks.ToString())+",\"error\":"+Json(error.Message)+"}");}catch(IOException){}
      return 1;
    }
    finally {if(memory!=IntPtr.Zero)Marshal.FreeHGlobal(memory);if(job!=IntPtr.Zero)CloseHandle(job);}
  }
}
