"use strict";
/* «Искатель» — мост между интерфейсом и основным процессом приложения (Electron) */
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("iskatelAPI", {
  // Базовые функции поиска и подсказок
  search: (params) => ipcRenderer.invoke("iskatel:search", params),
  suggest: (params) => ipcRenderer.invoke("iskatel:suggest", params),

  // Платформа и приложение
  platform: process.platform,
  arch: process.arch,
  app: true,
  getVersion: () => ipcRenderer.invoke("iskatel:get-version"),

  // Настройки
  getSettings: () => ipcRenderer.invoke("iskatel:get-settings"),
  saveSettings: (settings) => ipcRenderer.invoke("iskatel:save-settings", settings),

  // Проверка и установка обновлений через GitHub Releases
  checkForUpdates: () => ipcRenderer.invoke("iskatel:check-update"),
  downloadUpdate: (params) => ipcRenderer.invoke("iskatel:download-update", params),
  installUpdate: (params) => ipcRenderer.invoke("iskatel:install-update", params),
  onDownloadProgress: (callback) => {
    const handler = (_event, data) => callback(data);
    ipcRenderer.on("iskatel:download-progress", handler);
    return () => ipcRenderer.removeListener("iskatel:download-progress", handler);
  },
  openExternal: (url) => ipcRenderer.invoke("iskatel:open-external", url),
});
