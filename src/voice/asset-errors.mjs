export function voiceAssetRecovery(code) {
  return ['VOICE_ASSET_MISSING','VOICE_ASSET_HASH','ENOENT'].includes(code) ? 'download' : 'verify';
}

export function voiceAssetFailureMessage(code) {
  return voiceAssetRecovery(code) === 'download' ? '校验没通过，请重新下载' : '校验时文件有变动，请再试一次';
}
