import {resolve} from 'node:path';
import {DSH_PREVIEW_NOTICE} from '../dsh-preview-notice.mjs';
export function dshUiBootstrap({stateDir,workClientMode=false,taskOnly=false,profileId='buddy-community-v1'}){
 if(taskOnly)return '';
 const workspace=resolve(stateDir,'workspace-documents');
 return `- id: workspace-controller\n  config:\n    documentsDirectory: ${JSON.stringify(workspace)}\n- id: ui-settings-models\n${workClientMode?'  disabled: true\n':'  config:\n    credentialOnboarding: false\n'}${!workClientMode&&profileId==='buddy-community-v1'?`- id: ui-settings-general\n  config:\n    welcomeNoticeVersion: ${JSON.stringify(DSH_PREVIEW_NOTICE.version)}\n`:''}`;
}
