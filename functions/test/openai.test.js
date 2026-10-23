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

test("사고량 값은 모델에 맞게 바꾼다: 처음 GPT-5 는 minimal, 그 뒤 계열은 none, none 을 못 받는 모델은 low", () => {
  const { effortFor, buildResponsesBody } = require("../openai");
  assert.equal(effortFor("gpt-5-mini", "minimal"), "minimal");
  assert.equal(effortFor("gpt-5-mini-2025-08-07", "minimal"), "minimal");
  for (const m of ["gpt-5.6-terra", "gpt-5.6-luna", "gpt-5.6-sol", "gpt-5.4-mini", "gpt-6-luna"]) {
    assert.equal(effortFor(m, "minimal"), "none", m);
    assert.equal(effortFor(m, "low"), "low", m);
    assert.equal(effortFor(m, "medium"), "medium", m);
  }
  assert.equal(effortFor("gpt-6-astra", "minimal"), "low");
  assert.equal(effortFor("gpt-6.1-sol", "minimal"), "low");
  assert.equal(effortFor("o4-mini", "minimal"), "low");
  assert.equal(isReasoning("gpt-6.1-sol"), true);
  assert.equal(isReasoning("gpt-6-luna"), true);
  // 함수 도구를 줄 때(인물의 사실 찾아보기) 새 계열은 none 이어야 400 이 나지 않는다
  const msgs = [{ role: "user", content: "hi" }];
  const tool = { type: "function", function: { name: "lookup", parameters: { type: "object", properties: {} } } };
  assert.equal(buildBody({ model: "gpt-5.6-terra", messages: msgs, effort: "low", tools: [tool] }).reasoning_effort, "none");
  assert.equal(buildBody({ model: "gpt-5.6-terra", messages: msgs, effort: "low" }).reasoning_effort, "low");
  assert.equal(buildBody({ model: "gpt-5-mini", messages: msgs, effort: "low", tools: [tool] }).reasoning_effort, "low", "처음 GPT-5 는 도구와 사고량을 함께 쓸 수 있다");
  assert.ok(buildBody({ model: "gpt-5.6-terra", messages: msgs, maxTokens: 600, effort: "low", tools: [tool] }).max_completion_tokens >= 600);
  // 웹 검색(Responses API)은 가장 가벼운 사고량을 low 로 올린다
  for (const e of ["minimal", "none"]) assert.equal(buildResponsesBody({ model: "gpt-5.6-luna", instructions: "i", input: "q", effort: e }).reasoning.effort, "low");
});

test("인물의 사실 찾아보기(Responses API 함수 도구): 새 모델도 정한 사고량(low)을 그대로 쓰고, 마지막 차례는 도구를 막는다", () => {
  const { buildToolBody } = require("../openai");
  const tools = [{ type: "function", name: "lookup", parameters: { type: "object", properties: {} } }];
  const input = [{ role: "user", content: "몇 명이에요?" }];
  const b = buildToolBody({ model: "gpt-5.6-terra", input, tools, maxTokens: 600, effort: "low" });
  assert.deepEqual(b.reasoning, { effort: "low" });
  assert.equal(b.tool_choice, "auto");
  assert.ok(b.max_output_tokens >= 600 + 2500, "사고 여유분");
  assert.equal(buildToolBody({ model: "gpt-5.6-terra", input, tools, toolChoice: "none", effort: "low" }).tool_choice, "none");
  assert.deepEqual(buildToolBody({ model: "gpt-5.6-terra", input, tools, effort: "minimal" }).reasoning, { effort: "none" });
  assert.deepEqual(buildToolBody({ model: "gpt-5-mini", input, tools, effort: "low" }).reasoning, { effort: "low" });
});
