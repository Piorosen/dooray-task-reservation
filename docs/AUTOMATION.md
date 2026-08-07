# Chrome Web Store 자동 배포 설정

Chrome Web Store 공식 API로 **패키지 업로드 → 검토 제출**을 자동화합니다.
최초 1회의 OAuth 설정만 해두면, 이후에는 명령 한 줄(또는 git 태그 push)로 제출됩니다.

> ⚠️ 단, **스토어 등록정보(설명·스크린샷·개인정보 설정)는 API로 채울 수 없습니다.**
> 최초 제출 전에 개발자 콘솔에서 한 번만 입력해 두세요 —
> 붙여넣기용 문구는 [STORE_LISTING.md](STORE_LISTING.md)에 준비되어 있습니다.

## 1회 설정 (약 10분)

### 1. Google Cloud에서 OAuth 클라이언트 만들기

1. https://console.cloud.google.com 접속 → 새 프로젝트 생성 (이름 아무거나, 예: `cws-deploy`)
2. 상단 검색에서 **Chrome Web Store API** 검색 → **사용 설정**
3. **API 및 서비스 → OAuth 동의 화면**:
   - User Type: **외부(External)** → 앱 이름/이메일 입력 → 저장
   - **테스트 사용자**에 본인 Google 계정(Web Store 개발자 계정) 추가
4. **API 및 서비스 → 사용자 인증 정보 → 사용자 인증 정보 만들기 → OAuth 클라이언트 ID**:
   - 애플리케이션 유형: **데스크톱 앱**
   - 생성된 **클라이언트 ID**와 **클라이언트 보안 비밀번호**를 복사

### 2. Refresh Token 발급 (이 저장소의 스크립트 사용)

```bash
cd dooray-task-reservation
CWS_CLIENT_ID='클라이언트ID' CWS_CLIENT_SECRET='클라이언트시크릿' \
  node scripts/get-refresh-token.mjs
```

브라우저가 열리면 개발자 계정으로 동의 → 터미널에 출력되는
`CWS_REFRESH_TOKEN` 값을 복사해 안전한 곳에 보관합니다.

### 3. 확장 프로그램 ID 확인

개발자 콘솔(https://chrome.google.com/webstore/devconsole/)에서
**Dooray Task Reservation** 아이템을 열면 URL 또는 상세 화면에 32자 ID가 있습니다.

## 제출 방법 A — 로컬에서 한 줄

```bash
cd dooray-task-reservation
zip -r extension.zip manifest.json background.js content.js popup icons

CWS_CLIENT_ID='...' CWS_CLIENT_SECRET='...' \
CWS_REFRESH_TOKEN='...' CWS_EXTENSION_ID='...' \
  node scripts/deploy-webstore.mjs extension.zip
```

성공하면 `✅ 검토 제출 완료`가 출력되고 곧바로 심사 대기 상태가 됩니다.

## 제출 방법 B — GitHub Actions (완전 자동)

1. GitHub 저장소 → **Settings → Secrets and variables → Actions** 에 4개 등록:
   - `CWS_CLIENT_ID` / `CWS_CLIENT_SECRET` / `CWS_REFRESH_TOKEN` / `CWS_EXTENSION_ID`
2. 이후 둘 중 아무 방법으로 배포:
   - **Actions 탭 → "Deploy to Chrome Web Store" → Run workflow** 클릭
   - 또는 버전 태그 push:
     ```bash
     git tag v1.2.3 && git push --tags
     ```

## 새 버전 낼 때 체크리스트

1. `manifest.json`의 `"version"` 올리기 (같은 버전은 업로드 거부됨)
2. 커밋 & push
3. 방법 A 또는 B로 제출

## 문제 해결

- `업로드 결과: IN_PROGRESS` — 이전 업로드가 처리 중. 잠시 후 재시도.
- `ITEM_NOT_UPDATABLE` — 아이템이 심사 중이거나 반려 상태. 콘솔에서 상태 확인 후 재시도.
- `invalid_grant` — refresh token 만료(테스트 모드 OAuth 앱은 7일). OAuth 동의 화면을
  **프로덕션으로 게시**(App 게시 버튼)하면 만료되지 않습니다. 게시 후 토큰 재발급 1회 필요.
- 스토어 등록정보 미완성 오류 — 콘솔에서 등록정보/개인정보 탭을 채운 뒤 다시 제출.
