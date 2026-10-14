const test = require("node:test");
const assert = require("node:assert");
const { checkGate } = require("../policy");

const personaIds = ["p1", "p2"];
const qs = ["왜 이사를 왔나요?", "학교 생활은 어때요?", "가장 힘든 점은요?"];

test("2·6·7단계는 AI 호출이 차단된다", () => {
  for (const stage of [2, 6, 7]) {
    const r = checkGate({ stage, type: "persona_chat", work: {}, payload: {}, personaIds });
    assert.equal(r.ok, false);
  }
});

test("1단계: 사전 질문 3개 전에는 대화할 수 없다", () => {
  const base = { stage: 1, type: "persona_chat", personaIds, payload: { personaId: "p1", message: "안녕하세요" } };
  assert.equal(checkGate({ ...base, work: { s1: { preQuestions: qs.slice(0, 2) } } }).ok, false);
  assert.equal(checkGate({ ...base, work: { s1: { preQuestions: qs } } }).ok, true);
});

test("1단계: 없는 인물이나 빈/긴 메시지는 차단", () => {
  const work = { s1: { preQuestions: qs } };
  const g = (payload) => checkGate({ stage: 1, type: "persona_chat", work, payload, personaIds }).ok;
  assert.equal(g({ personaId: "zz", message: "안녕" }), false);
  assert.equal(g({ personaId: "p1", message: "   " }), false);
  assert.equal(g({ personaId: "p1", message: "가".repeat(501) }), false);
});

test("3단계: 2단계에서 만든 검증 질문만 허용", () => {
  const work = { s2: { verifyQuestions: ["난민 인정 비율은?"] } };
  const g = (q) => checkGate({ stage: 3, type: "verify_query", work, payload: { question: q }, personaIds }).ok;
  assert.equal(g("난민 인정 비율은?"), true);
  assert.equal(g("원인이 뭐야?"), false);
});

test("4단계: 대안을 먼저 써야 피드백을 받는다", () => {
  const g = (work) => checkGate({ stage: 4, type: "proposal_feedback", work, payload: { proposalId: "a" }, personaIds }).ok;
  assert.equal(g({}), false);
  assert.equal(g({ s4: { proposals: [{ id: "a", text: "짧음" }] } }), false);
  assert.equal(g({ s4: { proposals: [{ id: "a", text: "가".repeat(40) }] } }), true);
});

test("5단계: 예측 2개 이전에는 시뮬레이션 불가, 시점은 1·3·5년", () => {
  const preds = [{ text: "지역 주민은 반대할 것이다" }, { text: "지원 단체는 환영할 것이다" }];
  const s4 = { proposals: [{ id: "a", text: "가".repeat(40) }] };
  const g = (work, payload) => checkGate({ stage: 5, type: "scenario", work, payload, personaIds }).ok;
  assert.equal(g({ s4, s5: { predictions: preds.slice(0, 1) } }, { proposalId: "a", round: 1 }), false);
  assert.equal(g({ s4, s5: { predictions: preds } }, { proposalId: "a", round: 1 }), true);
  assert.equal(g({ s4, s5: { predictions: preds } }, { proposalId: "a", round: 2 }), false);
});

test("단계와 맞지 않는 기능 요청은 차단", () => {
  assert.equal(checkGate({ stage: 4, type: "scenario", work: {}, payload: {}, personaIds }).ok, false);
});
