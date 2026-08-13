let electron = require("electron");
//#region src/preload/index.ts
electron.contextBridge.exposeInMainWorld("hd", {
	getState: () => electron.ipcRenderer.invoke("hd:getState"),
	onState: (cb) => {
		const listener = (_event, state) => {
			cb(state);
		};
		electron.ipcRenderer.on("hd:state", listener);
		return () => {
			electron.ipcRenderer.removeListener("hd:state", listener);
		};
	},
	sendMessage: (sessionId, text) => electron.ipcRenderer.invoke("hd:send", sessionId, text),
	openSession: (sessionId) => electron.ipcRenderer.invoke("hd:open", sessionId),
	spawnSession: (input) => electron.ipcRenderer.invoke("hd:spawn", input),
	stopSession: (sessionId) => electron.ipcRenderer.invoke("hd:stopSession", sessionId)
});
//#endregion
