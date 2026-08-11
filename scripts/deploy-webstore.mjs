// Chrome Web Store 자동 배포: 패키지 업로드 + 검토 제출(publish)
// 사용법: CWS_CLIENT_ID=... CWS_CLIENT_SECRET=... CWS_REFRESH_TOKEN=... CWS_EXTENSION_ID=... \
//         node scripts/deploy-webstore.mjs [zip경로]
import fs from 'node:fs';

const env = (key) => {
  const v = process.env[key];
  if (!v) {
    console.error(`환경변수 ${key} 가 필요합니다. docs/AUTOMATION.md 참고`);
    process.exit(1);
  }
  return v;
};

const zipPath = process.argv[2] || 'extension.zip';
if (!fs.existsSync(zipPath)) {
  console.error(`패키지 파일이 없습니다: ${zipPath}`);
  console.error('먼저: npm run build -- --out dist/extension.zip');
  process.exit(1);
}

const clientId = env('CWS_CLIENT_ID');
const clientSecret = env('CWS_CLIENT_SECRET');
const refreshToken = env('CWS_REFRESH_TOKEN');
const extensionId = env('CWS_EXTENSION_ID');

// 1) access token 갱신
const tok = await (
  await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type: 'refresh_token',
    }),
  })
).json();
if (!tok.access_token) {
  console.error('access token 발급 실패:', JSON.stringify(tok));
  process.exit(1);
}
const auth = { Authorization: `Bearer ${tok.access_token}`, 'x-goog-api-version': '2' };

// 2) 패키지 업로드
console.log(`업로드 중: ${zipPath} → 아이템 ${extensionId}`);
const upload = await (
  await fetch(`https://www.googleapis.com/upload/chromewebstore/v1.1/items/${extensionId}`, {
    method: 'PUT',
    headers: auth,
    body: fs.readFileSync(zipPath),
  })
).json();
console.log('업로드 결과:', upload.uploadState || JSON.stringify(upload));
if (upload.uploadState !== 'SUCCESS') {
  console.error('상세:', JSON.stringify(upload.itemError || upload, null, 2));
  process.exit(1);
}

// 3) 검토 제출 (publish — 심사가 자동으로 시작된다)
const publish = await (
  await fetch(
    `https://www.googleapis.com/chromewebstore/v1.1/items/${extensionId}/publish?publishTarget=default`,
    { method: 'POST', headers: auth },
  )
).json();
console.log('제출 결과:', JSON.stringify(publish.status || publish));
const ok = Array.isArray(publish.status) && publish.status.some((s) => s === 'OK' || s === 'ITEM_PENDING_REVIEW');
if (!ok) {
  console.error('상세:', JSON.stringify(publish, null, 2));
  process.exit(1);
}
console.log('✅ 검토 제출 완료 — 심사 상태는 개발자 콘솔에서 확인할 수 있습니다.');
