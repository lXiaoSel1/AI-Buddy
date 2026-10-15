import assert from 'node:assert/strict';
import {petBounds} from '../src/pet-window.mjs';
import {clampToDisplays} from '../src/window-position.mjs';

export function expectedReleasePetBounds(state,saved){
 const live=state.petContentBounds;
 if(live&&Number.isFinite(live.x)&&Number.isFinite(live.y)&&live.width>0&&live.height>0)return {mode:'visible-content-bounds',bounds:live};
 assert.ok(saved?.petBounds&&Number.isFinite(saved.petBounds.x)&&Number.isFinite(saved.petBounds.y),'A minimized window requires saved normal position evidence');
 assert.ok(state.displays?.length,'Restoring a minimized window requires current display evidence');
 return {mode:'saved-normal-bounds',bounds:clampToDisplays(petBounds(saved.petBounds,state.settings.preferences.petScale),state.displays)};
}
