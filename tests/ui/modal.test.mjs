// 실제 Chrome(Puppeteer)에서 content script 의 버튼 삽입과 예약 모달을 검증한다.
//
//   npm run test:ui

import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { launch, openPage, openModal, modalEval, clickInModal, messages, ARTIFACTS, FIXTURE_BASE } from './helpers.mjs';

let browser;

before(async () => {
  mkdirSync(ARTIFACTS, { recursive: true });
  browser = await launch();
});
after(async () => {
  await browser?.close();
});

/** 모달 안 요소의 값/텍스트를 읽는다 */
async function val(page, id) {
  return modalEval(page, (root, elId) => {
    const el = root.getElementById(elId);
    if (!el) return null;
    return 'value' in el && el.tagName !== 'DIV' ? el.value : el.textContent;
  }, id);
}

async function hidden(page, id) {
  return modalEval(page, (root, elId) => !!root.getElementById(elId)?.hidden, id);
}

async function chips(page) {
  return modalEval(page, (root) => [...root.querySelectorAll('.chip')].map((c) => ({
    text: c.textContent, warn: c.classList.contains('warn'),
  })));
}

// ───────────────────────── 버튼 삽입 ─────────────────────────

test('편집기가 있는 저장 버튼 옆에만 예약 버튼이 붙는다', async () => {
  const page = await openPage(browser);
  const state = await page.evaluate(() => {
    const next = (id) => document.getElementById(id)?.nextElementSibling;
    const isBtn = (el) => !!el && el.classList.contains('dtr-reserve-btn');
    return {
      comment: isBtn(next('comment-save')),
      body: isBtn(next('body-save')),
      unrelated: isBtn(next('unrelated-save')),
      total: document.querySelectorAll('.dtr-reserve-btn').length,
    };
  });
  assert.equal(state.comment, true, '댓글 작성 버튼 옆에 붙어야 한다');
  assert.equal(state.body, true, '본문 저장 버튼 옆에도 붙어야 한다');
  assert.equal(state.unrelated, false, '편집기가 없으면 붙으면 안 된다');
  assert.equal(state.total, 2);
  await page.close();
});

test('DOM 이 다시 그려져도 예약 버튼이 중복 삽입되지 않는다', async () => {
  const page = await openPage(browser);
  await page.evaluate(() => {
    // SPA 재렌더링 흉내 — 무관한 노드를 여러 번 추가해 MutationObserver 를 깨운다
    for (let i = 0; i < 5; i += 1) document.body.appendChild(document.createElement('span'));
  });
  await new Promise((r) => setTimeout(r, 900));
  const count = await page.evaluate(() => document.querySelectorAll('.dtr-reserve-btn').length);
  assert.equal(count, 2);
  await page.close();
});

test('예약 버튼 클릭이 원래 저장 동작을 발생시키지 않는다', async () => {
  const page = await openPage(browser);
  await page.evaluate(() => {
    window.__saved = false;
    document.getElementById('comment-save').addEventListener('click', () => { window.__saved = true; });
  });
  await openModal(page);
  assert.equal(await page.evaluate(() => window.__saved), false, '실제 저장이 일어나면 안 된다');
  await page.close();
});

// ───────────────────────── 캡처 정확도 ─────────────────────────

test('에디터 내용이 Dooray 마크다운으로 캡처되어 편집 가능한 칸에 채워진다', async () => {
  const page = await openPage(browser, {
    editorHtml:
      '<p><b>굵게</b> 그리고 <a href="https://www.dooray.com">링크</a></p>' +
      '<pre><code class="language-python">x = 1\ny = 2</code></pre>' +
      '<table><thead><tr><th>a</th><th>b</th></tr></thead><tbody><tr><td>1</td><td>2</td></tr></tbody></table>',
  });
  await openModal(page);
  const content = await val(page, 'content');
  assert.equal(
    content,
    '**굵게** 그리고 [링크](https://www.dooray.com)\n\n' +
    '```python\nx = 1\ny = 2\n```\n\n' +
    '| a | b |\n| --- | --- |\n| 1 | 2 |',
  );
  await page.close();
});

test('버튼과 가까운 에디터를 고른다 (본문 저장 vs 댓글 작성)', async () => {
  const page = await openPage(browser, { editorHtml: '<p>댓글 내용</p>' });
  await openModal(page, '#body-save');
  assert.equal(await val(page, 'content'), '업무 본문입니다.');
  await page.close();
});

