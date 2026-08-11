// 실계정 Dooray API 통합 테스트 (.env 의 TEST_KEY_CODE / SERVER_DOMAIN 사용)
//
// 프로덕션 코드(editor-markdown.js + background.js)를 그대로 실행해
// "에디터 DOM → 마크다운 → Dooray API → 다시 읽기" 전 구간을 검증한다.
// 테스트용 업무를 하나 만들고 끝나면 완료 처리한다.
//
//   npm run test:live

import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { loadBackground } from '../helpers/load-background.mjs';
import { convert } from '../helpers/dom.mjs';
import { API_BASE, SETTINGS, HAS_CREDS, raw, pngFile, textFile, PNG_8PX_B64 } from '../helpers/env.mjs';

// 테스트 대상 프로젝트 — 개인 기록용 프로젝트를 샌드박스로 쓴다
const PROJECT = process.env.DTR_TEST_PROJECT || '4274783225974692162'; // 차주형-공부기록

const skip = !HAS_CREDS ? '.env 에 TEST_KEY_CODE 가 없어 건너뜁니다' : false;

let bg;
let postId;
let me;
const createdLogs = [];

before(async () => {
  if (skip) return;
  bg = loadBackground({ settings: SETTINGS });
  me = (await raw('GET', '/common/v1/members/me')).json.result;
  const res = await raw('POST', `/project/v1/projects/${PROJECT}/posts`, {
    subject: `[자동테스트] 예약 댓글 검증 ${new Date().toISOString()}`,
    body: { mimeType: 'text/x-markdown', content: '이 업무는 확장 프로그램 자동 테스트가 생성했습니다.' },
    users: { to: [], cc: [] },
  });
  postId = res.json?.result?.id;
  assert.ok(postId, `테스트 업무 생성 실패: ${JSON.stringify(res.json)}`);
});

after(async () => {
  if (skip || !postId) return;
  // 업무 삭제는 Dooray 공개 API 가 지원하지 않으므로(404 실측) 완료 처리한다
  await raw('POST', `/project/v1/projects/${PROJECT}/posts/${postId}/set-done`);
});

/** 댓글을 실제로 달고 서버에 저장된 내용을 그대로 돌려받는다 */
async function postComment(params) {
  const logId = await bg.ctx.executeAction('comment-create', {
    projectId: PROJECT,
    postId,
    mimeType: 'text/x-markdown',
    ...params,
  });
  createdLogs.push(logId);
  const logs = await raw('GET', `/project/v1/projects/${PROJECT}/posts/${postId}/logs?page=0&size=100`);
  const log = (logs.json?.result || []).find((l) => l.id === logId);
  assert.ok(log, '방금 등록한 댓글을 다시 읽지 못했습니다');
  return { logId, mimeType: log.body.mimeType, content: log.body.content };
}

/** 에디터 DOM → 마크다운 → 댓글 등록 → 읽기 (실제 사용 경로 전체) */
async function postFromEditorHtml(html, { files = [], orgId = '' } = {}) {
  const r = convert(html);
  let content = r.window.DTR_MD.applyMentions(r.content, r.mentions, orgId || me.defaultOrganization.id);
  // 에디터가 품고 있던 이미지는 cid 로 바꿔 첨부와 함께 넘긴다 (content script 와 동일)
  const cidFiles = r.images.map((img, i) => {
    const cid = `dtr-test-${i}`;
    content = r.window.DTR_MD.applyImage(
      content, i, r.window.DTR_MD.imageMarkup(img.alt || `image-${i + 1}.png`, `cid:${cid}`, img.width),
    );
    return pngFile(img.alt || `image-${i + 1}.png`, PNG_8PX_B64, { cid });
  });
  return postComment({ content, files: [...cidFiles, ...files] });
}

// ───────────────────────── 연결 ─────────────────────────

test('연결 테스트 — 개인 인증 토큰이 유효하다', { skip }, async () => {
  const r = await bg.ctx.handleMessage({ type: 'testConnection' });
  assert.ok(r.id);
  assert.ok(r.name);
});

test('apiBase 가 SaaS 전용 호스트로 유도된다', { skip }, () => {
  assert.equal(API_BASE, 'https://api.dooray.com');
});

