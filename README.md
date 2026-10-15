# AI-EPS 수업 도구 (MVP)

AI 활용 확장된 경험 기반 문제해결학습 모형(AI-EPS)을 수업에서 쓰기 위한 웹 서비스입니다.
주제는 "2018년 제주 예멘 난민 신청 논란", AI는 OpenAI GPT, 인프라는 Firebase입니다.

## 구조

```
public/            정적 웹 (Firebase Hosting)
  index.html, app.js     학생용: 수업 코드 입장 → 1~7단계 워크스페이스
  teacher.html, teacher.js  교사용: 수업 생성, 모둠 진행 현황, AI 로그, CSV
functions/         Cloud Functions (서울 리전)
  policy.js        GYR 규칙 엔진 (단위 테스트 있음)
  prompts.js       단계별 시스템 프롬프트
  case.js          제주 예멘 사건, 출처 24건, 자료 기반 페르소나 4명 (출처별 verified 플래그)
  charter.js       상위 AI(사건 규범 감독자)의 규범: 사건 범위, 허용/범위 밖 주제, 인물 규칙
  guard.js         감독자 AI의 검사 프롬프트와 판정 해석, 위반 시 학생용 안내문
  scripts/         export-sources.js: 원문 대조 점검표(docs/PERSONA_SOURCES.md) 생성
docs/PERSONA_SOURCES.md  인물별 근거 진술과 출처 점검표 (수업 전 원문 대조용)
  index.js         createSession, joinSession, getCase, aiRequest
firestore.rules    학생은 자기 모둠의 work만 수정, AI 로그는 서버만 기록
```

### 핵심 원리: GYR을 서버가 강제한다
| 단계 | AI | 서버가 확인하는 선행 조건 |
|---|---|---|
| 1 사건 경험 | 자료 기반 인물 대화 (모둠원마다 서로 다른 인물) | 모둠 사전 질문 3개 이상 저장 |
| 2 원인 탐색 | **차단** | - |
| 3 검증 | 질문 한 개씩 답변 | 2단계에서 만든 검증 질문만 허용 |
| 4 대안 구상 | 강점·약점 피드백만 | 모둠 대안 30자 이상 저장 |
| 5 시나리오 | 시나리오 2개 (1·3·5년 후) | 이해관계자 반응 예측 2개 이상 |
| 6, 7 | **차단** | - |

학생 브라우저는 OpenAI를 직접 호출하지 않습니다. 모든 호출은 `aiRequest`를 거치며, 입력과 응답이 모두 로그로 저장됩니다.

## 배포 (Firebase 프로젝트: `knue-socialstudies-ai-eps`)

웹 앱 설정(`public/firebase-config.js`)과 프로젝트 ID(`.firebaserc`)는 이미 연결되어 있습니다. 아래는 **선생님 PC에서 한 번만** 하면 되는 작업입니다.

### 1. 콘솔에서 설정 (https://console.firebase.google.com/project/knue-socialstudies-ai-eps)
1. **요금제를 Blaze(종량제)로 전환** — Cloud Functions 배포에 필요합니다. 결제 예산 알림도 설정하세요.
2. **Authentication → 로그인 방법**: *익명*과 *Google*을 사용 설정 (학생은 익명, 교사는 구글 로그인).
3. **Firestore Database 만들기**: 위치는 `asia-northeast3`(서울) 권장, 프로덕션 모드로 시작 (보안 규칙은 배포 시 적용됩니다).
4. Authentication → 설정 → **승인된 도메인**에 `knue-socialstudies-ai-eps.web.app`, `knue-socialstudies-ai-eps.firebaseapp.com`이 있는지 확인 (보통 자동 등록).

### 2. 터미널에서 배포
```bash
git clone https://github.com/workingkhwdk-dotcom/AI-EPS.git && cd AI-EPS
git checkout claude/loving-fermat-vslak3

npm i -g firebase-tools
firebase login
cd functions && npm install && cd ..

# OpenAI API 키를 비밀값으로 저장 (코드·저장소에 넣지 않습니다)
firebase functions:secrets:set OPENAI_API_KEY

# 교사 계정·모델·리허설 설정
cp functions/.env.example functions/.env     # 열어서 TEACHER_EMAILS 를 본인 구글 계정으로 수정

firebase deploy
```
배포가 끝나면 학생용 주소는 `https://knue-socialstudies-ai-eps.web.app/`, 교사용은 `/teacher.html`입니다.

### 3. 첫 점검
1. `/teacher.html`에서 구글 로그인 → "인물·출처 점검"에 인물 4명이 보이는지 확인
2. 수업 만들기 → 6자리 코드 확인 → 다른 기기(휴대폰)에서 `/` 접속해 코드·모둠 번호·별명으로 입장
3. 사전 질문 3개를 만들고 인물과 대화, 교사 화면에서 로그와 감독자 판정(`guard`) 확인
4. 리허설이 끝나면 `functions/.env`의 `ALLOW_UNVERIFIED_PERSONAS`를 지우거나 `false`로 바꾸고 `firebase deploy --only functions`

