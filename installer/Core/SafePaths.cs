using System.Text.RegularExpressions;
namespace AiBuddy.Install;
public static class SafePaths {
    public static void Relative(string path) {
        if(string.IsNullOrWhiteSpace(path)||path.Length>1800||path.Contains('\\')||path.StartsWith('/')||path.Any(c=>char.IsControl(c)||"<>:\"|?*".Contains(c)))throw new InvalidDataException("Unsafe archive path");
        foreach(var part in path.Split('/'))if(part is "" or "." or ".." || part.EndsWith('.')||part.EndsWith(' ')||Regex.IsMatch(part,"^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\\.|$)",RegexOptions.IgnoreCase))throw new InvalidDataException("Unsafe Windows filename");
    }
    public static string Under(string root,string relative) {
        Relative(relative);root=Path.GetFullPath(root);var target=Path.GetFullPath(Path.Combine(root,relative.Replace('/',Path.DirectorySeparatorChar)));
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
