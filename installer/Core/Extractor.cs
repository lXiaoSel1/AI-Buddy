using System.IO.Compression;
using System.Security.Cryptography;
namespace AiBuddy.Install;
public static class Extractor {
    public static async Task Extract(Package package,string archive,string destination,IProgress<InstallProgress>? progress,CancellationToken cancel) {
        if(!await Hashing.Matches(archive,package.Bytes,package.Sha256,cancel))throw new InvalidDataException("Package integrity failed");
        SafePaths.NoLinks(destination);Directory.CreateDirectory(destination);
        var index=package.Files.ToDictionary(f=>f.Path,StringComparer.OrdinalIgnoreCase);
        using var zip=ZipFile.OpenRead(archive);if(zip.Entries.Count!=index.Count)throw new InvalidDataException("Archive file count differs from index");
        var seen=new HashSet<string>(StringComparer.OrdinalIgnoreCase);long completed=0;
        foreach(var entry in zip.Entries) {
            cancel.ThrowIfCancellationRequested();SafePaths.Relative(entry.FullName);
            if(!seen.Add(entry.FullName)||!index.TryGetValue(entry.FullName,out var f)||f.Path!=entry.FullName||entry.Length!=f.Bytes||((entry.ExternalAttributes>>16)&0xF000)==0xA000||(entry.ExternalAttributes&0x400)!=0)throw new InvalidDataException("Unexpected archive entry");
            var target=SafePaths.Under(destination,f.Path);Directory.CreateDirectory(Path.GetDirectoryName(target)!);
            if(!await Hashing.Matches(target,f.Bytes,f.Sha256,cancel)) {
                var temp=target+".install-partial-"+Guid.NewGuid().ToString("N");SafePaths.NoLinks(temp);
                await using(var input=entry.Open())await using(var output=new FileStream(temp,FileMode.Create,FileAccess.Write,FileShare.None,1024*1024,FileOptions.Asynchronous)) {
                    using var hash=IncrementalHash.CreateHash(HashAlgorithmName.SHA256);var buffer=new byte[256*1024];long length=0;
                    while(true){var n=await input.ReadAsync(buffer,cancel);if(n==0)break;length+=n;if(length>f.Bytes)throw new InvalidDataException("Expanded file exceeds declaration");hash.AppendData(buffer,0,n);await output.WriteAsync(buffer.AsMemory(0,n),cancel);}
                    await output.FlushAsync(cancel);if(length!=f.Bytes||Convert.ToHexStringLower(hash.GetHashAndReset())!=f.Sha256)throw new InvalidDataException("Expanded file hash differs from index");
                }
                File.Move(temp,target,true);
            }
            completed+=f.Bytes;progress?.Report(new("extract",package.Id,completed,package.UnpackedBytes));
        }
    }
}
