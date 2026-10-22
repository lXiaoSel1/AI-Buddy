using System.Net;
using System.Numerics;
using System.Security.Cryptography;
using System.Text.Json;
using System.Text.RegularExpressions;

namespace AiBuddy.Install;

public sealed record UpdateRelease(string Version,string Tag,string ReleaseUrl,string InstallerUrl,string InstallerName,
    long Bytes,string InstallerSha256,string ManifestSha256,string SourceCommit,string TagObjectSha);

// Discovery selects an installer once, not a resource manifest. The selected installer
// retains its own embedded manifest pin and all existing transactional install checks.
// Signature trust is GitHub's HTTPS verification result, not a local public-key verifier.
public sealed class UpdateDiscovery(HttpClient http,TimeSpan? idleTimeout=null) {
    public const string Repository="lXiaoSel1/AI-Buddy";
    public const long InstallerLimit=256L*1024*1024;
    const int ApiLimit=4*1024*1024;
    const string Api="https://api.github.com/repos/"+Repository;
    const string Web="https://github.com/"+Repository;
    readonly TimeSpan idle=idleTimeout??TimeSpan.FromSeconds(60);

    public async Task<UpdateRelease?> Check(string currentVersion,CancellationToken cancel) {
        var current=VersionParts(currentVersion);
        // Never re-resolve latest while validating or downloading the selected release.
        using var release=await GetJson(new Uri(Api+"/releases/latest"),cancel);
        var r=release.RootElement;
        if(Bool(r,"draft")||Bool(r,"prerelease"))throw Invalid("Latest release is not a stable published release");
        var tag=String(r,"tag_name");
        if(!tag.StartsWith('v'))throw Invalid("Invalid release tag");
        var version=tag[1..];var latest=VersionParts(version);
        if(String(r,"html_url")!=Web+"/releases/tag/"+tag)throw Invalid("Release repository or URL differs");
        var source=String(r,"target_commitish");RequireSha(source,40,"release source commit");
        if(Compare(latest,current)<=0)return null;

        var name="AI-Buddy-Setup-"+version+"-win-x64.exe";
        var installer=Asset(r,name,InstallerLimit,Web+"/releases/download/"+tag+"/"+name);
        var manifest=Asset(r,"install-manifest-"+version+".json",16L*1024*1024,
            Web+"/releases/download/"+tag+"/install-manifest-"+version+".json");

        using var reference=await GetJson(new Uri(Api+"/git/ref/tags/"+tag),cancel);
        var rf=reference.RootElement;
        if(String(rf,"ref")!="refs/tags/"+tag)throw Invalid("Tag reference differs");
        var target=Object(rf,"object");
        if(String(target,"type")!="tag")throw Invalid("An annotated signed tag is required");
        var tagSha=String(target,"sha");RequireSha(tagSha,40,"tag object");

        using var tagDocument=await GetJson(new Uri(Api+"/git/tags/"+tagSha),cancel);
        var t=tagDocument.RootElement;var commit=Object(t,"object");
        if(String(t,"sha")!=tagSha||String(t,"tag")!=tag||String(commit,"type")!="commit"||String(commit,"sha")!=source)
            throw Invalid("Signed tag and release source differ");
        var verification=Object(t,"verification");
        if(!Bool(verification,"verified")||String(verification,"reason")!="valid")throw Invalid("GitHub did not verify the release tag signature");
        var signature=String(verification,"signature");
        if(!signature.StartsWith("-----BEGIN SSH SIGNATURE-----\n",StringComparison.Ordinal)&&
            !signature.StartsWith("-----BEGIN PGP SIGNATURE-----\n",StringComparison.Ordinal))throw Invalid("Missing signed tag signature");
        var payload=String(verification,"payload");var separator=payload.IndexOf("\n\n",StringComparison.Ordinal);
        if(separator<0)throw Invalid("Invalid signed tag payload");
        var headers=UniqueLines(payload[..separator]," ");
        if(!headers.TryGetValue("object",out var signedSource)||signedSource!=source||
            !headers.TryGetValue("type",out var signedType)||signedType!="commit"||
            !headers.TryGetValue("tag",out var signedTag)||signedTag!=tag)throw Invalid("Signed tag payload identity differs");
        var body=payload[(separator+2)..];
        if(String(t,"message")!=body+signature)throw Invalid("Tag message is not the verified signed payload");
        var bindings=UniqueLines(body,": ");
        if(!bindings.TryGetValue("Source",out var boundSource)||boundSource!=source||
            !bindings.TryGetValue("Installer SHA-256",out var installerSha)||installerSha!=installer.Hash||
            !bindings.TryGetValue("Manifest SHA-256",out var manifestSha)||manifestSha!=manifest.Hash)
            throw Invalid("Signed release hashes or source differ from release assets");
        return new(version,tag,Web+"/releases/tag/"+tag,installer.Url,name,installer.Bytes,installer.Hash,manifest.Hash,source,tagSha);
    }

