# anon-ledger (거래장부)

컴장부를 대체하는 한국어 거래 장부 웹앱. 상호(거래처)·제품·거래를 관리하고 거래명세표를 인쇄한다.
UI 문구, 커밋 메시지, 문서는 모두 한국어를 사용한다.

## 브랜치 전략 (중요: PR을 만들지 않는다)

- `production` — 운영 브랜치 (Vercel 프로덕션 배포 → https://ledger.anon-chat.kr)
- `develop` — 개발 브랜치. 모든 작업의 기본 베이스 (Vercel 프리뷰 → https://dev-ledger.anon-chat.kr)
- `staging` — develop과 production 사이 중간 검증이 필요할 때만 사용
- 흐름: `feat/*` → `develop` → (`staging` →) `production`
- 작업이 끝나면 **PR 없이** 위 순서대로 직접 머지하고 푸시한다.
- 운영(production) 반영 시 package.json의 version을 올린다 —
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
  `{seq, settings, companies, products, transactions}`
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

## 진행 상태 (2026-08-14 기준)

- **완료**: 상호/제품/거래 관리, 거래명세표 인쇄, 부가세 3모드, 미수금 집계,
  백업/복원, 회원가입+관리자 승인제(첫 가입자=관리자), Vercel 배포
  (운영 https://ledger.anon-chat.kr 정상 동작, 관리자 계정 생성 완료),
  장부 시트형 거래 입력(품명·상호 자동완성 검색, 제품 자동 등록·최신 단가 갱신,
  마이너스 단가·'=' 부호 토글, 행 체크 =/−/Backspace 조작, 고정 헤더,
  날짜·상호·품명 필터, ESC 하단 도킹 검색 패널), 세션 자동 연장(90일 슬라이딩)
- **사용자(소유자)가 진행 중**: dev-ledger.anon-chat.kr 도메인 연결(Vercel Domains에서
  Git Branch=develop 지정 + Cloudflare CNAME), Neon `dev` 브랜치 생성 후
  Vercel Preview 환경 전용 DATABASE_URL 등록 — 완료 여부는 사용자에게 확인할 것
- **다음 작업 후보** (사용자 요청 시): 거래 목록 월별/기간 조회, 상호별 거래 합계표,
  거래명세표 양식 조정 등
- Vercel은 package.json의 start 스크립트로 server.js를 직접 실행하는 방식으로
  배포된다 — server.js도 DATABASE_URL이 있으면 Neon을 쓰는 이유
