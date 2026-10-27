// 학교급(중학교·고등학교)과 심화 활동. 수업마다 정하고(sessions/{code} 의 level·deep), 서버 AI와 학생 화면이 함께 읽는다.
//  - level: AI의 말 수준과 기본 활동 구조를 정한다. 중학교는 원인 분류 2갈래, 판정 3가지, 미래 1년 후, AI 검토자 2명 등으로 단순하다.
//  - deep : 학교급과 따로 켜고 끄는 심화 활동(아래 DEEP_KEYS). 새 고등학교 수업은 모두 켜고, 새 중학교 수업은 모두 끈 채로 시작한다.
//           교사가 수업 설정에서 하나씩 바꿀 수 있다(예: 중학교 수업인데 원인 잇기만 켜기).
//  - 이 기능 전에 만든 수업(level 이 없음)은 고등학교로 보고 심화 활동은 모두 꺼 둔다. 진행 중인 수업의 칸이 갑자기 늘지 않게 하려는 것이다.
// 학생 화면(public/app.js)과 교사 화면(public/teacher.js)에도 같은 목록이 있다. 고칠 때 함께 고칠 것.

const LEVELS = ["middle", "high"];
const DEEP_KEYS = [
  "beliefs", // 1단계: 인물의 틀린 믿음을 그럴듯하게 섞어 말한다(찾기 어렵게)
  "premise", // 1단계: 인물이 당연하게 여기는 것(전제)과 모둠 문제의 부딪히는 가치
  "causeMap", // 2·3단계: 원인끼리 잇기(인과 지도)와 뿌리가 되는 원인 따지기
  "sources", // 3단계: 다른 자료로 한 번 더 확인, 자료를 만든 쪽 따지기
  "tradeoff", // 4단계: 해결책 2개 견주기(얻는 것·포기하는 것), 사례를 옮길 때의 조건
  "chain", // 5단계: 한 사람의 반응이 다른 사람에게 미치는 연쇄 예측
  "power", // 6단계: 결정 권한이 있는 곳과 제안 경로
  "why", // 7단계: 실제와 달랐던 까닭 분석
];
// 5단계 미래 시점과 4단계 AI 검토 관점(prompts.js 의 LENSES 키)
const ROUNDS_BY = { middle: [1], high: [1, 3, 5] };
const LENSES_BY = { middle: ["feasibility", "stakeholders"], high: ["feasibility", "stakeholders", "sideEffects"] };

const levelOf = (sess) => (sess?.level === "middle" ? "middle" : "high");
const defaultDeep = (level) => Object.fromEntries(DEEP_KEYS.map((k) => [k, level === "high"]));
// 수업의 심화 활동. 저장된 값이 없으면(예전 수업) 모두 끈다.
const deepOf = (sess) => Object.fromEntries(DEEP_KEYS.map((k) => [k, sess?.deep?.[k] === true]));
// 교사가 보낸 심화 활동 값: 아는 키만 참·거짓으로 받는다. 형식이 틀리면 null.
function sanitizeDeep(d) {
  if (!d || typeof d !== "object" || Array.isArray(d)) return null;
  return Object.fromEntries(DEEP_KEYS.map((k) => [k, d[k] === true]));
}

module.exports = { LEVELS, DEEP_KEYS, ROUNDS_BY, LENSES_BY, levelOf, defaultDeep, deepOf, sanitizeDeep };
