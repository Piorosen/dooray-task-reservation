// Dooray Task Reservation — background service worker
// 예약 저장/알람 등록/예약 시각 도래 시 Dooray API 호출을 담당한다.
// MV3 서비스 워커는 상시 실행이 아니므로 모든 예약은 chrome.alarms 로 스케줄링한다.

const ALARM_PREFIX = 'resv:';
const DEFAULT_MIME = 'text/x-markdown';

// ───────────────────────── 스토리지 ─────────────────────────

async function getSettings() {
  const { settings } = await chrome.storage.local.get('settings');
  return settings || null;
}

async function getReservations() {
  const { reservations } = await chrome.storage.local.get('reservations');
  return reservations || {};
}

async function setReservations(reservations) {
  await chrome.storage.local.set({ reservations });
}

// Dooray 사이트 URL → API base URL.
// SaaS 클라우드(민간/공공/금융)는 전용 api 도메인을 쓰고, 그 외(자체 설치형)는 입력한 origin을 그대로 쓴다.
function deriveApiBase(doorayUrl) {
  const { hostname, origin } = new URL(doorayUrl);
  const clouds = [
    ['.gov-dooray.co.kr', 'https://api.gov-dooray.co.kr'],
    ['.gov-dooray.com', 'https://api.gov-dooray.com'],
    ['.dooray.co.kr', 'https://api.dooray.co.kr'],
    ['.dooray.com', 'https://api.dooray.com'],
  ];
  for (const [suffix, apiBase] of clouds) {
    if (hostname.endsWith(suffix)) return apiBase;
  }
  return origin;
}

// ───────────────────────── Dooray API ─────────────────────────