test('빈 에디터에서는 안내 문구가 나온다', async () => {
  const page = await openPage(browser);
  await openModal(page);
  assert.match(await val(page, 'capture-note'), /캡처하지 못했습니다/);
  await page.close();
});

test('사용자가 캡처된 내용을 직접 고칠 수 있다', async () => {
  const page = await openPage(browser, { editorHtml: '<p>원본</p>' });
  await openModal(page);
  await modalEval(page, (root) => {
    const ta = root.getElementById('content');
    ta.value = '직접 고친 내용';
    ta.dispatchEvent(new Event('input'));
  });
  await clickInModal(page, 'save');
  await page.waitForFunction(() => window.__dtrMessages.some((m) => m.type === 'saveReservation'));
  const msg = (await messages(page)).find((m) => m.type === 'saveReservation');
  assert.equal(msg.params.content, '직접 고친 내용');
  await page.close();
});

// ───────────────────────── 이미지 · 멘션 ─────────────────────────

test('인라인 이미지가 cid 로 치환되고 첨부 후보로 잡힌다', async () => {
  const page = await openPage(browser, {
    editorHtml: '<p>그래프</p><p><img src="blob:mock-image-1" alt="chart.png"></p>',
  });
  await openModal(page);
  const content = await val(page, 'content');
  assert.match(content, /!\[chart\.png\]\(cid:dtr-[0-9a-f-]+\)/, content);
  const c = await chips(page);
  assert.ok(c.some((x) => x.text.includes('인라인 이미지 1장')), JSON.stringify(c));
  await page.close();
});

test('멘션이 해석되면 마크업으로 치환되고 확인 칩이 뜬다', async () => {
  const page = await openPage(browser, {
    editorHtml: '<p><a href="">@권효윤</a> 확인 부탁드립니다.</p>',
  });
  await openModal(page);
  assert.equal(
    await val(page, 'content'),
    '[@권효윤](dooray://4257700934375023467/members/4291687299319957161 "member") 확인 부탁드립니다.',
  );
  const c = await chips(page);
  assert.ok(c.some((x) => x.text === '@권효윤 ✓' && !x.warn), JSON.stringify(c));
  await page.close();
});

test('동명이인이면 경고 칩으로 알린다', async () => {
  const page = await openPage(browser, {
    editorHtml: '<p><a href="">@김민수</a></p>',
    overrides: {
      mentionCandidates: {
        김민수: [{ id: '1', name: '김민수', userCode: 'a' }, { id: '2', name: '김민수', userCode: 'b' }],
      },
    },
  });
  await openModal(page);
  const c = await chips(page);
  assert.ok(c.some((x) => x.warn && x.text.includes('동명이인')), JSON.stringify(c));
  await page.close();
});

test('멤버를 못 찾으면 평문으로 남기고 경고한다', async () => {
  const page = await openPage(browser, {
    editorHtml: '<p><a href="">@없는사람</a> 확인</p>',
    overrides: { mentionCandidates: { 없는사람: [] } },
  });
  await openModal(page);
  assert.equal(await val(page, 'content'), '@없는사람 확인');
  const c = await chips(page);
  assert.ok(c.some((x) => x.warn && x.text.includes('멤버 확인 실패')), JSON.stringify(c));
  await page.close();
});

// ───────────────────────── 대상 업무 · 작업 유형 ─────────────────────────

