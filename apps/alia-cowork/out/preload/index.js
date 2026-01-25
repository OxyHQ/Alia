"use strict";
const electron = require("electron");
const preload = require("@electron-toolkit/preload");
const api = {
  // Window controls
  minimize: () => electron.ipcRenderer.invoke("window:minimize"),
  maximize: () => electron.ipcRenderer.invoke("window:maximize"),
  close: () => electron.ipcRenderer.invoke("window:close"),
  toggleAlwaysOnTop: () => electron.ipcRenderer.invoke("window:toggle-always-on-top"),
  // Chat
  sendMessage: (message, mode, model, context) => electron.ipcRenderer.invoke("chat:send", message, mode, model, context),
  stopGeneration: () => electron.ipcRenderer.invoke("chat:stop"),
  clearChat: () => electron.ipcRenderer.invoke("chat:clear"),
  // User & Models
  getUserInfo: () => electron.ipcRenderer.invoke("user:get"),
  getModels: () => electron.ipcRenderer.invoke("models:get"),
  // Screen
  captureScreen: () => electron.ipcRenderer.invoke("screen:capture"),
  // Event listeners
  onChatStart: (callback) => {
    electron.ipcRenderer.on("chat:start", callback);
    return () => electron.ipcRenderer.removeListener("chat:start", callback);
  },
  onChatStream: (callback) => {
    electron.ipcRenderer.on("chat:stream", (_, data) => callback(data));
    return () => electron.ipcRenderer.removeListener("chat:stream", callback);
  },
  onChatEnd: (callback) => {
    electron.ipcRenderer.on("chat:end", callback);
    return () => electron.ipcRenderer.removeListener("chat:end", callback);
  },
  onChatError: (callback) => {
    electron.ipcRenderer.on("chat:error", (_, data) => callback(data));
    return () => electron.ipcRenderer.removeListener("chat:error", callback);
  },
  onChatTool: (callback) => {
    electron.ipcRenderer.on("chat:tool", (_, data) => callback(data));
    return () => electron.ipcRenderer.removeListener("chat:tool", callback);
  },
  onChatToolResult: (callback) => {
    electron.ipcRenderer.on("chat:toolResult", (_, data) => callback(data));
    return () => electron.ipcRenderer.removeListener("chat:toolResult", callback);
  },
  onModeChanged: (callback) => {
    electron.ipcRenderer.on("chat:modeChanged", (_, data) => callback(data));
    return () => electron.ipcRenderer.removeListener("chat:modeChanged", callback);
  }
};
if (process.contextIsolated) {
  try {
    electron.contextBridge.exposeInMainWorld("electron", preload.electronAPI);
    electron.contextBridge.exposeInMainWorld("api", api);
  } catch (error) {
    console.error(error);
  }
} else {
  window.electron = preload.electronAPI;
  window.api = api;
}
