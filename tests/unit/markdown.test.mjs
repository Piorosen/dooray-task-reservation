// 에디터 DOM → Dooray 마크다운 변환기 단위 테스트
// Dooray 댓글에서 쓸 수 있는 모든 작성 조건을 커버한다.

import test from 'node:test';
import assert from 'node:assert/strict';
import { convert, convertFull } from '../helpers/dom.mjs';

// ───────────────────────── 텍스트 · 서식 ─────────────────────────

test('일반 텍스트 문단', () => {
  const { content } = convert('<p>안녕하세요. 확인 부탁드립니다.</p>');
  assert.equal(content, '안녕하세요. 확인 부탁드립니다.');
});

test('여러 문단은 빈 줄로 구분된다', () => {
  const { content } = convert('<p>첫 문단</p><p>둘째 문단</p>');
  assert.equal(content, '첫 문단\n\n둘째 문단');
});

test('빈 문단은 Dooray 관례대로 <br> 로 보존된다', () => {
  const { content } = convert('<p>위</p><p><br></p><p>아래</p>');
  assert.equal(content, '위\n\n<br>\n\n아래');
});

test('굵게 · 기울임 · 취소선 · 밑줄', () => {
  const { content } = convert(
    '<p><b>굵게</b> <i>기울임</i> <s>취소</s> <u>밑줄</u></p>',
  );
  assert.equal(content, '**굵게** *기울임* ~~취소~~ <u>밑줄</u>');
});

test('강조 안팎의 공백은 마커 밖으로 밀려난다', () => {
  const { content } = convert('<p>앞<b> 굵게 </b>뒤</p>');
  assert.equal(content, '앞 **굵게** 뒤');
});

test('<br> 은 줄바꿈이 된다', () => {
  const { content } = convert('<p>첫 줄<br>둘째 줄</p>');
  assert.equal(content, '첫 줄\n둘째 줄');
});

test('마크다운 특수문자는 이스케이프된다', () => {
  const { content } = convert('<p>a*b_c[d]e`g</p>');
  assert.equal(content, 'a\\*b\\_c\\[d\\]e\\`g');
});

test('파이프는 일반 문단에서 이스케이프하지 않는다 (표에서만 의미가 있다)', () => {
  const { content } = convert('<p>a|b</p>');
  assert.equal(content, 'a|b');
});

test('줄머리 # 와 - 는 제목/목록으로 오독되지 않게 이스케이프', () => {
  const { content } = convert('<p># 제목아님</p><p>- 목록아님</p>');
  assert.equal(content, '\\# 제목아님\n\n\\- 목록아님');
});

// ───────────────────────── 제목 ─────────────────────────

test('H1~H6 은 마크다운 제목이 된다', () => {
  const { content } = convert('<h1>큰제목</h1><h3>작은제목</h3>');
  assert.equal(content, '# 큰제목\n\n### 작은제목');
});

// ───────────────────────── 하이퍼링크 ─────────────────────────

test('하이퍼링크', () => {
  const { content } = convert('<p><a href="https://www.dooray.com">두레이</a> 링크</p>');
  assert.equal(content, '[두레이](https://www.dooray.com) 링크');
});

test('href 없는 앵커는 텍스트만 남는다', () => {
  const { content } = convert('<p>앞 <a>그냥텍스트</a> 뒤</p>');
  assert.equal(content, '앞 그냥텍스트 뒤');
});

test('링크 텍스트 안의 서식도 유지된다', () => {
  const { content } = convert('<p><a href="https://x.com"><b>굵은</b> 링크</a></p>');
  assert.equal(content, '[**굵은** 링크](https://x.com)');
});

// ───────────────────────── 코드 ─────────────────────────

test('인라인 코드', () => {
  const { content } = convert('<p>변수 <code>foo_bar</code> 확인</p>');
  assert.equal(content, '변수 `foo_bar` 확인');
});

test('인라인 코드 안의 특수문자는 이스케이프하지 않는다', () => {
  const { content } = convert('<p><code>a*b_c[d]</code></p>');
  assert.equal(content, '`a*b_c[d]`');
});

test('코드 블록은 줄바꿈이 보존된다 (HTML 전송 시 뭉개지던 부분)', () => {
  const { content } = convert(
    '<pre><code class="language-python">def hello():\n    return "world"</code></pre>',
  );
  assert.equal(content, '```python\ndef hello():\n    return "world"\n```');
});

test('언어 표시 없는 코드 블록', () => {
  const { content } = convert('<pre>line1\nline2</pre>');
  assert.equal(content, '```\nline1\nline2\n```');
});

