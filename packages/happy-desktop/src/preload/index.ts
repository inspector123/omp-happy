import { contextBridge, ipcRenderer } from 'electron';
import type { IpcRendererEvent } from 'electron';
import type { DesktopState, SpawnSessionResult } from '../sync';

export type SpawnSessionAgent = 'omp' | 'claude' | 'codex' | 'gemini' | 'openclaw';

export interface SpawnSessionInput {
  machineId: string;
  directory: string;
  agent: SpawnSessionAgent;
}

export interface StopSessionResult {
  success: boolean;
  message: string;
}

export interface HdBridge {
  getState(): Promise<DesktopState>;
  onState(cb: (state: DesktopState) => void): () => void;
  sendMessage(sessionId: string, text: string): Promise<void>;
  openSession(sessionId: string): Promise<void>;
  spawnSession(input: SpawnSessionInput): Promise<SpawnSessionResult>;
  stopSession(sessionId: string): Promise<StopSessionResult>;
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
  spawnSession: (input) => ipcRenderer.invoke('hd:spawn', input),
  stopSession: (sessionId) => ipcRenderer.invoke('hd:stopSession', sessionId),
};

contextBridge.exposeInMainWorld('hd', bridge);
