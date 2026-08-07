// Dooray Task Reservation — popup UI

const $ = (id) => document.getElementById(id);

const ACTION_LABELS = {
  'task-create': '업무 생성',
  'task-update': '업무 수정',
  'task-delete': '업무 삭제',
  'comment-create': '댓글 작성',
  'comment-update': '댓글 수정',
  'comment-delete': '댓글 삭제',
};

// 작업 유형별로 보여줄 필드 구성
const ACTION_FIELDS = {
  'task-create': {
    subject: '제목',
    content: '본문 (마크다운)',
    assignMe: true,
  },
  'task-update': {
    post: true,
    subject: '새 제목 (비워두면 기존 제목 유지)',
    content: '새 본문 (비워두면 기존 본문 유지)',
  },
  'task-delete': {
    post: true,
    warning:
      '업무 삭제는 Dooray 공개 API에 문서화되어 있지 않아 환경에 따라 거부될 수 있습니다. 실패하면 알림과 예약 목록에서 사유를 확인할 수 있습니다.',
  },
  'comment-create': {
    post: true,
    content: '댓글 내용 (마크다운)',
  },
  'comment-update': {
    post: true,
    comment: true,
    content: '새 댓글 내용 (마크다운)',
  },
  'comment-delete': {
    post: true,
    comment: true,
    warning: '예약 시각에 선택한 댓글이 삭제됩니다. 삭제된 댓글은 되돌릴 수 없습니다.',
  },
};

const MANUAL = '__manual__';

function send(msg) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(msg, (res) => {
      if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
      if (!res) return reject(new Error('백그라운드 응답이 없습니다.'));
      if (res.ok) resolve(res.data);
      else reject(new Error(res.error));
    });
  });
}

function setStatus(el, text, kind) {
  el.textContent = text;
  el.className = `status${kind ? ` ${kind}` : ''}`;
}

// ───────────────────────── 탭 ─────────────────────────

function switchTab(name) {
  document.querySelectorAll('.tab').forEach((b) => {
    b.classList.toggle('active', b.dataset.tab === name);
  });
  for (const t of ['new', 'list', 'settings']) {
    $(`tab-${t}`).hidden = t !== name;
  }
  if (name === 'list') renderList();
}

document.querySelectorAll('.tab').forEach((b) => {
  b.addEventListener('click', () => switchTab(b.dataset.tab));
});

// ───────────────────────── 선택 헬퍼 ─────────────────────────

function fillSelect(selectEl, items, placeholder) {
  selectEl.innerHTML = '';
  if (placeholder) {
    const opt = document.createElement('option');
    opt.value = '';
    opt.textContent = placeholder;
    selectEl.appendChild(opt);
  }
  for (const item of items) {
    const opt = document.createElement('option');
    opt.value = item.value;
    opt.textContent = item.label;
    selectEl.appendChild(opt);
  }
  const manual = document.createElement('option');
  manual.value = MANUAL;
  manual.textContent = 'ID 직접 입력…';
  selectEl.appendChild(manual);
}

function syncManualVisibility(selectEl, manualEl) {
  manualEl.hidden = selectEl.value !== MANUAL;
}

// 선택된 ID (직접 입력 우선)와 표시용 텍스트를 함께 반환
function selectedIdAndLabel(selectEl, manualEl) {
  if (selectEl.value === MANUAL) {
    const v = manualEl.value.trim();
    return { id: v, label: v };
  }
  const opt = selectEl.selectedOptions[0];
  return { id: selectEl.value, label: opt ? opt.textContent : selectEl.value };
}

// ───────────────────────── 데이터 로드 ─────────────────────────

async function loadProjects() {
  const sel = $('project');
  fillSelect(sel, [], '불러오는 중…');
  try {
    const projects = await send({ type: 'listProjects' });
    fillSelect(
      sel,
      projects.map((p) => ({ value: p.id, label: p.code })),
      '프로젝트 선택',
    );
    syncManualVisibility(sel, $('project-manual'));
    setStatus($('new-status'), '');
  } catch (e) {
    fillSelect(sel, [], null);
    sel.value = MANUAL;
    syncManualVisibility(sel, $('project-manual'));
    setStatus($('new-status'), `프로젝트 목록 로드 실패: ${e.message}`, 'err');
  }
}

