import {createHash} from 'node:crypto';
import {socialExperienceEvidenceHash} from '../../src/companion-memory.mjs';

// This private fixture map stands for the immutable host receipt store, never
// the mutable companion JSON that the attacker/portable import can change.
export const fixtureReceiptHash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
export function rememberFixtureReceipt(receipts,source){receipts.set(source.eventRef,{scope:structuredClone(source.scope),sourceHash:source.sourceHash,sourcePluginId:source.sourcePluginId,sourceVersion:source.sourceVersion??1,companionSourceHash:socialExperienceEvidenceHash(source,source.eventRef,source.scope)});}
export const fixtureReceiptResolver=receipts=>args=>{const receipt=receipts.get(args.eventRef);if(!receipt||receipt.sourceHash!==args.sourceEvidenceHash||receipt.sourcePluginId!==args.sourcePluginId||receipt.sourceVersion!==args.sourceVersion||receipt.companionSourceHash!==args.companionSourceHash||['characterId','lifeId','personaId','channel','conversationId'].some(key=>receipt.scope[key]!==args[key]))return null;return {...receipt.scope,eventRef:args.eventRef,sourcePluginId:receipt.sourcePluginId,sourceEvidenceHash:receipt.sourceHash,sourceVersion:receipt.sourceVersion,companionSourceHash:receipt.companionSourceHash};};
