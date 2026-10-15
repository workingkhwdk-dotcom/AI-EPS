const test = require("node:test");
const assert = require("node:assert");
const { buildBody, extractJson, isReasoning, chat, headroom } = require("../openai");

const msgs = [{ role: "user", content: "hi" }];

test("GPT-5 계열: max_tokens·temperature 를 보내지 않고 max_completion_tokens 와 reasoning_effort 를 쓴다", () => {
  for (const model of ["gpt-5", "gpt-5-mini", "gpt-5.1", "gpt-5.2-mini", "o4-mini"]) {
    const b = buildBody({ model, messages: msgs, maxTokens: 400, effort: "low" });
    assert.equal(isReasoning(model), true, model);
    assert.equal("max_tokens" in b, false, model);
    assert.equal("temperature" in b, false, model);
    assert.equal(b.reasoning_effort, "low");
    assert.ok(b.max_completion_tokens > 400, "추론 여유분이 더해져야 한다");
  }
});

test("비추론 모델(gpt-5-chat)에는 reasoning_effort 를 보내지 않는다", () => {
  const b = buildBody({ model: "gpt-5-chat-latest", messages: msgs, effort: "low" });
  assert.equal("reasoning_effort" in b, false);
  assert.equal("temperature" in b, false);
});

test("GPT-4 계열: temperature 사용, 추론 파라미터 없음, 토큰 여유분 없음", () => {
  const b = buildBody({ model: "gpt-4o-mini", messages: msgs, maxTokens: 400, effort: "low" });
  assert.equal(b.temperature, 0.8);
  assert.equal("reasoning_effort" in b, false);
  assert.equal(b.max_completion_tokens, 400);
});

test("JSON 모드는 response_format 을 붙인다", () => {
  assert.deepEqual(buildBody({ model: "gpt-5-mini", messages: msgs, json: true }).response_format, { type: "json_object" });
});

test("extractJson: 코드펜스나 앞뒤 설명이 붙어도 JSON 을 꺼낸다", () => {
  assert.deepEqual(extractJson('```json\n{"ok":true}\n```'), { ok: true });
  assert.deepEqual(extractJson('결과: {"a":{"b":1}} 끝'), { a: { b: 1 } });
  assert.throws(() => extractJson("JSON 없음"));
});

test("chat: 추론에 한도를 다 써서 내용이 비면 오류로 처리한다", async () => {
  const realFetch = global.fetch;
  global.fetch = async () => ({ ok: true, json: async () => ({ choices: [{ message: { content: "" }, finish_reason: "length" }] }) });
  try {
    await assert.rejects(chat({ apiKey: "k", model: "gpt-5-mini", messages: msgs }), /빈 응답.*length/);
  } finally { global.fetch = realFetch; }
});

test("사고량이 클수록 토큰 여유가 커진다 (시뮬레이션이 빈 답으로 끝나지 않도록)", () => {
  assert.ok(headroom("medium") >= 8000);
  assert.ok(headroom("medium") > headroom("low"));
  const b = buildBody({ model: "gpt-5", messages: msgs, maxTokens: 1400, effort: "medium" });
  assert.ok(b.max_completion_tokens >= 1400 + 8000);
});
