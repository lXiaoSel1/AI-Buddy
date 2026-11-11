export function fixtureVoiceWav(durationMs=10000){
  const sampleRate=16000;
  const dataBytes=durationMs*sampleRate*2/1000;
  const wav=Buffer.alloc(44+dataBytes);
  wav.write('RIFF');
  wav.writeUInt32LE(wav.length-8,4);
  wav.write('WAVEfmt ',8);
  wav.writeUInt32LE(16,16);
  wav.writeUInt16LE(1,20);
  wav.writeUInt16LE(1,22);
  wav.writeUInt32LE(sampleRate,24);
  wav.writeUInt32LE(sampleRate*2,28);
  wav.writeUInt16LE(2,32);
  wav.writeUInt16LE(16,34);
  wav.write('data',36);
  wav.writeUInt32LE(dataBytes,40);
  return wav;
}