    public async Task<string> Download(UpdateRelease release,string cache,IProgress<InstallProgress>? progress,CancellationToken cancel) {
        Validate(release);SafePaths.NoLinks(cache);Directory.CreateDirectory(cache);
        var fileName=release.InstallerSha256+"-"+release.InstallerName;
        var final=SafePaths.Under(cache,fileName);var partial=SafePaths.Under(cache,fileName+".partial");
        await using var cacheLock=new FileStream(SafePaths.Under(cache,fileName+".lock"),FileMode.OpenOrCreate,FileAccess.ReadWrite,FileShare.None);
        cancel.ThrowIfCancellationRequested();
        if(await Hashing.Matches(final,release.Bytes,release.InstallerSha256,cancel))return final;
        if(File.Exists(final))File.Delete(final);
        using var request=Request(new Uri(release.InstallerUrl),false);
        using var timeout=CancellationTokenSource.CreateLinkedTokenSource(cancel);timeout.CancelAfter(idle);
        using var response=await http.SendAsync(request,HttpCompletionOption.ResponseHeadersRead,timeout.Token);
        RequireSuccess(response);
        if(response.StatusCode!=HttpStatusCode.OK||response.Content.Headers.ContentEncoding.Any(e=>e!="identity")||
            response.Content.Headers.ContentLength is long length&&length!=release.Bytes)throw Invalid("Installer HTTP length, encoding or status differs");
        await using var input=await response.Content.ReadAsStreamAsync(cancel);
        // Remove only the old cache entry; never truncate a possibly hard-linked file.
        if(File.Exists(partial))File.Delete(partial);
        await using(var output=new FileStream(partial,FileMode.CreateNew,FileAccess.Write,FileShare.None,256*1024,FileOptions.Asynchronous)) {
            using var sha=IncrementalHash.CreateHash(HashAlgorithmName.SHA256);var buffer=new byte[256*1024];long total=0;
            while(true) {
                using var readTimeout=CancellationTokenSource.CreateLinkedTokenSource(cancel);readTimeout.CancelAfter(idle);
                var count=await input.ReadAsync(buffer,readTimeout.Token);if(count==0)break;
                if(total+count>release.Bytes)throw Invalid("Installer download exceeds signed length");
                await output.WriteAsync(buffer.AsMemory(0,count),cancel);sha.AppendData(buffer,0,count);total+=count;
                progress?.Report(new("update-download",release.Version,total,release.Bytes));
            }
            await output.FlushAsync(cancel);output.Flush(true);
            if(total!=release.Bytes||Convert.ToHexStringLower(sha.GetHashAndReset())!=release.InstallerSha256)throw Invalid("Installer download SHA-256 or length differs");
        }
        cancel.ThrowIfCancellationRequested();File.Move(partial,final,true);return final;
    }

