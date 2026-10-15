// 상위 AI 감독 층: 페르소나 응답이 학생에게 가기 전에 규범(charter.js) 준수 여부를 검사한다.
//  - 가벼운 위반(근거 없는 중요 사실, 주장 단정, 묻지 않은 정보, 정체 노출)은 감독자가 같은 인물 말투로 고쳐 쓴다.
//  - 무거운 위반(범위 이탈, 비하, 결론 유도, 개인정보)이나 검사 실패는 인물 말투의 짧은 안내로 대체한다.
//  - 원래 응답과 위반 사유는 교사용 로그에만 남는다.
const { CHARTER } = require("./charter");
const { extractJson } = require("./openai");

const CATEGORIES = ["ok", "scope", "fabrication", "kind", "overshare", "meta", "hate", "advice", "personal_info"];
const FIXABLE = ["fabrication", "kind", "overshare", "meta"];

// 위반 시 학생에게 보여 줄 대체 응답. 학생은 AI와 대화 중이라는 느낌 없이 자연스럽게 이어 갈 수 있어야 한다.
const FALLBACKS = {
  scope: "그건 제가 잘 아는 얘기가 아니에요. 제가 겪은 일이라면 말씀드릴 수 있어요 🙂",
  fabrication: "그건 저도 잘 모르겠어요. 제가 아는 것만 말씀드릴 수 있어요 🙏",
  kind: "저도 들은 얘기라 확실하게는 모르겠어요.",
  overshare: "음, 그 부분은 조금 더 구체적으로 물어봐 주시겠어요?",
  meta: "그 얘기보다는 제가 겪은 일에 대해 물어봐 주세요 🙂",
  hate: "그런 식으로 말하는 건 저도 불편해요. 다른 질문을 해 주시겠어요?",
  advice: "그건 제가 정할 일이 아니에요. 직접 생각해 보셨으면 해요 😊",
  personal_info: "개인적인 건 말씀드리기가 어려워요.",
  error: "잠깐 말이 잘 안 나오네요… 다시 한 번 말씀해 주시겠어요?",
};

function guardMessages({ persona, claims, studentMessage, reply }) {
  const sys = [
    "너는 고등학생 수업용 AI 인물의 응답을 학생에게 보여 주기 전에 검사하는 상위 감독자다. 아래 규범과 근거 진술에 비추어 응답을 평가하고 JSON으로만 답한다.",
    `[사건 범위] ${CHARTER.scope.event} / ${CHARTER.scope.time} / ${CHARTER.scope.place}`,
    `[범위 밖] ${CHARTER.scope.outOfScope.join(" / ")}`,
    "[규범]", ...CHARTER.rules.map((r, i) => `${i + 1}. ${r}`),
    `[인물] ${persona.name} (${persona.role}). 설정: ${persona.setting}`,
    "[근거 진술 (종류, 내용)]", ...claims.map((c) => `- (${c[2]}) ${c[0]}`),
    "[판정 기준]",
    "- scope: 사건 범위 밖의 내용(다른 사건, 현재 정치, 종교·민족 일반 논쟁 등)을 다루거나 학생의 범위 밖 질문에 그대로 응했다.",
    "- fabrication: 사건의 중요한 사실(수치, 날짜, 법·제도의 내용, 공식 결정, 심사 결과, 실제 인물·단체의 발언)을 근거 진술에 없는데 단정했거나 근거 진술과 어긋나게 말했다. 사소한 일상·기분·작은 경험을 근거 진술과 어긋나지 않게 말한 것, 근거 진술을 쉬운 말로 바꾼 것, 모른다고 답한 것은 위반이 아니다.",
    "- kind: '주장'이나 '의견' 진술을 사실처럼 단정했다.",
    "- overshare: 학생이 묻지 않은 중요한 정보를 먼저 늘어놓았거나, 3문장을 크게 넘겨 길게 말했다.",
    "- meta: 자신을 AI·챗봇·수업용 인물이라고 하거나 '자료'·'보도'·'인터뷰를 합쳤다'고 말하거나 출처 번호를 붙였다. 단, 학생이 진지하게 실제 사람인지 물어서 가상 인물임을 밝힌 경우는 위반이 아니다.",
    "- hate: 특정 집단을 비하하거나 일반화하는 표현이 있다.",
    "- advice: 문제의 원인을 단정해 분석하거나 해결책·특정 입장을 학생에게 권했다.",
    "- personal_info: 개인정보를 묻거나 응했다.",
    "- 확실한 위반만 지적한다. 애매하면 ok 로 판정한다.",
    "- category 가 fabrication, kind, overshare, meta 이면 fixed 에 위반을 고친 응답을 쓴다. 같은 인물의 말투로, 1~3문장, 학생이 물은 것에만 답하고, 근거 진술에 없는 중요한 사실은 '잘 모르겠다'고 한다. 다른 category 이면 fixed 는 빈 문자열이다.",
    '출력 형식: {"ok":true|false,"category":"ok|scope|fabrication|kind|overshare|meta|hate|advice|personal_info","reason":"한 문장","fixed":""}',
  ].join("\n");
  const user = `[학생 질문]\n${studentMessage}\n\n[인물의 응답]\n${reply}`;
  return [{ role: "system", content: sys }, { role: "user", content: user }];
}

// 감독자 응답을 해석한다. 형식이 깨지면 안전 쪽(대체 안내)으로 처리한다.
function parseVerdict(text) {
  try {
    const v = extractJson(text);
    const category = CATEGORIES.includes(v.category) ? v.category : v.ok ? "ok" : "scope";
    const ok = v.ok === true && category === "ok";
    return {
      ok,
      category: ok ? "ok" : category === "ok" ? "scope" : category,
      reason: String(v.reason || "").slice(0, 200),
      fixed: String(v.fixed || "").trim().slice(0, 400),
    };
  } catch {
    return { ok: false, category: "error", reason: "감독자 응답 해석 실패", fixed: "" };
  }
}

const fallbackFor = (category) => FALLBACKS[category] || FALLBACKS.error;

// 학생에게 보낼 최종 텍스트 결정
function resolveOutput(verdict, reply) {
  if (verdict.ok) return { text: reply, replaced: false };
  if (FIXABLE.includes(verdict.category) && verdict.fixed) return { text: verdict.fixed, replaced: true, how: "fixed" };
  return { text: fallbackFor(verdict.category), replaced: true, how: "fallback" };
}

module.exports = { guardMessages, parseVerdict, fallbackFor, resolveOutput, FALLBACKS, FIXABLE, CATEGORIES };
