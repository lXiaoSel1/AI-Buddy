// Line icons from the approved design (24px grid, 1.7 stroke, round caps). Decorative only:
// no <title>/<text>, so a button's text content stays its visible label.
import React from 'react';
export const ICONS=Object.freeze({
 "alert": "<path d=\"M12 4l9 16H3z\"/><path d=\"M12 10v4M12 17h.01\"/>",
 "archive": "<rect x=\"3.5\" y=\"5\" width=\"17\" height=\"4\" rx=\"1\"/><path d=\"M5 9v9.5A1.5 1.5 0 0 0 6.5 20h11a1.5 1.5 0 0 0 1.5-1.5V9M10 13h4\"/>",
 "brush": "<path d=\"M5 19l9-9\"/><path d=\"M14.5 4.5l.9 2 2 .9-2 .9-.9 2-.9-2-2-.9 2-.9zM18.5 11.5l.6 1.3 1.3.6-1.3.6-.6 1.3-.6-1.3-1.3-.6 1.3-.6z\"/>",
 "camera": "<path d=\"M4 8.5A1.5 1.5 0 0 1 5.5 7h2.3l1.4-2h5.6l1.4 2h2.3A1.5 1.5 0 0 1 20 8.5v9a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 17.5z\"/><circle cx=\"12\" cy=\"12.5\" r=\"3.5\"/>",
 "chats": "<path d=\"M4 6.5A2.5 2.5 0 0 1 6.5 4h7A2.5 2.5 0 0 1 16 6.5v4a2.5 2.5 0 0 1-2.5 2.5H9l-3.5 3v-3A2.5 2.5 0 0 1 4 10.5z\"/><path d=\"M18 9.5a2 2 0 0 1 2 2V15a2 2 0 0 1-2 2v2.5L15 17h-3\"/>",
 "check": "<path d=\"M5 12.5l4.5 4.5L19 7.5\"/>",
 "chevron": "<path d=\"M7 10l5 5 5-5\"/>",
 "clock": "<circle cx=\"12\" cy=\"12\" r=\"8.5\"/><path d=\"M12 7.5V12l3 2\"/>",
 "close": "<path d=\"M6 6l12 12M18 6L6 18\"/>",
 "coin": "<circle cx=\"12\" cy=\"12\" r=\"8\"/><path d=\"M9.5 9.5h4a1.8 1.8 0 0 1 0 3.6h-3a1.8 1.8 0 0 0 0 3.6h4M12 7.5v1.5M12 16.7v1.5\"/>",
 "download": "<path d=\"M12 4v11M7 10l5 5 5-5M5 20h14\"/>",
 "exit": "<path d=\"M14 4.5H6.5v15H14\"/><path d=\"M11 12h9M17 8.5l3.5 3.5-3.5 3.5\"/>",
 "external": "<path d=\"M14 5h5v5M19 5l-8 8M18 14v4a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h4\"/>",
 "eye": "<path d=\"M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z\"/><circle cx=\"12\" cy=\"12\" r=\"2.8\"/>",
 "fit": "<path d=\"M4 9V5h4M20 9V5h-4M4 15v4h4M20 15v4h-4\"/>",
 "gallery": "<rect x=\"3.5\" y=\"3.5\" width=\"7\" height=\"7\" rx=\"1.5\"/><rect x=\"13.5\" y=\"3.5\" width=\"7\" height=\"7\" rx=\"1.5\"/><rect x=\"3.5\" y=\"13.5\" width=\"7\" height=\"7\" rx=\"1.5\"/><rect x=\"13.5\" y=\"13.5\" width=\"7\" height=\"7\" rx=\"1.5\"/>",
 "gauge": "<path d=\"M4.5 16a8 8 0 1 1 15 0\"/><path d=\"M12 13l3.5-3.5\"/>",
 "gift": "<rect x=\"4\" y=\"9\" width=\"16\" height=\"11\" rx=\"1.5\"/><path d=\"M3 9h18M12 9v11M12 9c-1.6-3.6-5.2-4-5.2-1.6S12 9 12 9zM12 9c1.6-3.6 5.2-4 5.2-1.6S12 9 12 9z\"/>",
 "globe": "<circle cx=\"12\" cy=\"12\" r=\"8.5\"/><path d=\"M3.5 12h17M12 3.5c2.3 2.4 3.4 5.2 3.4 8.5s-1.1 6.1-3.4 8.5c-2.3-2.4-3.4-5.2-3.4-8.5s1.1-6.1 3.4-8.5z\"/>",
 "hand": "<path d=\"M8 13V6.5a1.5 1.5 0 0 1 3 0V12M11 11V5a1.5 1.5 0 0 1 3 0v6M14 11V6a1.5 1.5 0 0 1 3 0v7M17 12.5V9.5a1.5 1.5 0 0 1 3 0v5.5a6 6 0 0 1-6 6h-2a6 6 0 0 1-4.6-2.1L5 15.5a1.5 1.5 0 0 1 2.3-1.9L8 14.5\"/>",
 "idcard": "<rect x=\"3.5\" y=\"5.5\" width=\"17\" height=\"13\" rx=\"2\"/><circle cx=\"9\" cy=\"11\" r=\"2\"/><path d=\"M6 16c.5-1.5 1.6-2.2 3-2.2s2.5.7 3 2.2M14.5 10h3.5M14.5 13.5h3.5\"/>",
 "image": "<rect x=\"3.5\" y=\"5\" width=\"17\" height=\"14\" rx=\"2\"/><circle cx=\"9\" cy=\"10\" r=\"1.6\"/><path d=\"M20.5 16l-5-5-8 8\"/>",
 "info": "<circle cx=\"12\" cy=\"12\" r=\"8.5\"/><path d=\"M12 11v5M12 8h.01\"/>",
 "jump": "<path d=\"M8 16L16 8M9.5 8H16v6.5\"/>",
 "link": "<path d=\"M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1\"/><path d=\"M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1\"/>",
 "lock": "<rect x=\"5\" y=\"11\" width=\"14\" height=\"9\" rx=\"2\"/><path d=\"M8 11V8a4 4 0 0 1 8 0v3\"/>",
 "memory": "<path d=\"M9.5 4.5A3 3 0 0 0 6.5 7.5 3 3 0 0 0 5 13a3 3 0 0 0 3 5 2.5 2.5 0 0 0 4 1.3V6a2.5 2.5 0 0 0-2.5-1.5z\"/><path d=\"M14.5 4.5a3 3 0 0 1 3 3A3 3 0 0 1 19 13a3 3 0 0 1-3 5 2.5 2.5 0 0 1-4 1.3\"/>",
 "moon": "<path d=\"M19 14.5A7.5 7.5 0 0 1 9.5 5a7.5 7.5 0 1 0 9.5 9.5z\"/>",
 "more": "<circle cx=\"6\" cy=\"12\" r=\"1.3\"/><circle cx=\"12\" cy=\"12\" r=\"1.3\"/><circle cx=\"18\" cy=\"12\" r=\"1.3\"/>",
 "nav-actions": "<path d=\"M12 4v4M12 16v4M4 12h4M16 12h4M6.5 6.5l2.6 2.6M14.9 14.9l2.6 2.6M6.5 17.5l2.6-2.6M14.9 9.1l2.6-2.6\"/>",
 "nav-api": "<path d=\"M5 9h13l-3-3M19 15H6l3 3\"/>",
 "nav-galgame": "<path d=\"M12 19s-7-4.4-7-9.2A3.8 3.8 0 0 1 12 7.6a3.8 3.8 0 0 1 7 2.2C19 14.6 12 19 12 19z\"/>",
 "nav-history": "<circle cx=\"12\" cy=\"12\" r=\"8\"/><path d=\"M12 7.5V12h4\"/>",
 "nav-overview": "<circle cx=\"12\" cy=\"12\" r=\"3.6\"/>",
 "nav-settings": "<circle cx=\"12\" cy=\"12\" r=\"3\"/><path d=\"M12 3.5v2.2M12 18.3v2.2M3.5 12h2.2M18.3 12h2.2M6 6l1.6 1.6M16.4 16.4L18 18M6 18l1.6-1.6M16.4 7.6L18 6\"/>",
 "nav-token": "<circle cx=\"12\" cy=\"12\" r=\"5.5\"/><circle cx=\"12\" cy=\"12\" r=\"1.5\"/>",
 "nav-usage": "<rect x=\"4\" y=\"4\" width=\"16\" height=\"16\" rx=\"1.5\"/><path d=\"M4 10h16M4 15h16M10 4v16M15 4v16\"/>",
 "pause": "<path d=\"M9 6v12M15 6v12\"/>",
 "paw": "<circle cx=\"7.5\" cy=\"10\" r=\"1.7\"/><circle cx=\"11\" cy=\"6.8\" r=\"1.7\"/><circle cx=\"15\" cy=\"7\" r=\"1.7\"/><circle cx=\"18\" cy=\"10.5\" r=\"1.7\"/><path d=\"M8.5 17c0-2.6 2-4.6 4.2-4.6s3.8 2 3.8 4.3c0 1.5-1.2 2.3-2.4 2.3-.7 0-1-.4-1.5-.4s-.9.4-1.6.4c-1.3 0-2.5-.7-2.5-2z\"/>",
 "pencil": "<path d=\"M14.5 5.5l4 4L9 19H5v-4z\"/><path d=\"M13 7l4 4\"/>",
 "person": "<circle cx=\"12\" cy=\"7.5\" r=\"3.2\"/><path d=\"M6 20c.6-3.8 3-6 6-6s5.4 2.2 6 6\"/>",
 "play": "<path d=\"M8 5.5v13l10.5-6.5z\"/>",
 "plug": "<path d=\"M9 3v5M15 3v5M6.5 8h11v3.5a5.5 5.5 0 0 1-11 0zM12 17v4\"/>",
 "plus": "<path d=\"M12 5v14M5 12h14\"/>",
 "power": "<path d=\"M12 4v8\"/><path d=\"M7.5 6.8a7 7 0 1 0 9 0\"/>",
 "refresh": "<path d=\"M19 8a7.5 7.5 0 1 0 1 6\"/><path d=\"M20 4v4h-4\"/>",
 "retry": "<path d=\"M5 12a7 7 0 1 0 2.2-5.1\"/><path d=\"M5 4v4h4\"/>",
 "search": "<circle cx=\"11\" cy=\"11\" r=\"6\"/><path d=\"M20 20l-4.2-4.2\"/>",
 "send": "<path d=\"M4.5 11.5L19.5 5l-5 14-3-5.5z\"/><path d=\"M11.5 13.5l8-8.5\"/>",
 "sliders": "<path d=\"M4 7h10M18 7h2M4 17h4M12 17h8\"/><circle cx=\"16\" cy=\"7\" r=\"2\"/><circle cx=\"10\" cy=\"17\" r=\"2\"/>",
 "sprout": "<path d=\"M12 20v-8\"/><path d=\"M12 12c0-4 3-6.5 7-6.5 0 4-3 6.5-7 6.5zM12 14c0-3-2.4-5-6-5 0 3 2.4 5 6 5z\"/>",
 "star": "<path d=\"M12 4l2.4 5 5.4.6-4 3.7 1.1 5.3L12 16l-4.9 2.6 1.1-5.3-4-3.7 5.4-.6z\"/>",
 "stop": "<rect x=\"6.5\" y=\"6.5\" width=\"11\" height=\"11\" rx=\"2\"/>",
 "terminal": "<rect x=\"3.5\" y=\"5\" width=\"17\" height=\"14\" rx=\"2\"/><path d=\"M7.5 10l3 2.5-3 2.5M12.5 15h4\"/>",
 "ticket": "<path d=\"M4 7.5A1.5 1.5 0 0 1 5.5 6h13A1.5 1.5 0 0 1 20 7.5V10a2 2 0 0 0 0 4v2.5a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 16.5V14a2 2 0 0 0 0-4z\"/><path d=\"M14 7v2M14 11v2M14 15v2\"/>",
 "trash": "<path d=\"M5 7h14M10 4h4M7 7l1 12.5h8L17 7\"/>",
 "undo": "<path d=\"M9 6L5 10l4 4\"/><path d=\"M5 10h9.5a4.5 4.5 0 0 1 0 9H11\"/>",
 "upload": "<path d=\"M12 16V5M7 9.5l5-5 5 5M5 20h14\"/>",
 "users": "<circle cx=\"9\" cy=\"8\" r=\"3\"/><path d=\"M3.5 19c.5-3.4 2.6-5.2 5.5-5.2s5 1.8 5.5 5.2\"/><path d=\"M15.5 5.3a3 3 0 0 1 0 5.4M17.5 13.9c1.7.6 2.7 2.3 3 5.1\"/>",
 "zin": "<circle cx=\"11\" cy=\"11\" r=\"6\"/><path d=\"M20 20l-4.2-4.2M8.5 11h5M11 8.5v5\"/>",
 "zout": "<circle cx=\"11\" cy=\"11\" r=\"6\"/><path d=\"M20 20l-4.2-4.2M8.5 11h5\"/>"
});
const SVG_NS='http://www.w3.org/2000/svg',ATTRS={viewBox:'0 0 24 24',fill:'none',stroke:'currentColor','stroke-width':'1.7','stroke-linecap':'round','stroke-linejoin':'round','aria-hidden':'true',focusable:'false'};
export function Icon(name,{size=16,className=''}={}){
 const markup=ICONS[name];if(!markup)throw Error('Unknown icon: '+name);
 return React.createElement('svg',{className:'ui-icon'+(className?' '+className:''),viewBox:ATTRS.viewBox,width:size,height:size,fill:'none',stroke:'currentColor',strokeWidth:1.7,strokeLinecap:'round',strokeLinejoin:'round','aria-hidden':true,focusable:'false',dangerouslySetInnerHTML:{__html:markup}});
}
// For plain DOM pages (the desktop pet).
export function iconElement(name,{size=16,className=''}={}){
 const svg=document.createElementNS(SVG_NS,'svg');for(const [k,v] of Object.entries(ATTRS))svg.setAttribute(k,v);
 svg.setAttribute('width',size);svg.setAttribute('height',size);svg.setAttribute('class','ui-icon'+(className?' '+className:''));
 const doc=new DOMParser().parseFromString('<svg xmlns="'+SVG_NS+'">'+ICONS[name]+'</svg>','image/svg+xml');for(const child of [...doc.documentElement.childNodes])svg.append(document.importNode(child,true));return svg;
}
