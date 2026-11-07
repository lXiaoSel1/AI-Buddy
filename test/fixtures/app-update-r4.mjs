import {createHash,generateKeyPairSync,sign} from 'node:crypto';
import {createAppReleaseClient} from '../../src/update-release-proof.mjs';
import {verifyRawSshSignature} from '../../src/raw-sshsig.mjs';

export const fixtureBytes=Buffer.from('verified installer fixture');
const hash=value=>createHash('sha256').update(value).digest('hex');
const field=value=>{const n=Buffer.alloc(4);n.writeUInt32BE(value.length);return Buffer.concat([n,value]);};
export function releaseFixture({bootstrap=true,update=true}={}){
  const {publicKey,privateKey}=generateKeyPairSync('ed25519'),pub=Buffer.concat([field(Buffer.from('ssh-ed25519')),field(Buffer.from(publicKey.export({format:'jwk'}).x,'base64url'))]);
  const sourceCommit='d'.repeat(40),tagObjectSha='e'.repeat(40),version='2.0.8',tag='v'+version,base='https://github.com/lXiaoSel1/AI-Buddy/releases',installerName=`AI-Buddy-Setup-${version}-win-x64.exe`;
  const installerSha256=hash(fixtureBytes),manifestSha256='b'.repeat(64),checksumsSha256='c'.repeat(64);
  const signedPayload=`object ${sourceCommit}\ntype commit\ntag ${tag}\ntagger AI Buddy test\n\nAI Buddy test release\nSource: ${sourceCommit}\nInstaller SHA-256: ${installerSha256}\nManifest SHA-256: ${manifestSha256}\nChecksums SHA-256: ${checksumsSha256}\n${update?'App Update Protocol: 1\n':''}${bootstrap?'App Bootstrap Protocol: 1\n':''}Notes: Signed fixture notes\n`;
  const fields=[Buffer.from('git'),Buffer.alloc(0),Buffer.from('sha512')],signatureBytes=sign(null,Buffer.concat([Buffer.from('SSHSIG'),...fields.map(field),field(createHash('sha512').update(signedPayload).digest())]),privateKey),v=Buffer.from('00000001','hex');
  const binary=Buffer.concat([Buffer.from('SSHSIG'),v,field(pub),...fields.map(field),field(Buffer.concat([field(Buffer.from('ssh-ed25519')),field(signatureBytes)]))]);
  const signature='-----BEGIN SSH SIGNATURE-----\n'+binary.toString('base64').match(/.{1,70}/g).join('\n')+'\n-----END SSH SIGNATURE-----\n';
  const release={version,tag,releaseUrl:base+'/tag/'+tag,installerUrl:base+'/download/'+tag+'/'+installerName,installerName,bytes:fixtureBytes.length,installerSha256,manifestSha256,sourceCommit,tagObjectSha,signedPayload,signature,checksumsSha256};
  const asset=(name,bytes,hash)=>({name,size:bytes,state:'uploaded',digest:'sha256:'+hash,browser_download_url:base+'/download/'+tag+'/'+name});
  const document={draft:false,prerelease:false,tag_name:tag,html_url:release.releaseUrl,target_commitish:sourceCommit,assets:[asset(installerName,release.bytes,installerSha256),asset(`install-manifest-${version}.json`,12,manifestSha256),asset(`SHA256SUMS-${version}.txt`,12,checksumsSha256)]};
  const reference={ref:'refs/tags/'+tag,object:{type:'tag',sha:tagObjectSha}};
  const tagDocument={sha:tagObjectSha,tag,object:{type:'commit',sha:sourceCommit},message:signedPayload.slice(signedPayload.indexOf('\n\n')+2)+signature,verification:{verified:true,reason:'valid',payload:signedPayload,signature}};
  const publicSsh='ssh-ed25519 '+pub.toString('base64');
  const verifySignature=(payload,armored)=>verifyRawSshSignature(Buffer.from(payload,'utf8'),armored,publicSsh,'git');
  const urls=new Map([['https://api.github.com/repos/lXiaoSel1/AI-Buddy/releases/latest',document],['https://api.github.com/repos/lXiaoSel1/AI-Buddy/git/ref/tags/'+tag,reference],['https://api.github.com/repos/lXiaoSel1/AI-Buddy/git/tags/'+tagObjectSha,tagDocument]]);
  const fetch=async url=>url===release.installerUrl?new Response(fixtureBytes,{headers:{'content-length':String(fixtureBytes.length)}}):new Response(JSON.stringify(urls.get(url)),{headers:{'content-type':'application/json'}});
  return {release,document,reference,tagDocument,publicSsh,verifySignature,fetch,client:createAppReleaseClient({fetch,verifySignature})};
}
