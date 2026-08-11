// Dooray 에디터 DOM → Dooray 마크다운 변환기
//
// 왜 마크다운인가:
//   실제 Dooray 웹 UI가 저장하는 댓글/본문은 예외 없이 mimeType "text/x-markdown" 이다.
//   (실계정 sota.dooray.com 의 기존 댓글 전수 확인 — 멘션/이미지/표/코드 전부 마크다운)
//   HTML(text/html)로 올리면
//     · 멘션이 서버에서 해석되지 않아 죽은 링크가 되고 알림도 가지 않는다
//     · <pre> 안의 줄바꿈이 공백으로 뭉개져 코드 블록이 깨진다
//   이므로 에디터 내용은 Dooray 네이티브 마크다운으로 변환해 보낸다.
//
// Dooray 마크다운 방언(실측):
//   멘션   [@이름](dooray://{orgId}/members/{memberId} "member")
//   그룹멘션 [@그룹/all](dooray://{orgId}/member-groups/{groupId})
//   이미지  ![파일명](/files/{fileId})  또는  <img src="/files/{id}" alt="…" width="139" />
//   빈 줄   <br> 를 한 줄로 단독 배치
//   복잡한 표는 마크다운 대신 <table> 원본 HTML 을 그대로 허용
//
// 이 파일은 content script 로 주입되며 window.DTR_MD 로 노출된다.
// (content script 는 격리 세계에서 실행되므로 페이지 전역을 오염시키지 않는다)

