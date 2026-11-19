import React from 'react';
import {GalgameApp,GalgameCSS} from '../../src/adapted/galgame-client.ts';
import {applyAppearance} from '../../src/appearance.mjs';
import {setLocale} from '../../src/i18n.mjs';

async function waitFor(predicate,description){
 for(let i=0;i<250;i++){const value=predicate();if(value)return value;await new Promise(resolve=>setTimeout(resolve,10));}
 throw Error('Migration fixture did not show '+description);
}
export async function run(root){
 applyAppearance({theme:'deepseek'});
 setLocale('en');
 const style=document.createElement('style');style.textContent=GalgameCSS;document.head.append(style);
 root.render(React.createElement(GalgameApp,{variant:'tab',useSessions:null,chat:{enabled:true}}));
 const dialog=await waitFor(()=>document.querySelector('[data-galgame-screen="migrating"]'),'migration status');
 if(!dialog.textContent.includes('Organizing chat history'))throw Error('Migration wait should be localized');
 if(document.querySelector('#whg-panel,[data-galgame-input-toggle]'))throw Error('Galgame opened a writable chat during migration');
 await waitFor(()=>dialog.textContent.includes('36 / 60'),'updated migration count');
 await waitFor(()=>document.querySelector('#whg-panel'),'dialogue after automatic migration completion');
 if(document.querySelector('[data-galgame-screen="migrating"]'))throw Error('Migration status remained visible after the view was ready');
}
