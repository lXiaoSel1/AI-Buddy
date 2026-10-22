export const PET_CHARACTERS=Object.freeze([
 ['deepseek','DeepSeek'],['claude','Claude'],['grok','Grok'],['seed','Seed'],['kimi','Kimi'],['qwen','Qwen'],['minimax','MiniMax'],['chatgpt','GPT'],['gemini','Gemini'],['glm','GLM'],['hunyuan','混元'],
].map(([id,name])=>Object.freeze({id,name})));
export const validPetCharacter=id=>PET_CHARACTERS.some(c=>c.id===id);
export const normalizePetCharacter=id=>id==='gpt'?'chatgpt':validPetCharacter(id)?id:'deepseek';
export const resolvePetCharacter=(preferences={},selected='deepseek')=>normalizePetCharacter(preferences.petCharacterMode==='fixed'?preferences.petFixedCharacter:selected);
// The character the brand icons show: the one the visible pet has reported drawing (a demo, or the old
// character while a switch waits for a reaction to finish); the settings target while she is hidden or not yet drawn.
export const brandPetCharacter=({shown=false,reported=null,target='deepseek'}={})=>shown&&validPetCharacter(reported)?reported:normalizePetCharacter(target);
export const petCharacterName=id=>PET_CHARACTERS.find(c=>c.id===normalizePetCharacter(id)).name;
