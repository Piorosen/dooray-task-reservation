// background.js(서비스 워커 스크립트)를 Node 에서 그대로 실행해 내부 함수를 꺼내오는 로더.
// 프로덕션 코드를 수정하지 않고 실제 코드 경로를 테스트하기 위해 vm 컨텍스트에
// chrome API 스텁을 심어 실행한다.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

export function makeChromeStub(initialStorage = {}) {
  const store = { ...initialStorage };
  const alarms = new Map();
  const notifications = [];
  const listeners = { alarm: [], startup: [], installed: [], message: [] };

  return {
    store,
    alarms,
    notifications,
    listeners,
    chrome: {
      storage: {
        local: {
          async get(key) {
            if (key == null) return { ...store };
            if (typeof key === 'string') return { [key]: store[key] };
            const out = {};
            for (const k of Array.isArray(key) ? key : Object.keys(key)) out[k] = store[k];
            return out;
          },
          async set(obj) {
            Object.assign(store, obj);
          },
        },
        onChanged: { addListener() {} },
      },
      alarms: {
        async create(name, info) {
          alarms.set(name, info);
        },
        async clear(name) {
          return alarms.delete(name);
        },
        onAlarm: { addListener: (fn) => listeners.alarm.push(fn) },
      },
      notifications: {
        create(opts) {
          notifications.push(opts);
        },
      },
      runtime: {
        getURL: (p) => `chrome-extension://test/${p}`,
        onMessage: { addListener: (fn) => listeners.message.push(fn) },
        onStartup: { addListener: (fn) => listeners.startup.push(fn) },
        onInstalled: { addListener: (fn) => listeners.installed.push(fn) },
      },
    },
  };
}

/**
 * background.js 를 vm 컨텍스트에서 실행하고, 최상위 function 선언을 그대로 반환한다.
 * @param {object} opts.settings  chrome.storage.local 에 미리 넣어둘 settings
 * @param {Function} opts.fetch   주입할 fetch (미지정 시 전역 fetch = 실제 네트워크)
 */
export function loadBackground({ settings = null, fetch: fetchImpl = globalThis.fetch } = {}) {
  const stub = makeChromeStub(settings ? { settings } : {});
  const sandbox = {
    chrome: stub.chrome,
    fetch: fetchImpl,
    console,
    crypto: globalThis.crypto,
    atob: globalThis.atob,
    btoa: globalThis.btoa,
    Blob: globalThis.Blob,
    FormData: globalThis.FormData,
    URL: globalThis.URL,
    TextEncoder: globalThis.TextEncoder,
    Uint8Array: globalThis.Uint8Array,
    setTimeout: globalThis.setTimeout,
    clearTimeout: globalThis.clearTimeout,
    Date: globalThis.Date,
    Promise: globalThis.Promise,
    Error: globalThis.Error,
    JSON: globalThis.JSON,
    Object: globalThis.Object,
    Number: globalThis.Number,
    String: globalThis.String,
    Array: globalThis.Array,
    Math: globalThis.Math,
  };
  sandbox.globalThis = sandbox;
  const context = vm.createContext(sandbox);
  const src = readFileSync(path.join(ROOT, 'background.js'), 'utf8');
  vm.runInContext(src, context, { filename: 'background.js' });
  return { ...stub, ctx: context, fn: context };
}