test('코드 블록 안에 백틱이 있으면 울타리를 늘린다', () => {
  const { content } = convert('<pre><code>```\nnested\n```</code></pre>');
  assert.match(content, /^````\n/);
  assert.ok(content.includes('```\nnested\n```'));
});

// ───────────────────────── 목록 ─────────────────────────

test('순서 없는 목록', () => {
  const { content } = convert('<ul><li>하나</li><li>둘</li></ul>');
  assert.equal(content, '- 하나\n- 둘');
});

test('순서 있는 목록', () => {
  const { content } = convert('<ol><li>첫째</li><li>둘째</li></ol>');
  assert.equal(content, '1. 첫째\n2. 둘째');
});

test('중첩 목록은 들여쓰기로 표현된다', () => {
  const { content } = convert('<ul><li>상위<ul><li>하위</li></ul></li></ul>');
  assert.equal(content, '- 상위\n  - 하위');
});

test('체크리스트', () => {
  const { content } = convert(
    '<ul><li><input type="checkbox" checked>완료</li><li><input type="checkbox">미완</li></ul>',
  );
  assert.equal(content, '- [x] 완료\n- [ ] 미완');
});

// ───────────────────────── 표 ─────────────────────────

test('단순 표는 마크다운 파이프 표가 된다', () => {
  const { content } = convert(
    '<table><thead><tr><th>항목</th><th>값</th></tr></thead>' +
      '<tbody><tr><td>A</td><td>1</td></tr><tr><td>B</td><td>2</td></tr></tbody></table>',
  );
  assert.equal(content, '| 항목 | 값 |\n| --- | --- |\n| A | 1 |\n| B | 2 |');
});

test('헤더 행이 없는 표도 유효한 마크다운 표가 된다', () => {
  const { content } = convert('<table><tr><td>A</td><td>1</td></tr></table>');
  const lines = content.split('\n');
  assert.equal(lines[1], '| --- | --- |');
  assert.equal(lines[2], '| A | 1 |');
});

test('표 셀 안의 파이프와 줄바꿈은 표를 깨뜨리지 않는다', () => {
  const { content } = convert(
    '<table><tr><td>a|b</td><td>1<br>2</td></tr></table>',
  );
  assert.ok(content.includes('| a\\|b | 1<br>2 |'), content);
});

test('셀 병합이 있는 표는 원본 HTML 표로 내보낸다', () => {
  const { content } = convert(
    '<table><tr><td rowspan="2">경북대</td><td>조수호</td></tr><tr><td>마준익</td></tr></table>',
  );
  assert.ok(content.startsWith('<table>'), content);
  assert.ok(content.includes('rowspan="2"'));
  assert.ok(content.includes('조수호'));
});

test('표 셀 안의 링크도 유지된다', () => {
  const { content } = convert(
    '<table><tr><th>타입</th><th>링크</th></tr>' +
      '<tr><td>IO</td><td><a href="https://github.com/axboe/fio">fio</a></td></tr></table>',
  );
  assert.ok(content.includes('[fio](https://github.com/axboe/fio)'), content);
});

// ───────────────────────── 인용 · 구분선 ─────────────────────────

test('인용문', () => {
  const { content } = convert('<blockquote><p>인용된 문장</p></blockquote>');
  assert.equal(content, '> 인용된 문장');
});

test('구분선', () => {
  const { content } = convert('<p>위</p><hr><p>아래</p>');
  assert.equal(content, '위\n\n---\n\n아래');
});

// ───────────────────────── 이미지 ─────────────────────────

test('이미지는 자리표시자로 수집된다', () => {
  const { content, images } = convert('<p><img src="blob:abc" alt="screen.png"></p>');
  assert.equal(images.length, 1);
  assert.equal(images[0].src, 'blob:abc');
  assert.equal(images[0].alt, 'screen.png');
  assert.match(content, /@@DTR_IMG_0@@/);
});

test('업로드 후 이미지는 Dooray 인라인 마크다운이 된다', () => {
  const { content } = convertFull('<p><img src="blob:abc" alt="screen.png"></p>');
  assert.equal(content, '![screen.png](/files/FILE0)');
});

test('리사이즈된 이미지는 width 를 보존하는 <img> 로 나간다', () => {
  const { content } = convertFull(
    '<p><img src="blob:abc" alt="a.png" style="width: 139px"></p>',
  );
  assert.equal(content, '<img src="/files/FILE0" alt="a.png" width="139" />');
});

