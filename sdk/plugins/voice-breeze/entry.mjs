export async function activate(api) {
  await api.commands.register({id:'ai-buddy.voice-breeze.prepare',title:'Breeze voice engine'},()=>({
    protocolVersion:1,engine:'breeze',worker:'breeze_worker.py',
    providers:['local','minimax'],cloudWorker:'cloud_speech.py',
  }));
}
