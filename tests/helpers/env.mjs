// .env 로더 + 라이브 테스트 공용 픽스처

import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

export function loadEnv() {
  const file = path.join(ROOT, '.env');
  if (!existsSync(file)) return {};
  const out = {};
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i);
    if (m) out[m[1]] = m[2].trim();
  }
  return out;
}

const env = loadEnv();

export const API_KEY = env.TEST_KEY_CODE || process.env.TEST_KEY_CODE || '';
export const DOORAY_DOMAIN = env.SERVER_DOMAIN || process.env.SERVER_DOMAIN || 'sota.dooray.com';
export const HAS_CREDS = Boolean(API_KEY);

// deriveApiBase 와 동일한 규칙 (테스트 하네스용 독립 구현)
export const API_BASE = /\.dooray\.com$/.test(DOORAY_DOMAIN)
  ? 'https://api.dooray.com'
  : `https://${DOORAY_DOMAIN}`;

export const SETTINGS = { doorayUrl: `https://${DOORAY_DOMAIN}`, apiBase: API_BASE, apiKey: API_KEY };

/** 원시 API 호출 (검증용 — 프로덕션 코드와 독립) */
export async function raw(method, urlPath, body) {
  const res = await fetch(API_BASE + urlPath, {
    method,
    headers: {
      Authorization: `dooray-api ${API_KEY}`,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    /* non-JSON */
  }
  return { status: res.status, ok: res.ok, json, text };
}

// ── 픽스처 ──

/** 1x1 빨간 PNG (base64) */
export const PNG_1PX_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

/** 8x8 파란 PNG — 인라인 이미지 구분용 */
export const PNG_8PX_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAYAAADED76LAAAAHElEQVR42mNkYPhfz0AEYBxVSF+FjKN' +
  'BQ1+FAP5FCgGdEeEVAAAAAElFTkSuQmCC';

export function pngFile(name = 'test-image.png', b64 = PNG_1PX_B64, extra = {}) {
  return { name, type: 'image/png', dataBase64: b64, ...extra };
}

export function textFile(name = 'notes.txt', body = 'Dooray 예약 테스트 첨부 파일\n두 번째 줄') {
  return { name, type: 'text/plain', dataBase64: Buffer.from(body, 'utf8').toString('base64') };
}
