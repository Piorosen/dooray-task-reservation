// 팝업 UI(popup.html + popup.js) 를 실제 Chrome 에서 구동해 검증한다.
// chrome.runtime / chrome.storage 는 스텁으로 대체한다.

import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import { launch, ARTIFACTS } from './helpers.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const POPUP = pathToFileURL(path.join(ROOT, 'popup/popup.html')).href;

let browser;
before(async () => {
  mkdirSync(ARTIFACTS, { recursive: true });
  browser = await launch();
});
after(async () => { await browser?.close(); });

const ME = { id: '4257708009915581841', name: '차주형', defaultOrganization: { id: 'ORG' } };

function stub(overrides = {}) {
  return `
    window.__msgs = [];
    const O = ${JSON.stringify(overrides)};
    window.chrome = {
      runtime: {
        lastError: null,
        sendMessage(msg, cb) {
          window.__msgs.push(msg);
          const ok = (data) => setTimeout(() => cb({ ok: true, data }), 0);
          const no = (e) => setTimeout(() => cb({ ok: false, error: e }), 0);
          if (O[msg.type] === 'fail') return no('스텁 강제 실패');
          switch (msg.type) {
            case 'getSettings':
              return ok(O.noSettings ? null
                : { doorayUrl: 'https://sota.dooray.com', apiBase: 'https://api.dooray.com', apiKey: 'KEY' });
            case 'listProjects':
              return ok([{ id: 'P1', code: '차주형-공부기록' }, { id: 'P2', code: '2026-중요업무' }]);
            case 'listPosts':
              return ok([{ id: 'T1', number: 42, subject: '검증용 업무', closed: false }]);
            case 'listComments':
              return ok([{ id: 'L1', creator: '차주형', snippet: '기존 댓글', createdAt: '' }]);
            case 'searchMembers':
              return ok({ orgId: 'ORG', members: O.members
                || [{ id: '4291687299319957161', name: '권효윤', userCode: 'hyoyun' }] });
            case 'saveReservation':
              return ok({ id: 'R1', status: 'pending' });
            case 'getReservations':
              return ok(O.reservations || []);
            case 'testConnection':
              return ok({ id: '${ME.id}', name: '차주형' });
            case 'saveSettings':
              return ok({ doorayUrl: 'https://sota.dooray.com', apiBase: 'https://api.dooray.com', apiKey: 'K' });
            default: return ok(null);
          }
        },
      },
      storage: { onChanged: { addListener() {} } },
      permissions: { request: async () => true },
    };
  `;
}

async function openPopup(overrides = {}) {
  const page = await browser.newPage();
  await page.setViewport({ width: 420, height: 780, deviceScaleFactor: 2 });
  page.on('pageerror', (e) => console.error('[popup error]', e.message));
  await page.evaluateOnNewDocument(stub(overrides));
  await page.goto(POPUP, { waitUntil: 'networkidle0' });
  await page.waitForFunction(() => window.__msgs?.length > 0);
  return page;
}

const value = (page, id) => page.evaluate((i) => {
  const el = document.getElementById(i);
  return el.tagName === 'SELECT' || 'value' in el ? el.value : el.textContent;
}, id);
const text = (page, id) => page.evaluate((i) => document.getElementById(i).textContent, id);
const isHidden = (page, id) => page.evaluate((i) => document.getElementById(i).hidden, id);
const setSelect = (page, id, v) => page.evaluate((i, val) => {
  const s = document.getElementById(i);
  s.value = val;
  s.dispatchEvent(new Event('change'));
}, id, v);

// ───────────────────────── 초기화 ─────────────────────────

test('설정이 있으면 새 예약 탭에서 시작하고 프로젝트를 불러온다', async () => {
  const page = await openPopup();
  await page.waitForFunction(() => document.getElementById('project').options.length > 2);
  assert.equal(await isHidden(page, 'tab-new'), false);
  const opts = await page.evaluate(() =>
    [...document.getElementById('project').options].map((o) => o.textContent));
  assert.deepEqual(opts, ['프로젝트 선택', '차주형-공부기록', '2026-중요업무', 'ID 직접 입력…']);
  await page.close();
});

