# 교사 주제 만들기 (설계와 진행 상황)

교사가 웹앱 안에서 새 수업 주제(사건)를 만든다. 서버 AI가 기본 주제(`functions/cases/*.js`)와 같은 구조·같은 설계 원칙으로
출처·사건·인물 9명·자료·사례·이후 전개를 만들고, 교사가 출처 원문을 확인한 뒤 '내 주제'로 쓴다. 주제는 만든 교사 계정에만 속한다.

## 기본 주제만큼 정교하게 만들기 위한 장치

기본 주제는 사람이 여러 번 고치며 만들었다. 웹앱에서는 그 과정을 단계로 나눠 흉내 낸다.

1. **근거 먼저(사실 은행)**: 웹 검색을 여러 각도(사건 흐름·공식 발표, 처지별 목소리, 숫자, 다른 곳의 사례, 이후 전개)로 나눠 하고,
   검색 결과의 **실제 인용 링크(url_citation)가 붙은 문장만** 사실 은행에 넣는다. 인용이 없는 문장은 버린다.
2. **인물의 근거 진술(claims)은 사실 은행 문장을 그대로 쓴다.** AI는 사실 ID만 고르고, 서버가 문장·출처·종류를 채운다.
   그래서 근거 진술은 지어낼 수 없다. 사건 공통 배경·2단계 자료·사례 카드·이후 전개도 사실 ID로만 근거를 단다.
3. **설계 단계를 따로 둔다(사건 틀 + 인물 구성안)**: 축 4개(축마다 2명 이상), 입장 분포(한쪽 쏠림 금지, 가운데 인물도 구체적 안),
   인물끼리 이름 없이 스치는 장면, 실존 인물 제외를 먼저 정하고, 교사가 구성안을 보고 고치거나 다시 만들 수 있다.
4. **인물은 한 명씩 만든다**: 기본 주제의 인물 하나를 본보기로 주고, 다른 인물의 구성안(스치는 장면)을 함께 준다.
5. **AI 점검(다시 보기)**: ① 인물 이야기·편지·생각에 근거 진술·공통 배경에 없는 중요한 사실(수치·날짜·제도·공식 결정)이 있는지,
   ② 실존 인물 이름, ③ 특정 집단 비하·고정관념, ④ 메타 표현('자료', 'AI' 등), ⑤ 입장 균형을 점검하고, 걸린 곳은 고쳐 쓰고 기록을 남긴다.
6. **구조 검사(코드)**: 기본 주제 다섯 개에 쓰는 검사(`functions/topicCheck.js`)를 그대로 적용한다. 기본 주제 다섯 개도 이 검사를 통과해야 한다(테스트).
7. **교사 검토**: 출처마다 원문 링크와 그 출처를 쓰는 진술을 나란히 보여 주고, 교사가 **원문 확인**을 눌러야 그 출처를 쓰는
   인물·자료가 학생에게 보인다(기본 주제의 `verified` 원칙과 같다). 점검에서 걸린 곳을 먼저 보여 준다.

## 저장 구조

- `teacherTopics/{topicId}`: `ownerUid`, `title`, `status`(building | review | ready), `createdAt`, `updatedAt`, `input`(교사가 넣은 아이디어·범위 답),
  `bundle`(SOURCES·EVENT·PERSONAS·MATERIALS·POLICY_CASES·AFTERMATH·BRIEFS, 기본 주제 파일과 같은 모양), `plan`(인물 구성안), `review`(점검 기록), `build`(단계·호출 수), `imported`(파일에서 불러온 주제면 `{at, title, signed}`). `config/topicFile`: 주제 파일 서명 키(처음 내보낼 때 생성).
- `teacherTopics/{topicId}/parts/research`: 사실 은행(출처·사실). 크기가 커서 따로 둔다.
- `topicUsage/{uid}`: 하루 생성 횟수(기본 3, `TOPIC_DAILY_LIMIT`), 아이디어 찾기 횟수(기본 10).
- 수업을 만들면 그때의 주제를 `sessions/{code}/private/topic` 에 복사한다(원본을 고치거나 지워도 진행 중인 수업은 그대로).
- 모두 서버(Cloud Functions)만 읽고 쓴다(firestore.rules).

## 서버 함수

- `topics` 함수 하나가 action 으로 나뉜다(Cloud Run CPU 한도 때문에 함수 수를 늘리지 않는다. `functions/topicApi.js`).
  - 저장: list / get / save(교사 수정) / plan(구성안) / verifySource / delete / syncSession(수업 사본 갱신)
  - 파일: export(`{format:"ai-eps-topic", version:1, title, file, plan, review, research, sig}`. sig 는 config/topicFile 의 키로 만든 HMAC-SHA256(키 순서와 무관한 정규화 JSON 기준))
    / import(형식·버전·크기(4MB)·주제 수 확인 → 서명이 맞으면 원문 확인·구성안·점검 기록·조사 결과까지 그대로, `imported.signed: true` 라 AI 단계도 된다.
      서명이 없거나 다르면 출처 ID(T1..)만 받아 모두 verified:false, facts 를 빼고 조사 결과 없이 저장하며 AI 단계를 막는다. 어느 쪽이든 sanitizeFile 로 정리하고 build.step "review" 로 저장)
  - AI: ideas / start / research / frame / personas(3명씩 여러 번) / extras / review / regenPersona
- 단계마다 따로 부르므로 한 번의 호출이 오래 걸리지 않고(최대 540초), 실패하면 그 단계만 다시 한다. 화면을 닫아도 이어서 만들 수 있다.
- 기존 함수는 `bundleOf(code, sess)` 로 주제를 읽는다(기본 주제면 코드, 교사 주제면 수업 사본).

## 아직 확인하지 못한 것

- 테스트는 가짜 AI 로 했다. 실제 OpenAI(gpt-5.6-sol 생성 + gpt-5.6-terra web_search)로 주제 하나를 끝까지 만들어 보며 걸리는 시간, 사실 은행의 크기(인용 링크가 붙는 비율),
  인물 품질을 확인해야 한다. 인용이 적게 붙으면 조사 단계가 '기사를 충분히 찾지 못했어요'로 멈춘다(사실 20개 미만).
- 실제 Firestore 에서는 `undefined` 값과 배열 안의 배열을 저장하지 못한다. 테스트의 가짜 저장소도 이를 거부하게 해 두었다.

## 진행 상황

- [x] 1. 주제 묶음(bundle) 계층: case.js 를 묶음 단위 함수로 바꾸고 기존 동작 유지(테스트 통과)
- [x] 2. 구조 검사(topicCheck.js) + 기본 주제 다섯 개 통과 테스트
- [x] 3. index.js 가 수업의 주제를 bundleOf 로 읽기(교사 주제 수업 사본), createSession/cloneSession/getCase 확장
- [x] 4. 저장 함수(topicStore) + 규칙 + 테스트
- [x] 5. 생성 파이프라인(topicBuild.js: 프롬프트·검색·사실 은행·조립) + 가짜 AI 테스트
- [x] 6. topicAi 함수 + 한도 + 테스트
- [x] 7. 교사 화면(PC·모바일): 내 주제 탭, 만들기 안내 흐름, 구성안 확인, 검토·원문 확인, 수업 만들 때 고르기
- [x] 8. 화면 테스트, README·문서
