import { contextBridge, ipcRenderer } from 'electron';
import type { IpcRendererEvent } from 'electron';
import type { DesktopState } from '../sync';

export interface HdBridge {
  getState(): Promise<DesktopState>;
  onState(cb: (state: DesktopState) => void): () => void;
  sendMessage(sessionId: string, text: string): Promise<void>;
  openSession(sessionId: string): Promise<void>;
}

// Sandboxed preload: keep this file free of runtime imports other than
// 'electron' so the CJS bundle has no ESM-only dependencies.
const bridge: HdBridge = {
  getState: () => ipcRenderer.invoke('hd:getState'),
  onState: (cb) => {
    const listener = (_event: IpcRendererEvent, state: DesktopState): void => {
      cb(state);
    };
    ipcRenderer.on('hd:state', listener);
    return () => {
      ipcRenderer.removeListener('hd:state', listener);
    };
  },
  sendMessage: (sessionId, text) => ipcRenderer.invoke('hd:send', sessionId, text),
  openSession: (sessionId) => ipcRenderer.invoke('hd:open', sessionId),
};

contextBridge.exposeInMainWorld('hd', bridge);
