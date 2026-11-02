import {contextBridge, ipcRenderer} from 'electron';

// This file is bundled as sandbox-compatible CJS. It exposes no Node, arbitrary
// channel, tool name, raw token, filesystem or general application preload.
const invoke = (method, payload = null) => ipcRenderer.invoke('buddy-plugin-client:invoke', {method, payload}).catch(error => ({ok: false, error: {code: 'WORK_CLIENT_TRANSPORT_FAILED', message: String(error.message).replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '')}}));
contextBridge.exposeInMainWorld('aiBuddyPluginClient', Object.freeze({
  describe: () => invoke('describe'),
  selectViewer: value => invoke('selectViewer', value),
  chooseWorkspace: value => invoke('chooseWorkspace', value),
  request: value => {
    if (['plans.approve', 'native.respond'].includes(value?.action) && globalThis.navigator?.userActivation?.isActive !== true) return Promise.resolve({ok: false, error: {code: 'WORK_USER_ACTIVATION_REQUIRED', message: value.action === 'plans.approve' ? '请点击当前计划的批准按钮。' : '请填写并点击原生问题的回答按钮。'}});
    return invoke('request', value);
  },
  subscribe(listener) {
    if (typeof listener !== 'function') throw TypeError('An event listener is required');
    const handler = (_event, value) => listener(value);
    ipcRenderer.on('buddy-plugin-client:event', handler);
    return () => ipcRenderer.removeListener('buddy-plugin-client:event', handler);
  },
}));
