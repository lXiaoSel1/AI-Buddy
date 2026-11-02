// Host-owned startup check; the pinned third-party package remains unchanged.
const path=require('node:path');
const root=process.env.AI_BUDDY_QQ_PRIVATE_HOME;
if(!root||path.resolve(require('node:os').homedir())!==path.resolve(root))process.exit(78);
const moduleObject={exports:{}};
process.dlopen(moduleObject,process.env.NAPCAT_WRAPPER_PATH);
const selected=moduleObject.exports.NodeQQNTWrapperUtil.getNTUserDataInfoConfig();
if(selected){const relative=path.relative(root,selected);if(relative==='..'||relative.startsWith('..'+path.sep)||path.isAbsolute(relative))process.exit(78);}
process.on('disconnect',()=>{process.emit('message',{type:'shutdown'});setTimeout(()=>process.exit(0),1500).unref();});
