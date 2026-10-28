const test = require("node:test");
const assert = require("node:assert");
const demo = require("../demo");
const { availablePersonas } = require("../case");

const dev = "dev-1234567890ab";
const pid = availablePersonas("jeju2018")[0].id;
const rec = (replies) => { const calls = []; const call = async (o) => { calls.push(o); const r = replies.shift(); if (r instanceof Error) throw r; return r; }; return { calls, deps: { call, effort: "low" } }; };

test("요청 확인: 기기 표시·주제·종류·단계가 맞아야 하고, 모르는 값은 거절한다", () => {
  assert.ok(demo.parse({ deviceId: dev, topic: "jeju2018", kind: "chat" }));
  assert.throws(() => demo.parse({ deviceId: "x", topic: "jeju2018", kind: "chat" }), /기기/);
  assert.throws(() => demo.parse({ deviceId: dev, topic: "nope", kind: "chat" }), /주제/);
  for (const topic of ["constructor", "__proto__", "toString"]) assert.throws(() => demo.parse({ deviceId: dev, topic, kind: "chat" }), /주제/);
  assert.throws(() => demo.parse({ deviceId: "day-2026-10-25", topic: "jeju2018", kind: "chat" }), /기기/, "하루 전체 횟수 문서와 겹치는 이름");
  assert.throws(() => demo.parse({ deviceId: dev, topic: "jeju2018", kind: "x" }), /종류/);
  assert.throws(() => demo.parse({ deviceId: dev, topic: "jeju2018", kind: "ai", stage: 1 }), /단계/);
  assert.throws(() => demo.parse({ deviceId: dev, topic: "jeju2018", kind: "ai", stage: 6 }), /단계/);
  assert.deepEqual(demo.LIMITS, { chat: 5, ai: 5 });
});

test("인물 대화: 실제와 같이 인물 응답 → 상위 AI 검사를 거치고, 요청의 대화 기록을 8개까지만 쓴다", async () => {
  const { calls, deps } = rec(["네, 안녕하세요. 저는 아델이에요.", '{"ok":true,"category":"ok","reason":"","fixed":"","conduct":"ok"}']);
  const history = Array.from({ length: 12 }, (_, i) => ({ input: `질문${i}`, output: `답${i}` }));
  const r = await demo.run(demo.parse({ deviceId: dev, topic: "jeju2018", kind: "chat", personaId: pid, message: "고향이 어디예요?", history }), deps);
  assert.equal(r.text, "네, 안녕하세요. 저는 아델이에요.");
  assert.equal(calls.length, 2, "인물 한 번 + 감독자 한 번");
  assert.match(calls[0].messages[0].content, /아델/);
  assert.equal(calls[0].messages.length, 1 + 8 * 2 + 1, "시스템 + 기록 8쌍 + 이번 질문");
  assert.equal(calls[0].messages.at(-1).content, "고향이 어디예요?");
  assert.equal(calls[1].json, true);
});

test("인물 대화: 감독자가 고쳐 쓰면 고친 글, 검사가 깨지면 안내로 대체하고 횟수를 돌려준다, 명백한 욕설은 AI를 부르지 않는다", async () => {
  const a = rec(["원래 답", '{"ok":false,"category":"fabrication","reason":"x","fixed":"고친 답이에요.","conduct":"ok"}']);
  const r1 = await demo.run(demo.parse({ deviceId: dev, topic: "jeju2018", kind: "chat", personaId: pid, message: "난민이 몇 명이에요?" }), a.deps);
  assert.equal(r1.text, "고친 답이에요."); assert.equal(r1.replaced, true);
  const b = rec(["원래 답", new Error("boom")]);
  const r2 = await demo.run(demo.parse({ deviceId: dev, topic: "jeju2018", kind: "chat", personaId: pid, message: "고향이 어디예요?" }), b.deps);
  assert.equal(r2.refunded, true); assert.equal(r2.replaced, true);
  const c = rec([]);
  const r3 = await demo.run(demo.parse({ deviceId: dev, topic: "jeju2018", kind: "chat", personaId: pid, message: "씨발 꺼져" }), c.deps);
  assert.equal(c.calls.length, 0); assert.equal(r3.replaced, true);
});

test("인물 대화: 이 주제의 인물이 아니거나 빈 말이면 거절한다", async () => {
  const { deps } = rec([]);
  await assert.rejects(demo.run(demo.parse({ deviceId: dev, topic: "waste2019", kind: "chat", personaId: pid, message: "안녕" }), deps), /인물/);
  await assert.rejects(demo.run(demo.parse({ deviceId: dev, topic: "jeju2018", kind: "chat", personaId: pid, message: "  " }), deps), /보낼 말/);
});

