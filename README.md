# THE LISTENING PARTY

리스닝 파티용 웹앱. Cloudflare Worker 하나로 돌아간다.

| 주소 | 화면 |
|---|---|
| `/admin/` | 관리자 — 재생목록 불러오기, 곡 정보·타임코드 편집, 참가자에게 공개 |
| `/` | 참가자 — 지금 곡, 지금까지 들은 곡 (실시간) |

## 폴더 구조

```
public/            그대로 서빙되는 화면들
  index.html       참가자 화면
  admin/index.html 관리자 화면
src/index.js       서버 (API + 실시간 연결)
wrangler.jsonc     Cloudflare 설정
```

## 동작 방식

- 곡 정보·타임코드는 관리자 브라우저에 저장된다 (JSON 내보내기로 백업).
- 관리자가 「참가자에게 공개」를 누른 곡만 서버로 간다. 서버는 아직 공개 안 된 곡을 모르므로, 참가자가 미래 곡을 볼 방법이 없다.
- 서버로 가는 필드: 제목, 아티스트, 앨범, 연도, 세션, 곡 해설, 감상 포인트, 관련곡. 선정 이유와 큐포인트는 가지 않는다.
- 공개·초기화는 관리자 토큰(`ADMIN_TOKEN`)이 있어야 된다.

## 처음 배포하기

1. Cloudflare 대시보드 → **Workers & Pages** → **Create** → **Import a repository** → 이 레포 선택 → Deploy
2. 배포된 Worker → **Settings** → **Variables and Secrets** → **Add** → 타입 Secret, 이름 `ADMIN_TOKEN`, 값은 원하는 비밀번호
3. `https://<worker 주소>/admin/` 접속 → 오른쪽 위에 토큰 입력

이후 GitHub에 push하면 자동으로 다시 배포된다.

## 내 컴퓨터에서 돌려보기 (선택)

```
npm install
echo ADMIN_TOKEN=test > .dev.vars
npm run dev
```

→ http://localhost:8787/admin/

## 다음 단계

- 메인 스크린 (`/screen/`)
- 곡 데이터를 D1으로 이전, 별점·댓글
