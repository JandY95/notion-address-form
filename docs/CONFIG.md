# CONFIG — 환경변수/설정값/운영 튜닝 가이드

## 1) Vercel Environment Variables (필수)
Vercel 프로젝트 Settings → Environment Variables 에 아래를 등록합니다.

- **NOTION_TOKEN**  
  Notion Integration Token (secret)

- **NOTION_DATABASE_ID**  
  Notion DB ID (출고 접수 관리 database_id)

- **TRACKING_ADMIN_PASS**  
  송장 반영(운영자 페이지) 실행용 비밀번호

⚠️ 주의  
- 이 값들은 **GitHub에 커밋/문서 저장 금지**  
- Production 환경으로 등록 후 Redeploy 필요

---

## 2) 노션 속성명(필수 일치)
코드에서 문자열로 참조하는 속성명(예시)

- 접수번호(Title)
- 고객명(Rich text)
- 연락처(Rich text)
- 우편번호(Rich text)
- 기본주소(Rich text)
- 상세주소(Rich text)
- 요청사항(Rich text)
- 처리상태(Status)
- 송장번호(Rich text)
- 출고일시(Date)
- 접수일시(Created time)

속성명이 다르면 “조회/반영 실패”가 발생합니다.

---

## 3) 성능/운영 설정값(매우 중요)

### A. CHUNK (클라이언트/프론트에서 분할 전송 단위)
- 의미: 송장 반영에서 엑셀 아이템을 **몇 개씩 나눠서 API로 보낼지**
- CHUNK가 **작아질수록**:
  - ✅ 한 번 실패해도 영향 범위가 작음(안정적)
  - ❌ API 호출 횟수(Invocations)가 증가 → **Vercel 무료 한도에 불리**
- CHUNK가 **커질수록**:
  - ✅ 호출 횟수 감소(비용 절약)
  - ❌ 한 번 실패하면 실패 범위가 커짐 / 요청 크기 증가

권장:
- 기본: 100~150
- 엑셀 건수가 1,000건 이상일 때: 150~250 시도(문제 생기면 다시 낮추기)

---

### B. UPDATE_DELAY_MS (서버에서 Notion 업데이트 사이 지연)
- 의미: Notion pages.update 호출을 너무 빠르게 연속 실행하면 제한/실패 가능
- 값을 **올리면**:
  - ✅ 안정성 증가(실패 감소)
  - ❌ 실행시간 증가(느려짐)
- 값을 **내리면**:
  - ✅ 빨라짐
  - ❌ Notion API 제한에 걸릴 확률 증가

권장:
- 기본: 300~500ms
- 오류가 잦으면: 700~1200ms

---

### C. DEFAULT_LOOKBACK_DAYS (최근 N일 조회)
- 의미: “출고준비” 상태인 페이지를 최근 N일에서만 찾음
- 값을 **늘리면**:
  - ✅ 오래된 접수도 매칭 가능
  - ❌ 조회량 증가 → 느려짐/호출 증가
권장:
- 기본: 14
- 간헐적으로 오래된 건 반영 필요 시: 21~30

---

### D. (옵션) 미일치 상태 확인 — MISS_CHECK_DELAY_MS / MAX_MISS_STATUS_CHECK
송장 반영 “미리보기”에서 **미일치 건의 이유를 노션에서 추가 조회**하는 기능(느림)

- MISS_CHECK_DELAY_MS:
  - 미일치 1건 조회 후 대기(ms)
  - 권장: 80~200ms

- MAX_MISS_STATUS_CHECK:
  - 미일치 상태 확인을 **최대 몇 건까지 할지(성능 보호)**
  - 권장: 30 (기본)
  - 늘리면: 원인 파악은 쉬워지지만, **느려지고 호출/CPU 사용 증가**

운영 권장:
- 기본 OFF로 두고, “원인 파악이 필요할 때만” 체크해서 사용

---

## 4) Vercel 무료 플랜(30일 기준)과 “초과 시”
Vercel Free(개인/호비 기준)에서 보통 아래 같은 사용량 지표가 있습니다.
(실제 표기는 Vercel 대시보드 “Usage” 화면을 따릅니다)

- Edge Requests
- Function Invocations
- Fluid Active CPU
- Fluid Provisioned Memory
- Data Transfer 등

초과 시:
- 서비스가 곧바로 “완전 정지”라기보다, **제한/차단/추가 과금 유도/성능 저하**가 발생할 수 있습니다.
- 따라서 “송장 반영”처럼 batch 작업은 **CHUNK/딜레이** 튜닝이 중요합니다.

운영 팁:
- CHUNK를 너무 작게 하지 않기
- “미일치 상태 확인(느림)”은 평소 OFF
- 엑셀 반영은 하루에 몰아서 1~2회 정도로 운영(불필요한 반복 호출 방지)

---

## 5) 문서 업데이트 규칙
- 설정값을 바꾸면 반드시 `CHANGELOG.md`에 기록
- 설정값의 “왜/언제/어떻게 조정하는지”를 이 문서에 함께 반영