test("2단계 생각 도우미: 질문 하나를 JSON 으로 받아 유형을 확인하고, 비면 오류", async () => {
  const link = { prior: "돈 벌러 온 줄 알았다", surprise: "전쟁을 피해 왔다고 해서", scene: "전학 첫날", question: "나도 그랬나?" };
  const ok = rec(['{"kind":"겉모습만 닮음","question":"전학 첫날 무엇을 당연하게 여겼나요?"}']);
  const r = await demo.run(demo.parse({ deviceId: dev, topic: "jeju2018", kind: "ai", stage: 2, personaId: pid, payload: { focus: "link", link } }), ok.deps);
  assert.deepEqual(r.result, { kind: "겉모습만 닮음", question: "전학 첫날 무엇을 당연하게 여겼나요?" });
  assert.match(ok.calls[0].messages[1].content, /전학 첫날/);
  const cause = rec(['{"kind":"없는유형","question":"어느 쪽을 아직 안 봤나요?"}']);
  const r2 = await demo.run(demo.parse({ deviceId: dev, topic: "jeju2018", kind: "ai", stage: 2, payload: { focus: "cause", causes: [{ level: "개인", text: "편견" }] } }), cause.deps);
  assert.equal(r2.result.kind, "", "목록에 없는 유형은 비운다");
  await assert.rejects(demo.run(demo.parse({ deviceId: dev, topic: "jeju2018", kind: "ai", stage: 2, payload: { focus: "cause", causes: [] } }), rec(['{"question":""}']).deps), /비어/);
});

test("3단계 검색 도우미: 수업 자료만 근거로 주고(웹 검색 없음) 답을 그대로 돌려준다", async () => {
  const { calls, deps } = rec(["자료에 따르면 …"]);
  const r = await demo.run(demo.parse({ deviceId: dev, topic: "jeju2018", kind: "ai", stage: 3, payload: { check: { heard: "일자리가 없었다", question: "신청자는 일할 수 있었나?", srcType: "법·제도" } } }), deps);
  assert.equal(r.result, "자료에 따르면 …");
  assert.match(calls[0].messages[0].content, /\[사건 흐름\]|\[.+\] \(/, "수업 자료가 들어간다");
  assert.match(calls[0].messages[1].content, /신청자는 일할 수 있었나/);
});

test("4단계: 서로 다른 관점의 의견 3개, 하나만 실패해도 나머지를 보여 준다. 5단계: 시나리오 JSON", async () => {
  const { calls, deps } = rec(["의견1", new Error("x"), "의견3"]);
  const r = await demo.run(demo.parse({ deviceId: dev, topic: "jeju2018", kind: "ai", stage: 4, payload: { proposal: { text: "일자리 연결 센터를 만든다", cause: "일자리 부족" } } }), deps);
  assert.equal(calls.length, 3);
  assert.deepEqual(r.result.reviews.map((x) => x.label), ["실행 가능성", "부작용·장기 영향"]);
  const sc = rec(['{"scenarios":[{"title":"A","story":"s","mechanism":"m","unintended":[],"newProblems":[]},{"title":"B","story":"s","mechanism":"m","unintended":[],"newProblems":[]}]}']);
  const r5 = await demo.run(demo.parse({ deviceId: dev, topic: "jeju2018", kind: "ai", stage: 5, payload: { proposalText: "센터를 만든다", round: 7, predictions: [{ stakeholder: "도민", text: "찬성" }] } }), sc.deps);
  assert.equal(r5.result.scenarios.length, 2);
  assert.match(sc.calls[0].messages[0].content, /3년/, "정해진 시점이 아니면 3년");
  await assert.rejects(demo.run(demo.parse({ deviceId: dev, topic: "jeju2018", kind: "ai", stage: 5, payload: { proposalText: "" } }), sc.deps), /비어/);
});

test("학교급: 중학교 체험은 중학생 수준 프롬프트·검토자 2명·1년 후, 학교급이 없거나 모르면 고등학교", async () => {
  assert.equal(demo.parse({ deviceId: dev, topic: "jeju2018", kind: "chat" }).level, "high");
  assert.equal(demo.parse({ deviceId: dev, topic: "jeju2018", kind: "chat", level: "x" }).level, "high");
  const d = demo.parse({ deviceId: dev, topic: "jeju2018", kind: "ai", stage: 4, level: "middle", payload: { proposal: { text: "가".repeat(40) } } });
  assert.equal(d.deep.tradeoff, false, "심화는 학교급 기본값(서버가 정한다)");
  const a = rec(["의견1", "의견2"]);
  const r = await demo.run(d, a.deps);
  assert.deepEqual(r.result.reviews.map((x) => x.label), ["정말 할 수 있을까", "사람들의 반응"]);
  assert.ok(a.calls.every((c) => /중학생/.test(c.messages[0].content)));
  const sc = rec(['{"scenarios":[]}']);
  await demo.run(demo.parse({ deviceId: dev, topic: "jeju2018", kind: "ai", stage: 5, level: "middle", payload: { proposalText: "가".repeat(40), round: 5 } }), sc.deps);
  assert.match(sc.calls[0].messages[1].content, /시점: 1년 후/);
});
