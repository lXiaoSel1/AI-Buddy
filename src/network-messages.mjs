import {locale} from './i18n.mjs';
export const networkMessages=Object.freeze({
 '请填写有效的网络地址':'Enter a valid network address.','暂时只支持 http 代理':'Only HTTP and HTTPS proxies are supported for now.','镜像地址需要使用 HTTPS':'Mirror addresses must use HTTPS.','请填写不含账号、路径或查询参数的网络地址':'Enter an address without credentials, paths or query parameters.','网络设置格式无效':'Invalid network settings.','代理模式无效':'Invalid proxy mode.','网络地址必须是文字':'Network addresses must be text.',
 '网络':'Network','代理':'Proxy','跟随系统':'Follow system','手动':'Manual','不使用':'Do not use','测试':'Test',
 '扩展中心、组件下载和模型聊天都按这里的设置联网。':'Extensions, component downloads and model chat use these network settings.',
 '可以访问扩展目录':'The extension catalog is accessible','下载镜像':'Download mirrors','GitHub 镜像':'GitHub mirror','HuggingFace 镜像':'HuggingFace mirror',
 '留空就从官方地址下载。用镜像下载的文件同样会核对大小和 SHA-256，对不上会拒绝。':'Leave blank to download from official sources. Mirror downloads are checked against the same size and SHA-256; mismatches are rejected.',
 '正在测试…':'Testing…','网络设置已保存':'Network settings saved','请填写代理地址':'Enter a proxy address','地区':'Region','中国大陆':'Mainland China','国际':'International',
 '这是局域网地址，连接没有加密。':'This is a local network address. The connection is not encrypted.',
 '已自动整理成服务地址':'Normalized to the service base address','不同地区的 Key 不通用，请填写所选地区的 Key。':'API keys are region specific. Enter a key for the selected region.',
 '改用官方地址重试':'Retry from the official source','技术详情':'Technical details',
});
export const networkLabel=value=>locale()==='en'?(networkMessages[value]??value):value;
