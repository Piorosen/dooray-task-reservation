// jsdom 위에서 editor-markdown.js / content.js 를 실제 코드 그대로 실행하기 위한 헬퍼

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { JSDOM } from 'jsdom';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

export function readSrc(name) {
  return readFileSync(path.join(ROOT, name), 'utf8');
}

/** editor-markdown.js 를 로드한 jsdom 환경을 만든다 */
export function makeDom(bodyHtml = '') {
  const dom = new JSDOM(`<!doctype html><html><body>${bodyHtml}</body></html>`, {
    runScripts: 'outside-only',
    pretendToBeVisual: true,
  });
  dom.window.eval(readSrc('editor-markdown.js'));
  return dom;
}

/** contenteditable 편집 영역을 만들고 마크다운 변환 결과를 돌려준다 */
export function convert(innerHtml) {
  const dom = makeDom(`<div id="editor" contenteditable="true">${innerHtml}</div>`);
  const { window } = dom;
  const editor = window.document.getElementById('editor');
  const result = window.DTR_MD.domToMarkdown(editor);
  return { ...result, window, dom };
}

/** 변환 + 멘션/이미지 자리표시자까지 최종 치환한 마크다운 */
export function convertFull(innerHtml, { orgId = 'ORG', fileId = (i) => `FILE${i}` } = {}) {
  const r = convert(innerHtml);
  let content = r.window.DTR_MD.applyMentions(r.content, r.mentions, orgId);
  r.images.forEach((img, i) => {
    content = r.window.DTR_MD.applyImage(
      content,
      i,
      r.window.DTR_MD.imageMarkup(img.alt || `image-${i + 1}.png`, `/files/${fileId(i)}`, img.width),
    );
  });
  return { ...r, content };
}