    async Task<JsonDocument> GetJson(Uri url,CancellationToken cancel) {
        using var request=Request(url,true);using var timeout=CancellationTokenSource.CreateLinkedTokenSource(cancel);timeout.CancelAfter(idle);
        using var response=await http.SendAsync(request,HttpCompletionOption.ResponseHeadersRead,timeout.Token);RequireSuccess(response);
        if(response.StatusCode!=HttpStatusCode.OK||response.Content.Headers.ContentLength>ApiLimit)throw Invalid("Invalid GitHub API response length or status");
        await using var input=await response.Content.ReadAsStreamAsync(cancel);using var output=new MemoryStream();var buffer=new byte[32*1024];
        while(true) {
            using var readTimeout=CancellationTokenSource.CreateLinkedTokenSource(cancel);readTimeout.CancelAfter(idle);
            var count=await input.ReadAsync(buffer,readTimeout.Token);if(count==0)break;
            if(output.Length+count>ApiLimit)throw Invalid("GitHub API response exceeds limit");output.Write(buffer,0,count);
        }
        try{return JsonDocument.Parse(output.ToArray());}catch(JsonException e){throw new InvalidDataException("Invalid GitHub API JSON",e);}
    }
    static HttpRequestMessage Request(Uri url,bool api) {
        var request=new HttpRequestMessage(HttpMethod.Get,url);request.Headers.UserAgent.ParseAdd("AI-Buddy-Installer/"+ReleaseIdentity.Version);
        request.Headers.AcceptEncoding.ParseAdd("identity");if(api){request.Headers.Accept.ParseAdd("application/vnd.github+json");request.Headers.Add("X-GitHub-Api-Version","2022-11-28");}return request;
    }
    static void RequireSuccess(HttpResponseMessage response) {
        if(response.IsSuccessStatusCode)return;
        var wait=response.Headers.RetryAfter?.Delta??(response.Headers.RetryAfter?.Date-DateTimeOffset.UtcNow);
        if(response.StatusCode==HttpStatusCode.Forbidden&&response.Headers.TryGetValues("X-RateLimit-Remaining",out var values)&&values.Contains("0")&&
            response.Headers.TryGetValues("X-RateLimit-Reset",out var resets)&&long.TryParse(resets.FirstOrDefault(),out var reset)) {
            try{wait=DateTimeOffset.FromUnixTimeSeconds(reset)-DateTimeOffset.UtcNow;}catch(ArgumentOutOfRangeException){}
        }
        bool retry=response.StatusCode is HttpStatusCode.RequestTimeout or HttpStatusCode.TooManyRequests||
            response.StatusCode==HttpStatusCode.Forbidden&&wait>TimeSpan.Zero||(int)response.StatusCode>=500;
        throw new DownloadException($"Update check/download HTTP {(int)response.StatusCode}",retry,wait>TimeSpan.Zero?wait:null);
    }
    static (long Bytes,string Hash,string Url) Asset(JsonElement r,string name,long limit,string expectedUrl) {
        var assets=Property(r,"assets");if(assets.ValueKind!=JsonValueKind.Array)throw Invalid("Missing release assets");
        var found=assets.EnumerateArray().Where(a=>String(a,"name")==name).ToArray();
        if(found.Length!=1)throw Invalid("Missing or duplicate release asset: "+name);
        var a=found[0];var length=Property(a,"size");
        if(String(a,"state")!="uploaded"||!length.TryGetInt64(out var bytes)||bytes<=0||bytes>limit||String(a,"browser_download_url")!=expectedUrl)
            throw Invalid("Invalid release asset identity: "+name);
        var digest=String(a,"digest");if(!digest.StartsWith("sha256:",StringComparison.Ordinal))throw Invalid("Missing release asset SHA-256: "+name);
        var hash=digest[7..];RequireSha(hash,64,name);return(bytes,hash,expectedUrl);
    }
    static Dictionary<string,string> UniqueLines(string text,string separator) {
        var result=new Dictionary<string,string>(StringComparer.Ordinal);
        foreach(var line in text.Split('\n')){var n=line.IndexOf(separator,StringComparison.Ordinal);if(n<0)continue;var key=line[..n];if(!result.TryAdd(key,line[(n+separator.Length)..]))throw Invalid("Duplicate signed tag field: "+key);}return result;
    }
    static JsonElement Property(JsonElement value,string name)=>value.ValueKind==JsonValueKind.Object&&value.TryGetProperty(name,out var found)?found:throw Invalid("Missing GitHub field: "+name);
    static JsonElement Object(JsonElement value,string name){var found=Property(value,name);return found.ValueKind==JsonValueKind.Object?found:throw Invalid("Invalid GitHub object: "+name);}
    static string String(JsonElement value,string name){var found=Property(value,name);return found.ValueKind==JsonValueKind.String?found.GetString()!:throw Invalid("Invalid GitHub string: "+name);}
    static bool Bool(JsonElement value,string name){var found=Property(value,name);return found.ValueKind is JsonValueKind.True or JsonValueKind.False?found.GetBoolean():throw Invalid("Invalid GitHub boolean: "+name);}
    static void RequireSha(string sha,int length,string item){if(!Regex.IsMatch(sha,"^[a-f0-9]{"+length+"}\\z",RegexOptions.CultureInvariant))throw Invalid("Invalid SHA identity: "+item);}
    static BigInteger[] VersionParts(string version) {
        if(version.Length>128||!Regex.IsMatch(version,"^(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)\\z",RegexOptions.CultureInvariant))throw Invalid("Unsupported stable version: "+version);
        return version.Split('.').Select(v=>BigInteger.Parse(v,System.Globalization.CultureInfo.InvariantCulture)).ToArray();
    }
    static int Compare(BigInteger[] a,BigInteger[] b){for(int n=0;n<3;n++){var compared=a[n].CompareTo(b[n]);if(compared!=0)return compared;}return 0;}
    static void Validate(UpdateRelease r) {
        VersionParts(r.Version);RequireSha(r.InstallerSha256,64,"installer");RequireSha(r.ManifestSha256,64,"manifest");RequireSha(r.SourceCommit,40,"source");RequireSha(r.TagObjectSha,40,"tag");
        if(r.Tag!="v"+r.Version||r.InstallerName!="AI-Buddy-Setup-"+r.Version+"-win-x64.exe"||r.Bytes<=0||r.Bytes>InstallerLimit||
            r.ReleaseUrl!=Web+"/releases/tag/"+r.Tag||r.InstallerUrl!=Web+"/releases/download/"+r.Tag+"/"+r.InstallerName)throw Invalid("Invalid selected update identity");
    }
    static InvalidDataException Invalid(string message)=>new(message);
}
