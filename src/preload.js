const { contextBridge, ipcRenderer } = require('electron');
const call = (c) => (...a) => ipcRenderer.invoke(c, ...a);
contextBridge.exposeInMainWorld('api', {
  state: call('state'), pickGame: call('pickGame'), pickMods: call('pickMods'), pickSteamcmd: call('pickSteamcmd'),
  pickLibrary: call('pickLibrary'), setActive: call('setActive'), installSteamcmd: call('installSteamcmd'),
  download: call('download'), push: call('push'), clearCache: call('clearCache'), remove: call('remove'),
  select: call('select'), checkUpdates: call('checkUpdates'), cancel: call('cancel'),
  instCreate: call('instCreate'), instRename: call('instRename'), instSelect: call('instSelect'), instDelete: call('instDelete'), instActivate: call('instActivate'),
  pickFolder: call('pickFolder'), pickExe: call('pickExe'), pickSteamExe: call('pickSteamExe'), steamInfo: call('steamInfo'), launch: call('launch'),
  on: (ch, cb) => ipcRenderer.on(ch, (_e, d) => cb(d)),
  reply: (ch, v) => ipcRenderer.send(ch, v)
});
