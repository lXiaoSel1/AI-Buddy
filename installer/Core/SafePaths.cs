using System.Text.RegularExpressions;
namespace AiBuddy.Install;
public static class SafePaths {
    [System.Runtime.InteropServices.DllImport("kernel32.dll",CharSet=System.Runtime.InteropServices.CharSet.Unicode)]
    static extern uint GetLongPathName(string path,System.Text.StringBuilder output,uint size);
    public static string Full(string path){
        var full=Path.GetFullPath(path);var tail=new Stack<string>();var existing=full;
        while(!File.Exists(existing)&&!Directory.Exists(existing)){var parent=Path.GetDirectoryName(existing);if(string.IsNullOrEmpty(parent))return full;tail.Push(Path.GetFileName(existing));existing=parent;}
        var buffer=new System.Text.StringBuilder(32768);var count=GetLongPathName(existing,buffer,(uint)buffer.Capacity);
        var result=count>0&&count<buffer.Capacity?buffer.ToString():existing;while(tail.Count>0)result=Path.Combine(result,tail.Pop());return result;
    }
    public static void Relative(string path) {
        if(string.IsNullOrWhiteSpace(path)||path.Length>1800||path.Contains('\\')||path.StartsWith('/')||path.Any(c=>char.IsControl(c)||"<>:\"|?*".Contains(c)))throw new InvalidDataException("Unsafe archive path");
        foreach(var part in path.Split('/'))if(part is "" or "." or ".." || part.EndsWith('.')||part.EndsWith(' ')||Regex.IsMatch(part,"^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\\.|$)",RegexOptions.IgnoreCase))throw new InvalidDataException("Unsafe Windows filename");
    }
    public static string Under(string root,string relative) {
        Relative(relative);root=Full(root);var target=Full(Path.Combine(root,relative.Replace('/',Path.DirectorySeparatorChar)));
        if(!target.StartsWith(root.TrimEnd(Path.DirectorySeparatorChar)+Path.DirectorySeparatorChar,StringComparison.OrdinalIgnoreCase))throw new InvalidDataException("Path escaped installation");
        NoLinks(target);return target;
    }
    public static void NoLinks(string path) {
        var current=Path.GetFullPath(path);
        while(!string.IsNullOrEmpty(current)) {
            if((File.Exists(current)||Directory.Exists(current))&&(File.GetAttributes(current)&FileAttributes.ReparsePoint)!=0)throw new IOException("Installation path contains a reparse point: "+current);
            current=Path.GetDirectoryName(current);
        }
    }
    public static void RemoveOwnedTree(string path,string ownerRoot) {
        var relative=Path.GetRelativePath(ownerRoot,path).Replace('\\','/');var checkedPath=Under(ownerRoot,relative);
        if(!Directory.Exists(checkedPath))return;
        foreach(var entry in Directory.EnumerateFileSystemEntries(checkedPath)) {
            NoLinks(entry);if(Directory.Exists(entry))RemoveOwnedTree(entry,ownerRoot);else File.Delete(entry);
        }
        Directory.Delete(checkedPath);
    }
}
