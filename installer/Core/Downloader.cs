using System.Net;
using System.Net.Http.Headers;
namespace AiBuddy.Install;

public sealed record DownloadState(string PackageId,string Tag,long Bytes,string Sha256,long SavedBytes,string? ETag,string? LastModified);
public sealed record InstallProgress(string Phase,string Item,long Completed=0,long Total=0,string? Detail=null);
public sealed class DownloadException(string message,bool retryable,TimeSpan? wait=null):IOException(message) {
    public bool Retryable{get;}=retryable;public TimeSpan? Wait{get;}=wait;
}
public sealed class Downloader(HttpClient http,TimeSpan? idleTimeout=null) {
    readonly TimeSpan idle=idleTimeout??TimeSpan.FromSeconds(60);
    public async Task<string> Get(Package p,string tag,Uri url,string cache,IProgress<InstallProgress>? progress,CancellationToken cancel) {
        SafePaths.NoLinks(cache);Directory.CreateDirectory(cache);
        var final=SafePaths.Under(cache,p.Sha256+".zip");var partial=final+".partial";var statePath=partial+".json";
        await using var cacheLock=new FileStream(final+".lock",FileMode.OpenOrCreate,FileAccess.ReadWrite,FileShare.None);
        if(await Hashing.Matches(final,p.Bytes,p.Sha256,cancel)){progress?.Report(new("cached",p.Id,p.Bytes,p.Bytes));return final;}
        if(File.Exists(final))File.Delete(final);
        for(int attempt=0;attempt<3;attempt++) {
            cancel.ThrowIfCancellationRequested();
            try {
                await Transfer(p,tag,url,partial,statePath,progress,cancel);
                if(!await Hashing.Matches(partial,p.Bytes,p.Sha256,cancel)) {File.Delete(partial);File.Delete(statePath);throw new DownloadException("SHA-256 verification failed: "+p.AssetName,true);}
                File.Move(partial,final,true);File.Delete(statePath);return final;
            } catch(Exception ex) when(!cancel.IsCancellationRequested && (ex is HttpRequestException or IOException or OperationCanceledException)) {
                if(ex is DownloadException d && !d.Retryable || attempt==2)throw;
                var wait=(ex as DownloadException)?.Wait??TimeSpan.FromSeconds(attempt==0?1:3);
                if(wait>TimeSpan.FromMinutes(5))throw new DownloadException("Rate limited; retry after "+wait,false,wait);
                progress?.Report(new("retry",p.Id,Detail:ex.Message));await Task.Delay(wait,cancel);
            }
        }
        throw new IOException("Download did not finish");
    }
    async Task Transfer(Package p,string tag,Uri url,string partial,string statePath,IProgress<InstallProgress>? progress,CancellationToken cancel) {
        DownloadState? state=null;try{if(File.Exists(statePath))state=Json.Read<DownloadState>(statePath);}catch(System.Text.Json.JsonException){}
        long offset=File.Exists(partial)?new FileInfo(partial).Length:0;
        if(state is not null && state.PackageId==p.Id&&state.Tag==tag&&state.Bytes==p.Bytes&&state.Sha256==p.Sha256&&state.SavedBytes>=0&&state.SavedBytes<offset&&offset<=p.Bytes){
            // A process/power interruption can leave bytes past the last durable checkpoint.
            // Keep the confirmed prefix rather than discard a large valid download.
            using var recovered=new FileStream(partial,FileMode.Open,FileAccess.Write,FileShare.None);recovered.SetLength(state.SavedBytes);recovered.Flush(true);offset=state.SavedBytes;
        }
        if(state is null || state.PackageId!=p.Id || state.Tag!=tag || state.Bytes!=p.Bytes || state.Sha256!=p.Sha256 || offset!=state.SavedBytes || offset>p.Bytes) {
            if(File.Exists(partial))File.Delete(partial);File.Delete(statePath);offset=0;state=null;
        }
        if(offset==p.Bytes && await Hashing.Matches(partial,p.Bytes,p.Sha256,cancel))return;
        using var request=new HttpRequestMessage(HttpMethod.Get,url);request.Headers.AcceptEncoding.ParseAdd("identity");
        if(offset>0) {
            request.Headers.Range=new RangeHeaderValue(offset,null);
            if(state?.ETag is {} etag&&!etag.StartsWith("W/"))request.Headers.TryAddWithoutValidation("If-Range",etag);
            else if(state?.LastModified is {} last)request.Headers.TryAddWithoutValidation("If-Range",last);
        }
        using var headersTimeout=CancellationTokenSource.CreateLinkedTokenSource(cancel);headersTimeout.CancelAfter(idle);
        using var response=await http.SendAsync(request,HttpCompletionOption.ResponseHeadersRead,headersTimeout.Token);
        if(response.StatusCode==HttpStatusCode.RequestedRangeNotSatisfiable) {
            if(await Hashing.Matches(partial,p.Bytes,p.Sha256,cancel))return;
            File.Delete(partial);File.Delete(statePath);throw new DownloadException("Invalid resume range; restarting this package",true);
        }
        if(!response.IsSuccessStatusCode) {
            var retry=response.StatusCode is HttpStatusCode.RequestTimeout or HttpStatusCode.TooManyRequests || (int)response.StatusCode>=500;
            var wait=response.Headers.RetryAfter?.Delta??(response.Headers.RetryAfter?.Date-DateTimeOffset.UtcNow);
            throw new DownloadException($"Download HTTP {(int)response.StatusCode}: {p.AssetName}",retry,wait>TimeSpan.Zero?wait:null);
        }
        var newETag=response.Headers.ETag?.ToString();var modified=response.Content.Headers.LastModified?.ToString("R");
        if(response.StatusCode==HttpStatusCode.PartialContent) {
            var range=response.Content.Headers.ContentRange;
            if(range?.From!=offset||range.To!=p.Bytes-1||range.Length!=p.Bytes)throw new DownloadException("Server returned an invalid Content-Range",false);
            if(offset>0 && ((state?.ETag is not null && state.ETag!=newETag)||(state?.ETag is null && state?.LastModified is not null && state.LastModified!=modified))) {
                File.Delete(partial);File.Delete(statePath);throw new DownloadException("Remote file identity changed; restarting package",true);
            }
        } else if(response.StatusCode==HttpStatusCode.OK)offset=0;
        else throw new DownloadException("Unexpected successful HTTP status",false);
        if(response.Content.Headers.ContentEncoding.Any(e=>e!="identity") || response.Content.Headers.ContentLength is long length && length!=p.Bytes-offset)throw new DownloadException("Download length or encoding differs from manifest",false);
        var current=new DownloadState(p.Id,tag,p.Bytes,p.Sha256,offset,newETag,modified);Json.Save(statePath,current);
        await using var source=await response.Content.ReadAsStreamAsync(cancel);
        await using var output=new FileStream(partial,offset>0?FileMode.Append:FileMode.Create,FileAccess.Write,FileShare.None,1024*1024,FileOptions.Asynchronous);
        var buffer=new byte[256*1024];long received=offset,lastSaved=offset;
        try {
            while(true) {
                using var readTimeout=CancellationTokenSource.CreateLinkedTokenSource(cancel);readTimeout.CancelAfter(idle);
                var count=await source.ReadAsync(buffer,readTimeout.Token);if(count==0)break;
                if(received+count>p.Bytes)throw new DownloadException("Download exceeds manifest size",false);
                await output.WriteAsync(buffer.AsMemory(0,count),cancel);received+=count;
                if(received-lastSaved>=4*1024*1024){await output.FlushAsync(cancel);Json.Save(statePath,current with {SavedBytes=received});lastSaved=received;}
                progress?.Report(new("download",p.Id,received,p.Bytes));
            }
        } finally {await output.FlushAsync(CancellationToken.None);Json.Save(statePath,current with {SavedBytes=received});}
        if(received!=p.Bytes)throw new DownloadException("Connection ended before the package completed",true);
    }
}
