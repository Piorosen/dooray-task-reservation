// Dooray Task Reservation — content script
// Dooray 페이지의 편집기('저장'/'등록' 버튼이 있는 에디터) 옆에 [예약] 버튼을 삽입한다.
// 버튼을 누르면 에디터에 작성 중인 내용을 그대로 캡처해 예약 등록 모달을 띄우고,
// 등록된 예약은 background 서비스 워커가 예약 시각에 자동 실행한다.

(() => {
  if (window.__dtrLoaded) return;
  window.__dtrLoaded = true;

  const SAVE_LABELS = ['저장', '등록', '댓글 작성'];
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
  function findEditor(fromEl) {
    let node = fromEl.parentElement;
    let depth = 0;
    while (node && depth < 8) {
      const candidates = [
        ...node.querySelectorAll('[contenteditable="true"], textarea, iframe'),
      ].filter(isVisible);
      if (candidates.length) return candidates[0];
      node = node.parentElement;
      depth += 1;
    }
    return null;
  }

  // ── 에디터 HTML 정화 ──
  // 스마트 에디터의 contenteditable 안에는 실제 내용 외에 이미지 리사이즈 핸들,
  // 편집 버튼, 숨김 div 같은 UI 부품이 섞여 있다. innerHTML 을 그대로 보내면
  // 이 잔해가 댓글/본문에 저장되므로(실측 확인), 화이트리스트 방식으로 재구성한다.

  const SKIP_TAGS = new Set(['BUTTON', 'SVG', 'STYLE', 'SCRIPT', 'SELECT', 'INPUT', 'TEXTAREA', 'NOSCRIPT']);
  const BLOCK_TAGS = new Set(['P', 'DIV', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'BLOCKQUOTE', 'PRE']);
  const KEEP_TAGS = new Set(['B', 'STRONG', 'I', 'EM', 'U', 'S', 'DEL', 'CODE', 'HR',
    'UL', 'OL', 'LI', 'TABLE', 'THEAD', 'TBODY', 'TR', 'TD', 'TH']);

  function escapeHtml(s) {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  // images 배열에 발견한 <img> 를 수집하고 본문에는 자리표시자를 남긴다
  function sanitizeEditorDom(rootEl, images) {
    const acc = [];
    (function walk(node, out) {
      for (const child of node.childNodes) {
        if (child.nodeType === Node.TEXT_NODE) {
          out.push(escapeHtml(child.nodeValue));
          continue;
        }
        if (child.nodeType !== Node.ELEMENT_NODE) continue;
        const el = child;
        const tag = el.tagName;
        if (SKIP_TAGS.has(tag)) continue;
        const cs = getComputedStyle(el);
        if (cs.display === 'none' || cs.visibility === 'hidden') continue;
        if ((cs.cursor || '').includes('resize')) continue; // 이미지 리사이즈 핸들
        if (tag === 'IMG') {
          const idx = images.length;
          images.push({
            src: el.getAttribute('src') || '',
            alt: el.getAttribute('alt') || '',
            width: el.style?.width || '',
          });
          out.push(`@@DTR_IMG_${idx}@@`);
          continue;
        }
        if (tag === 'BR') {
          out.push('<br>');
          continue;
        }
        if (tag === 'A') {
          const href = el.getAttribute('href') || '';
          const inner = [];
          walk(el, inner);
          out.push(`<a href="${escapeHtml(href)}">${inner.join('')}</a>`);
          continue;
        }
        if (BLOCK_TAGS.has(tag)) {
          const inner = [];
          walk(el, inner);
          const html = inner.join('');
          if (html.trim()) out.push(`<p>${html}</p>`);
          else if (el.querySelector('br')) out.push('<p><br></p>'); // 빈 줄 유지
          continue;
        }
        if (KEEP_TAGS.has(tag)) {
          const t = tag.toLowerCase();
          const inner = [];
          walk(el, inner);
          out.push(`<${t}>${inner.join('')}</${t}>`);
          continue;
        }
        walk(el, out); // SPAN 등 그 외 태그는 감싸지 않고 내용만 유지
      }
    })(rootEl, acc);
    return acc.join('');
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

  // 에디터가 임시 업로드한 이미지(/files/..., blob:, data:)를 페이지 세션으로 내려받아
  // base64 로 확보한다. 실행 시각에 대상 업무에 정식 첨부로 재업로드되고 cid 가 교체된다.
  async function resolveImages(html, images) {
    const files = [];
    for (let i = 0; i < images.length; i += 1) {
      const { src, alt, width } = images[i];
      const style = width ? ` style="width: ${escapeHtml(width)};"` : '';
      let replacement;
      try {
        if (!src) throw new Error('src 없음');
        const url = src.startsWith('data:') || src.startsWith('blob:') ? src : new URL(src, location.href).href;
        const res = await fetch(url, { credentials: 'include' });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const blob = await res.blob();
        // 고유 cid — 순번 방식(dtr-img-1)은 이미지 11장 이상에서 접두사 충돌(dtr-img-10)이 나므로 UUID 사용
        const cid = `dtr-${crypto.randomUUID()}`;
        const ext = ((blob.type.split('/')[1] || 'png').split('+')[0]) || 'png';
        const name = alt && /\.[a-z0-9]+$/i.test(alt) ? alt : `image-${i + 1}.${ext}`;
        files.push({ name, type: blob.type || 'image/png', dataBase64: await blobToB64(blob), cid });
        replacement = `<img src="cid:${cid}" alt="${escapeHtml(name)}"${style}>`;
      } catch {
        // 내려받기 실패 시 원본 src 라도 유지
        replacement = src ? `<img src="${escapeHtml(src)}" alt="${escapeHtml(alt)}"${style}>` : '';
      }
      // replace()는 치환 문자열의 $ 패턴을 해석하므로 파일명에 $가 있어도 안전한 split/join 사용
      html = html.split(`@@DTR_IMG_${i}@@`).join(replacement);
    }
    return { html, files };
  }

  async function captureContent(editor) {
    if (!editor) return { content: '', mimeType: 'text/html', files: [] };
    if (editor.tagName === 'TEXTAREA') {
      return { content: editor.value, mimeType: 'text/html', files: [] };
    }
    if (editor.tagName === 'IFRAME') {
      try {
        const doc = editor.contentDocument;
        if (doc?.body) return { content: doc.body.innerHTML, mimeType: 'text/html', files: [] };
      } catch {
        // cross-origin iframe 은 접근 불가
      }
      return { content: '', mimeType: 'text/html', files: [] };
    }
    // HTML 소스 편집기(CodeMirror 계열)는 텍스트 자체가 HTML 소스다
    if (editor.closest('.CodeMirror, .cm-editor')) {
      return { content: editor.textContent || '', mimeType: 'text/html', files: [] };
    }
    const images = [];
    const sanitized = sanitizeEditorDom(editor, images);
    const { html, files } = await resolveImages(sanitized, images);
    return { content: html, mimeType: 'text/html', files };
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
      if (el.dataset.dtrDone || el.className === 'dtr-reserve-btn') continue;
      if (!isSaveButton(el)) continue;
      const editor = findEditor(el);
      if (!editor) continue; // 편집기가 없는 화면의 저장 버튼은 무시
      el.dataset.dtrDone = '1';

      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'dtr-reserve-btn';
      btn.textContent = '⏰ 예약';
      btn.style.cssText = [
        'margin-left:6px',
        'padding:6px 14px',
        'border:1px solid #2563eb',
        'color:#2563eb',
        'background:#fff',
        'border-radius:4px',
        'cursor:pointer',
        'font-size:13px',
        'vertical-align:middle',
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

  function defaultScheduleValue() {
    const d = new Date(Date.now() + 10 * 60 * 1000);
    d.setSeconds(0, 0);
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }

  function htmlToPreviewText(html) {
    const div = document.createElement('div');
    div.innerHTML = html;
    return (div.textContent || '').trim();
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

  async function openModal(saveBtn) {
    const editor = findEditor(saveBtn);
    const captured = await captureContent(editor);

    const host = document.createElement('div');
    host.style.cssText = 'position:fixed;inset:0;z-index:2147483647;';
    const root = host.attachShadow({ mode: 'open' });
    root.innerHTML = `
      <style>
        * { box-sizing: border-box; margin: 0; padding: 0; }
        .overlay {
          position: fixed; inset: 0; background: rgba(0,0,0,.4);
          display: flex; align-items: center; justify-content: center;
          font-family: "Apple SD Gothic Neo", "Malgun Gothic", system-ui, sans-serif;
        }
        .panel {
          background: #fff; width: 380px; max-height: 85vh; overflow-y: auto;
          border-radius: 10px; padding: 18px; font-size: 13px; color: #1f2937;
          box-shadow: 0 10px 30px rgba(0,0,0,.3);
        }
        h2 { font-size: 15px; margin-bottom: 12px; color: #1d4ed8; }
        label { display: block; font-weight: 600; margin: 10px 0 4px; color: #374151; }
        input, select {
          width: 100%; padding: 7px 9px; border: 1px solid #d1d5db;
          border-radius: 6px; font-size: 13px; font-family: inherit; background: #fff;
        }
        input:focus, select:focus { outline: 2px solid #93c5fd; border-color: #2563eb; }
        .row { display: flex; gap: 6px; }
        .row input { flex: 1; }
        .row button {
          border: 1px solid #d1d5db; background: #fff; border-radius: 6px;
          padding: 0 12px; cursor: pointer; font-size: 12.5px;
        }
        .target {
          background: #eff6ff; border: 1px solid #bfdbfe; color: #1e40af;
          border-radius: 6px; padding: 8px 10px; margin-top: 10px; line-height: 1.5;
          word-break: break-all;
        }
        .preview {
          background: #f9fafb; border: 1px solid #e5e7eb; border-radius: 6px;
          padding: 8px 10px; margin-top: 10px; color: #6b7280; font-size: 12px;
          line-height: 1.5; word-break: break-all;
        }
        .status { margin-top: 8px; min-height: 16px; }
        .status.err { color: #dc2626; }
        .status.ok { color: #059669; }
        .btns { display: flex; gap: 8px; margin-top: 14px; justify-content: flex-end; }
        .btns button {
          border-radius: 6px; padding: 8px 16px; font-size: 13px; cursor: pointer;
          border: 1px solid #d1d5db; background: #fff;
        }
        .btns .primary {
          background: #2563eb; color: #fff; border: none; font-weight: 700;
        }
        .btns .primary:disabled { background: #93c5fd; }
      </style>
      <div class="overlay">
        <div class="panel">
          <h2>⏰ Dooray 예약 등록</h2>
          <label>작업 유형</label>
          <select id="action">
            <option value="comment-create">이 업무에 댓글 작성</option>
            <option value="task-update">이 업무의 본문 수정</option>
            <option value="task-create">새 업무 생성</option>
          </select>
          <div id="target" class="target" hidden></div>
          <div id="manual-wrap" hidden>
            <label>업무 ID (자동 감지 실패 — 직접 입력)</label>
            <div class="row">
              <input id="manual-post" placeholder="업무 ID" />
              <button id="resolve-btn">확인</button>
            </div>
          </div>
          <div id="create-wrap" hidden>
            <label>프로젝트</label>
            <select id="project"><option value="">불러오는 중…</option></select>
            <label>제목</label>
            <input id="subject" placeholder="업무 제목" />
          </div>
          <label>첨부파일 (선택 — 이미지는 인라인 표시)</label>
          <input id="files" type="file" multiple />
          <label>예약 시각</label>
          <input id="when" type="datetime-local" step="60" />
          <div class="preview" id="preview"></div>
          <p id="status" class="status"></p>
          <div class="btns">
            <button id="cancel">취소</button>
            <button id="save" class="primary">예약 등록</button>
          </div>
        </div>
      </div>
    `;
    document.body.appendChild(host);

    const $ = (id) => root.getElementById(id);
    const close = () => host.remove();
    $('cancel').addEventListener('click', close);
    root.querySelector('.overlay').addEventListener('click', (e) => {
      if (e.target === e.currentTarget) close();
    });

    $('when').value = defaultScheduleValue();

    const previewText = htmlToPreviewText(captured.content);
    const imgInfo = captured.files.length ? ` · 인라인 이미지 ${captured.files.length}장` : '';
    $('preview').textContent = previewText || captured.files.length
      ? `캡처된 내용 (${previewText.length}자${imgInfo}): ${previewText.slice(0, 80)}${previewText.length > 80 ? '…' : ''}`
      : '⚠️ 에디터에서 내용을 캡처하지 못했습니다. 내용을 작성한 뒤 다시 열어주세요.';

    const setStatus = (text, kind) => {
      const el = $('status');
      el.textContent = text;
      el.className = `status${kind ? ` ${kind}` : ''}`;
    };

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
      const fileList = [...$('files').files];
      if (!captured.content.trim() && !fileList.length && action !== 'task-update')
        return setStatus('캡처된 내용이 없습니다. 에디터에 내용을 작성한 뒤 다시 열어주세요.', 'err');
      if (fileList.reduce((sum, f) => sum + f.size, 0) > 25 * 1024 * 1024)
        return setStatus('첨부파일 총 용량은 25MB 이하만 지원합니다.', 'err');

      const params = { content: captured.content, mimeType: captured.mimeType };
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
        toast(`⏰ 예약이 등록되었습니다 — ${new Date(scheduledAt).toLocaleString('ko-KR')} (${ACTION_LABELS[action]})`);
      } catch (e) {
        setStatus(`예약 등록 실패: ${e.message}`, 'err');
        $('save').disabled = false;
      }
    });
  }
})();