async function apiFetch(method, path, body) {
  const settings = await getSettings();
  if (!settings || !settings.apiKey) {
    throw new Error('설정 탭에서 Dooray URL과 API Key를 먼저 저장하세요.');
  }
  let res;
  try {
    res = await fetch(settings.apiBase + path, {
      method,
      headers: {
        Authorization: `dooray-api ${settings.apiKey}`,
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch (e) {
    throw new Error(`네트워크 오류: ${e.message}`);
  }
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    // 본문이 JSON이 아니면 상태 코드로만 판단
  }
  if (!res.ok) {
    const detail = json?.header?.resultMessage || `HTTP ${res.status}`;
    throw new Error(detail);
  }
  if (json?.header && json.header.isSuccessful === false) {
    throw new Error(json.header.resultMessage || 'Dooray API 오류');
  }
  return json;
}

// 업무 상세 조회 응답의 users(PostUser) → 업무 수정 요청의 users(CreatePostUser) 변환.
// PUT은 전체 업데이트라 기존 담당자/참조를 그대로 되돌려 보내야 유지된다.
function toCreateUser(u) {
  if (u?.member?.organizationMemberId) {
    return { type: 'member', member: { organizationMemberId: u.member.organizationMemberId } };
  }
  if (u?.emailUser?.emailAddress) {
    return {
      type: 'emailUser',
      emailUser: { emailAddress: u.emailUser.emailAddress, name: u.emailUser.name || '' },
    };
  }
  return null;
}

async function executeAction(action, p) {
  const mime = p.mimeType || DEFAULT_MIME;
  switch (action) {
    case 'task-create': {
      const users = { to: [], cc: [] };
      if (p.assignMe) {
        const me = await apiFetch('GET', '/common/v1/members/me');
        const myId = me?.result?.id;
        if (myId) users.to.push({ type: 'member', member: { organizationMemberId: myId } });
      }
      const res = await apiFetch('POST', `/project/v1/projects/${p.projectId}/posts`, {
        subject: p.subject,
        body: { mimeType: mime, content: p.content || '' },
        users,
      });
      return res?.result?.id || null;
    }
    case 'task-update': {
      const detail = (
        await apiFetch('GET', `/project/v1/projects/${p.projectId}/posts/${p.postId}`)
      )?.result;
      if (!detail) throw new Error('기존 업무를 불러오지 못했습니다.');
      const body = {
        subject: p.subject || detail.subject,
        body: p.content
          ? { mimeType: mime, content: p.content }
          : { mimeType: detail.body?.mimeType || mime, content: detail.body?.content ?? '' },
        users: {
          to: (detail.users?.to || []).map(toCreateUser).filter(Boolean),
          cc: (detail.users?.cc || []).map(toCreateUser).filter(Boolean),
        },
      };
      if (detail.dueDate) {
        body.dueDate = detail.dueDate;
        body.dueDateFlag = detail.dueDateFlag ?? true;
      }
      if (detail.milestone?.id) body.milestoneId = detail.milestone.id;
      if (detail.tags?.length) body.tagIds = detail.tags.map((t) => t.id);
      if (detail.priority) body.priority = detail.priority;
      await apiFetch('PUT', `/project/v1/projects/${p.projectId}/posts/${p.postId}`, body);
      return p.postId;
    }
    case 'task-delete':
      // Dooray 공개 API 문서에 업무 삭제 엔드포인트가 없어, 테넌트에 따라 거부될 수 있다.
      await apiFetch('DELETE', `/project/v1/projects/${p.projectId}/posts/${p.postId}`);
      return p.postId;
    case 'comment-create': {
      const res = await apiFetch(
        'POST',
        `/project/v1/projects/${p.projectId}/posts/${p.postId}/logs`,
        { body: { mimeType: mime, content: p.content || '' } },
      );
      return res?.result?.id || null;
    }
    case 'comment-update':
      await apiFetch(
        'PUT',
        `/project/v1/projects/${p.projectId}/posts/${p.postId}/logs/${p.logId}`,
        { body: { mimeType: mime, content: p.content || '' } },
      );
      return p.logId;
    case 'comment-delete':
      await apiFetch(
        'DELETE',
        `/project/v1/projects/${p.projectId}/posts/${p.postId}/logs/${p.logId}`,
      );
      return p.logId;
    default:
      throw new Error(`알 수 없는 작업 유형: ${action}`);
  }
}

// ───────────────────────── 예약 실행 ─────────────────────────

function notify(title, message) {
  chrome.notifications.create({
    type: 'basic',
    iconUrl: chrome.runtime.getURL('icons/icon128.png'),
    title,
    message: String(message).slice(0, 300),
  });
}

async function runReservation(id) {
  const reservations = await getReservations();
  const resv = reservations[id];
  if (!resv) return;
  if (resv.status === 'done' || resv.status === 'running') return;

  resv.status = 'running';
  resv.startedAt = Date.now();
  await setReservations(reservations);

  try {
    const resultId = await executeAction(resv.action, resv.params);
    resv.status = 'done';
    resv.error = null;
    if (resultId) resv.resultId = resultId;
    notify('Dooray 예약 실행 완료', resv.summary);
  } catch (e) {
    resv.status = 'failed';
    resv.error = e.message;
    notify('Dooray 예약 실행 실패', `${resv.summary}\n사유: ${e.message}`);
  }
  resv.executedAt = Date.now();

  // 실행 도중 팝업에서 삭제됐을 수 있으므로 다시 읽어 존재할 때만 갱신한다.
  const latest = await getReservations();
  if (latest[id]) {
    latest[id] = resv;
    await setReservations(latest);
  }
}

// 브라우저(재)시작 시: 미래 예약은 알람 재등록, 지나간 예약은 즉시 실행.
async function syncAlarms() {
  const reservations = await getReservations();
  const now = Date.now();
  let changed = false;

  for (const resv of Object.values(reservations)) {
    if (resv.status === 'running' && now - (resv.startedAt || 0) > 5 * 60 * 1000) {
      // 실행 도중 브라우저가 종료된 흔적 — 실패로 되돌려 재시도 가능하게 한다.
      resv.status = 'failed';
      resv.error = '실행 중 중단되었습니다. [지금 실행]으로 재시도할 수 있습니다.';
      changed = true;
      continue;
    }
    if (resv.status !== 'pending') continue;
    if (resv.scheduledAt <= now) {
      runReservation(resv.id);
    } else {
      chrome.alarms.create(ALARM_PREFIX + resv.id, { when: resv.scheduledAt });
    }
  }
  if (changed) await setReservations(reservations);
}

chrome.runtime.onStartup.addListener(syncAlarms);
chrome.runtime.onInstalled.addListener(syncAlarms);

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name.startsWith(ALARM_PREFIX)) {
    runReservation(alarm.name.slice(ALARM_PREFIX.length));
  }
});

