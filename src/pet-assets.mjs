import selection from '../assets/pet-assets.json' with {type:'json'};
import candidate from '../assets/v014-pet-assets.json' with {type:'json'};
// One selection shared by the runtime, build, exporters, and verification.
const chosen=typeof __FIVE_ACTIONS_V014__!=='undefined'&&__FIVE_ACTIONS_V014__?candidate:selection;
export const ACTION_MANIFEST=chosen.actions;
export const MOTION_MANIFEST=chosen.motion;
