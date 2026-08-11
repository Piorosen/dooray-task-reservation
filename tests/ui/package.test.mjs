// 배포 패키지 검증 — scripts/build.mjs 로 만든 zip 을 실제 Chrome 에 설치해
// 서비스 워커 등록 · 팝업 렌더 · content script 주입까지 확인한다.
//
// "테스트는 통과하는데 스토어에 올린 zip 은 깨져 있는" 사고를 막는 마지막 관문이다.

import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const WORK = path.join(ROOT, 'test-artifacts', 'package-check');
const ZIP = path.join(WORK, 'extension.zip');
const UNPACKED = path.join(WORK, 'unpacked');

let browser;
let extensionId;
let manifest;
let listing;

before(async () => {
  fs.rmSync(WORK, { recursive: true, force: true });
  fs.mkdirSync(UNPACKED, { recursive: true });

  execFileSync('node', ['scripts/build.mjs', '--out', ZIP], { cwd: ROOT, stdio: 'pipe' });
  execFileSync('unzip', ['-q', ZIP, '-d', UNPACKED]);

  listing = execFileSync('unzip', ['-Z1', ZIP], { encoding: 'utf8' })
    .split('\n').map((s) => s.trim()).filter(Boolean).filter((s) => !s.endsWith('/'));
  manifest = JSON.parse(fs.readFileSync(path.join(UNPACKED, 'manifest.json'), 'utf8'));

  browser = await puppeteer.launch({
    headless: true,
    args: [
      `--disable-extensions-except=${UNPACKED}`,
      `--load-extension=${UNPACKED}`,
      '--no-sandbox',
      '--disable-dev-shm-usage',
    ],
  });
  const target = await browser.waitForTarget((t) => t.type() === 'service_worker', { timeout: 30000 });
  extensionId = target.url().split('/')[2];
});

after(async () => {
  await browser?.close();
});

// ───────────────────────── 패키지 내용물 ─────────────────────────

test('실행에 필요한 파일만 들어 있다', () => {
  assert.deepEqual(listing.sort(), [
    'background.js',
    'content.js',
    'editor-markdown.js',
    'icons/icon128.png',
    'icons/icon16.png',
    'icons/icon48.png',
    'manifest.json',
    'popup/popup.css',
    'popup/popup.html',
    'popup/popup.js',
  ]);
});

test('개발용 파일과 비밀 정보가 포함되지 않는다', () => {
  const banned = /(^|\/)(\.env|\.git|node_modules|tests?|dist|docs|scripts|package(-lock)?\.json|README\.md|\.DS_Store)(\/|$)/;
  const leaked = listing.filter((f) => banned.test(f));
  assert.deepEqual(leaked, [], `배포 패키지에 개발 파일이 들어갔습니다: ${leaked}`);
});

test('패키지 안에 API Key 같은 문자열이 없다', () => {
  for (const f of listing.filter((x) => /\.(js|html|css|json)$/.test(x))) {
    const src = fs.readFileSync(path.join(UNPACKED, f), 'utf8');
    assert.doesNotMatch(src, /TEST_KEY_CODE|dooray-api\s+[a-z0-9]{10,}:/i, `${f} 에 자격증명이 있습니다`);
  }
});

test('manifest 가 스토어 요구사항을 만족한다', () => {
  assert.equal(manifest.manifest_version, 3);
  assert.match(manifest.version, /^\d+\.\d+\.\d+$/);
  assert.ok(manifest.name && manifest.name.length <= 75);
  assert.ok(manifest.description && manifest.description.length <= 132,
    `description 은 132자 이하여야 합니다 (현재 ${manifest.description?.length})`);
  assert.deepEqual(Object.keys(manifest.icons).sort(), ['128', '16', '48']);
});

test('요청 권한이 최소한으로 유지된다', () => {
  assert.deepEqual(
    manifest.permissions.sort(),
    ['alarms', 'notifications', 'storage', 'unlimitedStorage'],
    '권한이 늘면 스토어 심사에서 사유 설명이 필요합니다',
  );
  for (const h of manifest.host_permissions) {
    assert.match(h, /^https:\/\/\*\.(gov-)?dooray\.(com|co\.kr)\/\*$/, `과도한 호스트 권한: ${h}`);
  }
});

