# anon-ledger (거래장부)

컴장부를 대체하는 한국어 거래 장부 웹앱. 상호(거래처)·제품·거래를 관리하고 거래명세표를 인쇄한다.
UI 문구, 커밋 메시지, 문서는 모두 한국어를 사용한다.

## 브랜치 전략 (중요: PR을 만들지 않는다)

- `production` — 운영 브랜치 (Vercel 프로덕션 배포 대상)
- `develop` — 개발 브랜치. 모든 작업의 기본 베이스
- `staging` — develop과 production 사이 중간 검증이 필요할 때만 사용
- 흐름: `feat/*` → `develop` → (`staging` →) `production`
- 작업이 끝나면 **PR 없이** 위 순서대로 직접 머지하고 푸시한다.

## 실행과 검증

- 로컬 실행: `node server.js` → http://localhost:3000 (외부 패키지 불필요, 데이터는 `data/db.json`)
- 문법 검사: `node --check server.js lib/core.js public/app.js`
- 자동화된 테스트는 없다 — 변경 후 서버를 띄워 curl로 API를 검증할 것
  (인증이 있으므로 `curl -c/-b 쿠키파일`로 로그인 세션을 유지해야 한다)

## 구조

- `lib/core.js` — 공통 로직: API 라우터, 인증(scrypt+세션 쿠키), 부가세 계산.
  저장소는 `setStore()`로 주입한다
- `lib/store-file.js` — 로컬 저장소 (`data/db.json` 파일 하나)
- `lib/store-pg.js` — Vercel 저장소 (Neon Postgres, `ledger` 테이블에 jsonb 문서 한 건)
- `server.js` — 로컬 실행기: 정적 파일 서빙 + API 위임
- `api/index.js` — Vercel 서버리스 진입점 (`vercel.json`이 `/api/*`를 여기로 rewrite)
- `public/` — 바닐라 JS SPA (`index.html`, `app.js`, `style.css`, `login.html`)

## 주의사항

- 부가세 계산은 서버(`lib/core.js`)가 최종 권한 — 클라이언트 계산은 미리보기용이며
  두 곳의 `calcItem`을 항상 같게 유지할 것
- 데이터는 장부 전체가 하나의 JSON 문서다. 스키마를 바꿀 때는 `normalizeDb()`에
  기본값을 추가해 예전 백업 파일도 읽히게 할 것
- 백업/복원(JSON 다운로드·업로드)이 로컬↔Vercel 데이터 이동 통로이므로 이 형식을 깨지 말 것