test('프로젝트 목록을 불러온다', { skip }, async () => {
  const projects = await bg.ctx.handleMessage({ type: 'listProjects' });
  assert.ok(projects.length > 0);
  assert.ok(projects.some((p) => p.id === PROJECT), '테스트 프로젝트에 접근할 수 있어야 한다');
});

test('resolvePost 가 업무의 소속 프로젝트를 찾아준다', { skip }, async () => {
  const r = await bg.ctx.handleMessage({ type: 'resolvePost', postId });
  assert.equal(r.projectId, PROJECT);
  assert.ok(r.number > 0);
});

// ───────────────────────── 댓글: 텍스트 · 서식 ─────────────────────────

test('일반 텍스트 댓글이 그대로 저장된다', { skip }, async () => {
  const r = await postFromEditorHtml('<p>안녕하세요. 예약 테스트입니다.</p>');
  assert.equal(r.mimeType, 'text/x-markdown');
  assert.equal(r.content, '안녕하세요. 예약 테스트입니다.');
});

test('굵게/기울임/취소선 서식이 마크다운으로 보존된다', { skip }, async () => {
  const r = await postFromEditorHtml('<p><b>굵게</b> <i>기울임</i> <s>취소선</s></p>');
  assert.equal(r.content, '**굵게** *기울임* ~~취소선~~');
});

test('여러 문단과 빈 줄이 유지된다', { skip }, async () => {
  const r = await postFromEditorHtml('<p>첫 문단</p><p><br></p><p>둘째 문단</p>');
  assert.equal(r.content, '첫 문단\n\n<br>\n\n둘째 문단');
});

test('제목(H1~H3)이 마크다운 제목으로 저장된다', { skip }, async () => {
  const r = await postFromEditorHtml('<h1>큰제목</h1><h2>중제목</h2><p>본문</p>');
  assert.equal(r.content, '# 큰제목\n\n## 중제목\n\n본문');
});

// ───────────────────────── 댓글: 하이퍼링크 ─────────────────────────

test('하이퍼링크가 클릭 가능한 마크다운 링크로 저장된다', { skip }, async () => {
  const r = await postFromEditorHtml(
    '<p>문서는 <a href="https://www.dooray.com/guide">여기</a>를 보세요.</p>',
  );
  assert.equal(r.content, '문서는 [여기](https://www.dooray.com/guide)를 보세요.');
});

// ───────────────────────── 댓글: 코드 ─────────────────────────

test('코드 블록의 줄바꿈과 들여쓰기가 살아남는다', { skip }, async () => {
  const r = await postFromEditorHtml(
    '<pre><code class="language-python">def hello():\n    return "world"</code></pre>',
  );
  assert.equal(r.content, '```python\ndef hello():\n    return "world"\n```');
  assert.ok(r.content.includes('\n    return'), '들여쓰기가 보존되어야 한다');
});

test('HTML(text/html)로 보내면 코드 줄바꿈이 뭉개진다 — 마크다운을 쓰는 이유', { skip }, async () => {
  const r = await postComment({
    mimeType: 'text/html',
    content: '<pre>def hello():\n    return "world"</pre>',
  });
  // 서버가 <pre> 안의 개행을 공백으로 접는다 (회귀 방지용 기록)
  assert.ok(!r.content.includes('\n    return'), `실제 저장값: ${JSON.stringify(r.content)}`);
});

test('인라인 코드', { skip }, async () => {
  const r = await postFromEditorHtml('<p>변수 <code>batch_size</code> 를 확인하세요.</p>');
  assert.equal(r.content, '변수 `batch_size` 를 확인하세요.');
});

// ───────────────────────── 댓글: 표 ─────────────────────────

test('표가 Dooray 마크다운 표로 저장된다', { skip }, async () => {
  const r = await postFromEditorHtml(
    '<table><thead><tr><th>항목</th><th>값</th></tr></thead>' +
      '<tbody><tr><td>정확도</td><td>91%</td></tr><tr><td>지연</td><td>12ms</td></tr></tbody></table>',
  );
  assert.equal(r.content, '| 항목 | 값 |\n| --- | --- |\n| 정확도 | 91% |\n| 지연 | 12ms |');
});

test('셀 병합 표는 원본 HTML 표로 저장된다', { skip }, async () => {
  const r = await postFromEditorHtml(
    '<table><tr><td rowspan="2">경북대</td><td>조수호</td></tr><tr><td>마준익</td></tr></table>',
  );
  assert.ok(r.content.includes('rowspan="2"'), r.content);
  assert.ok(r.content.includes('조수호') && r.content.includes('마준익'));
});