test('패키지 크기가 스토어 제한(128MB) 안에 있다', () => {
  const mb = fs.statSync(ZIP).size / 1024 / 1024;
  assert.ok(mb < 128, `${mb.toFixed(1)}MB`);
});

// ───────────────────────── 실제 설치 동작 ─────────────────────────

test('서비스 워커가 등록되고 필요한 chrome API 를 쓸 수 있다', async () => {
  const target = await browser.waitForTarget((t) => t.type() === 'service_worker');
  const worker = await target.worker();
  const probe = await worker.evaluate(() => ({
    alarms: typeof chrome.alarms?.create,
    storage: typeof chrome.storage?.local?.get,
    notifications: typeof chrome.notifications?.create,
    handler: typeof handleMessage,
    mime: DEFAULT_MIME,
  }));
  assert.equal(probe.alarms, 'function');
  assert.equal(probe.storage, 'function');
  assert.equal(probe.notifications, 'function');
  assert.equal(probe.handler, 'function');
  assert.equal(probe.mime, 'text/x-markdown', 'Dooray 네이티브 형식이어야 한다');
});

test('팝업이 오류 없이 렌더된다', async () => {
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

  await page.goto(`chrome-extension://${extensionId}/popup/popup.html`, { waitUntil: 'networkidle0' });
  const ui = await page.evaluate(() => ({
    title: document.title,
    tabs: [...document.querySelectorAll('.tab')].map((t) => t.textContent),
    actions: [...document.querySelectorAll('#action option')].map((o) => o.value),
  }));

  assert.equal(ui.title, 'Dooray 예약');
  assert.deepEqual(ui.tabs, ['새 예약', '예약 목록', '설정']);
  assert.deepEqual(ui.actions, [
    'task-create', 'task-update', 'task-delete',
    'comment-create', 'comment-update', 'comment-delete',
  ]);
  assert.deepEqual(errors, []);
  await page.close();
});

test('Dooray 도메인에서 content script 가 순서대로 주입된다', async () => {
  const page = await browser.newPage();
  await page.setRequestInterception(true);
  page.on('request', (req) => {
    // 로그인 없이 매칭 규칙을 검증하기 위해 Dooray 도메인 응답을 가로챈다
    if (req.url().startsWith('https://sota.dooray.com/')) {
      return req.respond({
        status: 200,
        contentType: 'text/html; charset=utf-8',
        body: `<!doctype html><html><body>
          <div class="panel">
            <div contenteditable="true" id="ed"><p>안녕 <b>세상</b></p></div>
            <button id="save">댓글 작성</button>
          </div>
        </body></html>`,
      });
    }
    return req.abort();
  });

  await page.goto('https://sota.dooray.com/project/4257709183066132770/4396252369406084111', {
    waitUntil: 'domcontentloaded',
  });
  await page.waitForSelector('.dtr-reserve-btn', { timeout: 10000 });

  const injected = await page.evaluate(() => ({
    buttons: document.querySelectorAll('.dtr-reserve-btn').length,
    label: document.querySelector('.dtr-reserve-btn').textContent,
    // 페이지 세계에는 노출되지 않아야 한다 (격리 세계 확인)
    leakedMd: typeof window.DTR_MD,
    leakedHook: typeof window.__dtr,
  }));
  assert.equal(injected.buttons, 1, '저장 버튼 옆에 예약 버튼이 붙어야 한다');
  assert.equal(injected.label, '⏰ 예약');
  assert.equal(injected.leakedMd, 'undefined', 'content script 가 페이지 전역을 오염시키면 안 된다');
  assert.equal(injected.leakedHook, 'undefined');
  await page.close();
});

test('Dooray 가 아닌 사이트에는 주입되지 않는다', async () => {
  const page = await browser.newPage();
  await page.setRequestInterception(true);
  page.on('request', (req) => req.respond({
    status: 200, contentType: 'text/html',
    body: '<!doctype html><html><body><div><div contenteditable="true">x</div><button>저장</button></div></body></html>',
  }));
  await page.goto('https://example.com/');
  await new Promise((r) => setTimeout(r, 1200));
  assert.equal(await page.evaluate(() => document.querySelectorAll('.dtr-reserve-btn').length), 0);
  await page.close();
});