test('설정이 없으면 설정 탭으로 안내한다', async () => {
  const page = await openPopup({ noSettings: true });
  await page.waitForFunction(() => !document.getElementById('tab-settings').hidden);
  assert.equal(await isHidden(page, 'tab-new'), true);
  assert.match(await text(page, 'settings-status'), /API Key/);
  assert.equal(await value(page, 'dooray-url'), 'https://sota.dooray.com');
  await page.close();
});

test('예약 시각 기본값은 10분 뒤다', async () => {
  const page = await openPopup();
  const t = new Date(await value(page, 'scheduled-at')).getTime();
  const d = t - Date.now();
  assert.ok(d > 8 * 60_000 && d < 12 * 60_000, `기본값이 10분 뒤가 아님: ${d}`);
  await page.close();
});

// ───────────────────────── 작업 유형별 필드 ─────────────────────────

test('작업 유형에 따라 필요한 입력칸만 보인다', async () => {
  const page = await openPopup();
  const shown = async () => ({
    post: !(await isHidden(page, 'f-post')),
    comment: !(await isHidden(page, 'f-comment')),
    subject: !(await isHidden(page, 'f-subject')),
    content: !(await isHidden(page, 'f-content')),
    files: !(await isHidden(page, 'f-files')),
    assign: !(await isHidden(page, 'f-assignme')),
    warn: !(await isHidden(page, 'delete-warning')),
  });

  assert.deepEqual(await shown(), {
    post: false, comment: false, subject: true, content: true, files: true, assign: true, warn: false,
  }, '업무 생성');

  await setSelect(page, 'action', 'comment-create');
  assert.deepEqual(await shown(), {
    post: true, comment: false, subject: false, content: true, files: true, assign: false, warn: false,
  }, '댓글 작성');

  await setSelect(page, 'action', 'comment-update');
  assert.deepEqual(await shown(), {
    post: true, comment: true, subject: false, content: true, files: true, assign: false, warn: false,
  }, '댓글 수정');

  await setSelect(page, 'action', 'comment-delete');
  assert.deepEqual(await shown(), {
    post: true, comment: true, subject: false, content: false, files: false, assign: false, warn: true,
  }, '댓글 삭제');
  await page.close();
});

test('업무 삭제는 API 미지원 경고를 보여준다', async () => {
  const page = await openPopup();
  await setSelect(page, 'action', 'task-delete');
  assert.match(await text(page, 'delete-warning'), /지원되지 않는/);
  await page.close();
});

test('댓글 작성으로 바꾸면 업무 목록을 자동으로 불러온다', async () => {
  const page = await openPopup();
  await page.waitForFunction(() => document.getElementById('project').options.length > 2);
  await setSelect(page, 'project', 'P1');
  await setSelect(page, 'action', 'comment-create');
  await page.waitForFunction(() => document.getElementById('post').options.length > 2);
  const opts = await page.evaluate(() =>
    [...document.getElementById('post').options].map((o) => o.textContent));
  assert.ok(opts.includes('#42 검증용 업무'), JSON.stringify(opts));
  await page.close();
});

test('ID 직접 입력을 고르면 입력칸이 나타난다', async () => {
  const page = await openPopup();
  await page.waitForFunction(() => document.getElementById('project').options.length > 2);
  assert.equal(await isHidden(page, 'project-manual'), true);
  await setSelect(page, 'project', '__manual__');
  assert.equal(await isHidden(page, 'project-manual'), false);
  await page.close();
});

// ───────────────────────── 멘션 ─────────────────────────

test('@추가로 Dooray 멘션 마크업이 본문에 삽입된다', async () => {
  const page = await openPopup();
  await setSelect(page, 'action', 'comment-create');
  await page.type('#content', '안녕하세요 ');
  await page.type('#mention-name', '권효윤');
  await page.click('#mention-add');
  await page.waitForFunction(() => document.getElementById('content').value.includes('dooray://'));
  assert.equal(
    await value(page, 'content'),
    '안녕하세요 [@권효윤](dooray://ORG/members/4291687299319957161 "member") ',
  );
  await page.close();
});