// ───────────────────────── 댓글: 목록 · 인용 ─────────────────────────

test('중첩 목록과 체크리스트', { skip }, async () => {
  const r = await postFromEditorHtml(
    '<ul><li>상위<ul><li>하위</li></ul></li></ul>' +
      '<ol><li>첫째</li><li>둘째</li></ol>',
  );
  assert.equal(r.content, '- 상위\n  - 하위\n\n1. 첫째\n2. 둘째');
});

test('인용문', { skip }, async () => {
  const r = await postFromEditorHtml('<blockquote><p>인용된 문장입니다.</p></blockquote>');
  assert.equal(r.content, '> 인용된 문장입니다.');
});

// ───────────────────────── 댓글: 멘션 ─────────────────────────

test('멘션이 Dooray 네이티브 마크업으로 저장되고 서버가 정규화한다', { skip }, async () => {
  const r = await postFromEditorHtml(
    `<p><span class="mention" data-member-id="${me.id}">@${me.name}</span> 확인 부탁드립니다.</p>`,
  );
  // 서버가 인식하면 org ID 를 실제 값으로 바꾸고 역할(me/member)을 붙인다
  assert.match(r.content, /^\[@.+\]\(dooray:\/\/\d+\/members\/\d+ "(me|member|owner)"\)/, r.content);
  assert.ok(r.content.includes(me.id), '멤버 ID 가 유지되어야 한다');
  assert.ok(r.content.endsWith('확인 부탁드립니다.'));
});

test('멘션 이름만 있어도 API 조회로 멤버 ID 를 채운다', { skip }, async () => {
  const res = await bg.ctx.handleMessage({ type: 'resolveMentions', names: [me.name] });
  assert.ok(res.orgId);
  const hit = res.results[0].candidates.find((c) => c.id === me.id);
  assert.ok(hit, `이름 "${me.name}" 조회로 본인을 찾아야 한다`);
});

test('HTML 멘션은 서버가 인식하지 못한다 — 마크다운으로 보내야 하는 이유', { skip }, async () => {
  const r = await postComment({
    mimeType: 'text/html',
    content: `<p><a href="dooray://${me.defaultOrganization.id}/members/${me.id}">@${me.name}</a></p>`,
  });
  // 정규화되지 않고 그대로 남는다 = 알림이 가지 않는 죽은 링크 (회귀 방지용 기록)
  assert.ok(r.content.includes(me.defaultOrganization.id), `실제 저장값: ${r.content}`);
});

// ───────────────────────── 댓글: 이미지 · 파일 ─────────────────────────

test('에디터 인라인 이미지가 업로드되고 본문에 인라인으로 들어간다', { skip }, async () => {
  const r = await postFromEditorHtml('<p>결과 그래프:</p><p><img src="blob:x" alt="chart.png"></p>');
  assert.match(r.content, /^결과 그래프:\n\n!\[chart\.png\]\(\/files\/\d+\)$/, r.content);
});

test('리사이즈한 이미지는 width 를 유지한 채 업로드된다', { skip }, async () => {
  const r = await postFromEditorHtml('<p><img src="blob:x" alt="wide.png" style="width: 240px"></p>');
  assert.match(r.content, /<img src="\/files\/\d+" alt="wide\.png" width="240" \/>/, r.content);
});

test('이미지 여러 장의 순서가 유지된다', { skip }, async () => {
  const r = await postFromEditorHtml(
    '<p><img src="blob:1" alt="one.png"></p><p><img src="blob:2" alt="two.png"></p>',
  );
  const ids = [...r.content.matchAll(/\/files\/(\d+)/g)].map((m) => m[1]);
  assert.equal(ids.length, 2);
  assert.notEqual(ids[0], ids[1]);
  assert.ok(r.content.indexOf('one.png') < r.content.indexOf('two.png'));
});

test('일반 파일 첨부는 본문 끝에 다운로드 링크로 붙는다', { skip }, async () => {
  const r = await postComment({ content: '첨부 확인 부탁드립니다.', files: [textFile('보고서.txt')] });
  assert.match(r.content, /^첨부 확인 부탁드립니다\.\n\n\[보고서\.txt\]\(\/files\/\d+\)$/, r.content);
});

