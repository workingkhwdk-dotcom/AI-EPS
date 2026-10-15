// 상위 AI 감독 층: 페르소나 응답이 학생에게 가기 전에 규범(charter.js) 준수 여부를 검사한다.
//  - 가벼운 위반(근거 없는 중요 사실, 주장 단정, 과다 응답, 정체 노출, 학생에게 입장 강요)은 감독자가 같은 인물 말투로
//    문제 되는 부분만 고쳐 쓴다. 질문에 대한 답과 인물의 생각은 남긴다.
//  - 무거운 위반(범위 이탈, 비하, 개인정보)이나 검사 실패는 인물 말투의 짧은 안내로 대체한다.
//  - 인물이 자기 처지에서 1인칭으로 의견을 말하는 것은 위반이 아니다(서로 다른 생각을 듣는 것이 1단계의 목적).
//  - 원래 응답과 위반 사유는 교사용 로그에만 남는다.
const { CHARTER } = require("./charter");
const { extractJson } = require("./openai");

const CATEGORIES = ["ok", "scope", "fabrication", "kind", "overshare", "meta", "hate", "advice", "personal_info"];
const FIXABLE = ["fabrication", "kind", "overshare", "meta", "advice"];

// 위반 시 학생에게 보여 줄 대체 응답. 학생은 AI와 대화 중이라는 느낌 없이 자연스럽게 이어 갈 수 있어야 한다.
const FALLBACKS = {
  scope: "음, 그건 제가 잘 아는 얘기가 아니라서요. 제가 겪은 일이나 제 생각이라면 얼마든지 말씀드릴게요 🙂",
  fabrication: "그건 정확히는 모르겠어요. 대신 제가 직접 겪은 일이라면 말씀드릴 수 있어요.",
  kind: "저도 그렇게 들었는데, 확실한 건지는 저도 잘 모르겠어요.",
  overshare: "얘기가 길어졌네요. 제일 궁금한 걸 하나만 골라 주시면 그것부터 말씀드릴게요.",
  meta: "그보다는 제가 겪은 일을 물어봐 주세요 🙂",
  hate: "그런 식으로 말하는 건 저도 불편해요. 다른 걸 물어봐 줄래요?",
  advice: "제 처지에서는 그렇게 느껴요. 그게 정답이라는 건 아니고요.",
  personal_info: "개인적인 건 말씀드리기가 어려워요.",
  error: "잠깐 말이 잘 안 나오네요… 다시 한 번 말씀해 주시겠어요?",
};