test('동명이인이면 선택 목록을 보여주고 고른 사람이 삽입된다', async () => {
  const page = await openPopup({
    members: [
      { id: '1', name: '김민수', userCode: 'a' },
      { id: '2', name: '김민수', userCode: 'b' },
    ],
  });
  await setSelect(page, 'action', 'comment-create');
  await page.type('#mention-name', '김민수');
  await page.click('#mention-add');
  await page.waitForFunction(() => !document.getElementById('mention-results').hidden);
  const opts = await page.evaluate(() =>
    [...document.getElementById('mention-results').options].map((o) => o.textContent));
  assert.deepEqual(opts, ['멘션할 멤버 선택…', '김민수 (a)', '김민수 (b)']);

  await page.evaluate(() => {
    const s = document.getElementById('mention-results');
    s.selectedIndex = 2;
    s.dispatchEvent(new Event('change'));
  });
  assert.equal(await value(page, 'content'), '[@김민수](dooray://ORG/members/2 "member") ');
  await page.close();
});

test('멤버를 못 찾으면 오류를 알린다', async () => {
  const page = await openPopup({ members: [] });
  await setSelect(page, 'action', 'comment-create');
  await page.type('#mention-name', '없는사람');
  await page.click('#mention-add');
  await page.waitForFunction(() => document.getElementById('new-status').textContent.includes('찾지'));
  assert.match(await text(page, 'new-status'), /'없는사람' 멤버를 찾지 못했습니다/);
  await page.close();
});

// ───────────────────────── 유효성 검사 ─────────────────────────

test('필수 입력이 빠지면 예약을 막는다', async () => {
  const page = await openPopup();
  await page.waitForFunction(() => document.getElementById('project').options.length > 2);

  await page.click('#submit');
  assert.match(await text(page, 'new-status'), /프로젝트를 선택/);

  await setSelect(page, 'project', 'P1');
  await page.click('#submit');
  assert.match(await text(page, 'new-status'), /업무 제목을 입력/);

  await setSelect(page, 'action', 'comment-create');
  await page.waitForFunction(() => document.getElementById('post').options.length > 2);
  await setSelect(page, 'post', 'T1');
  await page.click('#submit');
  assert.match(await text(page, 'new-status'), /댓글 내용 또는 첨부파일/);

  const sent = await page.evaluate(() => window.__msgs.filter((m) => m.type === 'saveReservation'));
  assert.equal(sent.length, 0);
  await page.close();
});

test('댓글 예약이 마크다운 본문으로 등록된다', async () => {
  const page = await openPopup();
  await page.waitForFunction(() => document.getElementById('project').options.length > 2);
  await setSelect(page, 'project', 'P1');
  await setSelect(page, 'action', 'comment-create');
  await page.waitForFunction(() => document.getElementById('post').options.length > 2);
  await setSelect(page, 'post', 'T1');
  await page.evaluate(() => {
    document.getElementById('content').value = '| a | b |\n| --- | --- |\n| 1 | 2 |';
  });
  await page.click('#submit');
  await page.waitForFunction(() => window.__msgs.some((m) => m.type === 'saveReservation'));

  const msg = await page.evaluate(() => window.__msgs.find((m) => m.type === 'saveReservation'));
  assert.equal(msg.action, 'comment-create');
  assert.equal(msg.params.projectId, 'P1');
  assert.equal(msg.params.postId, 'T1');
  assert.equal(msg.params.content, '| a | b |\n| --- | --- |\n| 1 | 2 |');
  assert.equal(msg.summary, '[차주형-공부기록] #42 검증용 업무');
  await page.close();
});

