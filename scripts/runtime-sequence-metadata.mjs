// Keep production manifests small and free of workstation-only review paths.
// Complete source/processing receipts remain beside the local original assets.
export function runtimeSequenceMetadata(clip){
 const keys=['version','resourceVersion','characterId','actionId','resourceId','backend','description','label','canvas','anchor','eyeOrigin','cycleMs','nativeFrameCount','emotionPeakFrame','directionFrames','directionEndFrame','directionBlinkRanges','directionContentBounds'];
 const out=Object.fromEntries(keys.filter(k=>clip[k]!==undefined).map(k=>[k,clip[k]]));
 out.frames=clip.frames.map(f=>Object.fromEntries(['src','file','timestampMs','originalFrame','sourceIndex'].filter(k=>f[k]!==undefined).map(k=>[k,f[k]])));
 const asset=a=>Object.fromEntries(['file','src','sha256','codec','durationMs','encodedDurationMs','crf','pixelFormat','fps','encodedFrameCount','timeline','contentBounds'].filter(k=>a[k]!==undefined).map(k=>[k,k==='file'&&/^(?:[A-Za-z]:|[\\/])/.test(a[k])?a.src.replace(/^\.\//,''):a[k]]));
 if(clip.video)out.video=asset(clip.video);
 if(clip.staticFrames)out.staticFrames=Object.fromEntries(Object.entries(clip.staticFrames).map(([i,a])=>[i,asset(a)]));
 if(clip.interpolation)out.interpolation=Object.fromEntries(['method','sourceFps','targetFps','multiplier','closedLoop','nativeFrameCount'].filter(k=>clip.interpolation[k]!==undefined).map(k=>[k,clip.interpolation[k]]));
 if(clip.derivation)out.derivation={method:clip.derivation.method,sourceFps:clip.derivation.sourceFps,targetFps:clip.derivation.targetFps};
 if(clip.source?.sha256)out.source={sha256:clip.source.sha256,reviewVariant:clip.source.reviewVariant};
 return out;
}
