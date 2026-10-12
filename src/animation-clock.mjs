// One rAF clock per renderer. Subscribers leave when paused/unmounted.
const listeners=new Set();let handle=null;
function tick(now){handle=null;if(document.hidden||!listeners.size)return;for(const fn of listeners)fn(now);handle=requestAnimationFrame(tick);}
function sync(){if(document.hidden||!listeners.size){if(handle!==null)cancelAnimationFrame(handle);handle=null;}else if(handle===null)handle=requestAnimationFrame(tick);}
document.addEventListener('visibilitychange',sync);window.addEventListener('pagehide',()=>{if(handle!==null)cancelAnimationFrame(handle);handle=null;listeners.clear();});
export function subscribeAnimationClock(fn){listeners.add(fn);sync();return()=>{listeners.delete(fn);sync();};}