// ───────────────────────── 팝업 메시지 처리 ─────────────────────────

async function handleMessage(msg) {
  switch (msg.type) {
    case 'saveSettings': {
      const raw = String(msg.doorayUrl || '').trim();
      const withScheme = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
      let apiBase;
      try {
        apiBase = deriveApiBase(withScheme);
      } catch {
        throw new Error('올바른 URL 형식이 아닙니다. 예: https://sota.dooray.com');
      }
      const apiKey = String(msg.apiKey || '').trim();
      if (!apiKey) throw new Error('API Key를 입력하세요.');
      const settings = { doorayUrl: new URL(withScheme).origin, apiBase, apiKey };
      await chrome.storage.local.set({ settings });
      return settings;
    }
    case 'getSettings':
      return getSettings();
    case 'testConnection': {
      const me = await apiFetch('GET', '/common/v1/members/me');
      return { id: me?.result?.id, name: me?.result?.name };
    }
    case 'listProjects': {
      const res = await apiFetch('GET', '/project/v1/projects?member=me&state=active&page=0&size=100');
      return (res?.result || []).map((pr) => ({ id: pr.id, code: pr.code }));
    }
    case 'listPosts': {
      const res = await apiFetch(
        'GET',
        `/project/v1/projects/${msg.projectId}/posts?page=0&size=100`,
      );
      return (res?.result || []).map((post) => ({
        id: post.id,
        number: post.number,
        subject: post.subject,
        closed: post.closed,
      }));
    }
    case 'listComments': {
      const res = await apiFetch(
        'GET',
        `/project/v1/projects/${msg.projectId}/posts/${msg.postId}/logs?page=0&size=100`,
      );
      return (res?.result || [])
        .filter((log) => log?.body?.content)
        .map((log) => ({
          id: log.id,
          creator: log.creator?.member?.name || '',
          snippet: String(log.body.content).slice(0, 60),
          createdAt: log.createdAt,
        }));
    }
    case 'saveReservation': {
      const id = crypto.randomUUID();
      const resv = {
        id,
        action: msg.action,
        params: msg.params,
        summary: msg.summary,
        scheduledAt: msg.scheduledAt,
        status: 'pending',
        createdAt: Date.now(),
      };
      const reservations = await getReservations();
      reservations[id] = resv;
      await setReservations(reservations);
      // when 이 과거이면 Chrome이 알람을 즉시 발화시키므로 별도 분기가 필요 없다.
      chrome.alarms.create(ALARM_PREFIX + id, { when: msg.scheduledAt });
      return resv;
    }
    case 'deleteReservation': {
      await chrome.alarms.clear(ALARM_PREFIX + msg.id);
      const reservations = await getReservations();
      delete reservations[msg.id];
      await setReservations(reservations);
      return true;
    }
    case 'runNow': {
      await chrome.alarms.clear(ALARM_PREFIX + msg.id);
      const reservations = await getReservations();
      if (reservations[msg.id]?.status === 'failed') {
        reservations[msg.id].status = 'pending';
        await setReservations(reservations);
      }
      await runReservation(msg.id);
      return true;
    }
    case 'getReservations':
      return Object.values(await getReservations());
    default:
      throw new Error(`알 수 없는 메시지: ${msg.type}`);
  }
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  handleMessage(msg)
    .then((data) => sendResponse({ ok: true, data }))
    .catch((e) => sendResponse({ ok: false, error: e.message }));
  return true; // 비동기 응답
});