test('URL 에서 업무를 자동 감지하면 댓글 작성이 기본값이 된다', async () => {
  const page = await openPage(browser, { editorHtml: '<p>x</p>' });
  await openModal(page);
  assert.equal(await val(page, 'action'), 'comment-create');
  assert.match(await val(page, 'target'), /#42 예약 기능 검증용 업무/);
  assert.equal(await hidden(page, 'manual-wrap'), true);
  await page.close();
});

test('업무 감지에 실패하면 수동 입력칸이 뜨고 새 업무 생성이 기본값이 된다', async () => {
  // URL 에 업무 ID 가 없는 화면 (업무 목록 등)
  const page = await openPage(browser, { editorHtml: '<p>x</p>', url: FIXTURE_BASE });
  await openModal(page);
  assert.equal(await val(page, 'action'), 'task-create');
  assert.equal(await hidden(page, 'create-wrap'), false, '프로젝트 선택이 보여야 한다');
  await page.close();
});

test('새 업무 생성으로 바꾸면 프로젝트 목록을 불러온다', async () => {
  const page = await openPage(browser, { editorHtml: '<p>x</p>' });
  await openModal(page);
  await modalEval(page, (root) => {
    const s = root.getElementById('action');
    s.value = 'task-create';
    s.dispatchEvent(new Event('change'));
  });
  await page.waitForFunction(() => {
    const host = [...document.body.children].find((el) => el.shadowRoot);
    return host.shadowRoot.getElementById('project').options.length > 1;
  });
  const opts = await modalEval(page, (root) =>
    [...root.getElementById('project').options].map((o) => o.textContent));
  assert.deepEqual(opts, ['프로젝트 선택', '차주형-공부기록', '2026-중요업무']);
  await page.close();
});

// ───────────────────────── 예약 시각 ─────────────────────────

test('기본 예약 시각은 10분 뒤이고 프리셋이 동작한다', async () => {
  const page = await openPage(browser, { editorHtml: '<p>x</p>' });
  await openModal(page);
  const initial = new Date(await val(page, 'when')).getTime();
  const delta = initial - Date.now();
  assert.ok(delta > 8 * 60_000 && delta < 12 * 60_000, `기본값이 10분 뒤가 아님: ${delta}ms`);

  await modalEval(page, (root) => {
    [...root.querySelectorAll('.presets button')].find((b) => b.dataset.min === '60').click();
  });
  const after = new Date(await val(page, 'when')).getTime();
  assert.ok(after - Date.now() > 58 * 60_000, '1시간 후 프리셋이 반영되어야 한다');
  await page.close();
});

test('지난 시각을 넣으면 즉시 실행된다고 경고한다', async () => {
  const page = await openPage(browser, { editorHtml: '<p>x</p>' });
  await openModal(page);
  await modalEval(page, (root) => {
    const w = root.getElementById('when');
    w.value = '2020-01-01T09:00';
    w.dispatchEvent(new Event('change'));
  });
  assert.match(await val(page, 'status'), /즉시 실행/);
  await page.close();
});

// ───────────────────────── 등록 ─────────────────────────

test('예약 등록이 올바른 파라미터로 전송된다', async () => {
  const page = await openPage(browser, {
    editorHtml: '<p>보고드립니다.</p><p><img src="blob:mock-image-1" alt="a.png"></p>',
  });
  await openModal(page);
  await clickInModal(page, 'save');
  await page.waitForFunction(() => window.__dtrMessages.some((m) => m.type === 'saveReservation'));

  const msg = (await messages(page)).find((m) => m.type === 'saveReservation');
  assert.equal(msg.action, 'comment-create');
  assert.equal(msg.params.mimeType, 'text/x-markdown');
  assert.equal(msg.params.projectId, '4274783225974692162');
  assert.equal(msg.params.postId, '4396252369406084111');
  assert.equal(msg.params.files.length, 1);
  assert.equal(msg.params.files[0].name, 'a.png');
  assert.ok(msg.params.files[0].cid, 'cid 가 있어야 본문 자리표시자와 연결된다');
  assert.ok(msg.params.content.includes(`cid:${msg.params.files[0].cid}`));
  assert.equal(msg.summary, '#42 예약 기능 검증용 업무');
  await page.close();
});

test('등록에 성공하면 모달이 닫히고 토스트가 뜬다', async () => {
  const page = await openPage(browser, { editorHtml: '<p>x</p>' });
  await openModal(page);
  await clickInModal(page, 'save');
  await page.waitForFunction(() => ![...document.body.children].some((el) => el.shadowRoot));
  const toast = await page.evaluate(() =>
    [...document.body.children].map((e) => e.textContent).find((t) => t.includes('예약이 등록되었습니다')));
  assert.ok(toast, '완료 토스트가 보여야 한다');
  await page.close();
});

test('내용도 첨부도 없으면 등록을 막는다', async () => {
  const page = await openPage(browser);
  await openModal(page);
  await clickInModal(page, 'save');
  assert.match(await val(page, 'status'), /보낼 내용이 없습니다/);
  const sent = (await messages(page)).filter((m) => m.type === 'saveReservation');
  assert.equal(sent.length, 0);
  await page.close();
});

test('백그라운드 오류는 모달에 표시되고 다시 시도할 수 있다', async () => {
  const page = await openPage(browser, {
    editorHtml: '<p>x</p>', overrides: { saveReservation: 'fail' },
  });
  await openModal(page);
  await clickInModal(page, 'save');
  await page.waitForFunction(() => {
    const host = [...document.body.children].find((el) => el.shadowRoot);
    return host?.shadowRoot?.getElementById('status')?.textContent.includes('실패');
  });
  assert.match(await val(page, 'status'), /예약 등록 실패/);
  const disabled = await modalEval(page, (root) => root.getElementById('save').disabled);
  assert.equal(disabled, false, '실패 후 다시 누를 수 있어야 한다');
  await page.close();
});

// ───────────────────────── 모달 UX ─────────────────────────

test('Esc 키로 모달이 닫힌다', async () => {
  const page = await openPage(browser, { editorHtml: '<p>x</p>' });
  await openModal(page);
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => ![...document.body.children].some((el) => el.shadowRoot));
  await page.close();
});

