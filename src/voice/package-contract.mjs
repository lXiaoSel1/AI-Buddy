export const VOICE_SHARED_PACKAGE = 'ai-buddy.voice-shared-runtime';
export const VOICE_PACKAGE_VERSION = '1.0.0';
export const VOICE_PACKAGE_VERSIONS = Object.freeze(['1.0.0', '1.0.1', '1.0.2', '1.0.3']);
export const VOICE_PROVIDERS = Object.freeze(['local', 'minimax']);
export const VOICE_CLOUD_WORKER = 'cloud_speech.py';
export const VOICE_ENGINES = Object.freeze({
  'ai-buddy.voice-breeze': Object.freeze({engine:'breeze',worker:'breeze_worker.py'}),
  'ai-buddy.voice-gpt-sovits': Object.freeze({engine:'gpt-sovits',worker:'gpt_worker.py'}),
});

export function isVoiceEnginePackage(id) {
  return Object.hasOwn(VOICE_ENGINES,id);
}

export function isVoicePackage(id) {
  return id===VOICE_SHARED_PACKAGE || isVoiceEnginePackage(id);
}

export function isVoiceCommunityWork(work) {
  return work?.category==='voice' && work.backend==='buddy-v1' && isVoiceEnginePackage(work.packageName);
}

export function supportsVoiceManifest(manifest) {
  if(!isVoiceEnginePackage(manifest?.id))return false;
  const {engine,worker}=VOICE_ENGINES[manifest.id];
  return VOICE_PACKAGE_VERSIONS.includes(manifest.version) && manifest.kind==='plugin' && manifest.entry==='entry.mjs' &&
    manifest.activationEvents?.length===1 && manifest.activationEvents.includes(`onCommand:voice.${engine}`) &&
    manifest.capabilities?.length===1 && manifest.capabilities.includes('commands.register') &&
    Object.keys(manifest.dependencies??{}).length===1 && manifest.dependencies[VOICE_SHARED_PACKAGE]===manifest.version &&
    ['entry.mjs','assets.json',worker].every(path=>manifest.files?.some(file=>file.path===path));
}