test('등록에 성공하면 목록 탭으로 넘어가고 입력칸이 비워진다', async () => {
  const page = await openPopup();
  await page.waitForFunction(() => document.getElementById('project').options.length > 2);
  await setSelect(page, 'project', 'P1');
  await page.evaluate(() => { document.getElementById('subject').value = '새 업무'; });
  await page.click('#submit');
  await page.waitForFunction(() => !document.getElementById('tab-list').hidden);
  assert.equal(await value(page, 'subject'), '');
  await page.close();
});

// ───────────────────────── 예약 목록 ─────────────────────────

test('예약 목록이 상태별로 표시되고 실패 사유가 보인다', async () => {
  const now = Date.now();
  const page = await openPopup({
    reservations: [
      { id: 'a', action: 'comment-create', status: 'pending', summary: '#42 대기 중', scheduledAt: now + 600000 },
      { id: 'b', action: 'comment-create', status: 'done', summary: '#42 완료됨', scheduledAt: now - 600000, executedAt: now - 590000 },
      { id: 'c', action: 'task-update', status: 'failed', summary: '#43 실패함', scheduledAt: now - 900000, executedAt: now - 890000, error: '권한이 없습니다' },
    ],
  });
  await page.evaluate(() => document.querySelector('.tab[data-tab="list"]').click());
  await page.waitForFunction(() => document.querySelectorAll('.resv').length === 3);

  const cards = await page.evaluate(() => [...document.querySelectorAll('.resv')].map((c) => ({
    badge: c.querySelector('.badge').textContent,
    action: c.querySelector('.resv-action').textContent,
    summary: c.querySelector('.resv-summary').textContent,
    error: c.querySelector('.resv-error')?.textContent || null,
    buttons: [...c.querySelectorAll('.resv-btns button')].map((b) => b.textContent),
  })));

  // 대기/실행 중이 먼저, 끝난 것은 최근 실행 순
  assert.equal(cards[0].badge, '대기', '대기 중 예약이 먼저 온다');
  assert.deepEqual(cards[0].buttons, ['지금 실행', '삭제']);
  assert.equal(cards[1].badge, '완료');
  assert.deepEqual(cards[1].buttons, ['삭제'], '완료된 예약은 실행 버튼이 없다');
  assert.equal(cards[2].badge, '실패');
  assert.equal(cards[2].error, '사유: 권한이 없습니다');
  assert.deepEqual(cards[2].buttons, ['재시도', '삭제']);
  await page.close();
});

test('예약이 없으면 안내 문구가 나온다', async () => {
  const page = await openPopup({ reservations: [] });
  await page.evaluate(() => document.querySelector('.tab[data-tab="list"]').click());
  await page.waitForFunction(() => document.querySelector('.empty'));
  assert.match(await page.evaluate(() => document.querySelector('.empty').textContent), /등록된 예약이 없습니다/);
  await page.close();
});

test('재시도 버튼이 runNow 를 호출한다', async () => {
  const page = await openPopup({
    reservations: [{ id: 'c', action: 'comment-create', status: 'failed', summary: 's', scheduledAt: Date.now(), error: 'e' }],
  });
  await page.evaluate(() => document.querySelector('.tab[data-tab="list"]').click());
  await page.waitForFunction(() => document.querySelector('.resv-btns button'));
  await page.evaluate(() => document.querySelector('.resv-btns button').click());
  await page.waitForFunction(() => window.__msgs.some((m) => m.type === 'runNow'));
  assert.equal(await page.evaluate(() => window.__msgs.find((m) => m.type === 'runNow').id), 'c');
  await page.close();
});

test('요약/오류 문구가 HTML 로 해석되지 않는다 (XSS 방지)', async () => {
  const page = await openPopup({
    reservations: [{
      id: 'x', action: 'comment-create', status: 'failed', scheduledAt: Date.now(),
      summary: '<img src=x onerror="window.__pwned=1">',
      error: '<script>window.__pwned=1</script>',
    }],
  });
  await page.evaluate(() => document.querySelector('.tab[data-tab="list"]').click());
  await page.waitForFunction(() => document.querySelector('.resv'));
  assert.equal(await page.evaluate(() => window.__pwned), undefined);
  assert.equal(
    await page.evaluate(() => document.querySelector('.resv-summary').textContent),
    '<img src=x onerror="window.__pwned=1">',
  );
  await page.close();
});

