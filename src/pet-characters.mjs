export const PET_CHARACTERS=Object.freeze([
 ['deepseek','DeepSeek'],['claude','Claude'],['grok','Grok'],['seed','Seed'],['kimi','Kimi'],['qwen','Qwen'],['minimax','MiniMax'],['chatgpt','GPT'],['gemini','Gemini'],['glm','GLM'],['hunyuan','混元'],
].map(([id,name])=>Object.freeze({id,name})));
export const validPetCharacter=id=>PET_CHARACTERS.some(c=>c.id===id);
export const normalizePetCharacter=id=>id==='gpt'?'chatgpt':validPetCharacter(id)?id:'deepseek';
export const resolvePetCharacter=(preferences={},selected='deepseek')=>normalizePetCharacter(preferences.petCharacterMode==='fixed'?preferences.petFixedCharacter:selected);
export const petCharacterName=id=>PET_CHARACTERS.find(c=>c.id===normalizePetCharacter(id)).name;