test('이미지 여러 장의 순서와 대응이 유지된다', () => {
  const { content } = convertFull(
    '<p><img src="b:1" alt="one.png"></p><p><img src="b:2" alt="two.png"></p>',
    { fileId: (i) => `F${i}` },
  );
  assert.equal(content, '![one.png](/files/F0)\n\n![two.png](/files/F1)');
});

// ───────────────────────── 멘션 ─────────────────────────

test('dooray:// href 를 가진 멘션은 그대로 인식된다', () => {
  const { mentions } = convert(
    '<p><a href="dooray://ORG/members/123456789012345678">@차주형</a> 확인</p>',
  );
  assert.equal(mentions.length, 1);
  assert.equal(mentions[0].name, '차주형');
  assert.equal(mentions[0].resolved, true);
});

test('data 속성에 멤버 ID 가 있는 멘션도 인식된다', () => {
  const { mentions } = convert(
    '<p><span class="mention" data-member-id="4291687299319957161">@권효윤</span></p>',
  );
  assert.equal(mentions.length, 1);
  assert.equal(mentions[0].memberId, '4291687299319957161');
  assert.equal(mentions[0].name, '권효윤');
});

test('href 가 빈 앵커 멘션(실제로 깨졌던 형태)도 이름으로 잡아낸다', () => {
  const { mentions } = convert('<p><a href="">@정예원</a>&nbsp;확인 부탁</p>');
  assert.equal(mentions.length, 1);
  assert.equal(mentions[0].name, '정예원');
  assert.equal(mentions[0].resolved, false);
  assert.equal(mentions[0].memberId, undefined);
});

test('멘션은 Dooray 네이티브 마크업으로 치환된다', () => {
  const { content } = convertFull(
    '<p><span class="mention" data-id="4291687299319957161">@권효윤</span> 님 확인</p>',
    { orgId: '4257700934375023467' },
  );
  assert.equal(
    content,
    '[@권효윤](dooray://4257700934375023467/members/4291687299319957161 "member") 님 확인',
  );
});

test('그룹 멘션', () => {
  const { content } = convertFull(
    '<p><a href="dooray://4257700934375023467/member-groups/4257709183131081427">@2026-SOTA-공통업무/all</a></p>',
  );
  assert.equal(
    content,
    '[@2026-SOTA-공통업무/all](dooray://4257700934375023467/member-groups/4257709183131081427)',
  );
});

test('끝내 해석 못한 멘션은 평문 @이름 으로 남는다', () => {
  const { content } = convertFull('<p><a href="">@홍길동</a></p>', { orgId: '' });
  assert.equal(content, '@홍길동');
});

// ───────────────────────── 에디터 잔해 제거 ─────────────────────────

test('버튼·스크립트·숨김 요소는 본문에 섞이지 않는다', () => {
  const { content } = convert(
    '<p>본문</p><button>삭제</button><script>x=1</script>' +
      '<div style="display:none">숨김</div>',
  );
  assert.equal(content, '본문');
});

test('중첩 div 가 <p><p> 로 깨지지 않는다', () => {
  const { content } = convert('<div><div>안쪽</div></div>');
  assert.equal(content, '안쪽');
});

test('SPAN 스타일 래퍼는 내용만 남는다', () => {
  const { content } = convert('<p><span style="color:red">빨강</span> 글씨</p>');
  assert.equal(content, '빨강 글씨');
});

// ───────────────────────── 복합 시나리오 ─────────────────────────

test('멘션 + 표 + 코드 + 링크 + 이미지 복합 댓글', () => {
  const { content } = convertFull(
    '<p><a href="dooray://ORG/members/111111111111111111">@차주형</a> 결과 공유드립니다.</p>' +
      '<p><br></p>' +
      '<table><thead><tr><th>항목</th><th>값</th></tr></thead><tbody><tr><td>정확도</td><td>91%</td></tr></tbody></table>' +
      '<pre><code class="language-bash">python train.py --lr 1e-3</code></pre>' +
      '<p>자세한 내용은 <a href="https://sota.dooray.com">여기</a> 참고.</p>' +
      '<p><img src="blob:xyz" alt="chart.png"></p>',
    { fileId: () => '4396253873198280481' },
  );
  const expected = [
    '[@차주형](dooray://ORG/members/111111111111111111 "member") 결과 공유드립니다.',
    '<br>',
    '| 항목 | 값 |\n| --- | --- |\n| 정확도 | 91% |',
    '```bash\npython train.py --lr 1e-3\n```',
    '자세한 내용은 [여기](https://sota.dooray.com) 참고.',
    '![chart.png](/files/4396253873198280481)',
  ].join('\n\n');
  assert.equal(content, expected);
});