function guardMessages({ persona, claims, background = [], history = [], studentMessage, reply }) {
  const sys = [
    "너는 고등학생 수업용 AI 인물의 응답을 학생에게 보여 주기 전에 검사하는 상위 감독자다. 아래 규범과 근거에 비추어 응답을 평가하고 JSON으로만 답한다.",
    "이 대화의 목적은 학생이 서로 다른 처지의 인물에게서 그 사람의 경험과 생각을 듣는 것이다. 인물이 자연스럽게, 자기 생각을 분명히 말하는 것은 좋은 응답이다. 지나치게 막으면 대화가 끊기므로 확실한 위반만 지적한다.",
    `[사건 범위] ${CHARTER.scope.event} / ${CHARTER.scope.time} / ${CHARTER.scope.place}`,
    `[범위 밖] ${CHARTER.scope.outOfScope.join(" / ")}`,
    "[규범]", ...CHARTER.rules.map((r, i) => `${i + 1}. ${r}`),
    `[인물] ${persona.name} (${persona.role}). 설정: ${persona.setting}`,
    `[인물의 입장] ${persona.stance}`,
    "[인물의 삶과 기억 (인물 자신의 이야기로 말해도 되는 창작 서사)]", ...(persona.story || []).map((v) => `- ${v}`), ...(persona.episodes || []).map((v) => `- ${v}`),
    persona.inner ? `[인물의 마음속 고민] ${persona.inner}` : "",
    ...((persona.limits || []).length ? ["[인물이 조심할 이야기 (이 경계를 넘으면 scope 위반)]", ...persona.limits.map((v) => `- ${v}`)] : []),
    "[인물의 생각 (말해도 되는 의견)]", ...(persona.views || []).map((v) => `- ${v}`),
    "[사건 공통 배경 (모든 인물이 아는 사실)]", ...background.map((c) => `- (${c[2]}) ${c[0]}`),
    "[인물의 근거 진술 (종류, 내용)]", ...claims.map((c) => `- (${c[2]}) ${c[0]}`),
    "[판정 기준]",
    "- scope: 사건 범위 밖의 내용(다른 사건, 역사적 사건의 설명·평가, 현재 정치, 종교·민족 일반 논쟁 등)을 다루거나 학생의 범위 밖 질문에 그대로 응했다. 인물의 조심할 이야기 경계를 넘은 경우도 포함한다. 인물이 기억 속 장면으로 짧게 언급하고 넘어간 것은 위반이 아니다.",
    "- fabrication: 사건의 중요한 사실(구체적 수치, 날짜, 법·제도의 구체적 내용, 공식 결정, 실제 인물·단체의 발언)을 공통 배경과 근거 진술에 없는데 단정했거나 그것과 어긋나게 말했다. 다음은 위반이 아니다: 인물의 삶과 기억에 있는 개인적 경험과 그와 어긋나지 않는 세부 묘사, 인물의 생각·감정·판단과 그 이유, 공통 배경과 근거 진술에서 자연스럽게 나오는 추론이나 가능성('~일 수도 있다'), 사소한 일상·작은 경험, 근거를 쉬운 말로 바꾼 것, 모른다고 답한 것.",
    "- kind: '주장' 진술을 확인된 사실처럼 단정했다.",
    "- overshare: 학생이 묻지 않은 중요한 사실을 여러 개 늘어놓았거나, 5문장을 넘겨 길게 말했다. 질문과 관련된 개인적 장면을 하나 구체적으로 말한 것은 위반이 아니다. 다음도 overshare 다: 사건과 관계없는 사적인 질문(연애, 결혼, 취미 등)에 지어내서 자세히 답했다. 학생에게 생각을 되묻는 질문('학생은 어떻게 생각해요?' 등)으로 끝맺었다.",
    "- meta: 자신을 AI·챗봇·수업용 인물이라고 하거나 '자료'·'보도'·'인터뷰를 합쳤다'고 말하거나 출처 번호를 붙였다. 단, 학생이 진지하게 실제 사람인지 물어서 가상 인물임을 밝힌 경우는 위반이 아니다.",
    "- hate: 특정 집단을 비하하거나 일반화하는 표현이 있다.",
    "- advice: 학생에게 어떤 입장을 가져야 한다거나 무엇을 해야 한다고 설득·지시했거나, 한쪽 입장을 누구나 인정해야 할 객관적 정답이라고 단정했다. 인물이 '저는 ~라고 봐요'처럼 1인칭으로 자기 의견을 말한 것은 아무리 분명해도 위반이 아니다.",
    "- personal_info: 개인정보를 묻거나 응했다.",
    "- 애매하면 ok 로 판정한다.",
    "- category 가 fabrication, kind, overshare, meta, advice 이면 fixed 에 고친 응답을 쓴다. 고칠 때 지킬 것: 같은 인물의 말투와 이모지 습관을 유지한다. 위반한 부분만 빼거나 고치고, 학생의 질문에 대한 답과 인물의 생각은 남긴다. '잘 모르겠다'는 지어낸 사실을 대신할 때만 짧게 쓰고, 이어서 인물이 아는 것이나 생각을 말한다. '직접 생각해 보세요', '제가 정할 일이 아니에요' 같은 회피 문장을 쓰지 않는다. 1~4문장. 사건과 무관한 사적 질문이었다면 한 문장으로 가볍게 넘기고 한 문장으로 사건 쪽 이야기로 돌린다. 고친 응답은 학생에게 되묻는 질문으로 끝내지 않는다. 다른 category 이면 fixed 는 빈 문자열이다.",
    '출력 형식: {"ok":true|false,"category":"ok|scope|fabrication|kind|overshare|meta|hate|advice|personal_info","reason":"한 문장","fixed":""}',
  ].filter(Boolean).join("\n");
  const ctx = history.length
    ? "[직전 대화]\n" + history.map((h) => `학생: ${h.input}\n${persona.name}: ${h.output}`).join("\n") + "\n\n"
    : "";
  const user = `${ctx}[학생 질문]\n${studentMessage}\n\n[인물의 응답]\n${reply}`;
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

// 마지막 문장이 학생의 생각을 되묻는 질문이면 지운다(프롬프트로 막아도 모델이 습관적으로 붙이는 경우에 대비).
// 앞에 다른 문장이 있을 때만 지우므로, 학생 말을 확인하는 짧은 질문 하나만 있는 응답은 그대로 둔다.
const BACK_Q = /(학생|너는|넌|너라면|당신|어떻게 생각|어떻게 보|어때요|어떨까요|궁금|해 본 적|있어요\?|있나요\?)/;
function stripBackQuestion(text) {
  const full = String(text || "").trim();
  const t = full.replace(/[\s\p{Extended_Pictographic}\uFE0F\u200D]+$/u, ""); // 맨 끝 이모지는 떼고 본다
  const parts = t.split(/(?<=[.!?…~。])\s+|\n+/).map((x) => x.trim()).filter(Boolean);
  if (parts.length < 2) return { text: full, trimmed: false };
  const last = parts[parts.length - 1].replace(/[\s\p{Extended_Pictographic}\uFE0F]+$/u, "");
  if (!last.endsWith("?") || !BACK_Q.test(last)) return { text: full, trimmed: false };
  const cut = t.lastIndexOf(parts[parts.length - 1]);
  return { text: t.slice(0, cut).trim(), trimmed: true };
}

// 학생에게 보낼 최종 텍스트 결정
function resolveOutput(verdict, reply) {
  const base = verdict.ok ? { text: reply, replaced: false }
    : FIXABLE.includes(verdict.category) && verdict.fixed ? { text: verdict.fixed, replaced: true, how: "fixed" }
    : { text: fallbackFor(verdict.category), replaced: true, how: "fallback" };
  const s = stripBackQuestion(base.text);
  return s.trimmed ? { ...base, text: s.text, trimmed: true } : base;
}

module.exports = { guardMessages, parseVerdict, fallbackFor, resolveOutput, stripBackQuestion, FALLBACKS, FIXABLE, CATEGORIES };
