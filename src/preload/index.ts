import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import type { InbetweenApi } from '../shared/api'

function on<T extends unknown[]>(channel: string, fn: (...args: T) => void): () => void {
  const handler = (_e: IpcRendererEvent, ...args: unknown[]): void => fn(...(args as T))
  ipcRenderer.on(channel, handler)
  return () => ipcRenderer.removeListener(channel, handler)
}

const api: InbetweenApi & { onToast(fn: (t: { message: string; kind: string }) => void): () => void; ready(): void } = {
  platform: process.platform,
  getDoc: () => ipcRenderer.invoke('doc:get'),
  onDoc: (fn) => on('doc', fn),
  command: (cmd) => ipcRenderer.invoke('cmd', cmd),
  file: (action) => ipcRenderer.invoke('file', action),
  readFile: (path) => ipcRenderer.invoke('file:read', path),
  getSettings: () => ipcRenderer.invoke('settings:get'),
  setSettings: (patch) => ipcRenderer.invoke('settings:set', patch),
  onSettings: (fn) => on('settings', fn),
  setApiKey: (key) => ipcRenderer.invoke('key:set', key),
  openModelsFile: () => ipcRenderer.invoke('models:open'),
  copy: (text) => ipcRenderer.invoke('copy', text),
  installStudioPlugin: () => ipcRenderer.invoke('studio:install'),
  reveal: (path) => ipcRenderer.invoke('reveal', path),
  agentSend: (text, view, worker) => ipcRenderer.invoke('agent:send', text, view, worker),
  agentStop: (worker) => ipcRenderer.invoke('agent:stop', worker),
  agentReset: () => ipcRenderer.invoke('agent:reset'),
  agentRetry: (worker) => ipcRenderer.invoke('agent:retry', worker),
  onAgent: (fn) => on('agent:event', fn),
  onTool: (fn) => on('tool:event', fn),
  exportClip: (args) => ipcRenderer.invoke('export:run', args),
  onExportProgress: (fn) => on('export:progress', fn),
  cancelExport: () => ipcRenderer.invoke('export:cancel'),
  onRenderRequest: (fn) => on('render:request', fn),
  renderResponse: (id, result) => ipcRenderer.send('render:response', id, result),
  onMenu: (fn) => on('menu', fn),
  setViewContext: (view) => ipcRenderer.send('view', view),
  onToast: (fn) => on('toast', fn),
  ready: () => ipcRenderer.send('renderer:ready')
}

contextBridge.exposeInMainWorld('inbetween', api)