> Analytics는 연결하지 않았습니다(학생 대상 서비스). 웹 설정값의 `apiKey`는 프로젝트 식별용 공개 값이며, 접근 통제는 Firestore 보안 규칙과 Cloud Functions가 담당합니다.

## 수업 진행

1. `/teacher.html`에서 구글 로그인 → 모둠 수를 정해 **수업 만들기** → 6자리 수업 코드 확인
2. 학생에게 `/` 주소, 수업 코드, 모둠 번호를 안내 (학생은 별명으로 입장, 로그인 불필요)
3. 교사 화면에서 모둠별 단계 진행 현황(1~7)과 AI 로그를 실시간으로 확인, 수업 후 CSV 내려받기

## 자료 기반 페르소나 4명 (중요)

| 인물 | 축 | 융합한 자료 유형 |
|---|---|---|
| 예멘에서 온 난민신청자 | 당사자 | 신청자 인터뷰(서울신문, 머니투데이, 알자지라), 인권위 상담 결과 |
| 불안해하는 제주 도민 | 반대·우려 | 상인 인터뷰, 반대 집회 주최·참가자 발언, 청원·여론 보도 |
| 난민 지원 단체 활동가 | 지원 | 제주예멘난민대책위, 이주민센터, 난민인권센터, 인권단체, 지원 현장 |
| 출입국·행정 담당자 | 제도 | 제주출입국·외국인청 일문일답, 법무부 발표, 제주도 대응, 청와대 답변 |

- 같은 유형의 여러 인터뷰는 한 인물로 **융합**했고, 근거는 `case.js`의 `basis`에 적혀 있습니다. 이름·나이·고향은 만들지 않고 역할로만 부릅니다.
- 진술마다 **종류**(증언 / 사실 / 주장 / 의견)와 출처가 붙어 있습니다. 인물은 주장·의견을 사실처럼 단정하지 않고, 검증되지 않은 주장은 "확인된 사실은 아니에요"라고 밝힙니다. 이 구분은 3단계 검증 활동의 재료가 됩니다.
- 자료에 없는 질문에는 "자료에 나와 있지 않아요"라고 답하고, 말한 내용마다 (자료n) 출처 번호가 붙습니다.
- **모둠원마다 서로 다른 인물이 자동 배정**됩니다. 학생은 배정된 인물과만 대화하고, 알아낸 점을 "내 말로" 적어 모둠에 공유합니다. 모둠원이 5명 이상이면 인물이 겹칩니다.

### 상위 AI(사건 규범 감독자)

인물 AI 위에 규범을 가진 감독 층이 있습니다(`charter.js`, `guard.js`).
1. **생성 단계**: 모든 인물 프롬프트에 규범이 들어갑니다 — 사건 범위(2018 제주 예멘), 허용 주제, 범위 밖 주제(다른 난민 사건, 현재 정치 예측, 종교·민족 일반 논쟁 등), 날조·단정·비하·결론 유도 금지.
2. **검사 단계**: 인물의 응답이 학생에게 가기 전에 감독자 AI가 `scope`(범위 이탈) / `fabrication`(근거 없는 사실) / `kind`(주장을 사실처럼) / `hate` / `advice` / `personal_info` 위반 여부를 검사합니다. 위반이면 응답을 안내문으로 바꾸고, **원래 응답과 위반 사유는 교사용 로그(`guard`)에만 남깁니다.** 감독자 호출이 실패하거나 응답 형식이 깨지면 안전 쪽(차단)으로 처리합니다.
3. 1단계 대화는 호출이 2번(인물 + 감독자) 일어나므로 비용이 약 2배입니다.
4. 한계: 감독자도 AI라 오판할 수 있습니다. 수업 전 리허설에서 범위 밖 질문, 비하 유도 질문, 자료에 없는 질문을 직접 던져 보고, 교사 로그의 `guard` 기록을 점검하세요.

### 원문 대조 (필수)

**근거 진술은 AI가 검색 결과 요약을 바탕으로 정리했고 원문을 직접 열람하지 못했습니다.** 모든 출처는 `verified:false`이며, 이 상태에서는 학생에게 인물이 노출되지 않습니다.
1. `docs/PERSONA_SOURCES.md`(또는 교사 화면의 "인물·출처 점검")에서 출처 링크를 열어 진술과 대조합니다.
2. 틀린 진술은 `functions/case.js`에서 고치고, 확인한 출처는 `verified: true`로 바꿉니다(`SOURCES`의 각 항목, 또는 파일 끝 일괄 `false` 설정 줄을 조정).
3. `cd functions && npm run export-sources > ../docs/PERSONA_SOURCES.md`로 점검표를 갱신하고 배포합니다.
- 리허설은 `functions/.env`에 `ALLOW_UNVERIFIED_PERSONAS=true`를 넣으면 대조 전 인물도 보입니다. 실제 수업 전에는 지우세요.
- 출처 제목 중 일부(J15, J17)는 설명 문구이며 실제 제목이 아닙니다.
- 아직 없는 관점: 어선·양식장 **고용주**(직접 인터뷰 자료 부족), 난민 인정자 본인의 장기 정착 증언. 자료를 찾으면 인물과 출처를 `case.js`에 추가하세요.

## 수업 전에 직접 확인할 것

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
