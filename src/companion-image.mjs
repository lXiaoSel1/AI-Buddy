// B4: a companion picture is either an inline data URL (fresh uploads, older saves)
// or a stored file served as buddy-media://<sha256>.<ext>. Both are shown as-is and
// sent back unchanged when a card, persona or group is saved.
const DATA_IMAGE=/^data:image\/(?:png|jpeg|webp|avif);base64,[a-z\d+/=\s]+$/i;
// Same form media-store.mjs accepts; that module uses node APIs, so the panel keeps its own copy.
const MEDIA_IMAGE=/^buddy-media:\/\/[a-f0-9]{64}\.(?:png|jpeg|webp|avif)\/?$/;
const BUNDLED_IMAGE=/^assets\/[a-z\d_./ -]+\.(?:png|jpe?g|webp|avif)$/i;

export const isMediaImage=value=>typeof value==='string'&&MEDIA_IMAGE.test(value);
// A picture the user supplied (uploaded or stored), as opposed to a bundled art key.
export const isStoredImage=value=>typeof value==='string'&&(DATA_IMAGE.test(value)||MEDIA_IMAGE.test(value));
export function companionImage(value,resolveArt=()=>null){
 if(typeof value!=='string'||!value)return null;
 if(isStoredImage(value))return value;
 if(BUNDLED_IMAGE.test(value)&&!value.split('/').includes('..'))return value;
 return resolveArt(value)||null;
}
