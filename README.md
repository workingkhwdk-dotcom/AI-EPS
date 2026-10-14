# AI-EPS 수업 도구 (MVP)

AI 활용 확장된 경험 기반 문제해결학습 모형(AI-EPS)을 수업에서 쓰기 위한 웹 서비스입니다.
주제는 "국내에 정착한 난민 문제", AI는 OpenAI GPT, 인프라는 Firebase입니다.

## 구조

```
public/            정적 웹 (Firebase Hosting)
  index.html, app.js     학생용: 수업 코드 입장 → 1~7단계 워크스페이스
  teacher.html, teacher.js  교사용: 수업 생성, 모둠 진행 현황, AI 로그, CSV
functions/         Cloud Functions (서울 리전)
  policy.js        GYR 규칙 엔진 (단위 테스트 있음)
  prompts.js       단계별 시스템 프롬프트
  case.js          난민 사건·가상 페르소나 4명·이해관계자 / 2단계 실제 자료 자리
  index.js         createSession, joinSession, getCase, aiRequest
firestore.rules    학생은 자기 모둠의 work만 수정, AI 로그는 서버만 기록
```

### 핵심 원리: GYR을 서버가 강제한다
| 단계 | AI | 서버가 확인하는 선행 조건 |
|---|---|---|
| 1 사건 경험 | 가상 인물 대화 | 모둠 사전 질문 3개 이상 저장 |
| 2 원인 탐색 | **차단** | - |
| 3 검증 | 질문 한 개씩 답변 | 2단계에서 만든 검증 질문만 허용 |
| 4 대안 구상 | 강점·약점 피드백만 | 모둠 대안 30자 이상 저장 |
| 5 시나리오 | 시나리오 2개 (1·3·5년 후) | 이해관계자 반응 예측 2개 이상 |
| 6, 7 | **차단** | - |

학생 브라우저는 OpenAI를 직접 호출하지 않습니다. 모든 호출은 `aiRequest`를 거치며, 입력과 응답이 모두 로그로 저장됩니다.

## 준비 (한 번만)

1. Firebase 콘솔에서 프로젝트를 만들고 **Blaze(종량제) 요금제**로 전환 (Cloud Functions 필요). 예산 알림을 설정하세요.
2. 콘솔에서 사용 설정: **Authentication**(익명, Google), **Firestore**(서울 `asia-northeast3` 권장).
3. 웹 앱을 등록하고 설정값을 `public/firebase-config.example.js`를 복사한 `public/firebase-config.js`에 붙여 넣기.
4. `.firebaserc`의 `YOUR-FIREBASE-PROJECT-ID`를 프로젝트 ID로 바꾸기.
5. 도구 설치와 로그인:
   ```bash
   npm i -g firebase-tools && firebase login
   cd functions && npm install && cd ..
   ```
6. OpenAI API 키를 비밀값으로 저장 (코드에 넣지 마세요):
   ```bash
   firebase functions:secrets:set OPENAI_API_KEY
   ```
7. 교사 계정과 모델 설정: `functions/.env` 파일을 만들어 아래처럼 작성
   ```
   TEACHER_EMAILS=교사구글계정@gmail.com
   OPENAI_MODEL=gpt-4o-mini
   ```
   (`OPENAI_MODEL`은 사용 가능한 모델명으로 바꿀 수 있습니다.)
8. 배포: `firebase deploy`

## 수업 진행

1. `/teacher.html`에서 구글 로그인 → 모둠 수를 정해 **수업 만들기** → 6자리 수업 코드 확인
2. 학생에게 `/` 주소, 수업 코드, 모둠 번호를 안내 (학생은 별명으로 입장, 로그인 불필요)
3. 교사 화면에서 모둠별 단계 진행 현황(1~7)과 AI 로그를 실시간으로 확인, 수업 후 CSV 내려받기

## 수업 전에 직접 채우거나 확인할 것

- `functions/case.js`의 `REAL_CASE_MATERIALS`에 **2단계 실제 사건 자료**(기사·보고서 요약, 출처, URL)를 넣으세요. 비어 있으면 학생 화면에 안내 문구만 표시됩니다. 페르소나는 모두 가상 설정이며 실제 사실로 단정하지 않도록 프롬프트에 제한을 두었습니다. 수업 의도에 맞게 수정하세요.
- `public/app.js`의 `CHECKLIST`(7단계 성찰 10문항)는 초안입니다. 연구에서 사용하는 문항으로 교체하세요.
- 학교 네트워크에서 Firebase·OpenAI 관련 도메인이 막히지 않는지 학생 기기로 미리 접속해 보세요.
- 학생 개인정보(실명 등)를 입력하지 않도록 안내하고, 로그를 연구에 쓸 계획이면 연구윤리·동의 절차를 확인하세요.
- AI 사용 한도: 모둠당 150회 (`functions/index.js`의 `MAX_AI_CALLS_PER_GROUP`).

## 개발·테스트

```bash
cd functions && npm test      # GYR 게이트 단위 테스트
```

## 아직 구현하지 않은 것 (델파이 의견 중 후속 과제)

복수 모델 피드백 비교, 페르소나·학생 입력의 자동 편향 점검, 이중 구조 AI(상위/하위), 모둠원별 서로 다른 인물 강제 배정(현재는 안내만), 5단계의 구조적 파급효과를 더 정교하게 다루는 다회차 시뮬레이션, 새 사건 등록 화면(현재는 `case.js` 직접 수정).