(() => {
  const SKIP_TAGS = new Set([
    'BUTTON', 'SVG', 'STYLE', 'SCRIPT', 'SELECT', 'INPUT', 'TEXTAREA',
    'NOSCRIPT', 'IFRAME', 'CANVAS', 'AUDIO', 'VIDEO', 'TEMPLATE',
  ]);

  const IMG_PLACEHOLDER = (i) => `@@DTR_IMG_${i}@@`;
  const MENTION_PLACEHOLDER = (i) => `@@DTR_MEN_${i}@@`;

  // Dooray 내부 ID는 19자리 안팎의 긴 정수다.
  const LONG_ID = /\b\d{15,}\b/;

  function win(node) {
    return node.ownerDocument?.defaultView || globalThis;
  }

  function isSkippable(el) {
    if (SKIP_TAGS.has(el.tagName)) return true;
    const view = win(el);
    if (!view.getComputedStyle) return false;
    let cs;
    try {
      cs = view.getComputedStyle(el);
    } catch {
      return false;
    }
    if (!cs) return false;
    if (cs.display === 'none' || cs.visibility === 'hidden') return true;
    // 이미지 리사이즈 핸들 등 에디터 UI 부품
    if ((cs.cursor || '').includes('resize')) return true;
    return false;
  }

  // ───────────────────────── 멘션 인식 ─────────────────────────

  // 에디터가 멘션을 어떤 태그로 그리는지는 Dooray 버전마다 다르므로
  // (a[href^=dooray://], data-* 속성에 멤버 ID, class에 mention 등) 여러 단서를 함께 본다.
  function detectMention(el) {
    const text = (el.textContent || '').trim();
    if (!text.startsWith('@')) return null;
    const name = text.replace(/^@+/, '').trim();
    if (!name) return null;

    const attrs = el.getAttributeNames ? el.getAttributeNames() : [];
    const bag = attrs.map((a) => `${a}=${el.getAttribute(a)}`).join(' ');

    // 1) 완성된 dooray:// URL 이 이미 있으면 그대로 사용
    for (const a of attrs) {
      const v = el.getAttribute(a) || '';
      if (v.startsWith('dooray://')) {
        const kind = v.includes('/member-groups/') ? 'group' : 'member';
        return { name, url: v, kind, resolved: true };
      }
    }

    // 2) 속성 어딘가에 긴 숫자 ID + 멘션 단서
    const looksLikeMention =
      /mention/i.test(bag) ||
      /mention/i.test(el.className || '') ||
      /member/i.test(bag);
    const idMatch = bag.match(LONG_ID);
    if (looksLikeMention && idMatch) {
      const kind = /group/i.test(bag) ? 'group' : 'member';
      return { name, memberId: idMatch[0], kind, resolved: false };
    }

    // 3) 이름만 확보 — 예약 등록 시 API로 조회해 채운다
    if (looksLikeMention || el.tagName === 'A') {
      return { name, kind: 'member', resolved: false };
    }
    return null;
  }

  // ───────────────────────── 인라인 ─────────────────────────

  // 마크다운 문법으로 오독될 문자를 이스케이프한다.
  // 과하게 하면 본문이 지저분해지므로 실제 렌더링을 바꾸는 문자만 대상으로 한다.
  // 파이프(|)는 표 셀 안에서만 의미가 있으므로 renderTable 에서 따로 처리한다.
  // 여기서 함께 이스케이프하면 표 셀이 이중 이스케이프(\\|)된다.
  function escapeMd(text) {
    return text
      .replace(/([\\`*_[\]])/g, '\\$1')
      .replace(/^(\s*)([#>])/gm, '$1\\$2')
      .replace(/^(\s*)([-+])(\s)/gm, '$1\\$2$3')
      .replace(/^(\s*)(\d+)\.(\s)/gm, '$1$2\\.$3');
  }

  function collapseWs(text) {
    // 에디터 DOM 의 개행/들여쓰기는 렌더링상 공백 하나와 같다.
    return text.replace(/[\t\n\r]+/g, ' ').replace(/ {2,}/g, ' ');
  }

  function wrapIfContent(md, marker) {
    // 앞뒤 공백을 강조 표시 바깥으로 빼내야 "** bold **" 같은 깨짐이 없다
    const m = md.match(/^(\s*)([\s\S]*?)(\s*)$/);
    const [, pre, core, post] = m;
    if (!core) return md;
    return `${pre}${marker}${core}${marker}${post}`;
  }

  function renderInline(node, ctx) {
    let out = '';
    for (const child of node.childNodes) {
      if (child.nodeType === 3) {
        out += ctx.raw ? child.nodeValue : escapeMd(collapseWs(child.nodeValue));
        continue;
      }
      if (child.nodeType !== 1) continue;
      const el = child;
      if (isSkippable(el)) continue;
      const tag = el.tagName;

      if (tag === 'BR') {
        out += '\n';
        continue;
      }

      if (tag === 'IMG') {
        out += IMG_PLACEHOLDER(pushImage(el, ctx));
        continue;
      }

      const mention = detectMention(el);
      if (mention) {
        ctx.mentions.push(mention);
        out += MENTION_PLACEHOLDER(ctx.mentions.length - 1);
        continue;
      }

      if (tag === 'A') {
        const href = (el.getAttribute('href') || '').trim();
        const inner = renderInline(el, ctx).trim();
        if (!inner) continue;
        if (!href || href === '#') out += inner;
        else out += `[${inner}](${href.replace(/[()]/g, encodeURIComponent)})`;
        continue;
      }

      if (tag === 'CODE' || tag === 'KBD' || tag === 'SAMP') {
        const code = (el.textContent || '').replace(/\n/g, ' ');
        if (!code.trim()) continue;
        // 내용에 백틱이 있으면 울타리를 늘려야 한다
        const longest = (code.match(/`+/g) || []).reduce((a, b) => Math.max(a, b.length), 0);
        const fence = '`'.repeat(longest + 1);
        const pad = code.startsWith('`') || code.endsWith('`') ? ' ' : '';
        out += `${fence}${pad}${code}${pad}${fence}`;
        continue;
      }

      if (tag === 'B' || tag === 'STRONG') {
        out += wrapIfContent(renderInline(el, ctx), '**');
        continue;
      }
      if (tag === 'I' || tag === 'EM') {
        out += wrapIfContent(renderInline(el, ctx), '*');
        continue;
      }
      if (tag === 'S' || tag === 'DEL' || tag === 'STRIKE') {
        out += wrapIfContent(renderInline(el, ctx), '~~');
        continue;
      }
      if (tag === 'U' || tag === 'INS') {
        const inner = renderInline(el, ctx);
        out += inner.trim() ? `<u>${inner}</u>` : inner;
        continue;
      }

      out += renderInline(el, ctx); // SPAN, FONT 등은 내용만 유지
    }
    return out;
  }

  function pushImage(el, ctx) {
    ctx.images.push({
      src: el.getAttribute('src') || '',
      alt: el.getAttribute('alt') || '',
      // 사용자가 에디터에서 리사이즈한 크기를 보존한다 (Dooray는 <img width> 를 지원)
      width: el.getAttribute('width') || parseSizeStyle(el.style?.width) || '',
    });
    return ctx.images.length - 1;
  }

  function parseSizeStyle(v) {
    if (!v) return '';
    const m = String(v).match(/^(\d+(?:\.\d+)?)px$/);
    return m ? String(Math.round(Number(m[1]))) : '';
  }

  // ───────────────────────── 표 ─────────────────────────

  function tableRows(table) {
    const rows = [...table.querySelectorAll('tr')];
    return rows.map((tr) => [...tr.children].filter((c) => /^T[DH]$/.test(c.tagName)));
  }

  // 병합 셀이나 블록 콘텐츠가 있으면 마크다운 표로 표현할 수 없다 →
  // Dooray 가 허용하는 원본 <table> HTML 로 내보낸다.
  function needsHtmlTable(table) {
    for (const cell of table.querySelectorAll('td, th')) {
      const rs = Number(cell.getAttribute('rowspan') || 1);
      const cs = Number(cell.getAttribute('colspan') || 1);
      if (rs > 1 || cs > 1) return true;
      if (cell.querySelector('table, ul, ol, pre, blockquote')) return true;
    }
    const rows = tableRows(table);
    if (!rows.length) return true;
    const widths = new Set(rows.map((r) => r.length));
    return widths.size > 1; // 행마다 열 수가 다르면 마크다운 표 불가
  }

  function renderTable(table, ctx) {
    if (needsHtmlTable(table)) return serializeHtmlTable(table, ctx);

    const rows = tableRows(table);
    const cellMd = (cell) =>
      renderInline(cell, ctx).replace(/\n+/g, '<br>').replace(/\|/g, '\\|').trim() || ' ';

    const hasHeader = rows[0].every((c) => c.tagName === 'TH');
    const header = hasHeader ? rows[0] : null;
    const bodyRows = hasHeader ? rows.slice(1) : rows;
    const cols = rows[0].length;

    const lines = [];
    lines.push(`| ${(header ? header.map(cellMd) : Array(cols).fill(' ')).join(' | ')} |`);
    lines.push(`| ${Array(cols).fill('---').join(' | ')} |`);
    for (const r of bodyRows) lines.push(`| ${r.map(cellMd).join(' | ')} |`);
    return lines.join('\n');
  }

  // 병합 셀 표는 구조를 유지한 채 안전한 태그/속성만 남겨 직렬화한다.
  function serializeHtmlTable(table, ctx) {
    const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    const out = ['<table>'];
    for (const tr of table.querySelectorAll('tr')) {
      out.push('<tr>');
      for (const cell of [...tr.children].filter((c) => /^T[DH]$/.test(c.tagName))) {
        const tag = cell.tagName.toLowerCase();
        const rs = cell.getAttribute('rowspan');
        const cs = cell.getAttribute('colspan');
        const attrs =
          (rs && Number(rs) > 1 ? ` rowspan="${esc(rs)}"` : '') +
          (cs && Number(cs) > 1 ? ` colspan="${esc(cs)}"` : '');
        // 셀 안은 다시 마크다운으로 — Dooray 는 표 셀 내부 마크다운을 해석한다
        const inner = renderBlocks(cell, ctx).join('\n\n');
        out.push(`<${tag}${attrs}>\n\n${inner}\n\n</${tag}>`);
      }
      out.push('</tr>');
    }
    out.push('</table>');
    return out.join('');
  }

  // ───────────────────────── 목록 ─────────────────────────

  function renderList(listEl, ctx, depth) {
    const ordered = listEl.tagName === 'OL';
    const start = Number(listEl.getAttribute('start') || 1);
    const indent = '  '.repeat(depth);
    const lines = [];
    let i = 0;
    for (const li of [...listEl.children].filter((c) => c.tagName === 'LI')) {
      if (isSkippable(li)) continue;
      const marker = ordered ? `${start + i}.` : '-';
      // 체크리스트: <li> 안의 checkbox 를 마크다운 태스크로 표현
      const box = li.querySelector('input[type="checkbox"]');
      const task = box ? (box.checked ? '[x] ' : '[ ] ') : '';

      const nested = [];
      const own = [];
      for (const child of li.childNodes) {
        if (child.nodeType === 1 && (child.tagName === 'UL' || child.tagName === 'OL')) {
          nested.push(renderList(child, ctx, depth + 1));
        } else {
          own.push(child);
        }
      }
      const holder = li.ownerDocument.createElement('div');
      for (const n of own) holder.appendChild(n.cloneNode(true));
      const text = renderInline(holder, ctx).trim() || ' ';
      const [first, ...rest] = text.split('\n');
      lines.push(`${indent}${marker} ${task}${first}`);
      for (const r of rest) lines.push(`${indent}  ${r}`);
      for (const n of nested) lines.push(n);
      i += 1;
    }
    return lines.join('\n');
  }

  // ───────────────────────── 블록 ─────────────────────────

  const HEADING = /^H([1-6])$/;

  function renderBlocks(root, ctx) {
    const blocks = [];
    let inlineBuf = [];

    const flush = () => {
      if (!inlineBuf.length) return;
      const holder = root.ownerDocument.createElement('div');
      for (const n of inlineBuf) holder.appendChild(n.cloneNode(true));
      const md = renderInline(holder, ctx);
      if (md.trim()) blocks.push(md.replace(/^\n+|\n+$/g, ''));
      inlineBuf = [];
    };

    for (const child of root.childNodes) {
      if (child.nodeType === 3) {
        if (child.nodeValue.trim()) inlineBuf.push(child);
        continue;
      }
      if (child.nodeType !== 1) continue;
      const el = child;
      if (isSkippable(el)) continue;
      const tag = el.tagName;

      // 블록 요소가 아니면 인라인으로 모아둔다
      const isBlock =
        HEADING.test(tag) ||
        ['P', 'DIV', 'SECTION', 'ARTICLE', 'BLOCKQUOTE', 'PRE', 'UL', 'OL', 'TABLE', 'HR', 'FIGURE']
          .includes(tag);
      if (!isBlock) {
        inlineBuf.push(el);
        continue;
      }
      flush();

      const h = tag.match(HEADING);
      if (h) {
        const md = renderInline(el, ctx).replace(/\n/g, ' ').trim();
        if (md) blocks.push(`${'#'.repeat(Number(h[1]))} ${md}`);
        continue;
      }

      if (tag === 'HR') {
        blocks.push('---');
        continue;
      }

      if (tag === 'PRE') {
        // 코드 블록: 줄바꿈이 핵심이므로 textContent 를 그대로 보존한다
        const codeEl = el.querySelector('code') || el;
        const lang =
          (codeEl.className || '').match(/(?:language|lang|highlight)-([\w+#.-]+)/)?.[1] ||
          (el.className || '').match(/(?:language|lang|highlight)-([\w+#.-]+)/)?.[1] ||
          el.getAttribute('data-language') ||
          '';
        const code = (codeEl.textContent || '').replace(/\n+$/, '');
        if (!code.trim()) continue;
        const longest = (code.match(/^`{3,}/gm) || []).reduce((a, b) => Math.max(a, b.length), 2);
        const fence = '`'.repeat(Math.max(3, longest + 1));
        blocks.push(`${fence}${lang}\n${code}\n${fence}`);
        continue;
      }

      if (tag === 'BLOCKQUOTE') {
        const inner = renderBlocks(el, ctx).join('\n\n');
        if (inner.trim()) {
          blocks.push(inner.split('\n').map((l) => (l ? `> ${l}` : '>')).join('\n'));
        }
        continue;
      }

      if (tag === 'UL' || tag === 'OL') {
        const md = renderList(el, ctx, 0);
        if (md.trim()) blocks.push(md);
        continue;
      }

      if (tag === 'TABLE') {
        const md = renderTable(el, ctx);
        if (md.trim()) blocks.push(md);
        continue;
      }

      // P / DIV / SECTION …
      // 블록 자식을 품고 있으면 재귀, 아니면 문단 하나로 처리한다
      const hasBlockChild = [...el.children].some(
        (c) => HEADING.test(c.tagName) ||
          ['P', 'DIV', 'BLOCKQUOTE', 'PRE', 'UL', 'OL', 'TABLE', 'HR', 'SECTION', 'ARTICLE', 'FIGURE']
            .includes(c.tagName),
      );
      if (hasBlockChild) {
        blocks.push(...renderBlocks(el, ctx));
        continue;
      }
      const md = renderInline(el, ctx);
      if (md.trim()) blocks.push(md.replace(/^\n+|\n+$/g, ''));
      else if (el.querySelector('br') || el.innerHTML === '<br>') blocks.push('<br>');
      else if (!el.textContent.trim() && el.childNodes.length === 0) blocks.push('<br>');
    }
    flush();
    return blocks;
  }

  /**
   * 에디터 루트 DOM 을 Dooray 마크다운으로 변환한다.
   * 이미지와 멘션은 자리표시자로 남기고 목록으로 함께 반환한다
   * (이미지는 업로드 후 /files/{id} 로, 멘션은 멤버 ID 조회 후 링크로 치환).
   */
  function domToMarkdown(root) {
    const ctx = { images: [], mentions: [] };
    const blocks = renderBlocks(root, ctx);
    const content = blocks
      .join('\n\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
    return { content, images: ctx.images, mentions: ctx.mentions };
  }

  /** 멘션 자리표시자를 Dooray 멘션 마크업으로 치환 */
  function applyMentions(content, mentions, orgId) {
    mentions.forEach((m, i) => {
      let markup;
      if (m.url) {
        markup = `[@${m.name}](${m.url}${m.kind === 'group' ? '' : ' "member"'})`;
      } else if (m.memberId && orgId) {
        const seg = m.kind === 'group' ? 'member-groups' : 'members';
        markup = `[@${m.name}](dooray://${orgId}/${seg}/${m.memberId}${m.kind === 'group' ? '' : ' "member"'})`;
      } else {
        markup = `@${m.name}`; // 끝내 확인 실패 — 평문으로라도 남긴다
      }
      content = content.split(MENTION_PLACEHOLDER(i)).join(markup);
    });
    return content;
  }

  /** 이미지 자리표시자를 마크다운/HTML 이미지로 치환 */
  function imageMarkup(alt, src, width) {
    const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    // 폭 지정이 있으면 Dooray 가 지원하는 인라인 <img> 로 (마크다운은 폭 표현 불가)
    if (width) return `<img src="${esc(src)}" alt="${esc(alt)}" width="${esc(width)}" />`;
    const safeAlt = String(alt).replace(/[[\]]/g, '');
    return `![${safeAlt}](${String(src).replace(/[()\s]/g, encodeURIComponent)})`;
  }

  function applyImage(content, index, markup) {
    return content.split(IMG_PLACEHOLDER(index)).join(markup);
  }

  const api = {
    domToMarkdown,
    applyMentions,
    applyImage,
    imageMarkup,
    escapeMd,
    detectMention,
    IMG_PLACEHOLDER,
    MENTION_PLACEHOLDER,
  };

  if (typeof globalThis !== 'undefined') globalThis.DTR_MD = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