// ───────────────────────── 설정 ─────────────────────────

test('연결 테스트가 계정 이름을 보여준다', async () => {
  const page = await openPopup();
  await page.evaluate(() => document.querySelector('.tab[data-tab="settings"]').click());
  await page.click('#test-conn');
  await page.waitForFunction(() => document.getElementById('settings-status').textContent.includes('성공'));
  assert.match(await text(page, 'settings-status'), /연결 성공 — 차주형/);
  await page.close();
});

test('연결 실패 사유를 그대로 보여준다', async () => {
  const page = await openPopup({ testConnection: 'fail' });
  await page.evaluate(() => document.querySelector('.tab[data-tab="settings"]').click());
  await page.click('#test-conn');
  await page.waitForFunction(() => document.getElementById('settings-status').textContent.includes('실패'));
  assert.match(await text(page, 'settings-status'), /연결 실패/);
  await page.close();
});

test('API Key 는 화면에 노출되지 않는다', async () => {
  const page = await openPopup();
  assert.equal(await page.evaluate(() => document.getElementById('api-key').type), 'password');
  await page.close();
});

test('URL 이나 Key 가 비면 저장을 막는다', async () => {
  const page = await openPopup({ noSettings: true });
  await page.evaluate(() => { document.getElementById('dooray-url').value = ''; });
  await page.click('#save-settings');
  assert.match(await text(page, 'settings-status'), /Dooray URL을 입력/);
  await page.close();
});

// ───────────────────────── 레이아웃 ─────────────────────────

test('팝업이 가로로 넘치지 않는다', async () => {
  const page = await openPopup();
  const overflow = await page.evaluate(() =>
    document.documentElement.scrollWidth - document.documentElement.clientWidth);
  assert.ok(overflow <= 0, `가로 스크롤 발생: ${overflow}px`);
  await page.close();
});

test('모든 label 이 실제 입력칸과 연결되어 있다', async () => {
  const page = await openPopup();
  const orphans = await page.evaluate(() =>
    [...document.querySelectorAll('label[for]')]
      .map((l) => l.getAttribute('for'))
      .filter((id) => !document.getElementById(id)));
  assert.deepEqual(orphans, []);
  await page.close();
});

test('팝업 스크린샷을 남긴다', async () => {
  const page = await openPopup();
  await setSelect(page, 'action', 'comment-create');
  await page.evaluate(() => {
    document.getElementById('content').value =
      '[@권효윤](dooray://ORG/members/429 "member") 확인 부탁드립니다.\n\n' +
      '| 항목 | 값 |\n| --- | --- |\n| 정확도 | 91% |';
  });
  await page.screenshot({ path: path.join(ARTIFACTS, 'popup-new.png') });

  const page2 = await openPopup({
    reservations: [
      { id: 'a', action: 'comment-create', status: 'pending', summary: '[2026-SOTA-공통업무] #128 주간 보고', scheduledAt: Date.now() + 3600_000 },
      { id: 'b', action: 'comment-create', status: 'done', summary: '[차주형-공부기록] #42 실험 결과', scheduledAt: Date.now() - 600000, executedAt: Date.now() - 590000 },
      { id: 'c', action: 'task-update', status: 'failed', summary: '[2026-중요업무] #7 본문 갱신', scheduledAt: Date.now() - 900000, executedAt: Date.now() - 890000, error: '권한이 없습니다' },
    ],
  });
  await page2.evaluate(() => document.querySelector('.tab[data-tab="list"]').click());
  await page2.waitForFunction(() => document.querySelectorAll('.resv').length === 3);
  await page2.screenshot({ path: path.join(ARTIFACTS, 'popup-list.png') });
  await page.close();
  await page2.close();
});
