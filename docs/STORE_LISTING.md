# Chrome Web Store 등록 정보 (복사해서 붙여넣기용)

개발자 콘솔(https://chrome.google.com/webstore/devconsole/)의 각 입력란에
아래 내용을 그대로 붙여넣으면 됩니다.

---

## 스토어 등록정보 (Store Listing)

### 제목
```
Dooray Task Reservation
```

### 요약 (짧은 설명, 132자 이내)
```
Dooray 업무·댓글 작업(생성/수정/삭제)을 예약하고, 예약 시각에 자동으로 실행합니다. 서버 없이 브라우저만으로 동작합니다.
```

### 자세한 설명
```
NHN Dooray 사용자를 위한 예약 실행 도구입니다. 업무(Task)와 댓글 작업을 원하는 시각으로 예약해 두면, 그 시각에 자동으로 Dooray에 반영됩니다.

주요 기능
• 업무 생성/수정(제목·본문), 댓글 작성/수정/삭제 예약
• 첨부파일 예약 업로드 — 이미지는 본문·댓글에 인라인으로 표시
• 멤버 검색 후 @멘션 삽입 (Dooray가 알림 발송)
• Dooray 페이지의 에디터 옆에 [⏰ 예약] 버튼 자동 추가 — 작성 중인 내용(서식·이미지 포함)을 그대로 캡처해 예약
• 예약 목록에서 대기/완료/실패 상태 확인, 재시도·즉시 실행
• 예약 시각에 크롬이 꺼져 있었다면, 다음 실행 시 밀린 예약을 자동 전송

사용 방법
1. Dooray 웹 설정 → API → 개인 인증 토큰을 발급합니다.
2. 확장 설정 탭에 Dooray URL과 토큰을 저장하고 연결 테스트를 합니다.
3. 팝업 또는 Dooray 페이지의 [⏰ 예약] 버튼으로 예약을 등록합니다.

개인정보
모든 데이터(토큰, 예약 내용)는 브라우저 로컬에만 저장되며, 사용자가 지정한 Dooray 서버 외 어디로도 전송되지 않습니다.

※ 본 확장은 NHN Dooray의 공식 제품이 아닌 서드파티 도구입니다.
```

### 카테고리
```
생산성 → 워크플로 및 계획 (Workflow & Planning)
```

### 언어
```
한국어
```

---

## 개인정보 보호 (Privacy) 탭

### 단일 목적 설명 (Single purpose)
```
사용자가 지정한 시각에 NHN Dooray의 업무·댓글 작업(생성/수정/삭제)을 자동 실행하는 예약 기능을 제공합니다.
```

### 권한 사용 이유 (Permission justification)

**storage / unlimitedStorage**
```
사용자가 입력한 Dooray API 토큰과 예약 내용(본문, 첨부파일)을 브라우저 로컬에 보관하기 위해 사용합니다. 첨부파일을 예약 시각까지 로컬에 보관해야 하므로 unlimitedStorage가 필요합니다. 외부 서버로 전송하지 않습니다.
```

**alarms**
```
예약 시각에 서비스 워커를 깨워 예약된 Dooray 작업을 실행하기 위해 사용합니다.
```

**notifications**
```
예약 실행 성공/실패 결과를 사용자에게 알리기 위해 사용합니다.
```

**호스트 권한 (*.dooray.com, *.gov-dooray.com, *.dooray.co.kr, *.gov-dooray.co.kr)**
```
본 확장의 유일한 기능이 Dooray REST API 호출(업무·댓글 작성, 파일 업로드)입니다. Dooray는 민간/공공/금융 클라우드별로 도메인이 다르므로 각 API 도메인 접근이 필요합니다. 콘텐츠 스크립트는 Dooray 편집기 옆에 예약 버튼을 추가하기 위해 동일 도메인에만 삽입됩니다.
```

**원격 코드 사용 여부**
```
사용하지 않음 (모든 코드는 패키지에 포함되어 있습니다)
```

### 데이터 사용 (Data usage) 체크리스트

- "다음 사용자 데이터를 수집하거나 사용합니다" 항목: **인증 정보(Authentication information)** 하나만 체크
  (사용자가 직접 입력한 Dooray API 토큰을 로컬에 저장 — 개발자에게 전송되지 않음)
- 인증서: 아래 3개 모두 체크 가능
  - 승인된 사용 사례 외 제3자에게 판매하지 않음 ✓
  - 항목의 단일 목적과 무관한 용도로 사용·양도하지 않음 ✓
  - 신용도 판단·대출 목적으로 사용·양도하지 않음 ✓

### 개인정보처리방침 URL
```
https://github.com/Piorosen/dooray-task-reservation/blob/main/PRIVACY.md
```

---

## 검토자 참고사항 (Notes for reviewers) — 심사 지연 방지용

```
This extension is a scheduler for NHN Dooray (a Korean collaboration SaaS). All features require a Dooray account and a personal API token issued from the user's own Dooray settings page. Data (token, scheduled drafts) is stored only in chrome.storage.local and sent only to the Dooray API domain configured by the user. No analytics, no remote code.

To test: enter any Dooray tenant URL (e.g. https://sota.dooray.com) and a personal API token in the Settings tab. Without a token, the UI is still fully visible (Settings/New reservation/List tabs).
```

---

## 그래픽 자산

- 스토어 아이콘 128×128: `icons/icon128.png` (패키지에 포함된 것과 동일)
- 스크린샷 1280×800 (3장): `docs/store/screenshot-1.png` ~ `screenshot-3.png`
- 소형 프로모션 타일(440×280)은 선택 사항이라 생략
