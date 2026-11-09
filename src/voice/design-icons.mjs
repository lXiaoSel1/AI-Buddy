import React from 'react';
import {Icon} from '../ui-icons.mjs';

// Approved secV0.js line-icon paths; data is static artwork, never user input.
export const VOICE_ICONS=Object.freeze({
  "mic": "<rect x=\"9\" y=\"3.5\" width=\"6\" height=\"11\" rx=\"3\"/><path d=\"M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5v3M9 20.5h6\"/>",
  "mic-off": "<path d=\"M9 9V6.5a3 3 0 0 1 5.6-1.5M15 11.5a3 3 0 0 1-4.7 2.4M5.5 11a6.5 6.5 0 0 0 10.4 5.2M18.5 11a6.4 6.4 0 0 1-.7 3M12 17.5v3M9 20.5h6M4 4l16 16\"/>",
  "wave": "<path d=\"M4 10.5v3M8 7.5v9M12 4.5v15M16 8v8M20 10.5v3\"/>",
  "speaker": "<path d=\"M4.5 9.5h3l4.5-4v13l-4.5-4h-3z\"/><path d=\"M15.5 9a4 4 0 0 1 0 6M18 6.5a7.5 7.5 0 0 1 0 11\"/>",
  "voice-breeze": "<path d=\"M3.5 9h9.5a2.5 2.5 0 1 0-2.5-2.5\"/><path d=\"M3.5 13h13a2.5 2.5 0 1 1-2.5 2.5\"/><path d=\"M3.5 17h5.5\"/>",
  "voice-gpt": "<path d=\"M3 12h2.5l2-5.5 3 11 3-9 2 5 1.5-1.5H21\"/>",
  "cloud": "<path d=\"M7 18.5h10.5a4 4 0 0 0 .4-8A6 6 0 0 0 6.4 9 4.8 4.8 0 0 0 7 18.5z\"/>",
  "turns": "<path d=\"M4 7.5h11.5a3 3 0 0 1 3 3V12\"/><path d=\"M16 5l2.5 2.5L16 10\"/><path d=\"M20 16.5H8.5a3 3 0 0 1-3-3V12\"/><path d=\"M8 19l-2.5-2.5L8 14\"/>",
  "cpu": "<rect x=\"7\" y=\"7\" width=\"10\" height=\"10\" rx=\"1.5\"/><path d=\"M10 3.5v3M14 3.5v3M10 17.5v3M14 17.5v3M3.5 10h3M3.5 14h3M17.5 10h3M17.5 14h3\"/>",
  "key": "<circle cx=\"8\" cy=\"15\" r=\"3.5\"/><path d=\"M10.5 12.5l8-8M16 7l2.5 2.5M14 9l2 2\"/>",
  "upload": "<path d=\"M12 15.5V4.5M7.5 9L12 4.5 16.5 9\"/><path d=\"M4.5 15v3.5a1.5 1.5 0 0 0 1.5 1.5h12a1.5 1.5 0 0 0 1.5-1.5V15\"/>",
  "check-c": "<circle cx=\"12\" cy=\"12\" r=\"8\"/><path d=\"M8.5 12.2l2.4 2.4 4.6-4.8\"/>",
  "x-c": "<circle cx=\"12\" cy=\"12\" r=\"8\"/><path d=\"M9.5 9.5l5 5M14.5 9.5l-5 5\"/>",
  "folder": "<path d=\"M3.5 7a1.5 1.5 0 0 1 1.5-1.5h4l2 2h8a1.5 1.5 0 0 1 1.5 1.5v8.5a1.5 1.5 0 0 1-1.5 1.5H5a1.5 1.5 0 0 1-1.5-1.5z\"/>",
  "gpu": "<rect x=\"3.5\" y=\"7\" width=\"17\" height=\"10\" rx=\"1.5\"/><circle cx=\"9\" cy=\"12\" r=\"2.5\"/><path d=\"M14 10.5h3.5M14 13.5h3.5M6 17v2M10 17v2\"/>"
});
export function VoiceIcon(name,{size=16,className=''}={}){
 const markup=VOICE_ICONS[name];
 return markup?React.createElement('svg',{className:'ui-icon'+(className?' '+className:''),viewBox:'0 0 24 24',width:size,height:size,fill:'none',stroke:'currentColor',strokeWidth:1.7,strokeLinecap:'round',strokeLinejoin:'round','aria-hidden':true,focusable:'false',dangerouslySetInnerHTML:{__html:markup}}):Icon(name,{size,className});
}
