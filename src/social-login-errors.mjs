import {networkErrorMessage} from './network-errors.mjs';
const messages={
 SOCIAL_LOGIN_RETRY_STALE:['原下载失败记录已变化，请重新连接。','The original failed download changed. Start a new connection.'],
 SOCIAL_LOGIN_EXPIRED:['登录已过期，请重新扫码。','Login expired. Scan again.'],
 SOCIAL_LOGIN_IDENTITY_MISMATCH:['账号核对不一致，请取消后选择正确账号重新扫码。','Account identities do not match. Cancel and scan with the intended account.'],
 SOCIAL_LOGIN_CONNECTION_CHANGED:['连接设置已变化，本次结果已作废，请重试。','Connection settings changed. This result was discarded; retry.'],
 SOCIAL_LOGIN_STOP_PENDING:['上一次连接仍在关闭，请稍后重试或正常退出 AI 酱。','The previous connection is still closing. Retry later or exit AI Buddy normally.'],
 SOCIAL_LOGIN_NETWORK_ERROR:['网络检查失败，原有账号保留。请联网后重试。','Network check failed. Your saved account is retained. Retry when online.'],
 QQ_COMPONENT_DISK_FULL:['组件准备空间不足，请先腾出磁盘空间后重试。','Not enough disk space to prepare the component. Free space and retry.'],
 QQ_COMPONENT_HASH_MISMATCH:['下载文件校验不通过，未运行该文件。请重试下载。','Download integrity check failed. The file was not run. Retry the download.'],
 QQ_COMPONENT_PREPARATION_BUSY:['另一实例正在准备组件，请等待其结束。','Another instance is preparing the component. Wait for it to finish.'],
 QQ_COMPONENT_RESTART_REQUIRED:['QQ组件要求重新启动，请点击连接重试。','The QQ component requested a restart. Click Connect to retry.'],
 QQ_COMPONENT_START_TIMEOUT:['QQ组件启动超时，已停止本次连接，请重试。','The QQ component startup timed out. This connection was stopped; retry.'],
 QQ_COMPONENT_PLATFORM_UNSUPPORTED:['扫码QQ组件目前仅支持 Windows x64；其他平台可使用高级连接。','The QR component currently supports Windows x64. Other platforms can use advanced connections.'],
 QQ_ONEBOT_NOT_READY:['QQ已登录，但连接通道还没有就绪，请稍后重试。','QQ login is available but its connection channel is not ready. Retry shortly.'],
 QQ_RESTORE_NOT_AUTHORIZED:['角色或人生状态已变化，请重新确认接管者和允许范围。','The character or life changed. Confirm the operator and allowed conversations again.'],
 QQ_CACHE_LIMIT_REACHED:['连接组件的临时缓存达到上限，已停止本次连接以保护磁盘空间。请重试。','The connector reached its temporary cache limit and was stopped to protect disk space. Retry.'],
};
export function socialLoginErrorText(code,en=false,host=''){if(typeof code==='string'&&code.startsWith('NETWORK_'))return networkErrorMessage(code,{host,language:en?'en':'zh-CN',offline:true});return messages[code]?.[en?1:0]??(en?'Connection did not complete. Retry or use Advanced connections.':'连接未完成，请重试或使用高级连接。');}
