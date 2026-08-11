// Chrome Web Store 제출용 패키지 빌드
//
//   node scripts/build.mjs          → dist/dooray-task-reservation-{version}.zip
//   node scripts/build.mjs --out X  → 지정한 경로로 zip 생성
//
// 실행 코드와 아이콘만 담는다. 테스트·문서·개발 설정·node_modules·.env 는 제외한다.
// manifest 가 참조하는 파일이 실제로 있는지, 빠뜨린 자산이 없는지 먼저 검사하고
// 확인된 목록만 스테이징한 뒤 압축하므로 "제외 규칙 실수로 비밀 파일 포함" 이 일어나지 않는다.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(ROOT, 'dist');
const STAGE = path.join(DIST, 'package');

const fail = (msg) => {
  console.error(`\n❌ ${msg}\n`);
  process.exit(1);
};

// ───────────────────────── manifest 검사 ─────────────────────────

const manifestPath = path.join(ROOT, 'manifest.json');
if (!fs.existsSync(manifestPath)) fail('manifest.json 이 없습니다.');

let manifest;
try {
  manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
} catch (e) {
  fail(`manifest.json 파싱 실패: ${e.message}`);
}

if (manifest.manifest_version !== 3) fail('manifest_version 은 3 이어야 합니다.');
if (!/^\d+\.\d+(\.\d+){0,2}$/.test(manifest.version || '')) {
  fail(`version 형식이 올바르지 않습니다: ${manifest.version}`);
}

// manifest 가 실제로 참조하는 파일을 전부 모은다 (수동 목록 관리로 인한 누락 방지)
const referenced = new Set(['manifest.json']);
const addRef = (p) => {
  if (typeof p === 'string' && p) referenced.add(p);
};

addRef(manifest.background?.service_worker);
addRef(manifest.action?.default_popup);
for (const cs of manifest.content_scripts || []) {
  (cs.js || []).forEach(addRef);
  (cs.css || []).forEach(addRef);
}
Object.values(manifest.icons || {}).forEach(addRef);
Object.values(manifest.action?.default_icon || {}).forEach(addRef);
for (const war of manifest.web_accessible_resources || []) {
  (war.resources || []).forEach(addRef);
}

// popup.html 이 불러오는 로컬 자산도 함께 담는다
const popup = manifest.action?.default_popup;
if (popup) {
  const popupFile = path.join(ROOT, popup);
  if (!fs.existsSync(popupFile)) fail(`팝업 파일이 없습니다: ${popup}`);
  const html = fs.readFileSync(popupFile, 'utf8');
  const dir = path.dirname(popup);
  for (const m of html.matchAll(/(?:src|href)\s*=\s*["']([^"']+)["']/g)) {
    const ref = m[1];
    if (/^(https?:|data:|#|\/\/)/.test(ref)) {
      fail(`팝업이 외부 리소스를 참조합니다 (스토어 정책 위반 소지): ${ref}`);
    }
    addRef(path.posix.join(dir, ref));
  }
}

const missing = [...referenced].filter((f) => !fs.existsSync(path.join(ROOT, f)));
if (missing.length) fail(`manifest/팝업이 참조하는 파일이 없습니다:\n   - ${missing.join('\n   - ')}`);

// ───────────────────────── 안전 검사 ─────────────────────────

// 개발용 파일이 실수로 참조 목록에 섞여 들어오지 않았는지 확인
const FORBIDDEN = /(^|\/)(\.env|node_modules|tests?|dist|test-artifacts|\.git|package(-lock)?\.json)(\/|$)/;
for (const f of referenced) {
  if (FORBIDDEN.test(f)) fail(`패키지에 포함되면 안 되는 경로가 참조되었습니다: ${f}`);
}

// 소스에 남은 개발 흔적 점검 (경고만)
for (const f of referenced) {
  if (!/\.(js|html|css)$/.test(f)) continue;
  const src = fs.readFileSync(path.join(ROOT, f), 'utf8');
  if (/\bdebugger\b/.test(src)) fail(`${f} 에 debugger 문이 남아 있습니다.`);
  if (/\bconsole\.log\(/.test(src)) console.warn(`⚠️  ${f} 에 console.log 가 있습니다.`);
}

// ───────────────────────── 스테이징 ─────────────────────────

fs.rmSync(DIST, { recursive: true, force: true });
fs.mkdirSync(STAGE, { recursive: true });

for (const f of [...referenced].sort()) {
  const dest = path.join(STAGE, f);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(path.join(ROOT, f), dest);
}

// ───────────────────────── 압축 ─────────────────────────

const outArg = process.argv.indexOf('--out');
const zipPath = outArg > -1 && process.argv[outArg + 1]
  ? path.resolve(process.argv[outArg + 1])
  : path.join(DIST, `dooray-task-reservation-${manifest.version}.zip`);

fs.rmSync(zipPath, { force: true });
fs.mkdirSync(path.dirname(zipPath), { recursive: true });

try {
  // -X: macOS 확장 속성/리소스 포크 제외, -r: 재귀
  execFileSync('zip', ['-X', '-r', '-q', zipPath, '.'], { cwd: STAGE, stdio: 'inherit' });
} catch (e) {
  fail(`압축 실패: ${e.message}`);
}

// ───────────────────────── 검증 & 요약 ─────────────────────────

const listing = execFileSync('unzip', ['-Z1', zipPath], { encoding: 'utf8' })
  .split('\n').map((s) => s.trim()).filter(Boolean).filter((s) => !s.endsWith('/'));

const unexpected = listing.filter((f) => !referenced.has(f));
if (unexpected.length) fail(`패키지에 예상치 못한 파일이 있습니다:\n   - ${unexpected.join('\n   - ')}`);
if (!listing.includes('manifest.json')) fail('패키지 루트에 manifest.json 이 없습니다.');

const size = fs.statSync(zipPath).size;
const kb = (n) => `${(n / 1024).toFixed(1)} KB`;

console.log(`\n✅ Chrome Web Store 패키지 생성 완료`);
console.log(`   ${path.relative(ROOT, zipPath)}  (${kb(size)}, ${listing.length}개 파일)\n`);
for (const f of listing.sort()) {
  console.log(`   ${f.padEnd(28)} ${kb(fs.statSync(path.join(STAGE, f)).size).padStart(10)}`);
}
console.log(`\n   버전 ${manifest.version} · ${manifest.name}`);
console.log(`   업로드: https://chrome.google.com/webstore/devconsole\n`);

fs.rmSync(STAGE, { recursive: true, force: true });
