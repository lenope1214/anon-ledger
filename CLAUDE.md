# anon-ledger (거래장부)

컴장부를 대체하는 한국어 거래 장부 웹앱. 상호(거래처)·제품·거래를 관리하고 거래명세표를 인쇄한다.
UI 문구, 커밋 메시지, 문서는 모두 한국어를 사용한다.

## 브랜치 전략 (중요: PR을 만들지 않는다)

- `production` — 운영 브랜치 (Vercel 프로덕션 배포 → https://ledger.anon-chat.kr)
- `develop` — 개발 브랜치. 모든 작업의 기본 베이스 (Vercel 프리뷰 → https://dev-ledger.anon-chat.kr)
- `staging` — develop과 production 사이 중간 검증이 필요할 때만 사용
- 흐름: `feat/*` → `develop` → (`staging` →) `production`
- 작업이 끝나면 **PR 없이** 위 순서대로 직접 머지하고 푸시한다.
- **기본값: develop과 production에 동시에 반영한다** (2026-08-19 사용자 지시).
  작업 완료 → `feat/*` → `develop` → `production`까지 한 번에 머지·푸시하고,
  "운영 반영해줘"라는 별도 요청을 기다리지 않는다.
  사용자가 "운영에 바로 적용하지 마라"고 말하면 그때부터 develop에만 올린다.
- 기능이 develop에 머지될 때마다 package.json의 version을 올린다 —
  화면 하단 버전 표시(/api/version)로 배포 확인에 쓰인다.
- `main` 브랜치는 삭제되었다. 다시 만들거나 푸시하지 말 것
  (Vercel Production Branch는 `production`).
- DB는 환경별로 분리되어 있다: Production은 Neon 기본 브랜치,
  Preview(develop)는 Neon `dev` 브랜치의 DATABASE_URL을 사용한다.

## 실행과 검증

- 로컬 실행: `node server.js` → http://localhost:3000 (외부 패키지 불필요, 데이터는 `data/db.json`)
- 문법 검사: `node --check server.js lib/core.js public/app.js`
- 자동화된 테스트는 없다 — 변경 후 서버를 띄워 curl로 API를 검증할 것
  (인증이 있으므로 `curl -c/-b 쿠키파일`로 로그인 세션을 유지해야 한다)

## 구조

- `lib/core.js` — 공통 로직: API 라우터, 계정 인증(scrypt+세션 쿠키, 회원가입),
  부가세 계산. 저장소는 `setStore()`로 주입한다
- `lib/store-file.js` — 로컬 저장소 (`data/db.json` 파일 하나에 users/sessions)
- `lib/store-pg.js` — Vercel 저장소 (Neon Postgres, `users`·`sessions` 테이블.
  사용자 레코드는 jsonb 문서 한 건)
- `server.js` — 로컬 실행기: 정적 파일 서빙 + API 위임
- `api/index.js` — Vercel 서버리스 진입점 (`vercel.json`이 `/api/*`를 여기로 rewrite)
- `public/` — 바닐라 JS SPA (`index.html`, `app.js`, `style.css`, `login.html`)

## 주의사항

- **다중 사용자 + 승인제**: 계정마다 독립된 장부를 갖는다. 사용자 레코드는
  `{username, salt, hash, createdAt, status, isAdmin, ledger}`, 장부는
  `{seq, settings, companies, products, transactions, payments}`
- **첫 가입자 = 관리자(자동 승인)**. 이후 가입자는 `status: 'pending'`으로 시작하며
  관리자가 `/api/admin/users/:아이디/approve|reject`로 처리한다.
  승인 전 계정은 장부 API에서 403을 받는다
- 부가세 계산은 서버(`lib/core.js`)가 최종 권한 — 클라이언트 계산은 미리보기용이며
  두 곳의 `calcItem`을 항상 같게 유지할 것
- 장부 스키마를 바꿀 때는 `normalizeLedger()`에 기본값을 추가해
  예전 백업 파일도 읽히게 할 것
- 백업/복원(JSON 다운로드·업로드)이 로컬↔Vercel 데이터 이동 통로이므로 이 형식을 깨지 말 것
- 예전 단일 비밀번호 시절 데이터(`ledger` 테이블 / 예전 형식 db.json)는
  첫 가입자가 물려받는다 (`takeLegacyLedger`)

## 진행 상태 (2026-08-19 기준)

### 배포 현황

- **운영** https://ledger.anon-chat.kr — `production` 브랜치
- **개발** https://dev-ledger.anon-chat.kr — `develop` 브랜치
- 두 브랜치는 **같은 내용으로 유지**한다 (동시 반영이 기본값). 현재 **v1.12.0**
- 두 도메인 모두 Cloudflare 프록시(주황 구름) 상태 — SSL 자동 갱신 실패 위험이 있어
  DNS 전용(회색 구름)을 권했으나 사용자 미적용. Vercel 운영 브랜치 설정 위치는
  Settings → Environments → Production → Branch Tracking (구 UI의 Git 메뉴 아님)

### 완료된 기능

**계정·배포**
- 회원가입 + 관리자 승인제(첫 가입자=관리자, 승인 전에는 장부 API 403)
- 세션 90일 + 사용할 때마다 자동 연장, 로그인 화면 아이디 기억
- 승인 후 온보딩(내 업체 정보 등록), 화면 하단 버전 표시(`/api/version`)
- 정적 파일 `Cache-Control: no-cache`, API `no-store`

**상호·제품**
- 상호 등록/수정/삭제·검색, 없는 상호명을 적으면 자동 등록
- 제품은 상호별로 관리되며 거래 입력 시 자동 등록 + 최신 단가 갱신(마이너스 포함)

**거래 입력 (엑셀식 셀 그리드)**
- 상시 입력폼 없이 **셀을 누르면 그 자리에서 편집** (v1.13.0)
- 저장된 줄 아래로 빈 줄이 이어지고, 아래로 내리면 계속 생김(무한 스크롤).
  중간 빈 줄에도 자유롭게 입력 가능하며 저장해도 줄 위치가 바뀌지 않는다
- 이미 저장된 줄도 셀을 눌러 바로 수정(즉시 저장). 여러 품목 거래는
  날짜·상호·입금만 셀 수정 가능(품목은 팝업에서)
- Enter/Tab=다음 칸, 줄 끝에서 저장 후 다음 줄로, ↑↓←→로 칸 이동
- 품명을 비우면 직전 품목(품명·규격·단가)을 그대로 불러옴
  (수량은 사용자가 직접 건드렸으면 유지)
- `=` 단가 부호 토글(반품·차감), 부가세 3모드
- 행 체크: 클릭 토글, `=` 연속 체크 / `−` 건너뛰기 / `Backspace` 되돌리기,
  포인터 행 표시, 선택 소계 (고정 행에 가리지 않게 스크롤 보정)
- **F2 / 📌 커서 고정**: 저장 후 커서가 돌아갈 칸 지정 (기기에 기억)
- 날짜 범위·상호·품명 필터 + 초기화
- 휴대폰: 입력 중 키보드 위에 저장 막대(품명·합계 표시), 터치 기기에서만 표시
- **큰 글씨 모드**: 한 항목씩 크게 입력, 수량 −/＋ 버튼, [직전과 같게] 버튼

**검색 (ESC / 🔍)**
- 하단 도킹 패널(본문이 위로 밀림, 비모달)
- **커서가 있던 칸에 맞춰 검색** — 상호 칸이면 상호만, 품명 칸이면 제품만,
  칸에 적어둔 글자가 검색어로 들어가고 그 글자로 **시작하는 항목이 먼저** 나옴
- 상호 탭은 상호명·대표자명·사업자번호·연락처·주소를 입력칸으로 표시해 즉시 수정 가능
- 입력 행의 인라인 자동완성은 제거됨 (여러 품목 팝업·입금 팝업에는 남아 있음)

**수금·집계·증빙**
- **수금(입금)을 거래와 별개로 기록** (`payments`): 상호·날짜·금액·방법·메모.
  장부에 초록색 줄로 섞여 표시되고 미수금에서 자동 차감
- **거래처원장**: 상호별 거래·입금을 날짜순 + 누적 잔액, 기간 지정 시 '이월' 줄,
  원장 인쇄
- **집계 탭**: 월별 현황 / 거래처별 / 품목별 (연도 선택, 합계 줄, CSV 내려받기)
- 거래명세표 인쇄·PDF, 공급받는자 정보 인라인 수정, **카톡·문자로 보내기**(공유/복사)
- 거래·입금 내역 **엑셀(CSV) 내보내기** (현재 검색 조건 기준, BOM 포함)
- 백업(JSON 다운로드) / 복원(업로드)

**사용법 안내**
- 스포트라이트 튜토리얼 10단계, 첫 방문 시 자동 1회,
  [?] 버튼·[자세한 사용법 보기]로 재시작

### 다음 작업 후보 (사용자 요청 시)

- 매입(지출) 기록 → 손익 현황
- 미수금 연령분석(30/60/90일 경과), 어음 만기 관리
- [＋ 여러 품목 거래] 팝업에도 상호 자동 등록 적용
- 전자세금계산서 연동, 재고 관리 (범위 큼)

### 환경 메모

- Vercel은 package.json의 start 스크립트로 server.js를 직접 실행하는 방식으로
  배포된다 — server.js도 DATABASE_URL이 있으면 Neon을 쓰는 이유
- UI 검증은 Chromium + playwright-core로 실행한다 (`npm install --no-save playwright-core`,
  `executablePath: '/opt/pw-browsers/chromium'`, `NODE_PATH`로 모듈 경로 지정).
  터치 기기 동작은 `hasTouch: true`로 확인
- 로컬 테스트 계정: `newbie / pass1234` (data/db.json, git에 포함되지 않음)