test('배경 클릭으로 닫히고, 패널 내부 클릭으로는 닫히지 않는다', async () => {
  const page = await openPage(browser, { editorHtml: '<p>x</p>' });
  await openModal(page);
  await clickInModal(page, 'content');
  assert.ok(await page.evaluate(() => [...document.body.children].some((el) => el.shadowRoot)));
  await page.mouse.click(20, 20);
  await page.waitForFunction(() => ![...document.body.children].some((el) => el.shadowRoot));
  await page.close();
});

test('닫기(✕) 버튼이 동작한다', async () => {
  const page = await openPage(browser, { editorHtml: '<p>x</p>' });
  await openModal(page);
  await clickInModal(page, 'close');
  await page.waitForFunction(() => ![...document.body.children].some((el) => el.shadowRoot));
  await page.close();
});

test('모달이 대화상자로 표시되고 라벨이 입력칸과 연결되어 있다', async () => {
  const page = await openPage(browser, { editorHtml: '<p>x</p>' });
  await openModal(page);
  const a11y = await modalEval(page, (root) => {
    const overlay = root.querySelector('.overlay');
    const labels = [...root.querySelectorAll('label[for]')].map((l) => l.getAttribute('for'));
    const orphans = labels.filter((id) => !root.getElementById(id));
    return {
      role: overlay.getAttribute('role'),
      modal: overlay.getAttribute('aria-modal'),
      labelCount: labels.length,
      orphans,
    };
  });
  assert.equal(a11y.role, 'dialog');
  assert.equal(a11y.modal, 'true');
  assert.ok(a11y.labelCount >= 5);
  assert.deepEqual(a11y.orphans, [], '연결되지 않은 label 이 있으면 안 된다');
  await page.close();
});

test('모달이 화면 안에 들어오고 가로 스크롤이 생기지 않는다', async () => {
  const page = await openPage(browser, { editorHtml: '<p>x</p>' });
  await page.setViewport({ width: 380, height: 700, deviceScaleFactor: 2 });
  await openModal(page);
  const fits = await modalEval(page, (root) => {
    const p = root.querySelector('.panel').getBoundingClientRect();
    return { left: p.left, right: p.right, w: window.innerWidth, h: window.innerHeight, bottom: p.bottom };
  });
  assert.ok(fits.left >= 0 && fits.right <= fits.w, `가로로 넘침: ${JSON.stringify(fits)}`);
  assert.ok(fits.bottom <= fits.h + 1, `세로로 넘침: ${JSON.stringify(fits)}`);
  await page.close();
});

test('시각 확인용 스크린샷을 남긴다', async () => {
  const page = await openPage(browser, {
    editorHtml:
      '<p><a href="">@권효윤</a> 주간 결과 공유드립니다.</p>' +
      '<table><thead><tr><th>모델</th><th>정확도</th></tr></thead>' +
      '<tbody><tr><td>base</td><td>88.1%</td></tr></tbody></table>' +
      '<pre><code class="language-bash">python train.py --lr 1e-3</code></pre>' +
      '<p><img src="blob:mock-image-1" alt="curve.png"></p>',
  });
  await openModal(page);
  await page.screenshot({ path: path.join(ARTIFACTS, 'modal.png') });
  await page.close();
});
