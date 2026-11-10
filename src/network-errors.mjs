const text={
  NETWORK_CATALOG_INVALID:['扩展目录返回了无效内容','The extension catalog returned invalid content.'],
  NETWORK_CONNECT_FAILED:['连不上 {host}。检查网络，或者到 通用设置 → 网络 设置代理。','Cannot connect to {host}. Check your network or configure a proxy in General settings → Network.'],
  NETWORK_UNSAFE_PORT:['无法连接 {host}：此端口被网络安全策略限制，请改用其他端口。','Cannot connect to {host}: this port is restricted by the network security policy. Use another port.'],
  NETWORK_TIMEOUT:['下载超时。已经下好的部分保留着，再点一次会接着下。','The download timed out. Downloaded data is retained; retry to resume.'],
  NETWORK_RATE_LIMITED:['GitHub 暂时限制了这个网络的访问次数。过一会儿再试，或者换一个代理节点。','GitHub has temporarily rate limited this network. Try again later or use another proxy.'],
  NETWORK_CERTIFICATE:['安全连接校验失败，可能是代理或安全软件替换了证书。','The secure connection could not be verified. A proxy or security software may have replaced the certificate.'],
  NETWORK_MIRROR_MISMATCH:['镜像返回的文件和官方记录不一致，已拒绝','The mirror returned a file that differs from the official record. It was rejected.'],
  NETWORK_REDIRECT:['服务地址跳转到了 {host}，请直接填它','The service redirected to {host}. Enter that address directly.'],
};
export function networkErrorMessage(code,{host='',language='zh-CN',offline=false}={}){const pair=text[code]??text.NETWORK_CONNECT_FAILED;return pair[language==='en'?1:0].replace('{host}',host||(language==='en'?'the service':'服务'))+(offline?(language==='en'?' You can also import offline.':'也可以用离线导入。'):'');}
export function networkFailure(cause,url,{response,offline=false}={}){
  if(cause?.network===true)return cause;const detail=cause?.cause??cause;
  const message=String(detail?.message??''),code=String(detail?.code??cause?.code??'');
  const certificate=/CERT|TLS.*(VERIFY|ALTNAME)|UNABLE_TO_VERIFY|SELF_SIGNED/.test(code)||/certificate|hostname mismatch|ERR_CERT_|ERR_TLS_/i.test(message);
  const limited=response&&[403,429].includes(response.status)&&(response.headers?.get('x-ratelimit-remaining')==='0'||response.headers?.has('retry-after')||response.headers?.has('x-ratelimit-reset'));
  const kind=certificate?'NETWORK_CERTIFICATE':limited?'NETWORK_RATE_LIMITED':/ERR_UNSAFE_PORT/.test(code+' '+message)?'NETWORK_UNSAFE_PORT':/TIMEOUT|ETIMEDOUT/.test(code)||cause?.name==='TimeoutError'?'NETWORK_TIMEOUT':'NETWORK_CONNECT_FAILED';
  let host='';try{host=new URL(url).hostname;}catch{}
  return Object.assign(Error(networkErrorMessage(kind,{host,offline}),{cause}),{code:kind,network:true,host,offline,...(response?{status:response.status}:{}),technical:{name:detail?.name??'Error',code:code.slice(0,80)}});
}
