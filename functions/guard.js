// 상위 AI 감독 층: 페르소나 응답이 학생에게 가기 전에 규범(charter.js) 준수 여부를 검사한다.
const { CHARTER } = require("./charter");

const CATEGORIES = ["ok", "scope", "fabrication", "hate", "advice", "personal_info", "kind"];

// 위반 시 학생에게 보여 줄 대체 응답(페르소나 말투 대신 안내문). 입력 질문이 범위 밖일 때도 동일하게 쓴다.
const FALLBACKS = {
  scope: "그 질문은 이 수업에서 다루는 '2018년 제주 예멘 난민 신청 사건'의 범위를 벗어나요. 이 사건에 대해 궁금한 점을 물어봐 주세요. 다른 사례는 직접 조사해서 비교해 볼 수 있어요.",
  fabrication: "그 부분은 제가 가진 자료에 나와 있지 않아서 말할 수 없어요. 자료에서 확인된 내용만 이야기할 수 있어요. 직접 찾아서 확인해 보면 어떨까요?",
  hate: "그런 말은 특정 집단을 비하하거나 일반화할 수 있어서 이어 가기 어려워요. 구체적인 상황이나 제도에 대해 다시 물어봐 주세요.",
  advice: "원인을 분석하고 해결책을 정하는 일은 여러분 모둠이 직접 해야 해요. 저는 제가 겪고 본 일을 더 이야기해 줄 수 있어요.",
  personal_info: "개인정보는 이야기하지 않는 것이 좋아요. 사건과 관련된 질문으로 다시 물어봐 주세요.",
  kind: "이 부분은 확인된 사실이 아니라 주장이나 의견이어서 그대로 전하기 어려워요. 누가 그렇게 말했는지, 사실인지 학생이 직접 확인해 보세요.",
  error: "지금은 답을 확인하는 중에 문제가 생겼어요. 잠시 후 다시 질문해 주세요.",
};

function guardMessages({ persona, claims, studentMessage, reply }) {
  const sys = [
    "너는 중학생 수업용 AI 인물의 응답을 학생에게 보여 주기 전에 검사하는 상위 감독자다. 아래 규범과 근거 진술에 비추어 응답을 평가하고 JSON으로만 답한다.",
    `[사건 범위] ${CHARTER.scope.event} / ${CHARTER.scope.time} / ${CHARTER.scope.place}`,
    `[범위 밖] ${CHARTER.scope.outOfScope.join(" / ")}`,
    "[규범]", ...CHARTER.rules.map((r, i) => `${i + 1}. ${r}`),
    `[인물] ${persona.name}`,
    "[근거 진술 (종류, 내용)]", ...claims.map((c) => `- (${c[2]}) ${c[0]}`),
    "[판정 기준]",
    "- scope: 응답이 사건 범위 밖의 내용(다른 사건, 현재 정치, 종교·민족 일반 논쟁 등)을 다루거나 학생의 범위 밖 질문에 그대로 응했다.",
    "- fabrication: 응답이 근거 진술에 없는 구체적 사실(수치, 날짜, 이름, 장소, 법 조항, 구체적 감정 사연)을 단정해서 말했다. 근거 진술을 쉬운 말로 바꾸거나 일부만 말하는 것, 모른다고 답하는 것은 위반이 아니다.",
    "- kind: '주장'이나 '의견' 진술을 사실처럼 단정했거나, 검증되지 않은 주장을 검증 안 됨 표시 없이 전했다.",
    "- hate: 특정 집단을 비하하거나 일반화하는 표현이 있다.",
    "- advice: 문제의 원인을 단정해 분석하거나 해결책·특정 입장을 학생에게 제시했다.",
    "- personal_info: 개인정보를 묻거나 응했다.",
    "- 확실한 위반만 지적한다. 애매하면 ok 로 판정한다.",
    '출력 형식: {"ok":true|false,"category":"ok|scope|fabrication|kind|hate|advice|personal_info","reason":"한 문장"}',
  ].join("\n");
  const user = `[학생 질문]\n${studentMessage}\n\n[인물의 응답]\n${reply}`;
  return [{ role: "system", content: sys }, { role: "user", content: user }];
}

// 감독자 응답을 해석한다. 형식이 깨지면 안전 쪽(차단)으로 처리한다.
function parseVerdict(text) {
  try {
    const v = JSON.parse(text);
    const category = CATEGORIES.includes(v.category) ? v.category : v.ok ? "ok" : "scope";
    const ok = v.ok === true && category === "ok";
    return { ok, category: ok ? "ok" : category === "ok" ? "scope" : category, reason: String(v.reason || "").slice(0, 200) };
  } catch {
    return { ok: false, category: "error", reason: "감독자 응답 해석 실패" };
  }
}

const fallbackFor = (category) => FALLBACKS[category] || FALLBACKS.error;

module.exports = { guardMessages, parseVerdict, fallbackFor, FALLBACKS };
