const messages={
  CLOUD_MINIMAX_AUTH:'MiniMax Key 无效，请到云配音设置重新填写',
  CLOUD_MINIMAX_BALANCE:'MiniMax 余额或点数不足，请到 MiniMax 账户充值',
  CLOUD_MINIMAX_QUOTA:'MiniMax 本时段额度已用完，稍后会自动恢复',
  CLOUD_MINIMAX_CLONE_DURATION:'MiniMax 要求克隆参考录音时长为 10 秒到 5 分钟',
  CLOUD_MINIMAX_CLONE_IDENTITY:'MiniMax 要求先完成账户实名认证才能克隆音色',
  CLOUD_MINIMAX_CLONE_DUPLICATE:'MiniMax 上已存在这个克隆音色 ID，请先核对已有音色',
  CLOUD_MINIMAX_CLONE_PROMPT_DURATION:'MiniMax 要求克隆提示录音短于 8 秒',
  CLOUD_MINIMAX_CLONE_QUALITY:'MiniMax 未通过克隆参考录音质量检查，请使用更清晰的录音',
  CLOUD_MINIMAX_CLONE_SLOTS:'MiniMax 克隆音色位已满，请到 MiniMax 管理音色或升级套餐',
  CLOUD_MINIMAX_RATE_LIMIT:'MiniMax 请求频率或并发受限，请降低频率并稍后重试',
  CLOUD_MINIMAX_MODERATION:'MiniMax 拦截了朗读内容，请调整内容后重试',
  CLOUD_MINIMAX_PARAMETERS:'MiniMax 拒绝了请求参数，请检查朗读内容、模型和音色',
  CLOUD_MINIMAX_SERVICE:'MiniMax 云配音服务暂不可用，请稍后重试',
  CLOUD_TIMEOUT:'MiniMax 云配音响应超时，请稍后重试',
  CLOUD_NETWORK:'MiniMax 云配音连接失败，请检查网络后重试',
  CLOUD_MINIMAX_DENIED:'MiniMax 拒绝访问，请检查账户权限',
  CLOUD_MINIMAX_UNKNOWN:'MiniMax 云配音暂不可用（错误码 {code}），请稍后重试',
  CLOUD_MINIMAX_HTTP:'MiniMax 云配音暂不可用（HTTP {code}），请稍后重试',
  CLOUD_MINIMAX_RESPONSE:'MiniMax 返回了意外响应，请稍后重试',
  CLOUD_PROTOCOL:'MiniMax 返回了无效流式事件',
};

// https://platform.minimax.io/docs/api-reference/errorcode
const providerCodes=new Map([
  ['auth',[1004,2049,2057]],['balance',[1008,2053,2067]],['quota',[2056]],
  ['rate_limit',[1002,1039,1041,1045,2045,2046,2047,2062]],
  ['moderation',[1026,1027,1040,1042,1046]],
  ['parameters',[2013,2014,20132,2022,2042,2043,2054,2061,2068,2069]],
  ['service',[1000,1024,1033,2064]],['timeout',[1001,2066]],
].flatMap(([category,codes])=>codes.map(code=>[code,category])));

const cloneCodes=new Map([
  [2037,'clone_duration'],[2038,'clone_identity'],[2039,'clone_duplicate'],
  [2048,'clone_prompt_duration'],[2051,'clone_quality'],[2052,'clone_slots'],
]);

export function minimaxSpeechMessage({code,providerCode,httpStatus}={},translate=value=>value) {
  if(!Object.hasOwn(messages,code))return undefined;
  const rawCode=providerCode??httpStatus;
  return translate(messages[code]).replace('{code}',Number.isSafeInteger(rawCode)?String(rawCode):'');
}

export class MiniMaxSpeechError extends Error {
  constructor(category,codes={}) {
    const code=({network:'CLOUD_NETWORK',timeout:'CLOUD_TIMEOUT',protocol:'CLOUD_PROTOCOL'})[category]??'CLOUD_MINIMAX_'+category.toUpperCase();
    super(minimaxSpeechMessage({code,...codes}));
    Object.assign(this,{code,category,state:category==='auth'?'key-invalid':'unavailable',...codes});
  }
}

export function minimaxBusinessError(row,{operation}={}) {
  const providerCode=row?.base_resp?.status_code;
  if(Number.isSafeInteger(providerCode) && providerCode!==0) {
    const cloneCategory=operation==='clone'?cloneCodes.get(providerCode):undefined;
    return new MiniMaxSpeechError(cloneCategory??providerCodes.get(providerCode)??'unknown',{providerCode});
  }
}

export function minimaxHttpError(httpStatus) {
  const category=({400:'parameters',401:'auth',403:'denied',408:'timeout',422:'parameters',429:'rate_limit',504:'timeout'})[httpStatus]??
    (httpStatus>=500&&httpStatus<600?'service':'http');
  return new MiniMaxSpeechError(category,{httpStatus});
}

export function minimaxSpeechStatus({state,code,message,category,providerCode,httpStatus,retryAt}) {
  return {state,code,message,...(category?{category}:{}),...(Number.isSafeInteger(providerCode)?{providerCode}:{}),...(Number.isSafeInteger(httpStatus)?{httpStatus}:{}),...(Number.isSafeInteger(retryAt)?{retryAt}:{})};
}
