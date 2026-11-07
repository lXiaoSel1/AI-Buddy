export async function activate(api) {
  await api.commands.register({id:'ai-buddy.voice-gpt-sovits.prepare',title:'GPT-SoVITS voice engine'},()=>({
    protocolVersion:1,engine:'gpt-sovits',worker:'gpt_worker.py',
    providers:['local','minimax'],cloudWorker:'cloud_speech.py',
  }));
}
