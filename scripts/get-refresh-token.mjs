// Chrome Web Store API용 OAuth refresh token 1회 발급 도구
// 사용법: CWS_CLIENT_ID=... CWS_CLIENT_SECRET=... node scripts/get-refresh-token.mjs
import http from 'node:http';
import { exec } from 'node:child_process';

const clientId = process.env.CWS_CLIENT_ID;
const clientSecret = process.env.CWS_CLIENT_SECRET;
if (!clientId || !clientSecret) {
  console.error('CWS_CLIENT_ID / CWS_CLIENT_SECRET 환경변수를 설정한 뒤 실행하세요.');
  console.error('발급 방법: docs/AUTOMATION.md 참고');
  process.exit(1);
}

const server = http.createServer();
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const redirectUri = `http://127.0.0.1:${server.address().port}`;

const authUrl =
  'https://accounts.google.com/o/oauth2/v2/auth?' +
  new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: 'https://www.googleapis.com/auth/chromewebstore',
    access_type: 'offline',
    prompt: 'consent',
  });

console.log('브라우저가 열리면 Web Store 개발자 계정으로 동의해 주세요.');
console.log('(자동으로 안 열리면 직접 접속)', authUrl);
exec(`open "${authUrl}"`);

const code = await new Promise((resolve) => {
  server.on('request', (req, res) => {
    const url = new URL(req.url, redirectUri);
    const c = url.searchParams.get('code');
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.end(c ? '<h2>인증 완료 — 터미널로 돌아가세요.</h2>' : '대기 중…');
    if (c) {
      resolve(c);
      server.close();
    }
  });
});

const token = await (
  await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: redirectUri,
      grant_type: 'authorization_code',
    }),
  })
).json();

if (!token.refresh_token) {
  console.error('refresh token 발급 실패:', JSON.stringify(token));
  process.exit(1);
}
console.log('\n✅ CWS_REFRESH_TOKEN (안전하게 보관하세요):\n');
console.log(token.refresh_token);
