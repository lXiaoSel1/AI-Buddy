using System.Collections.Concurrent;
using System.Net;
using System.Runtime.CompilerServices;

namespace AiBuddy.Install;

public sealed record NetworkSettings(int SchemaVersion=1,string Mode="system",string ProxyUrl="",string GithubMirror="",string HuggingFaceMirror="") {
    public NetworkSettings Validate() {
        if(SchemaVersion!=1||Mode is not ("system" or "manual" or "direct")||ProxyUrl is null||GithubMirror is null||HuggingFaceMirror is null)throw new InvalidDataException("Invalid network settings / 网络设置无效");
        if(Mode=="manual"&&(!Uri.TryCreate(ProxyUrl,UriKind.Absolute,out var proxy)||proxy.Scheme is not ("http" or "https")||string.IsNullOrEmpty(proxy.Host)||!string.IsNullOrEmpty(proxy.UserInfo)||proxy.AbsolutePath!="/"||!string.IsNullOrEmpty(proxy.Query)||!string.IsNullOrEmpty(proxy.Fragment)))
            throw new InvalidDataException("暂时只支持 http 代理（http 或 https 地址） / Only HTTP proxies with an http or https address are supported");
        Mirror(GithubMirror);Mirror(HuggingFaceMirror);return this;
    }
    static Uri? Mirror(string value) {
        if(string.IsNullOrEmpty(value))return null;
        if(!Uri.TryCreate(value,UriKind.Absolute,out var uri)||uri.Scheme!="https"||string.IsNullOrEmpty(uri.Host)||!string.IsNullOrEmpty(uri.UserInfo)||uri.AbsolutePath!="/"||!string.IsNullOrEmpty(uri.Query)||!string.IsNullOrEmpty(uri.Fragment))
            throw new InvalidDataException("Mirror must be an HTTPS origin without a path / 镜像只接受不带路径的 HTTPS 主机地址");
        return uri;
    }
    public Uri RequestUrl(Uri logical) {
        Validate();var mirror=logical.Host is "github.com" or "raw.githubusercontent.com"?Mirror(GithubMirror):logical.Host=="huggingface.co"?Mirror(HuggingFaceMirror):null;
        if(mirror is null)return logical;
        if(logical.Scheme!="https")throw new InvalidDataException("Mirrors require an HTTPS official URL");
        return new UriBuilder(logical){Scheme=mirror.Scheme,Host=mirror.Host,Port=mirror.IsDefaultPort?-1:mirror.Port}.Uri;
    }
}
public sealed record NetworkRoute(string LogicalUrl,string RequestUrl,string ActualUrl,bool Mirror);
public sealed class MirrorMismatchException(string host,string message):IOException(message){public string Host{get;}=host;}
public static class InstallerNetwork {
    static NetworkSettings current=new();
    static readonly AsyncLocal<bool> official=new();
    static readonly ConditionalWeakTable<HttpResponseMessage,NetworkRoute> responses=new();
    internal static void Record(HttpResponseMessage response,NetworkRoute route)=>responses.Add(response,route);
    public static NetworkRoute? Route(HttpResponseMessage response)=>responses.TryGetValue(response,out var route)?route:null;
    public static Exception IntegrityFailure(HttpResponseMessage response,string message)=>IntegrityFailure(Route(response),message);
    public static Exception IntegrityFailure(NetworkRoute? route,string message)=>route is {Mirror:true}?new MirrorMismatchException(new Uri(route.ActualUrl).Host,"镜像返回的文件和官方记录不一致，已拒绝 / The mirror file differs from the official record; rejected"):new InvalidDataException(message);
    public static bool OfficialOnly=>official.Value;
    sealed class OfficialScope(bool previous):IDisposable{public void Dispose()=>official.Value=previous;}
    public static IDisposable UseOfficial(){var previous=official.Value;official.Value=true;return new OfficialScope(previous);}
    public static NetworkSettings Current=>Volatile.Read(ref current);
    public static void Configure(NetworkSettings settings)=>Volatile.Write(ref current,settings.Validate());
    public static string ConfigPath(string root)=>Path.Combine(DataPaths.Registered(root,InstallEngine.Existing(root)?.DataPath,false),"network-settings.json");
    public static NetworkSettings Load(string root) {
        var path=ConfigPath(root);SafePaths.NoLinks(path);
        if(!File.Exists(path))return new();
        if(new FileInfo(path).Length>16384)throw new InvalidDataException("Network settings exceed limit");
        return Json.Read<NetworkSettings>(path).Validate();
    }
    public static void Save(string root,NetworkSettings settings)=>Json.Save(ConfigPath(root),settings.Validate());
}

// One immutable configuration snapshot per request; platform TLS validation stays enabled.
public sealed class InstallerNetworkHandler : HttpMessageHandler {
    readonly ConcurrentDictionary<NetworkSettings,HttpMessageInvoker> transports=new();
    readonly ConcurrentQueue<NetworkRoute> routes=new();
    public NetworkRoute[] Routes=>routes.ToArray();
    protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request,CancellationToken cancel) {
        var settings=InstallerNetwork.Current.Validate();var logical=request.RequestUri??throw new InvalidDataException("Missing request URL");
        var actual=InstallerNetwork.OfficialOnly?logical:settings.RequestUrl(logical);request.RequestUri=actual;
        var transport=transports.GetOrAdd(settings,s=>{
            var handler=new SocketsHttpHandler{AllowAutoRedirect=true,MaxAutomaticRedirections=8,AutomaticDecompression=DecompressionMethods.None,ConnectTimeout=TimeSpan.FromSeconds(30)};
            if(s.Mode=="direct")handler.UseProxy=false;
            else if(s.Mode=="manual"){handler.UseProxy=true;handler.Proxy=new WebProxy(s.ProxyUrl);}
            return new HttpMessageInvoker(handler);
        });
        var response=await transport.SendAsync(request,cancel);
        var route=new NetworkRoute(logical.AbsoluteUri,actual.AbsoluteUri,response.RequestMessage?.RequestUri?.AbsoluteUri??actual.AbsoluteUri,logical!=actual);routes.Enqueue(route);InstallerNetwork.Record(response,route);
        while(routes.Count>256)routes.TryDequeue(out _);return response;
    }
    protected override void Dispose(bool disposing){if(disposing)foreach(var transport in transports.Values)transport.Dispose();base.Dispose(disposing);}
}
