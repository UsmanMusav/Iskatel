"use strict";
/* «Искатель» — мост между интерфейсом и основным процессом приложения (Electron) */
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("iskatelAPI", {
  // Базовые функции поиска и подсказок
  search: (params) => ipcRenderer.invoke("iskatel:search", params),
  suggest: (params) => ipcRenderer.invoke("iskatel:suggest", params),

  // ИИ-ассистент в стиле Google Assistant
  askAI: (params) => ipcRenderer.invoke("iskatel:ai-ask", params),
  testAIProvider: (params) => ipcRenderer.invoke("iskatel:ai-test-provider", params),
  askCopilot: (params) => ipcRenderer.invoke("iskatel:ai-copilot", params),
  onToggleCopilot: (callback) => {
    const handler = () => callback();
    ipcRenderer.on("iskatel:toggle-copilot", handler);
    return () => ipcRenderer.removeListener("iskatel:toggle-copilot", handler);
  },

  // Открытие вкладок внутри браузера
  onOpenTabUrl: (callback) => {
    const handler = (_event, url) => callback(url);
    ipcRenderer.on("iskatel:open-tab-url", handler);
    return () => ipcRenderer.removeListener("iskatel:open-tab-url", handler);
  },

  // Платформа и приложение
  platform: process.platform,
  arch: process.arch,
  app: true,
  getVersion: () => ipcRenderer.invoke("iskatel:get-version"),

  // Настройки
  getSettings: () => ipcRenderer.invoke("iskatel:get-settings"),
  saveSettings: (settings) => ipcRenderer.invoke("iskatel:save-settings", settings),

  // Система аккаунтов и регистрации (Gmail / Google) v2.5
  getCurrentUser: () => ipcRenderer.invoke("iskatel:auth-get-current-user"),
  loginUser: (params) => ipcRenderer.invoke("iskatel:auth-login", params),
  registerUser: (params) => ipcRenderer.invoke("iskatel:auth-register", params),
  googleLogin: (params) => ipcRenderer.invoke("iskatel:auth-google-login", params),
  logoutUser: () => ipcRenderer.invoke("iskatel:auth-logout"),
  getBookmarks: () => ipcRenderer.invoke("iskatel:auth-get-bookmarks"),
  addBookmark: (bookmark) => ipcRenderer.invoke("iskatel:auth-add-bookmark", bookmark),
  removeBookmark: (id) => ipcRenderer.invoke("iskatel:auth-remove-bookmark", id),

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

  openIncognito: () => ipcRenderer.invoke("iskatel:open-incognito"),
  checkUrl: (url) => ipcRenderer.invoke("iskatel:shield-check-url", url),
  shieldStatus: () => ipcRenderer.invoke("iskatel:shield-status"),
  allowUrlOnce: (url) => ipcRenderer.invoke("iskatel:shield-allow-once", url),
  replyPermission: (payload) => ipcRenderer.invoke("iskatel:permission-reply", payload),
  onNavigationBlocked: (callback) => {
    const handler = (_event, data) => callback(data);
    ipcRenderer.on("iskatel:navigation-blocked", handler);
    return () => ipcRenderer.removeListener("iskatel:navigation-blocked", handler);
  },
  onShieldStats: (callback) => {
    const handler = (_event, data) => callback(data);
    ipcRenderer.on("iskatel:shield-stats", handler);
    return () => ipcRenderer.removeListener("iskatel:shield-stats", handler);
  },
  onShieldEvent: (callback) => {
    const handler = (_event, data) => callback(data);
    ipcRenderer.on("iskatel:shield-event", handler);
    return () => ipcRenderer.removeListener("iskatel:shield-event", handler);
  },
  onPermissionRequest: (callback) => {
    const handler = (_event, data) => callback(data);
    ipcRenderer.on("iskatel:permission-request", handler);
    return () => ipcRenderer.removeListener("iskatel:permission-request", handler);
  },
});