async function loadPosts() {
  const { id: projectId } = selectedIdAndLabel($('project'), $('project-manual'));
  const sel = $('post');
  if (!projectId) {
    fillSelect(sel, [], '프로젝트를 먼저 선택하세요');
    return;
  }
  fillSelect(sel, [], '불러오는 중…');
  try {
    const posts = await send({ type: 'listPosts', projectId });
    fillSelect(
      sel,
      posts.map((p) => ({ value: p.id, label: `#${p.number} ${p.subject}` })),
      '업무 선택',
    );
    syncManualVisibility(sel, $('post-manual'));
  } catch (e) {
    fillSelect(sel, [], null);
    sel.value = MANUAL;
    syncManualVisibility(sel, $('post-manual'));
    setStatus($('new-status'), `업무 목록 로드 실패: ${e.message}`, 'err');
  }
}

async function loadComments() {
  const { id: projectId } = selectedIdAndLabel($('project'), $('project-manual'));
  const { id: postId } = selectedIdAndLabel($('post'), $('post-manual'));
  const sel = $('comment');
  if (!projectId || !postId) {
    fillSelect(sel, [], '업무를 먼저 선택하세요');
    return;
  }
  fillSelect(sel, [], '불러오는 중…');
  try {
    const comments = await send({ type: 'listComments', projectId, postId });
    fillSelect(
      sel,
      comments.map((c) => ({ value: c.id, label: `${c.creator}: ${c.snippet}` })),
      '댓글 선택',
    );
    syncManualVisibility(sel, $('comment-manual'));
  } catch (e) {
    fillSelect(sel, [], null);
    sel.value = MANUAL;
    syncManualVisibility(sel, $('comment-manual'));
    setStatus($('new-status'), `댓글 목록 로드 실패: ${e.message}`, 'err');
  }
}

// ───────────────────────── 새 예약 폼 ─────────────────────────

function applyActionFields() {
  const cfg = ACTION_FIELDS[$('action').value];
  $('f-post').hidden = !cfg.post;
  $('f-comment').hidden = !cfg.comment;
  $('f-subject').hidden = !cfg.subject;
  if (cfg.subject) $('subject-label').textContent = cfg.subject;
  $('f-content').hidden = !cfg.content;
  if (cfg.content) $('content-label').textContent = cfg.content;
  $('f-assignme').hidden = !cfg.assignMe;
  $('delete-warning').hidden = !cfg.warning;
  if (cfg.warning) $('delete-warning').textContent = `⚠️ ${cfg.warning}`;

  if (cfg.post && $('post').options.length <= 1) loadPosts();
  if (cfg.comment && $('comment').options.length <= 1) loadComments();
}

$('action').addEventListener('change', applyActionFields);

$('project').addEventListener('change', () => {
  syncManualVisibility($('project'), $('project-manual'));
  const cfg = ACTION_FIELDS[$('action').value];
  if (cfg.post && $('project').value !== MANUAL) loadPosts();
});

$('post').addEventListener('change', () => {
  syncManualVisibility($('post'), $('post-manual'));
  const cfg = ACTION_FIELDS[$('action').value];
  if (cfg.comment && $('post').value !== MANUAL) loadComments();
});

$('comment').addEventListener('change', () => {
  syncManualVisibility($('comment'), $('comment-manual'));
});

$('reload-projects').addEventListener('click', loadProjects);
$('reload-posts').addEventListener('click', loadPosts);
$('reload-comments').addEventListener('click', loadComments);

