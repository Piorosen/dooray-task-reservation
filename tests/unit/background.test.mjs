// background.js 순수 로직 + 예약 실행 흐름 단위 테스트 (네트워크는 스텁)

import test from 'node:test';
import assert from 'node:assert/strict';
import { loadBackground } from '../helpers/load-background.mjs';

// vm 컨텍스트는 별도 realm 이라 객체의 프로토타입이 달라 deepStrictEqual 이 실패한다.
// 값만 비교하기 위해 평범한 객체로 되돌린다.
const plain = (v) => JSON.parse(JSON.stringify(v));

const SETTINGS = { doorayUrl: 'https://sota.dooray.com', apiBase: 'https://api.dooray.com', apiKey: 'K' };

/** 요청을 기록하고 미리 정한 응답을 돌려주는 fetch 스텁 */
function stubFetch(routes) {
  const calls = [];
  const fn = async (url, opts = {}) => {
    calls.push({ url, method: opts.method || 'GET', body: opts.body, headers: opts.headers });
    for (const [pattern, handler] of routes) {
      if (url.includes(pattern)) {
        const r = typeof handler === 'function' ? await handler(url, opts, calls) : handler;
        const payload = r.payload ?? { header: { isSuccessful: true, resultMessage: '' }, result: r.result };
        return new Response(JSON.stringify(payload), {
          status: r.status ?? 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
    }
    return new Response(JSON.stringify({ header: { isSuccessful: false, resultMessage: `no route: ${url}` } }), { status: 404 });
  };
  fn.calls = calls;
  return fn;
}

// ───────────────────────── deriveApiBase ─────────────────────────

test('deriveApiBase: SaaS 도메인은 전용 api 호스트로 매핑된다', () => {
  const { ctx } = loadBackground();
  assert.equal(ctx.deriveApiBase('https://sota.dooray.com'), 'https://api.dooray.com');
  assert.equal(ctx.deriveApiBase('https://x.gov-dooray.com'), 'https://api.gov-dooray.com');
  assert.equal(ctx.deriveApiBase('https://x.dooray.co.kr'), 'https://api.dooray.co.kr');
  assert.equal(ctx.deriveApiBase('https://x.gov-dooray.co.kr'), 'https://api.gov-dooray.co.kr');
});

test('deriveApiBase: 자체 설치형은 입력 origin 을 그대로 쓴다', () => {
  const { ctx } = loadBackground();
  assert.equal(ctx.deriveApiBase('https://dooray.mycorp.local/foo'), 'https://dooray.mycorp.local');
});

test('deriveApiBase: dooray.com 을 포함한 유사 도메인에 속지 않는다', () => {
  const { ctx } = loadBackground();
  assert.equal(ctx.deriveApiBase('https://evil-dooray.com.attacker.net'), 'https://evil-dooray.com.attacker.net');
});

// ───────────────────────── 파일 참조 마크업 ─────────────────────────

test('fileRef: 마크다운에서 이미지는 인라인, 그 외는 링크', () => {
  const { ctx } = loadBackground();
  const md = 'text/x-markdown';
  assert.equal(ctx.fileRef({ name: 'a.png', type: 'image/png' }, 'F1', md), '![a.png](/files/F1)');
  assert.equal(ctx.fileRef({ name: 'b.pdf', type: 'application/pdf' }, 'F2', md), '[b.pdf](/files/F2)');
});

test('fileRef: 확장자만으로도 이미지를 판별한다', () => {
  const { ctx } = loadBackground();
  assert.equal(ctx.fileRef({ name: 'c.WEBP', type: '' }, 'F3', 'text/x-markdown'), '![c.WEBP](/files/F3)');
});

test('appendRefs: 기존 본문과 참조 사이에 빈 줄을 넣는다', () => {
  const { ctx } = loadBackground();
  assert.equal(ctx.appendRefs('본문', '[a](/files/1)', 'text/x-markdown'), '본문\n\n[a](/files/1)');
  assert.equal(ctx.appendRefs('', '[a](/files/1)', 'text/x-markdown'), '[a](/files/1)');
  assert.equal(ctx.appendRefs('본문', '', 'text/x-markdown'), '본문');
});

// ───────────────────────── 재시도 ─────────────────────────

test('fetchWithRetry: 429 는 재시도한다', async () => {
  let n = 0;
  const { ctx } = loadBackground({
    settings: SETTINGS,
    fetch: async () => {
      n += 1;
      return new Response('{}', { status: n < 3 ? 429 : 200 });
    },
  });
  const res = await ctx.fetchWithRetry('https://x', {});
  assert.equal(res.status, 200);
  assert.equal(n, 3);
});

test('fetchWithRetry: 5xx 도 재시도한다 (예약 실행 중 일시 장애 대비)', async () => {
  let n = 0;
  const { ctx } = loadBackground({
    settings: SETTINGS,
    fetch: async () => {
      n += 1;
      return new Response('{}', { status: n < 2 ? 503 : 200 });
    },
  });
  const res = await ctx.fetchWithRetry('https://x', {});
  assert.equal(res.status, 200);
  assert.equal(n, 2);
});

test('fetchWithRetry: 네트워크 오류도 재시도하고 끝내 실패하면 던진다', async () => {
  let n = 0;
  const { ctx } = loadBackground({
    settings: SETTINGS,
    fetch: async () => {
      n += 1;
      throw new Error('ECONNRESET');
    },
  });
  await assert.rejects(() => ctx.fetchWithRetry('https://x', {}), /ECONNRESET/);
  assert.equal(n, 3);
});

test('fetchWithRetry: 4xx 는 재시도하지 않는다', async () => {
  let n = 0;
  const { ctx } = loadBackground({
    settings: SETTINGS,
    fetch: async () => {
      n += 1;
      return new Response('{}', { status: 403 });
    },
  });
  const res = await ctx.fetchWithRetry('https://x', {});
  assert.equal(res.status, 403);
  assert.equal(n, 1);
});

// ───────────────────────── apiFetch 오류 처리 ─────────────────────────

test('apiFetch: 설정이 없으면 안내 메시지로 실패한다', async () => {
  const { ctx } = loadBackground();
  await assert.rejects(() => ctx.apiFetch('GET', '/x'), /설정 탭/);
});

test('apiFetch: isSuccessful=false 는 서버 메시지를 그대로 전달한다', async () => {
  const { ctx } = loadBackground({
    settings: SETTINGS,
    fetch: async () => new Response(
      JSON.stringify({ header: { isSuccessful: false, resultMessage: '권한이 없습니다' } }),
      { status: 200 },
    ),
  });
  await assert.rejects(() => ctx.apiFetch('GET', '/x'), /권한이 없습니다/);
});

test('apiFetch: Authorization 헤더에 dooray-api 스킴을 쓴다', async () => {
  const f = stubFetch([['/x', { result: {} }]]);
  const { ctx } = loadBackground({ settings: SETTINGS, fetch: f });
  await ctx.apiFetch('GET', '/x');
  assert.equal(f.calls[0].headers.Authorization, 'dooray-api K');
});

// ───────────────────────── 댓글 생성 (핵심 경로) ─────────────────────────

test('comment-create: 본문이 그대로 마크다운으로 전송된다', async () => {
  const f = stubFetch([['/logs', { result: { id: 'LOG1' } }]]);
  const { ctx } = loadBackground({ settings: SETTINGS, fetch: f });
  const md = '[@차주형](dooray://O/members/1 "member") 확인\n\n| a | b |\n| --- | --- |\n| 1 | 2 |';
  const id = await ctx.executeAction('comment-create', {
    projectId: 'P', postId: 'T', mimeType: 'text/x-markdown', content: md,
  });
  assert.equal(id, 'LOG1');
  const sent = JSON.parse(f.calls[0].body);
  assert.equal(sent.body.mimeType, 'text/x-markdown');
  assert.equal(sent.body.content, md);
  assert.match(f.calls[0].url, /\/project\/v1\/projects\/P\/posts\/T\/logs$/);
});

test('comment-create: cid 자리표시자가 업로드된 파일 ID 로 치환된다', async () => {
  const f = stubFetch([
    ['/uploads/', { result: { id: 'FILE9' } }],
    ['/logs', { result: { id: 'LOG2' } }],
  ]);
  const { ctx } = loadBackground({ settings: SETTINGS, fetch: f });
  await ctx.executeAction('comment-create', {
    projectId: 'P', postId: 'T', mimeType: 'text/x-markdown',
    content: '보세요 ![shot.png](cid:abc) 끝',
    files: [{ name: 'shot.png', type: 'image/png', dataBase64: 'aGk=', cid: 'abc' }],
  });
  const sent = JSON.parse(f.calls.at(-1).body);
  assert.equal(sent.body.content, '보세요 ![shot.png](/files/FILE9) 끝');
});

test('comment-create: cid 없는 첨부는 본문 끝에 참조로 붙는다', async () => {
  const f = stubFetch([
    ['/uploads/', { result: { id: 'FILE7' } }],
    ['/logs', { result: { id: 'LOG3' } }],
  ]);
  const { ctx } = loadBackground({ settings: SETTINGS, fetch: f });
  await ctx.executeAction('comment-create', {
    projectId: 'P', postId: 'T', mimeType: 'text/x-markdown',
    content: '본문',
    files: [{ name: 'spec.pdf', type: 'application/pdf', dataBase64: 'aGk=' }],
  });
  const sent = JSON.parse(f.calls.at(-1).body);
  assert.equal(sent.body.content, '본문\n\n[spec.pdf](/files/FILE7)');
});

test('comment-create: 파일명에 $ 가 있어도 치환이 깨지지 않는다', async () => {
  const f = stubFetch([
    ['/uploads/', { result: { id: 'F$1' } }],
    ['/logs', { result: { id: 'LOG4' } }],
  ]);
  const { ctx } = loadBackground({ settings: SETTINGS, fetch: f });
  await ctx.executeAction('comment-create', {
    projectId: 'P', postId: 'T', mimeType: 'text/x-markdown',
    content: '![a$b.png](cid:x)',
    files: [{ name: 'a$b.png', type: 'image/png', dataBase64: 'aGk=', cid: 'x' }],
  });
  assert.equal(JSON.parse(f.calls.at(-1).body).body.content, '![a$b.png](/files/F$1)');
});

test('업로드는 file-api 호스트를 먼저 시도한다', async () => {
  const f = stubFetch([['/uploads/', { result: { id: 'F1' } }], ['/logs', { result: { id: 'L' } }]]);
  const { ctx } = loadBackground({ settings: SETTINGS, fetch: f });
  await ctx.executeAction('comment-create', {
    projectId: 'P', postId: 'T', content: 'x',
    files: [{ name: 'a.png', type: 'image/png', dataBase64: 'aGk=' }],
  });
  assert.equal(
    f.calls[0].url,
    'https://file-api.dooray.com/uploads/project/v1/projects/P/posts/T/files',
  );
});

test('업로드 실패는 파일명과 함께 보고된다', async () => {
  const f = stubFetch([['files', { status: 500, payload: { header: { isSuccessful: false, resultMessage: '용량 초과' } } }]]);
  const { ctx } = loadBackground({ settings: SETTINGS, fetch: f });
  await assert.rejects(
    () => ctx.executeAction('comment-create', {
      projectId: 'P', postId: 'T', content: 'x',
      files: [{ name: 'big.zip', type: 'application/zip', dataBase64: 'aGk=' }],
    }),
    /big\.zip/,
  );
});

// ───────────────────────── 댓글 수정 / 삭제 ─────────────────────────

test('comment-update: PUT 경로와 본문이 맞다', async () => {
  const f = stubFetch([['/logs/', { result: {} }]]);
  const { ctx } = loadBackground({ settings: SETTINGS, fetch: f });
  const id = await ctx.executeAction('comment-update', {
    projectId: 'P', postId: 'T', logId: 'L1', content: '수정됨', mimeType: 'text/x-markdown',
  });
  assert.equal(id, 'L1');
  assert.equal(f.calls[0].method, 'PUT');
  assert.match(f.calls[0].url, /\/posts\/T\/logs\/L1$/);
  assert.equal(JSON.parse(f.calls[0].body).body.content, '수정됨');
});

test('comment-delete: DELETE 를 호출한다', async () => {
  const f = stubFetch([['/logs/', { result: {} }]]);
  const { ctx } = loadBackground({ settings: SETTINGS, fetch: f });
  await ctx.executeAction('comment-delete', { projectId: 'P', postId: 'T', logId: 'L2' });
  assert.equal(f.calls[0].method, 'DELETE');
});

// ───────────────────────── 업무 생성 / 수정 ─────────────────────────

test('task-update: 기존 담당자·마감일·태그를 되돌려 보내 유지한다', async () => {
  const detail = {
    subject: '기존 제목',
    body: { mimeType: 'text/x-markdown', content: '기존 본문' },
    users: {
      to: [{ type: 'member', member: { organizationMemberId: 'M1' } }],
      cc: [{ type: 'emailUser', emailUser: { emailAddress: 'a@b.c', name: 'A' } }],
    },
    dueDate: '2026-09-01T00:00:00+09:00',
    dueDateFlag: true,
    milestone: { id: 'MS1' },
    tags: [{ id: 'TG1' }, { id: 'TG2' }],
    priority: 'high',
  };
  const f = stubFetch([['/posts/T', (url, opts) => (opts.method === 'GET' ? { result: detail } : { result: {} })]]);
  const { ctx } = loadBackground({ settings: SETTINGS, fetch: f });
  await ctx.executeAction('task-update', { projectId: 'P', postId: 'T', content: '새 본문' });

  const put = JSON.parse(f.calls.find((c) => c.method === 'PUT').body);
  assert.equal(put.subject, '기존 제목');
  assert.equal(put.body.content, '새 본문');
  assert.deepEqual(plain(put.users.to), [{ type: 'member', member: { organizationMemberId: 'M1' } }]);
  assert.deepEqual(plain(put.users.cc), [{ type: 'emailUser', emailUser: { emailAddress: 'a@b.c', name: 'A' } }]);
  assert.equal(put.dueDate, detail.dueDate);
  assert.equal(put.milestoneId, 'MS1');
  assert.deepEqual(plain(put.tagIds), ['TG1', 'TG2']);
  assert.equal(put.priority, 'high');
});

test('task-update: 본문을 비우면 기존 본문이 보존된다', async () => {
  const detail = { subject: 'S', body: { mimeType: 'text/x-markdown', content: '원래 본문' }, users: {} };
  const f = stubFetch([['/posts/T', (url, opts) => (opts.method === 'GET' ? { result: detail } : { result: {} })]]);
  const { ctx } = loadBackground({ settings: SETTINGS, fetch: f });
  await ctx.executeAction('task-update', { projectId: 'P', postId: 'T' });
  assert.equal(JSON.parse(f.calls.find((c) => c.method === 'PUT').body).body.content, '원래 본문');
});

test('task-create: assignMe 는 나를 담당자로 넣는다', async () => {
  const f = stubFetch([
    ['/members/me', { result: { id: 'ME' } }],
    ['/posts', { result: { id: 'NEW' } }],
  ]);
  const { ctx } = loadBackground({ settings: SETTINGS, fetch: f });
  const id = await ctx.executeAction('task-create', {
    projectId: 'P', subject: 'S', content: 'C', assignMe: true,
  });
  assert.equal(id, 'NEW');
  const sent = JSON.parse(f.calls.at(-1).body);
  assert.deepEqual(plain(sent.users.to), [{ type: 'member', member: { organizationMemberId: 'ME' } }]);
});

test('task-create: 첨부가 있으면 생성 후 본문을 다시 PUT 한다', async () => {
  const f = stubFetch([
    ['/uploads/', { result: { id: 'F1' } }],
    ['/posts/NEW', { result: {} }],
    ['/posts', { result: { id: 'NEW' } }],
  ]);
  const { ctx } = loadBackground({ settings: SETTINGS, fetch: f });
  await ctx.executeAction('task-create', {
    projectId: 'P', subject: 'S', content: '본문',
    files: [{ name: 'a.png', type: 'image/png', dataBase64: 'aGk=' }],
  });
  const put = f.calls.find((c) => c.method === 'PUT');
  assert.ok(put, 'PUT 이 호출되어야 한다');
  assert.equal(JSON.parse(put.body).body.content, '본문\n\n![a.png](/files/F1)');
});

test('알 수 없는 작업 유형은 거부된다', async () => {
  const { ctx } = loadBackground({ settings: SETTINGS });
  await assert.rejects(() => ctx.executeAction('nope', {}), /알 수 없는 작업 유형/);
});

// ───────────────────────── 예약 수명주기 ─────────────────────────

test('saveReservation → 알람 등록 → 실행 → done', async () => {
  const f = stubFetch([['/logs', { result: { id: 'L' } }]]);
  const bg = loadBackground({ settings: SETTINGS, fetch: f });
  const when = Date.now() + 60_000;
  const resv = await bg.ctx.handleMessage({
    type: 'saveReservation',
    action: 'comment-create',
    params: { projectId: 'P', postId: 'T', content: 'hi' },
    summary: '#1 테스트',
    scheduledAt: when,
  });
  assert.equal(resv.status, 'pending');
  assert.deepEqual(plain(bg.alarms.get(`resv:${resv.id}`)), { when });

  await bg.ctx.runReservation(resv.id);
  const after = (await bg.ctx.getReservations())[resv.id];
  assert.equal(after.status, 'done');
  assert.equal(after.resultId, 'L');
  assert.equal(bg.notifications.at(-1).title, 'Dooray 예약 실행 완료');
});

test('실행 실패는 failed 로 남고 사유를 알린다', async () => {
  const f = stubFetch([['/logs', { status: 403, payload: { header: { isSuccessful: false, resultMessage: '권한 없음' } } }]]);
  const bg = loadBackground({ settings: SETTINGS, fetch: f });
  const resv = await bg.ctx.handleMessage({
    type: 'saveReservation', action: 'comment-create',
    params: { projectId: 'P', postId: 'T', content: 'hi' }, summary: 's', scheduledAt: Date.now() + 1000,
  });
  await bg.ctx.runReservation(resv.id);
  const after = (await bg.ctx.getReservations())[resv.id];
  assert.equal(after.status, 'failed');
  assert.match(after.error, /권한 없음/);
  assert.match(bg.notifications.at(-1).message, /권한 없음/);
});

test('이미 완료된 예약은 다시 실행되지 않는다', async () => {
  const f = stubFetch([['/logs', { result: { id: 'L' } }]]);
  const bg = loadBackground({ settings: SETTINGS, fetch: f });
  const resv = await bg.ctx.handleMessage({
    type: 'saveReservation', action: 'comment-create',
    params: { projectId: 'P', postId: 'T', content: 'x' }, summary: 's', scheduledAt: Date.now(),
  });
  await bg.ctx.runReservation(resv.id);
  await bg.ctx.runReservation(resv.id);
  assert.equal(f.calls.filter((c) => c.url.includes('/logs')).length, 1);
});

test('실행 중 삭제된 예약은 되살아나지 않는다', async () => {
  const bg = loadBackground({
    settings: SETTINGS,
    fetch: async () => {
      await bg.ctx.handleMessage({ type: 'deleteReservation', id: created.id });
      return new Response(JSON.stringify({ header: { isSuccessful: true }, result: { id: 'L' } }), { status: 200 });
    },
  });
  const created = await bg.ctx.handleMessage({
    type: 'saveReservation', action: 'comment-create',
    params: { projectId: 'P', postId: 'T', content: 'x' }, summary: 's', scheduledAt: Date.now(),
  });
  await bg.ctx.runReservation(created.id);
  assert.equal((await bg.ctx.getReservations())[created.id], undefined);
});

test('deleteReservation 은 알람도 함께 지운다', async () => {
  const bg = loadBackground({ settings: SETTINGS });
  const resv = await bg.ctx.handleMessage({
    type: 'saveReservation', action: 'comment-create',
    params: {}, summary: 's', scheduledAt: Date.now() + 99999,
  });
  assert.ok(bg.alarms.has(`resv:${resv.id}`));
  await bg.ctx.handleMessage({ type: 'deleteReservation', id: resv.id });
  assert.equal(bg.alarms.has(`resv:${resv.id}`), false);
});

test('syncAlarms: 지난 예약은 실행하고 미래 예약은 알람을 다시 건다', async () => {
  const f = stubFetch([['/logs', { result: { id: 'L' } }]]);
  const bg = loadBackground({ settings: SETTINGS, fetch: f });
  const past = await bg.ctx.handleMessage({
    type: 'saveReservation', action: 'comment-create',
    params: { projectId: 'P', postId: 'T', content: 'x' }, summary: 'past', scheduledAt: Date.now() - 10_000,
  });
  const future = await bg.ctx.handleMessage({
    type: 'saveReservation', action: 'comment-create',
    params: { projectId: 'P', postId: 'T', content: 'y' }, summary: 'future', scheduledAt: Date.now() + 600_000,
  });
  bg.alarms.clear();
  await bg.ctx.syncAlarms();
  await new Promise((r) => setTimeout(r, 30));
  assert.equal((await bg.ctx.getReservations())[past.id].status, 'done');
  assert.ok(bg.alarms.has(`resv:${future.id}`));
});

test('syncAlarms: 중단된 running 예약은 failed 로 복구된다', async () => {
  const bg = loadBackground({ settings: SETTINGS });
  await bg.ctx.setReservations({
    r1: { id: 'r1', status: 'running', startedAt: Date.now() - 10 * 60 * 1000, scheduledAt: 0 },
  });
  await bg.ctx.syncAlarms();
  const after = (await bg.ctx.getReservations()).r1;
  assert.equal(after.status, 'failed');
  assert.match(after.error, /중단/);
});

test('runNow: 실패한 예약을 재시도할 수 있다', async () => {
  let ok = false;
  const bg = loadBackground({
    settings: SETTINGS,
    fetch: async () => new Response(
      JSON.stringify(ok
        ? { header: { isSuccessful: true }, result: { id: 'L' } }
        : { header: { isSuccessful: false, resultMessage: '일시 오류' } }),
      { status: 200 },
    ),
  });
  const resv = await bg.ctx.handleMessage({
    type: 'saveReservation', action: 'comment-create',
    params: { projectId: 'P', postId: 'T', content: 'x' }, summary: 's', scheduledAt: Date.now(),
  });
  await bg.ctx.runReservation(resv.id);
  assert.equal((await bg.ctx.getReservations())[resv.id].status, 'failed');
  ok = true;
  await bg.ctx.handleMessage({ type: 'runNow', id: resv.id });
  assert.equal((await bg.ctx.getReservations())[resv.id].status, 'done');
});

// ───────────────────────── 설정 ─────────────────────────

test('saveSettings: 스킴 없는 도메인도 받아준다', async () => {
  const bg = loadBackground();
  const s = await bg.ctx.handleMessage({ type: 'saveSettings', doorayUrl: 'sota.dooray.com', apiKey: 'K' });
  assert.equal(s.doorayUrl, 'https://sota.dooray.com');
  assert.equal(s.apiBase, 'https://api.dooray.com');
});

test('saveSettings: API Key 가 없으면 거부한다', async () => {
  const bg = loadBackground();
  await assert.rejects(
    () => bg.ctx.handleMessage({ type: 'saveSettings', doorayUrl: 'sota.dooray.com', apiKey: '  ' }),
    /API Key/,
  );
});

test('resolveMentions: 이름이 정확히 일치하는 후보를 우선한다', async () => {
  const f = stubFetch([
    ['/members/me', { result: { id: 'ME', defaultOrganization: { id: 'ORG1' } } }],
    ['/members?name=', { result: [
      { id: '1', name: '김진', userCode: 'kj' },
      { id: '2', name: '김진목', userCode: 'kjm' },
    ] }],
  ]);
  const bg = loadBackground({ settings: SETTINGS, fetch: f });
  const r = await bg.ctx.handleMessage({ type: 'resolveMentions', names: ['김진목'] });
  assert.equal(r.orgId, 'ORG1');
  assert.deepEqual(plain(r.results[0].candidates), [{ id: '2', name: '김진목', userCode: 'kjm' }]);
});

test('resolveMentions: 조회에 실패해도 전체가 죽지 않는다', async () => {
  const f = stubFetch([
    ['/members/me', { result: { id: 'ME', defaultOrganization: { id: 'ORG1' } } }],
    ['/members?name=', { status: 500, payload: { header: { isSuccessful: false, resultMessage: 'x' } } }],
  ]);
  const bg = loadBackground({ settings: SETTINGS, fetch: f });
  const r = await bg.ctx.handleMessage({ type: 'resolveMentions', names: ['없는사람'] });
  assert.deepEqual(plain(r.results), [{ name: '없는사람', candidates: [] }]);
});
