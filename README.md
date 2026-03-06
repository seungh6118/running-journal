# Running Journal (Garmin -> Strava -> This App)

이 프로젝트는 Garmin 데이터를 직접 API로 받지 않고,
Garmin Connect에서 Strava로 자동 동기화된 활동을 받아 훈련일지에 저장합니다.

## 1) 로컬 실행

```bash
npm install
copy .env.example .env
npm run dev
```

브라우저: http://localhost:3000

## 2) Strava 앱 생성

1. Strava API 설정 페이지에서 앱 생성
2. `Client ID`, `Client Secret` 확인 후 `.env`에 입력
3. Authorization Callback Domain은 로컬 개발 시 `localhost` 사용
4. Redirect URI는 아래 값으로 맞춤
   - `http://localhost:3000/auth/strava/callback`

참고: https://developers.strava.com/docs/getting-started/

## 3) 동기화 모드

### A. 앱 열 때 당겨오기

- 웹훅/터널 없이 사용 가능
- 앱 접속 시 자동으로 `/api/sync-now` 실행
- 화면의 `지금 동기화` 버튼으로 수동 갱신 가능

### B. 실시간 자동반영(Webhook)

- Strava Webhook 구독 + 공개 HTTPS 필요
- Strava 이벤트가 들어오면 새 활동 즉시 저장

참고: https://developers.strava.com/docs/webhooks/

## 4) PC 꺼도 동작하게 배포 (Railway 예시)

### 4-1. 코드 업로드

- 이 폴더를 GitHub 저장소로 push

### 4-2. Railway에 배포

1. Railway에서 `New Project` -> `Deploy from GitHub repo`
2. 서비스 생성 후 환경변수 설정:
   - `PORT=3000`
   - `APP_BASE_URL=https://<your-service-domain>`
   - `DB_PATH=/data/journal.db`
   - `DEFAULT_SYNC_DAYS=30`
   - `STRAVA_CLIENT_ID=...`
   - `STRAVA_CLIENT_SECRET=...`
   - `STRAVA_VERIFY_TOKEN=...`
   - `STRAVA_SCOPES=read,activity:read_all`
3. Railway Volume 추가 후 마운트 경로를 `/data`로 설정

### 4-3. Strava 앱 URL 교체

Strava API 앱 설정에서:
- `Authorization Callback Domain`: `<your-service-domain>`
- Redirect URI: `https://<your-service-domain>/auth/strava/callback`

### 4-4. Webhook 재등록

기존 ngrok 웹훅은 삭제하고 배포 URL로 새로 등록:
- callback: `https://<your-service-domain>/webhook/strava`
- verify_token: `STRAVA_VERIFY_TOKEN`

## 5) 현재 구현 범위

- Strava OAuth 연결
- 수동/자동 당겨오기 동기화 API (`POST /api/sync-now`)
- Webhook 검증/수신
- 활동 저장(SQLite) 및 최근 활동 표시
