/* Jembatan aman antara jendela (renderer) dan proses utama. */
'use strict';

const { contextBridge, ipcRenderer, webUtils } = require('electron');

async function call(channel, args) {
  const res = await ipcRenderer.invoke(channel, args);
  if (!res.ok) throw new Error(res.error);
  return res.data;
}

contextBridge.exposeInMainWorld('wd', {
  call,
  /** Path asli berkas yang di-drag ke jendela. */
  pathForFile: (file) => webUtils.getPathForFile(file),
  on: (channel, cb) => {
    const allowed = ['menu', 'ai:progress', 'deckcraft:progress', 'deckcraft:exit', 'deckcraft:error'];
    if (!allowed.includes(channel)) return;
    ipcRenderer.on(channel, (_e, payload) => cb(payload));
  },
});
