// Puppeteer UI 테스트 공용 헬퍼
// 실제 Chrome 에서 editor-markdown.js + content.js 를 그대로 주입해 동작을 검증한다.
// chrome.runtime 은 스텁으로 대체하고 주고받은 메시지를 전부 기록한다.

import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import puppeteer from 'puppeteer';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
// 실제 Dooray 업무 URL 처럼 긴 숫자 ID 를 포함시켜 content script 의 자동 감지를 태운다
export const FIXTURE_BASE = pathToFileURL(path.join(ROOT, 'tests/ui/fixtures/dooray-task.html')).href;
export const FIXTURE = `${FIXTURE_BASE}#4396252369406084111`;
export const ARTIFACTS = path.join(ROOT, 'test-artifacts');

const RESOLVED_POST = {
  postId: '4396252369406084111',
  projectId: '4274783225974692162',
  number: 42,
  subject: '예약 기능 검증용 업무',
  projectCode: '차주형-공부기록',
};

/** 백그라운드 서비스 워커를 흉내내는 chrome API 스텁 */
function chromeStubSource(overrides) {
  return `
    window.__dtrMessages = [];
    const OVERRIDES = ${JSON.stringify(overrides)};
    const RESOLVED = ${JSON.stringify(RESOLVED_POST)};
    window.chrome = {
      runtime: {
        lastError: null,
        sendMessage(msg, cb) {
          window.__dtrMessages.push(msg);
          const reply = (data) => setTimeout(() => cb({ ok: true, data }), 0);
          const fail = (error) => setTimeout(() => cb({ ok: false, error }), 0);
          if (OVERRIDES[msg.type] === 'fail') return fail('스텁 강제 실패');
          switch (msg.type) {
            case 'resolvePost':
              return OVERRIDES.noPost ? fail('업무를 찾을 수 없습니다.') : reply(RESOLVED);
            case 'resolveMentions':
              return reply({
                orgId: '4257700934375023467',
                results: (msg.names || []).map((name) => ({
                  name,
                  candidates: (OVERRIDES.mentionCandidates || {})[name]
                    || [{ id: '4291687299319957161', name, userCode: 'x' }],
                })),
              });
            case 'listProjects':
              return reply([
                { id: '4274783225974692162', code: '차주형-공부기록' },
                { id: '4290936116136545512', code: '2026-중요업무' },
              ]);
            case 'saveReservation':
              return reply({ id: 'RESV1', status: 'pending' });
            default:
              return reply(null);
          }
        },
      },
    };
  `;
}

export async function launch() {
  return puppeteer.launch({
    headless: 'shell',
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--font-render-hinting=none'],
  });
}

/** 모사 페이지를 열고 확장 스크립트를 주입한다 */
export async function openPage(browser, { editorHtml = '', overrides = {}, url = FIXTURE } = {}) {
  const page = await browser.newPage();
  await page.setViewport({ width: 1100, height: 900, deviceScaleFactor: 2 });
  page.on('pageerror', (e) => console.error('[page error]', e.message));
  await page.evaluateOnNewDocument(chromeStubSource(overrides));
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  if (editorHtml) {
    await page.evaluate((html) => {
      document.getElementById('comment-editor').innerHTML = html;
    }, editorHtml);
  }
  // 이미지 다운로드는 실제 네트워크 대신 고정 응답으로 대체한다
  await page.evaluate(() => {
    const orig = window.fetch;
    window.fetch = async (u, o) => {
      if (typeof u === 'string' && (u.startsWith('blob:') || u.includes('mock-image'))) {
        return new Response(
          Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='), (c) => c.charCodeAt(0)),
          { status: 200, headers: { 'Content-Type': 'image/png' } },
        );
      }
      return orig(u, o);
    };
  });
  await page.addScriptTag({ content: readFileSync(path.join(ROOT, 'editor-markdown.js'), 'utf8') });
  await page.addScriptTag({ content: readFileSync(path.join(ROOT, 'content.js'), 'utf8') });
  await page.waitForFunction(() => !!window.__dtr);
  return page;
}

/** shadow DOM 안 요소를 다루기 위한 핸들 */
export async function modalHandle(page) {
  return page.evaluateHandle(() => {
    const host = [...document.body.children].find((el) => el.shadowRoot);
    return host?.shadowRoot || null;
  });
}

export async function modalEval(page, fn, ...args) {
  const root = await modalHandle(page);
  return page.evaluate((r, body, a) => {
    // eslint-disable-next-line no-new-func
    return new Function('root', '...args', `return (${body})(root, ...args)`)(r, ...a);
  }, root, fn.toString(), args);
}

/** shadow DOM 안의 요소를 클릭 (좌표 기반 — 실제 사용자 클릭과 동일) */
export async function clickInModal(page, id) {
  const root = await modalHandle(page);
  const box = await page.evaluate((r, elId) => {
    const el = r.getElementById(elId);
    if (!el) return null;
    const b = el.getBoundingClientRect();
    return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
  }, root, id);
  if (!box) throw new Error(`모달에 #${id} 가 없습니다`);
  await page.mouse.click(box.x, box.y);
}

export async function openModal(page, buttonSelector = '#comment-save') {
  await page.waitForFunction(
    (sel) => !!document.querySelector(sel)?.nextElementSibling?.classList.contains('dtr-reserve-btn'),
    {}, buttonSelector,
  );
  await page.evaluate((sel) => {
    document.querySelector(sel).nextElementSibling.click();
  }, buttonSelector);
  await page.waitForFunction(() => {
    const host = [...document.body.children].find((el) => el.shadowRoot);
    return !!host?.shadowRoot?.getElementById('save');
  });
  // 캡처(이미지/멘션 비동기 처리) 완료 대기
  await page.waitForFunction(() => {
    const host = [...document.body.children].find((el) => el.shadowRoot);
    return host?.shadowRoot?.getElementById('capture-note')?.textContent?.trim().length > 0;
  }, { timeout: 10000 });
}

export async function messages(page) {
  return page.evaluate(() => window.__dtrMessages);
}