function defaultScheduleValue() {
  const d = new Date(Date.now() + 10 * 60 * 1000);
  d.setSeconds(0, 0);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

$('submit').addEventListener('click', async () => {
  const statusEl = $('new-status');
  const action = $('action').value;
  const cfg = ACTION_FIELDS[action];

  const project = selectedIdAndLabel($('project'), $('project-manual'));
  if (!project.id) return setStatus(statusEl, '프로젝트를 선택하거나 ID를 입력하세요.', 'err');

  const post = cfg.post ? selectedIdAndLabel($('post'), $('post-manual')) : null;
  if (cfg.post && !post.id) return setStatus(statusEl, '업무를 선택하거나 ID를 입력하세요.', 'err');

  const comment = cfg.comment ? selectedIdAndLabel($('comment'), $('comment-manual')) : null;
  if (cfg.comment && !comment.id)
    return setStatus(statusEl, '댓글을 선택하거나 ID를 입력하세요.', 'err');

  const subject = $('subject').value.trim();
  const content = $('content').value;

  if (action === 'task-create' && !subject)
    return setStatus(statusEl, '업무 제목을 입력하세요.', 'err');
  if (action === 'task-update' && !subject && !content.trim())
    return setStatus(statusEl, '새 제목 또는 새 본문 중 하나는 입력해야 합니다.', 'err');
  if ((action === 'comment-create' || action === 'comment-update') && !content.trim())
    return setStatus(statusEl, '댓글 내용을 입력하세요.', 'err');

  const when = $('scheduled-at').value;
  if (!when) return setStatus(statusEl, '예약 시각을 선택하세요.', 'err');
  const scheduledAt = new Date(when).getTime();
  if (Number.isNaN(scheduledAt)) return setStatus(statusEl, '예약 시각이 올바르지 않습니다.', 'err');

  const params = { projectId: project.id };
  if (post) params.postId = post.id;
  if (comment) params.logId = comment.id;
  if (cfg.subject && subject) params.subject = subject;
  if (cfg.content && content.trim()) params.content = content;
  if (cfg.assignMe) params.assignMe = $('assign-me').checked;

  const target =
    action === 'task-create' ? `"${subject}"` : post ? post.label : '';
  const summary = `[${project.label}] ${target}`.trim();

  $('submit').disabled = true;
  try {
    await send({ type: 'saveReservation', action, params, summary, scheduledAt });
    setStatus(statusEl, '예약이 등록되었습니다.', 'ok');
    $('subject').value = '';
    $('content').value = '';
    switchTab('list');
  } catch (e) {
    setStatus(statusEl, `예약 등록 실패: ${e.message}`, 'err');
  } finally {
    $('submit').disabled = false;
  }
});

// ───────────────────────── 예약 목록 ─────────────────────────

function formatTime(ms) {
  return new Date(ms).toLocaleString('ko-KR', {
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

const STATUS_LABELS = {
  pending: '대기',
  running: '실행 중',
  done: '완료',
  failed: '실패',
};

async function renderList() {
  const listEl = $('resv-list');
  let items;
  try {
    items = await send({ type: 'getReservations' });
  } catch (e) {
    listEl.innerHTML = '';
    const p = document.createElement('p');
    p.className = 'empty';
    p.textContent = `목록을 불러오지 못했습니다: ${e.message}`;
    listEl.appendChild(p);
    return;
  }

  const active = items
    .filter((r) => r.status === 'pending' || r.status === 'running')
    .sort((a, b) => a.scheduledAt - b.scheduledAt);
  const finished = items
    .filter((r) => r.status === 'done' || r.status === 'failed')
    .sort((a, b) => (b.executedAt || 0) - (a.executedAt || 0));

  listEl.innerHTML = '';
  if (!items.length) {
    const p = document.createElement('p');
    p.className = 'empty';
    p.textContent = '등록된 예약이 없습니다.';
    listEl.appendChild(p);
    return;
  }

  for (const resv of [...active, ...finished]) {
    const card = document.createElement('div');
    card.className = 'resv';

    const top = document.createElement('div');
    top.className = 'resv-top';
    const badge = document.createElement('span');
    badge.className = `badge ${resv.status}`;
    badge.textContent = STATUS_LABELS[resv.status] || resv.status;
    const actionEl = document.createElement('span');
    actionEl.className = 'resv-action';
    actionEl.textContent = ACTION_LABELS[resv.action] || resv.action;
    top.append(badge, actionEl);

    const summaryEl = document.createElement('div');
    summaryEl.className = 'resv-summary';
    summaryEl.textContent = resv.summary || '';

    const timeEl = document.createElement('div');
    timeEl.className = 'resv-time';
    timeEl.textContent =
      `예약: ${formatTime(resv.scheduledAt)}` +
      (resv.executedAt ? ` · 실행: ${formatTime(resv.executedAt)}` : '');

    card.append(top, summaryEl, timeEl);

    if (resv.error) {
      const errEl = document.createElement('div');
      errEl.className = 'resv-error';
      errEl.textContent = `사유: ${resv.error}`;
      card.appendChild(errEl);
    }

    const btns = document.createElement('div');
    btns.className = 'resv-btns';
    if (resv.status === 'pending' || resv.status === 'failed') {
      const runBtn = document.createElement('button');
      runBtn.textContent = resv.status === 'failed' ? '재시도' : '지금 실행';
      runBtn.addEventListener('click', async () => {
        runBtn.disabled = true;
        try {
          await send({ type: 'runNow', id: resv.id });
        } catch (e) {
          alert(`실행 실패: ${e.message}`);
        }
        renderList();
      });
      btns.appendChild(runBtn);
    }
    const delBtn = document.createElement('button');
    delBtn.className = 'danger';
    delBtn.textContent = '삭제';
    delBtn.addEventListener('click', async () => {
      if (resv.status === 'pending' && !confirm('대기 중인 예약입니다. 삭제할까요?')) return;
      try {
        await send({ type: 'deleteReservation', id: resv.id });
      } catch (e) {
        alert(`삭제 실패: ${e.message}`);
      }
      renderList();
    });
    btns.appendChild(delBtn);
    card.appendChild(btns);

    listEl.appendChild(card);
  }
}

// 백그라운드에서 예약 상태가 바뀌면 목록 자동 갱신
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.reservations && !$('tab-list').hidden) {
    renderList();
  }
});

// ───────────────────────── 설정 ─────────────────────────

const KNOWN_CLOUD_SUFFIXES = ['.dooray.com', '.gov-dooray.com', '.dooray.co.kr', '.gov-dooray.co.kr'];

$('save-settings').addEventListener('click', async () => {
  const statusEl = $('settings-status');
  const raw = $('dooray-url').value.trim();
  const apiKey = $('api-key').value.trim();
  if (!raw) return setStatus(statusEl, 'Dooray URL을 입력하세요.', 'err');
  if (!apiKey) return setStatus(statusEl, 'API Key를 입력하세요.', 'err');

  // 자체 설치형(알려진 클라우드 도메인이 아님)이면 해당 도메인 접근 권한을 추가로 요청
  try {
    const url = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
    const isCloud = KNOWN_CLOUD_SUFFIXES.some((s) => url.hostname.endsWith(s));
    if (!isCloud) {
      const granted = await chrome.permissions.request({ origins: [`${url.origin}/*`] });
      if (!granted) {
        return setStatus(statusEl, '해당 도메인 접근 권한이 거부되어 저장할 수 없습니다.', 'err');
      }
    }
  } catch {
    return setStatus(statusEl, '올바른 URL 형식이 아닙니다. 예: https://sota.dooray.com', 'err');
  }

  try {
    await send({ type: 'saveSettings', doorayUrl: raw, apiKey });
    setStatus(statusEl, '저장되었습니다. [연결 테스트]로 확인해 보세요.', 'ok');
    loadProjects();
  } catch (e) {
    setStatus(statusEl, `저장 실패: ${e.message}`, 'err');
  }
});

$('test-conn').addEventListener('click', async () => {
  const statusEl = $('settings-status');
  setStatus(statusEl, '연결 확인 중…');
  try {
    const me = await send({ type: 'testConnection' });
    setStatus(statusEl, `연결 성공 — ${me.name} 계정으로 인증되었습니다.`, 'ok');
  } catch (e) {
    setStatus(statusEl, `연결 실패: ${e.message}`, 'err');
  }
});

// ───────────────────────── 초기화 ─────────────────────────

async function init() {
  $('scheduled-at').value = defaultScheduleValue();
  applyActionFields();

  let settings = null;
  try {
    settings = await send({ type: 'getSettings' });
  } catch {
    // background 미기동 등 — 설정 탭에서 재시도 가능
  }

  if (settings) {
    $('dooray-url').value = settings.doorayUrl || '';
    $('api-key').value = settings.apiKey || '';
    loadProjects();
  } else {
    $('dooray-url').value = 'https://sota.dooray.com';
    switchTab('settings');
    setStatus($('settings-status'), 'Dooray URL과 API Key를 먼저 저장하세요.');
  }
}

init();