test('첨부한 이미지 파일은 링크가 아니라 인라인으로 표시된다', { skip }, async () => {
  const r = await postComment({ content: '스크린샷:', files: [pngFile('screen.png')] });
  assert.match(r.content, /!\[screen\.png\]\(\/files\/\d+\)/, r.content);
});

test('업로드한 파일이 업무 첨부 목록에 실제로 존재한다', { skip }, async () => {
  const r = await postComment({ content: 'x', files: [textFile('존재확인.txt')] });
  const fileId = r.content.match(/\/files\/(\d+)/)[1];
  const files = await raw('GET', `/project/v1/projects/${PROJECT}/posts/${postId}/files`);
  const hit = (files.json?.result || []).find((f) => f.id === fileId);
  assert.ok(hit, '업로드한 파일이 업무 첨부에 있어야 한다');
  assert.equal(hit.name, '존재확인.txt');
});

test('이미지와 일반 파일을 함께 첨부할 수 있다', { skip }, async () => {
  const r = await postComment({
    content: '자료 공유드립니다.',
    files: [pngFile('그림.png'), textFile('설명.txt')],
  });
  assert.match(r.content, /!\[그림\.png\]\(\/files\/\d+\)/);
  assert.match(r.content, /\[설명\.txt\]\(\/files\/\d+\)/);
});

// ───────────────────────── 댓글: 복합 ─────────────────────────

test('멘션+표+코드+링크+이미지+첨부 복합 댓글', { skip }, async () => {
  const r = await postFromEditorHtml(
    `<p><span class="mention" data-member-id="${me.id}">@${me.name}</span> 주간 결과 공유드립니다.</p>` +
      '<p><br></p>' +
      '<h2>측정 결과</h2>' +
      '<table><thead><tr><th>모델</th><th>정확도</th></tr></thead>' +
      '<tbody><tr><td>base</td><td>88.1%</td></tr><tr><td>ours</td><td>91.4%</td></tr></tbody></table>' +
      '<pre><code class="language-bash">python train.py --lr 1e-3 --epochs 30</code></pre>' +
      '<p>상세 로그는 <a href="https://sota.dooray.com">여기</a>에 있습니다.</p>' +
      '<p><img src="blob:c" alt="curve.png"></p>' +
      '<blockquote><p>다음 주에 재현 실험 예정</p></blockquote>',
    { files: [textFile('raw-log.txt')] },
  );
  const c = r.content;
  assert.match(c, /\[@.+\]\(dooray:\/\/\d+\/members\/\d+ "(me|member|owner)"\)/, c);
  assert.ok(c.includes('## 측정 결과'), c);
  assert.ok(c.includes('| 모델 | 정확도 |\n| --- | --- |\n| base | 88.1% |'), c);
  assert.ok(c.includes('```bash\npython train.py --lr 1e-3 --epochs 30\n```'), c);
  assert.ok(c.includes('[여기](https://sota.dooray.com)'), c);
  assert.match(c, /!\[curve\.png\]\(\/files\/\d+\)/, c);
  assert.ok(c.includes('> 다음 주에 재현 실험 예정'), c);
  assert.match(c, /\[raw-log\.txt\]\(\/files\/\d+\)/, c);
});

// ───────────────────────── 댓글: 수정 · 삭제 ─────────────────────────

test('예약된 댓글 수정이 동작한다', { skip }, async () => {
  const { logId } = await postComment({ content: '수정 전' });
  await bg.ctx.executeAction('comment-update', {
    projectId: PROJECT, postId, logId, content: '수정 후 ✅', mimeType: 'text/x-markdown',
  });
  const logs = await raw('GET', `/project/v1/projects/${PROJECT}/posts/${postId}/logs?page=0&size=100`);
  const log = logs.json.result.find((l) => l.id === logId);
  assert.equal(log.body.content, '수정 후 ✅');
});

test('예약된 댓글 삭제가 동작한다', { skip }, async () => {
  const { logId } = await postComment({ content: '삭제될 댓글' });
  await bg.ctx.executeAction('comment-delete', { projectId: PROJECT, postId, logId });
  const logs = await raw('GET', `/project/v1/projects/${PROJECT}/posts/${postId}/logs?page=0&size=100`);
  assert.equal(logs.json.result.find((l) => l.id === logId), undefined);
});

// ───────────────────────── 업무 ─────────────────────────

