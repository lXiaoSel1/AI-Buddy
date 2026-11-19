import {THEMES,themeAsset} from './appearance.mjs';
import {companionImage} from './companion-image.mjs';

export function groupMemberAvatar(character,resolveArt) {
 if(character&&character.builtin!==false&&Object.hasOwn(THEMES,character.id))return './'+themeAsset(character.id,'head.webp');
 return companionImage(character?.avatar,resolveArt);
}
