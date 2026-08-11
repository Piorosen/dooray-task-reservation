// Dooray Task Reservation — content script
// Dooray 페이지의 편집기('저장'/'등록' 버튼이 있는 에디터) 옆에 [예약] 버튼을 삽입한다.
// 버튼을 누르면 에디터에 작성 중인 내용을 Dooray 네이티브 마크다운으로 캡처해
// 예약 등록 모달을 띄우고, 등록된 예약은 background 서비스 워커가 예약 시각에 실행한다.

(() => {
  if (window.__dtrLoaded) return;
  window.__dtrLoaded = true;

  const MD = globalThis.DTR_MD;
  const MIME = 'text/x-markdown'; // Dooray 웹 UI 가 실제로 저장하는 형식
  const MAX_TOTAL_BYTES = 25 * 1024 * 1024;

  const SAVE_LABELS = ['저장', '등록', '댓글 작성', '댓글 등록', '확인'];
  const ACTION_LABELS = {
    'comment-create': '댓글 작성',
    'task-update': '업무 본문 수정',
    'task-create': '업무 생성',
  };

  // ───────────────────────── 메시지 ─────────────────────────

  function send(msg) {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage(msg, (res) => {
        if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
        if (!res) return reject(new Error('확장 프로그램 백그라운드 응답이 없습니다.'));
        if (res.ok) resolve(res.data);
        else reject(new Error(res.error));
      });
    });
  }

  // ───────────────────────── 에디터 탐지/캡처 ─────────────────────────

  function isVisible(el) {
    return !!el && el.getClientRects().length > 0;
  }

  // 저장 버튼에서 조상 방향으로 올라가며 같은 패널 안의 편집 영역을 찾는다.
  //
  // 주의: body 까지 올라가면 페이지 어딘가의 무관한 에디터가 잡힌다.
  // (설정 대화상자의 '저장', 필터의 '확인' 같은 버튼에도 예약 버튼이 붙어
  //  엉뚱한 에디터 내용을 예약하게 된다 — UI 테스트로 확인된 실제 버그)
  // 그래서 ①문서 루트 직전에서 멈추고 ②버튼과 화면상 가까운 에디터만 인정한다.
  const MAX_EDITOR_GAP_PX = 400;

  function findEditor(fromEl) {
    let node = fromEl.parentElement;
    let depth = 0;
    while (node && depth < 8) {
      if (node === document.body || node === document.documentElement) break;
      const candidates = [
        ...node.querySelectorAll('[contenteditable="true"], textarea, iframe'),
      ].filter(isVisible);
      const near = candidates.filter((el) => gapTo(el, fromEl) <= MAX_EDITOR_GAP_PX);
      if (near.length) return near.length === 1 ? near[0] : nearest(near, fromEl);
      node = node.parentElement;
      depth += 1;
    }
    return null;
  }

  // 에디터와 버튼 사이의 화면상 거리 (같은 입력 영역인지 판단)
  function gapTo(el, ref) {
    const a = el.getBoundingClientRect();
    const b = ref.getBoundingClientRect();
    const dy = a.bottom < b.top ? b.top - a.bottom : Math.max(0, a.top - b.bottom);
    const dx = a.right < b.left ? b.left - a.right : Math.max(0, a.left - b.right);
    return dy + dx;
  }

  function nearest(els, ref) {
    let best = els[0];
    let bestD = Infinity;
    for (const el of els) {
      const d = gapTo(el, ref);
      if (d < bestD) {
        bestD = d;
        best = el;
      }
    }
    return best;
  }

  async function blobToB64(blob) {
    const bytes = new Uint8Array(await blob.arrayBuffer());
    let bin = '';
    const CHUNK = 0x8000;
    for (let i = 0; i < bytes.length; i += CHUNK) {
      bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
    }
    return btoa(bin);
  }

  // 에디터가 임시로 올려둔 이미지(/files/…, blob:, data:)를 페이지 세션 권한으로 내려받아
  // base64 로 확보한다. 실행 시각에 대상 업무의 정식 첨부로 재업로드되고 cid 가 교체된다.
  async function resolveImages(content, images) {
    const files = [];
    const problems = [];
    for (let i = 0; i < images.length; i += 1) {
      const { src, alt, width } = images[i];
      try {
        if (!src) throw new Error('src 없음');
        const url = src.startsWith('data:') || src.startsWith('blob:')
          ? src
          : new URL(src, location.href).href;
        const res = await fetch(url, { credentials: 'include' });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const blob = await res.blob();
        // 고유 cid — 순번(dtr-img-1)은 11장 이상에서 접두사 충돌(dtr-img-10)이 나므로 UUID 사용
        const cid = `dtr-${crypto.randomUUID()}`;
        const ext = ((blob.type.split('/')[1] || 'png').split('+')[0]) || 'png';
        const name = alt && /\.[a-z0-9]+$/i.test(alt) ? alt : `image-${i + 1}.${ext}`;
        files.push({
          name,
          type: blob.type || 'image/png',
          dataBase64: await blobToB64(blob),
          size: blob.size,
          cid,
        });
        content = MD.applyImage(content, i, MD.imageMarkup(name, `cid:${cid}`, width));
      } catch (e) {
        // 내려받기 실패 — 원본 주소라도 살려 둔다 (외부 이미지/스티커는 이 경로가 정상)
        problems.push(alt || src.slice(0, 40));
        content = MD.applyImage(content, i, src ? MD.imageMarkup(alt || 'image', src, width) : '');
      }
    }
    return { content, files, problems };
  }

  // 멘션은 Dooray 마크다운으로 정확히 복원해야 알림이 간다.
  // 에디터 DOM 에서 멤버 ID 를 못 얻은 경우 이름으로 조회해 채운다.
  async function resolveMentions(content, mentions) {
    if (!mentions.length) return { content, mentions, orgId: '' };
    const needLookup = mentions.filter((m) => !m.url && !m.memberId).map((m) => m.name);
    let orgId = '';
    const found = new Map();
    const ambiguous = [];
    try {
      const res = await send({ type: 'resolveMentions', names: [...new Set(needLookup)] });
      orgId = res.orgId || '';
      for (const r of res.results || []) {
        if (r.candidates.length === 1) found.set(r.name, r.candidates[0]);
        else if (r.candidates.length > 1) ambiguous.push(r);
      }
    } catch {
      // 조회 실패 — 아래에서 평문 @이름 으로 대체된다
    }
    for (const m of mentions) {
      if (m.url || m.memberId) {
        m.resolved = true;
        continue;
      }
      const hit = found.get(m.name);
      if (hit) {
        m.memberId = hit.id;
        m.resolved = true;
      }
    }
    return { content: MD.applyMentions(content, mentions, orgId), mentions, ambiguous, orgId };
  }

  async function captureContent(editor) {
    const empty = { content: '', mimeType: MIME, files: [], mentions: [], problems: [] };
    if (!editor) return empty;

    // 마크다운/HTML 소스 편집기는 텍스트 자체가 이미 소스다
    if (editor.tagName === 'TEXTAREA') {
      return { ...empty, content: editor.value || '' };
    }
    if (editor.closest?.('.CodeMirror, .cm-editor')) {
      return { ...empty, content: editor.textContent || '' };
    }
    if (editor.tagName === 'IFRAME') {
      try {
        const doc = editor.contentDocument;
        if (doc?.body) return captureFromDom(doc.body);
      } catch {
        // cross-origin iframe 은 접근할 수 없다
      }
      return empty;
    }
    return captureFromDom(editor);
  }

  async function captureFromDom(rootEl) {
    const { content, images, mentions } = MD.domToMarkdown(rootEl);
    const img = await resolveImages(content, images);
    const men = await resolveMentions(img.content, mentions);
    return {
      content: men.content,
      mimeType: MIME,
      files: img.files,
      mentions: men.mentions,
      ambiguous: men.ambiguous || [],
      problems: img.problems,
    };
  }

  // URL 에서 업무(post) ID 후보 추출 — Dooray ID는 매우 긴 숫자
  function extractPostIdFromUrl() {
    const m = location.href.match(/(?:posts|tasks)\/(\d{8,})/);
    if (m) return m[1];
    const nums = location.href.match(/\d{15,}/g);
    return nums ? nums[nums.length - 1] : null;
  }

  // 업무 생성 화면의 제목 입력칸 추정
  function guessSubjectInput() {
    const inputs = [...document.querySelectorAll('input[type="text"], input:not([type])')].filter(
      (el) => isVisible(el) && /제목|subject|title/i.test(el.placeholder || el.name || el.id || ''),
    );
    return inputs[0] || null;
  }

  // ───────────────────────── 예약 버튼 삽입 ─────────────────────────

  function isSaveButton(el) {
    const text = (el.textContent || '').trim();
    return SAVE_LABELS.includes(text);
  }

  function scan() {
    for (const el of document.querySelectorAll('button, a[role="button"]')) {
      if (el.dataset.dtrDone || el.classList.contains('dtr-reserve-btn')) continue;
      if (!isSaveButton(el)) continue;
      const editor = findEditor(el);
      if (!editor) continue; // 편집기가 없는 화면의 저장 버튼은 무시
      el.dataset.dtrDone = '1';

      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'dtr-reserve-btn';
      btn.textContent = '⏰ 예약';
      btn.title = '이 내용을 지금 보내지 않고 지정한 시각에 자동으로 등록합니다';
      btn.style.cssText = [
        'margin-left:6px',
        'padding:6px 14px',
        'border:1px solid #2563eb',
        'color:#2563eb',
        'background:#fff',
        'border-radius:4px',
        'cursor:pointer',
        'font-size:13px',
        'font-weight:600',
        'vertical-align:middle',
        'line-height:1.4',
      ].join(';');
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        openModal(el);
      });
      el.insertAdjacentElement('afterend', btn);
    }
  }

  let scanTimer = null;
  const observer = new MutationObserver(() => {
    clearTimeout(scanTimer);
    scanTimer = setTimeout(scan, 500);
  });
  observer.observe(document.documentElement, { childList: true, subtree: true });
  scan();

  // ───────────────────────── 토스트 ─────────────────────────

  function toast(message) {
    const el = document.createElement('div');
    el.textContent = message;
    el.setAttribute('role', 'status');
    el.style.cssText = [
      'position:fixed',
      'bottom:24px',
      'left:50%',
      'transform:translateX(-50%)',
      'background:#1f2937',
      'color:#fff',
      'padding:10px 18px',
      'border-radius:8px',
      'font-size:13px',
      'z-index:2147483647',
      'box-shadow:0 4px 12px rgba(0,0,0,.25)',
    ].join(';');
    document.body.appendChild(el);
    setTimeout(() => el.remove(), 3500);
  }

  // ───────────────────────── 예약 모달 ─────────────────────────

  function toLocalInput(date) {
    const pad = (n) => String(n).padStart(2, '0');
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
      `T${pad(date.getHours())}:${pad(date.getMinutes())}`;
  }

  function defaultScheduleValue() {
    const d = new Date(Date.now() + 10 * 60 * 1000);
    d.setSeconds(0, 0);
    return toLocalInput(d);
  }

  function formatBytes(n) {
    if (n < 1024) return `${n}B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)}KB`;
    return `${(n / 1024 / 1024).toFixed(1)}MB`;
  }

  async function fileToB64(file) {
    const bytes = new Uint8Array(await file.arrayBuffer());
    let bin = '';
    const CHUNK = 0x8000;
    for (let i = 0; i < bytes.length; i += CHUNK) {
      bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
    }
    return btoa(bin);
  }

  const MODAL_CSS = `
    * { box-sizing: border-box; margin: 0; padding: 0; }
    .overlay {
      position: fixed; inset: 0; background: rgba(15,23,42,.55);
      display: flex; align-items: center; justify-content: center;
      font-family: "Apple SD Gothic Neo", "Malgun Gothic", system-ui, sans-serif;
    }
    .panel {
      background: #fff; width: 460px; max-width: calc(100vw - 32px);
      max-height: 88vh; display: flex; flex-direction: column;
      border-radius: 12px; font-size: 13px; color: #1f2937;
      box-shadow: 0 20px 50px rgba(0,0,0,.35);
    }
    header {
      padding: 16px 18px 12px; border-bottom: 1px solid #eef2f7;
      display: flex; align-items: center; justify-content: space-between;
    }
    h2 { font-size: 15px; color: #1d4ed8; font-weight: 700; }
    .x {
      border: none; background: none; cursor: pointer; font-size: 18px;
      color: #9ca3af; line-height: 1; padding: 2px 6px; border-radius: 4px;
    }
    .x:hover { background: #f3f4f6; color: #374151; }
    .body { padding: 4px 18px 16px; overflow-y: auto; }
    footer {
      padding: 12px 18px; border-top: 1px solid #eef2f7;
      display: flex; gap: 8px; justify-content: flex-end; align-items: center;
    }
    label { display: block; font-weight: 600; margin: 14px 0 5px; color: #374151; }
    label .sub { font-weight: 400; color: #9ca3af; margin-left: 4px; }
    input, select, textarea {
      width: 100%; padding: 7px 9px; border: 1px solid #d1d5db;
      border-radius: 6px; font-size: 13px; font-family: inherit; background: #fff;
      color: #1f2937;
    }
    textarea#content {
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      font-size: 12px; line-height: 1.55; min-height: 132px; resize: vertical;
      white-space: pre; overflow-wrap: normal; overflow-x: auto;
    }
    input:focus, select:focus, textarea:focus {
      outline: 2px solid #bfdbfe; outline-offset: -1px; border-color: #2563eb;
    }
    .row { display: flex; gap: 6px; }
    .row input { flex: 1; }
    .row button {
      border: 1px solid #d1d5db; background: #fff; border-radius: 6px;
      padding: 0 12px; cursor: pointer; font-size: 12.5px; white-space: nowrap;
    }
    .row button:hover { background: #f9fafb; }
    .target {
      background: #eff6ff; border: 1px solid #bfdbfe; color: #1e40af;
      border-radius: 6px; padding: 8px 10px; margin-top: 12px; line-height: 1.5;
      word-break: break-all;
    }
    .presets { display: flex; gap: 6px; margin-top: 6px; flex-wrap: wrap; }
    .presets button {
      border: 1px solid #d1d5db; background: #fff; border-radius: 999px;
      padding: 4px 11px; cursor: pointer; font-size: 12px; color: #4b5563;
    }
    .presets button:hover { border-color: #2563eb; color: #2563eb; }
    .chips { display: flex; gap: 5px; flex-wrap: wrap; margin-top: 6px; }
    .chip {
      border-radius: 999px; padding: 3px 9px; font-size: 11.5px;
      background: #ecfdf5; color: #047857; border: 1px solid #a7f3d0;
    }
    .chip.warn { background: #fffbeb; color: #b45309; border-color: #fde68a; }
    .files { margin-top: 6px; font-size: 12px; color: #6b7280; line-height: 1.7; }
    .files .f { display: flex; justify-content: space-between; gap: 8px; }
    .note {
      margin-top: 6px; font-size: 11.5px; color: #9ca3af; line-height: 1.5;
    }
    .status { margin-top: 10px; min-height: 16px; line-height: 1.5; }
    .status.err { color: #dc2626; }
    .status.ok { color: #059669; }
    .status.warn { color: #b45309; }
    footer button {
      border-radius: 6px; padding: 8px 16px; font-size: 13px; cursor: pointer;
      border: 1px solid #d1d5db; background: #fff;
    }
    footer button:hover { background: #f9fafb; }
    footer .primary {
      background: #2563eb; color: #fff; border-color: #2563eb; font-weight: 700;
    }
    footer .primary:hover { background: #1d4ed8; }
    footer .primary:disabled { background: #93c5fd; border-color: #93c5fd; cursor: default; }
  `;

  async function openModal(saveBtn) {
    const editor = findEditor(saveBtn);

    const host = document.createElement('div');
    host.style.cssText = 'position:fixed;inset:0;z-index:2147483647;';
    const root = host.attachShadow({ mode: 'open' });
    root.innerHTML = `
      <style>${MODAL_CSS}</style>
      <div class="overlay" role="dialog" aria-modal="true" aria-label="Dooray 예약 등록">
        <div class="panel">
          <header>
            <h2>⏰ Dooray 예약 등록</h2>
            <button class="x" id="close" title="닫기" aria-label="닫기">✕</button>
          </header>
          <div class="body">
            <label for="action">작업 유형</label>
            <select id="action">
              <option value="comment-create">이 업무에 댓글 작성</option>
              <option value="task-update">이 업무의 본문 수정</option>
              <option value="task-create">새 업무 생성</option>
            </select>

            <div id="target" class="target" hidden></div>

            <div id="manual-wrap" hidden>
              <label for="manual-post">업무 ID <span class="sub">자동 감지 실패 — 직접 입력</span></label>
              <div class="row">
                <input id="manual-post" placeholder="업무 ID" />
                <button id="resolve-btn" type="button">확인</button>
              </div>
            </div>

            <div id="create-wrap" hidden>
              <label for="project">프로젝트</label>
              <select id="project"><option value="">불러오는 중…</option></select>
              <label for="subject">제목</label>
              <input id="subject" placeholder="업무 제목" />
            </div>

            <label for="content">
              보낼 내용 <span class="sub">Dooray 마크다운 — 그대로 등록됩니다</span>
            </label>
            <textarea id="content" spellcheck="false" placeholder="에디터 내용을 불러오는 중…"></textarea>
            <div class="chips" id="chips"></div>
            <p class="note" id="capture-note"></p>

            <label for="files">첨부파일 <span class="sub">선택 — 이미지는 인라인 표시</span></label>
            <input id="files" type="file" multiple />
            <div class="files" id="file-list"></div>

            <label for="when">예약 시각</label>
            <input id="when" type="datetime-local" step="60" />
            <div class="presets">
              <button type="button" data-min="10">10분 후</button>
              <button type="button" data-min="60">1시간 후</button>
              <button type="button" data-min="180">3시간 후</button>
              <button type="button" data-tomorrow="9">내일 09:00</button>
              <button type="button" data-tomorrow="14">내일 14:00</button>
            </div>

            <p id="status" class="status" role="status"></p>
          </div>
          <footer>
            <button id="cancel" type="button">취소</button>
            <button id="save" class="primary" type="button">예약 등록</button>
          </footer>
        </div>
      </div>
    `;
    document.body.appendChild(host);

    const $ = (id) => root.getElementById(id);
    const close = () => {
      document.removeEventListener('keydown', onKey, true);
      host.remove();
    };
    const onKey = (e) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        close();
      }
    };
    document.addEventListener('keydown', onKey, true);
    $('cancel').addEventListener('click', close);
    $('close').addEventListener('click', close);
    root.querySelector('.overlay').addEventListener('click', (e) => {
      if (e.target === e.currentTarget) close();
    });

    const setStatus = (text, kind) => {
      const el = $('status');
      el.textContent = text;
      el.className = `status${kind ? ` ${kind}` : ''}`;
    };

    $('when').value = defaultScheduleValue();
    for (const b of root.querySelectorAll('.presets button')) {
      b.addEventListener('click', () => {
        const d = new Date();
        if (b.dataset.tomorrow) {
          d.setDate(d.getDate() + 1);
          d.setHours(Number(b.dataset.tomorrow), 0, 0, 0);
        } else {
          d.setMinutes(d.getMinutes() + Number(b.dataset.min), 0, 0);
        }
        $('when').value = toLocalInput(d);
        checkWhen();
      });
    }
    const checkWhen = () => {
      const t = new Date($('when').value).getTime();
      if (!Number.isNaN(t) && t <= Date.now()) {
        setStatus('지난 시각입니다. 이대로 등록하면 즉시 실행됩니다.', 'warn');
      } else if ($('status').classList.contains('warn')) {
        setStatus('');
      }
    };
    $('when').addEventListener('change', checkWhen);

    // ── 에디터 내용 캡처 (이미지 다운로드/멘션 조회로 시간이 걸릴 수 있다) ──
    let captured = { content: '', files: [], mentions: [], ambiguous: [], problems: [] };
    try {
      captured = await captureContent(editor);
    } catch (e) {
      setStatus(`내용 캡처 실패: ${e.message}`, 'err');
    }
    $('content').value = captured.content;
    $('content').placeholder = '보낼 내용을 입력하세요 (Dooray 마크다운)';

    // 캡처 결과 요약 — 무엇이 어떻게 변환됐는지 사용자가 확인할 수 있게
    const chips = $('chips');
    const addChip = (text, warn) => {
      const c = document.createElement('span');
      c.className = `chip${warn ? ' warn' : ''}`;
      c.textContent = text;
      chips.appendChild(c);
    };
    for (const m of captured.mentions || []) {
      addChip(m.resolved ? `@${m.name} ✓` : `@${m.name} — 멤버 확인 실패`, !m.resolved);
    }
    if (captured.files.length) addChip(`인라인 이미지 ${captured.files.length}장`);
    for (const p of captured.problems || []) addChip(`이미지 가져오기 실패: ${p}`, true);
    for (const a of captured.ambiguous || []) {
      addChip(`@${a.name} — 동명이인 ${a.candidates.length}명, 확인 필요`, true);
    }
    if (!captured.content.trim() && !captured.files.length) {
      $('capture-note').textContent =
        '⚠️ 에디터에서 내용을 캡처하지 못했습니다. 위 칸에 직접 입력해도 됩니다.';
    } else {
      $('capture-note').textContent =
        '위 내용은 그대로 등록됩니다. 필요하면 직접 수정하세요.';
    }

    // ── 첨부파일 목록 ──
    const renderFiles = () => {
      const list = $('file-list');
      list.innerHTML = '';
      const picked = [...$('files').files];
      let total = captured.files.reduce((s, f) => s + (f.size || 0), 0);
      for (const f of picked) total += f.size;
      for (const f of picked) {
        const row = document.createElement('div');
        row.className = 'f';
        const n = document.createElement('span');
        n.textContent = f.name;
        const s = document.createElement('span');
        s.textContent = formatBytes(f.size);
        row.append(n, s);
        list.appendChild(row);
      }
      if (total > 0) {
        const row = document.createElement('div');
        row.className = 'f';
        row.style.cssText = 'margin-top:4px;border-top:1px solid #f3f4f6;padding-top:4px';
        const n = document.createElement('span');
        n.textContent = `합계 (인라인 이미지 포함)`;
        const s = document.createElement('span');
        s.textContent = formatBytes(total);
        s.style.color = total > MAX_TOTAL_BYTES ? '#dc2626' : '#6b7280';
        row.append(n, s);
        list.appendChild(row);
      }
      return total;
    };
    $('files').addEventListener('change', renderFiles);
    renderFiles();

    // ── 대상 업무 자동 감지 ──
    let resolved = null;
    async function tryResolve(postId) {
      if (!postId) return false;
      try {
        resolved = await send({ type: 'resolvePost', postId });
        $('target').hidden = false;
        $('target').textContent = `대상 업무: #${resolved.number} ${resolved.subject}`;
        $('manual-wrap').hidden = true;
        return true;
      } catch {
        return false;
      }
    }

    const autoDetected = await tryResolve(extractPostIdFromUrl());

    $('resolve-btn').addEventListener('click', async () => {
      const ok = await tryResolve($('manual-post').value.trim());
      if (!ok) setStatus('해당 ID의 업무를 찾을 수 없습니다.', 'err');
      else setStatus('');
    });

    // ── 작업 유형별 표시 전환 ──
    let projectsLoaded = false;
    async function applyAction() {
      const action = $('action').value;
      const needsPost = action !== 'task-create';
      $('create-wrap').hidden = needsPost;
      $('target').hidden = !(needsPost && resolved);
      $('manual-wrap').hidden = !(needsPost && !resolved);

      if (!needsPost && !projectsLoaded) {
        projectsLoaded = true;
        try {
          const projects = await send({ type: 'listProjects' });
          const sel = $('project');
          sel.innerHTML = '<option value="">프로젝트 선택</option>';
          for (const p of projects) {
            const opt = document.createElement('option');
            opt.value = p.id;
            opt.textContent = p.code;
            sel.appendChild(opt);
          }
        } catch (e) {
          setStatus(`프로젝트 목록 로드 실패: ${e.message}`, 'err');
        }
        const subjectInput = guessSubjectInput();
        if (subjectInput?.value) $('subject').value = subjectInput.value;
      }
    }
    $('action').addEventListener('change', applyAction);
    $('action').value = autoDetected ? 'comment-create' : 'task-create';
    applyAction();

    // ── 등록 ──
    $('save').addEventListener('click', async () => {
      const action = $('action').value;
      const when = $('when').value;
      if (!when) return setStatus('예약 시각을 선택하세요.', 'err');
      const scheduledAt = new Date(when).getTime();
      if (Number.isNaN(scheduledAt)) return setStatus('예약 시각이 올바르지 않습니다.', 'err');

      const content = $('content').value;
      const fileList = [...$('files').files];
      if (!content.trim() && !fileList.length && !captured.files.length && action !== 'task-update')
        return setStatus('보낼 내용이 없습니다. 내용을 입력하거나 파일을 첨부하세요.', 'err');

      const total = renderFiles();
      if (total > MAX_TOTAL_BYTES)
        return setStatus(
          `첨부 총 용량이 ${formatBytes(total)}입니다. 25MB 이하만 지원합니다.`, 'err');

      const params = { content, mimeType: MIME };
      const allFiles = [...captured.files]; // 에디터에서 캡처한 인라인 이미지 (cid 교체용)
      if (fileList.length) {
        setStatus('첨부파일 읽는 중…');
        for (const f of fileList) {
          allFiles.push({ name: f.name, type: f.type, dataBase64: await fileToB64(f) });
        }
        setStatus('');
      }
      if (allFiles.length) params.files = allFiles;
      let summary = '';

      if (action === 'task-create') {
        const projectSel = $('project');
        if (!projectSel.value) return setStatus('프로젝트를 선택하세요.', 'err');
        const subject = $('subject').value.trim();
        if (!subject) return setStatus('업무 제목을 입력하세요.', 'err');
        params.projectId = projectSel.value;
        params.subject = subject;
        summary = `[${projectSel.selectedOptions[0].textContent}] "${subject}"`;
      } else {
        if (!resolved) return setStatus('대상 업무를 먼저 확인하세요.', 'err');
        if (!resolved.projectId)
          return setStatus('업무의 소속 프로젝트를 확인할 수 없습니다. 팝업에서 등록해 주세요.', 'err');
        params.projectId = resolved.projectId;
        params.postId = resolved.postId;
        summary = `#${resolved.number} ${resolved.subject}`;
      }

      $('save').disabled = true;
      try {
        await send({ type: 'saveReservation', action, params, summary, scheduledAt });
        close();
        toast(
          `⏰ 예약이 등록되었습니다 — ${new Date(scheduledAt).toLocaleString('ko-KR')}` +
          ` (${ACTION_LABELS[action]})`,
        );
      } catch (e) {
        setStatus(`예약 등록 실패: ${e.message}`, 'err');
        $('save').disabled = false;
      }
    });
  }

  // 테스트 훅 — content script 는 격리 세계에서 실행되므로 페이지에는 노출되지 않는다.
  window.__dtr = { captureContent, findEditor, extractPostIdFromUrl, openModal, scan, isSaveButton };
})();
