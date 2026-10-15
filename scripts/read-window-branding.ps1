param([Parameter(Mandatory=$true)][string]$BrandJson,[Parameter(Mandatory=$true)][string]$OutputDirectory)
$ErrorActionPreference = 'Stop'
Add-Type -ReferencedAssemblies System.Drawing -TypeDefinition @'
using System;
using System.Drawing;
using System.Drawing.Imaging;
using System.Runtime.InteropServices;
using System.Collections.Generic;
[StructLayout(LayoutKind.Sequential)] public struct BrandPropertyKey { public Guid format; public uint id; public BrandPropertyKey(uint value) { format=new Guid("9F4C2855-9F79-4B39-A8D0-E1D42DE1D5F3");id=value; } }
[StructLayout(LayoutKind.Sequential)] public struct BrandVariant { public ushort type;public ushort a,b,c;public IntPtr value;public IntPtr reserved; }
[ComImport,Guid("886D8EEB-8CF2-4446-8D02-CDBA1DBDCF99"),InterfaceType(ComInterfaceType.InterfaceIsIUnknown)] public interface BrandPropertyStore {
 [PreserveSig] int GetCount(out uint count);
 [PreserveSig] int GetAt(uint index,out BrandPropertyKey key);
 [PreserveSig] int GetValue(ref BrandPropertyKey key,out BrandVariant value);
 [PreserveSig] int SetValue(ref BrandPropertyKey key,ref BrandVariant value);
 [PreserveSig] int Commit();
}
public static class WindowBrandReader {
 [DllImport("user32.dll",SetLastError=true)] static extern IntPtr SendMessageTimeout(IntPtr window,uint message,IntPtr wparam,IntPtr lparam,uint flags,uint timeout,out IntPtr result);
 [DllImport("shell32.dll")] static extern int SHGetPropertyStoreForWindow(IntPtr window,ref Guid iid,[MarshalAs(UnmanagedType.Interface)] out BrandPropertyStore store);
 [DllImport("ole32.dll")] static extern int PropVariantClear(ref BrandVariant value);
 public static void SaveIcon(long handle,int size,string file) {
  IntPtr icon;if(SendMessageTimeout(new IntPtr(handle),0x7F,new IntPtr(size),IntPtr.Zero,2,5000,out icon)==IntPtr.Zero)throw new Exception("Native window icon read timed out");
  if(icon==IntPtr.Zero)throw new Exception("Window has no native icon");
  using(Bitmap bitmap=Icon.FromHandle(icon).ToBitmap())bitmap.Save(file,ImageFormat.Png);
 }
 public static Dictionary<string,string> Properties(long handle) {
  var result=new Dictionary<string,string>();var iid=new Guid("886D8EEB-8CF2-4446-8D02-CDBA1DBDCF99");BrandPropertyStore store;
  Marshal.ThrowExceptionForHR(SHGetPropertyStoreForWindow(new IntPtr(handle),ref iid,out store));
  try { foreach(var pair in new Dictionary<string,uint>{{"appId",5},{"iconPath",3},{"relaunchCommand",2},{"displayName",4}}) {
   var key=new BrandPropertyKey(pair.Value);BrandVariant value;Marshal.ThrowExceptionForHR(store.GetValue(ref key,out value));
   try { result[pair.Key]=value.type==31&&value.value!=IntPtr.Zero?Marshal.PtrToStringUni(value.value):""; } finally { PropVariantClear(ref value); }
  }} finally { Marshal.ReleaseComObject(store); }
  return result;
 }
}
'@
$aiChanBrand = Get-Content -LiteralPath $BrandJson -Raw -Encoding UTF8 | ConvertFrom-Json
New-Item -ItemType Directory -Path $OutputDirectory -Force | Out-Null
$aiChanWindows = @()
function Get-BrandIconSha256([string]$LiteralPath) {
  $brandHasher = [System.Security.Cryptography.SHA256]::Create()
  $brandStream = [System.IO.File]::OpenRead($LiteralPath)
  try { return ([System.BitConverter]::ToString($brandHasher.ComputeHash($brandStream))).Replace('-', '').ToLowerInvariant() }
  finally { $brandStream.Dispose(); $brandHasher.Dispose() }
}
foreach ($aiChanWindow in $aiChanBrand.windows.PSObject.Properties) {
  $aiChanHandle = [long]::Parse($aiChanWindow.Value.handle)
  $aiChanLarge = Join-Path $OutputDirectory ($aiChanWindow.Name + '-native-large.png')
  $aiChanSmall = Join-Path $OutputDirectory ($aiChanWindow.Name + '-native-small.png')
  [WindowBrandReader]::SaveIcon($aiChanHandle,1,$aiChanLarge)
  [WindowBrandReader]::SaveIcon($aiChanHandle,0,$aiChanSmall)
  $aiChanWindows += [pscustomobject]@{role=$aiChanWindow.Name;title=$aiChanWindow.Value.title;handle=$aiChanWindow.Value.handle;properties=[WindowBrandReader]::Properties($aiChanHandle);largeIcon=$aiChanLarge;smallIcon=$aiChanSmall;largeSha256=(Get-BrandIconSha256 $aiChanLarge);smallSha256=(Get-BrandIconSha256 $aiChanSmall)}
}
$aiChanResult = [pscustomobject]@{method='Windows WM_GETICON and SHGetPropertyStoreForWindow';windows=$aiChanWindows}
$aiChanResult | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $OutputDirectory 'native-branding.json') -Encoding UTF8
