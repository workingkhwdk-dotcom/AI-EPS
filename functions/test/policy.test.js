const test = require("node:test");
const assert = require("node:assert");
const { checkGate, toList } = require("../policy");

test("2·6·7단계는 AI 호출이 차단된다", () => {
  for (const stage of [2, 6, 7]) assert.equal(checkGate({ stage, type: "persona_chat", work: {}, payload: {} }).ok, false);
});

test("1단계: 사전 질문 없이 바로 대화할 수 있다 (빈 메시지·긴 메시지만 차단)", () => {
  const g = (message) => checkGate({ stage: 1, type: "persona_chat", work: {}, payload: { message } }).ok;
  assert.equal(g("안녕하세요, 언제 한국에 오셨어요?"), true);
  assert.equal(g("   "), false);
  assert.equal(g(undefined), false);
  assert.equal(g("가".repeat(501)), false);
});

test("3단계: 2단계에서 만든 검증 질문(지도 또는 배열)만 AI에게 물을 수 있다", () => {
  const map = { s2: { checks: { c1: { heard: "일자리가 어렵대요", question: "난민 신청자의 취업은 어떻게 제한되나?", real: "자료에 없음", t: 1 } } } };
  const arr = { s2: { checks: [{ id: "c1", heard: "x", question: "난민 신청자의 취업은 어떻게 제한되나?", real: "단기 노무" }] } };
  const g = (work, checkId) => checkGate({ stage: 3, type: "verify_query", work, payload: { checkId } }).ok;
  assert.equal(g(map, "c1"), true);
  assert.equal(g(arr, "c1"), true);
  assert.equal(g(map, "zz"), false);
  assert.equal(g({}, "c1"), false);
  assert.equal(g({ s2: { checks: { c1: { heard: "x", question: "짧다" } } } }, "c1"), false);
});

test("4단계: 대안을 먼저 써야 피드백을 받는다", () => {
  const g = (work) => checkGate({ stage: 4, type: "proposal_feedback", work, payload: { proposalId: "a" } }).ok;
  assert.equal(g({}), false);
  assert.equal(g({ s4: { proposals: { a: { text: "짧음", t: 1 } } } }), false);
  assert.equal(g({ s4: { proposals: { a: { text: "가".repeat(40), t: 1 } } } }), true);
});

test("5단계: 예측 2개 이전에는 시뮬레이션 불가, 시점은 1·3·5년", () => {
  const preds = { p1: { text: "지역 주민은 반대할 것이다", t: 1 }, p2: { text: "지원 단체는 환영할 것이다", t: 2 } };
  const s4 = { proposals: { a: { text: "가".repeat(40), t: 1 } } };
  const g = (work, payload) => checkGate({ stage: 5, type: "scenario", work, payload }).ok;
  assert.equal(g({ s4, s5: { predictions: { p1: preds.p1 } } }, { proposalId: "a", round: 1 }), false);
  assert.equal(g({ s4, s5: { predictions: preds } }, { proposalId: "a", round: 1 }), true);
  assert.equal(g({ s4, s5: { predictions: preds } }, { proposalId: "a", round: 2 }), false);
  assert.equal(g({ s4, s5: { predictions: preds } }, { proposalId: "zz", round: 1 }), false);
});

test("5단계: 4단계 최종 대안(final)도 30자 이상이면 시뮬레이션할 수 있다", () => {
  const s5 = { predictions: { p1: { text: "지역 주민은 반대할 것이다", t: 1 }, p2: { text: "지원 단체는 환영할 것이다", t: 2 } } };
  const g = (s4) => checkGate({ stage: 5, type: "scenario", work: { s4, s5 }, payload: { proposalId: "final", round: 3 } }).ok;
  assert.equal(g({ final: "짧은 최종안" }), false);
  assert.equal(g({ final: "나".repeat(40) }), true);
  assert.equal(g({}), false);
});

test("단계와 맞지 않는 기능 요청은 차단", () => {
  assert.equal(checkGate({ stage: 4, type: "scenario", work: {}, payload: {} }).ok, false);
});

test("toList: 지도는 시간순으로, 배열은 그대로 항목 ID를 붙여 목록으로", () => {
  assert.deepEqual(toList({ b: { text: "나", t: 2 }, a: { text: "가", t: 1 } }).map((x) => x.id), ["a", "b"]);
  assert.deepEqual(toList(["x", "y"]).map((x) => x.text), ["x", "y"]);
  assert.deepEqual(toList(undefined), []);
});

test("5단계: 최종 대안(final)은 30자 이상이어야 시뮬레이션할 수 있다", () => {
  const preds = { p1: { text: "가".repeat(12) }, p2: { text: "나".repeat(12) } };
  const ok = checkGate({ stage: 5, type: "scenario", work: { s4: { final: "가".repeat(30) }, s5: { predictions: preds } }, payload: { proposalId: "final", round: 3 } });
  assert.equal(ok.ok, true);
  const no = checkGate({ stage: 5, type: "scenario", work: { s4: { final: "짧다" }, s5: { predictions: preds } }, payload: { proposalId: "final", round: 3 } });
  assert.match(no.reason, /최종 대안/);
});

test("3단계: 실제 자료에서 먼저 찾아본 결과를 적지 않으면 AI에게 묻지 못한다", () => {
  const work = { s2: { checks: { c1: { heard: "x", question: "난민 신청자의 취업은 어떻게 제한되나?" } } } };
  assert.match(checkGate({ stage: 3, type: "verify_query", work, payload: { checkId: "c1" } }).reason, /실제 사건 자료/);
});