test('업무 생성 예약 (첨부 포함)', { skip }, async () => {
  const newId = await bg.ctx.executeAction('task-create', {
    projectId: PROJECT,
    subject: '[자동테스트] 업무 생성 예약',
    content: '본문입니다.',
    assignMe: true,
    files: [pngFile('생성첨부.png')],
    mimeType: 'text/x-markdown',
  });
  assert.ok(newId);
  const detail = (await raw('GET', `/project/v1/projects/${PROJECT}/posts/${newId}`)).json.result;
  assert.match(detail.body.content, /본문입니다\.\n\n!\[생성첨부\.png\]\(\/files\/\d+\)/);
  assert.ok(detail.users.to.some((u) => u.member?.organizationMemberId === me.id), '담당자가 지정되어야 한다');
  await raw('POST', `/project/v1/projects/${PROJECT}/posts/${newId}/set-done`);
});

test('업무 본문 수정 예약이 담당자/제목을 보존한다', { skip }, async () => {
  const before = (await raw('GET', `/project/v1/projects/${PROJECT}/posts/${postId}`)).json.result;
  await bg.ctx.executeAction('task-update', {
    projectId: PROJECT, postId, content: '수정된 본문 ✅', mimeType: 'text/x-markdown',
  });
  const afterDetail = (await raw('GET', `/project/v1/projects/${PROJECT}/posts/${postId}`)).json.result;
  assert.equal(afterDetail.body.content, '수정된 본문 ✅');
  assert.equal(afterDetail.subject, before.subject, '제목이 유지되어야 한다');
});

test('업무 삭제는 Dooray 공개 API 가 지원하지 않는다 (팝업 경고가 정확한지 확인)', { skip }, async () => {
  const t = await raw('POST', `/project/v1/projects/${PROJECT}/posts`, {
    subject: '[자동테스트] 삭제 불가 확인', body: { mimeType: 'text/x-markdown', content: 'x' }, users: { to: [], cc: [] },
  });
  const tid = t.json.result.id;
  const del = await raw('DELETE', `/project/v1/projects/${PROJECT}/posts/${tid}`);
  assert.equal(del.status, 404, '404 가 아니면 팝업의 경고 문구를 갱신해야 한다');
  await raw('POST', `/project/v1/projects/${PROJECT}/posts/${tid}/set-done`);
});

// ───────────────────────── 예약 수명주기 (실 API) ─────────────────────────

test('예약 등록 → 알람 발화 → 실제 댓글 등록까지 이어진다', { skip }, async () => {
  const when = Date.now() + 1000;
  const resv = await bg.ctx.handleMessage({
    type: 'saveReservation',
    action: 'comment-create',
    params: { projectId: PROJECT, postId, mimeType: 'text/x-markdown', content: '⏰ 예약으로 등록된 댓글' },
    summary: '예약 흐름 테스트',
    scheduledAt: when,
  });
  assert.equal(resv.status, 'pending');
  assert.ok(bg.alarms.has(`resv:${resv.id}`), '알람이 등록되어야 한다');

  // chrome.alarms 발화를 흉내낸다
  for (const fn of bg.listeners.alarm) fn({ name: `resv:${resv.id}` });
  await new Promise((r) => setTimeout(r, 4000));

  const stored = (await bg.ctx.getReservations())[resv.id];
  assert.equal(stored.status, 'done', `실행 실패: ${stored.error}`);
  const logs = await raw('GET', `/project/v1/projects/${PROJECT}/posts/${postId}/logs?page=0&size=100`);
  const log = logs.json.result.find((l) => l.id === stored.resultId);
  assert.ok(log, '예약 실행 결과 댓글이 존재해야 한다');
  assert.equal(log.body.content, '⏰ 예약으로 등록된 댓글');
});

test('잘못된 업무 ID 로 예약하면 failed 로 남고 사유가 기록된다', { skip }, async () => {
  const resv = await bg.ctx.handleMessage({
    type: 'saveReservation',
    action: 'comment-create',
    params: { projectId: PROJECT, postId: '1234567890123456789', content: 'x' },
    summary: '실패 케이스',
    scheduledAt: Date.now(),
  });
  await bg.ctx.runReservation(resv.id);
  const stored = (await bg.ctx.getReservations())[resv.id];
  assert.equal(stored.status, 'failed');
  assert.ok(stored.error, '실패 사유가 남아야 한다');
});
