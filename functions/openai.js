// OpenAI Chat Completions 호출 (SDK 없이 fetch 사용)
//
// 모델 계열별 파라미터 차이를 한 곳에서 처리한다.
//  - GPT-5 이후 계열(gpt-5, gpt-5.x, gpt-6 …)·o 시리즈(추론 모델): max_tokens 와 기본값이 아닌 temperature 를 거부한다(400).
//    max_completion_tokens 를 쓰고, 추론에 쓰이는 토큰이 이 한도에 포함되므로 여유분을 더한다.
//    reasoning_effort 로 속도와 품질을 조절한다. (gpt-5-chat 처럼 비추론 모델에는 보내지 않는다)
//  - GPT-3/4 계열: temperature 사용 가능.
//  - 사고량 값은 모델마다 받는 것이 다르다(effortFor). 코드 안에서는 가장 가벼운 사고량을 'minimal' 로 적고 여기서 바꾼다.
//      · 처음 GPT-5(gpt-5, gpt-5-mini, gpt-5-nano 와 날짜 붙은 스냅샷): minimal 그대로
//      · 그 뒤 계열(gpt-5.1 ~ gpt-5.6, gpt-6 Luna 등): minimal 을 받지 않고(400) none 을 받는다
//      · none 도 받지 않는 모델(gpt-6 Astra, gpt-6.x Sol)과 o 시리즈: low
//  - GPT-5.6 이후 계열은 Chat Completions 에서 함수 도구(tools)와 사고량(none 이 아닌 값)을 함께 쓰면 400 이다.
//    그래서 도구를 줄 때는 none 으로 보낸다(1단계 인물의 사실 찾아보기, lookup.js).

const isReasoning = (model) => /^(gpt-([5-9]|\d{2,})|o\d)/.test(model) && !/chat/.test(model);
const supportsTemperature = (model) => /^gpt-(3|4)/.test(model);
const isFirstGpt5 = (model) => /^gpt-5(-mini|-nano)?(-\d{4}-\d{2}-\d{2})?$/.test(model);
const noNone = (model) => /^o\d/.test(model) || /^gpt-6(\.\d+)?-(astra|sol)/.test(model);
function effortFor(model, effort, { tools = false } = {}) {
  if (!isReasoning(model) || !effort) return effort;
  if (isFirstGpt5(model)) return effort === "none" ? "minimal" : effort;
  if (tools && !noNone(model)) return "none";
  if (effort === "minimal" || effort === "none") return noNone(model) ? "low" : "none";
  return effort;
}
// 추론 모델은 보이는 답을 쓰기 전에 '사고'에 토큰을 쓴다. 사고량(effort)이 클수록 여유를 더 둔다.
// 여유가 모자라면 답이 비어 버린다(finish_reason=length). 실제로 쓴 토큰만 과금된다.
const HEADROOM = { none: 300, minimal: 800, low: 2500, medium: 8000, high: 16000, xhigh: 24000, max: 32000 };
const headroom = (effort) => HEADROOM[effort] ?? 2500;

function buildBody({ model, messages, json = false, maxTokens = 700, effort, tools }) {
  const eff = effortFor(model, effort, { tools: !!tools?.length });
  const body = { model, messages, max_completion_tokens: maxTokens + (isReasoning(model) ? headroom(eff) : 0) };
  if (tools?.length) body.tools = tools;
  if (supportsTemperature(model)) body.temperature = 0.8;
  if (isReasoning(model) && eff) body.reasoning_effort = eff;
  if (json) body.response_format = { type: "json_object" };
  return body;
}

// 모델이 JSON 앞뒤에 코드펜스나 설명을 붙여도 첫 JSON 객체를 꺼낸다.
function extractJson(text) {
  const s = String(text ?? "");
  const start = s.indexOf("{");
  const end = s.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("JSON 객체를 찾을 수 없음");
  return JSON.parse(s.slice(start, end + 1));
}

// 응답 메시지 전체를 돌려준다(도구 호출 포함). 보이는 답도 도구 호출도 없으면 오류.
async function chatMessage(opts) {
  const { apiKey } = opts;
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify(buildBody(opts)),
  });
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`OpenAI ${res.status}: ${t.slice(0, 300)}`);
  }
  const data = await res.json();
  const choice = data.choices?.[0];
  const message = choice?.message || {};
  // 추론에 한도를 다 써서 보이는 답이 비어 있으면 오류로 처리한다(조용히 빈 답을 보여 주지 않는다)
  if (!message.tool_calls?.length && !String(message.content ?? "").trim()) throw new Error(`OpenAI 빈 응답 (finish_reason=${choice?.finish_reason})`);
  return message;
}

async function chat(opts) {
  return (await chatMessage(opts)).content ?? "";
}

// Responses API: 웹 검색 도구(web_search)를 쓸 수 있다. 검색은 추론 사고량 minimal 과 함께 쓸 수 없어 low 이상으로 올린다.
function buildResponsesBody({ model, instructions, input, maxTokens = 1200, effort = "low", domains = [] }) {
  const tool = { type: "web_search", ...(domains.length ? { filters: { allowed_domains: domains } } : {}) };
  // 웹 검색 도구는 가장 가벼운 사고량(minimal·none)과 함께 쓸 수 없어 low 로 올린다
  const eff = effort === "minimal" || effort === "none" ? "low" : effort;
  const body = { model, instructions, input, tools: [tool], max_output_tokens: maxTokens + (isReasoning(model) ? headroom(eff) : 0) };
  if (isReasoning(model)) body.reasoning = { effort: eff };
  return body;
}

// Responses API 의 output 에서 글과 인용 출처를 꺼낸다
function parseResponses(data) {
  const parts = (data.output || []).filter((o) => o.type === "message").flatMap((o) => o.content || []).filter((c) => c.type === "output_text");
  const text = parts.map((c) => c.text || "").join("\n").trim();
  const seen = new Set();
  const sources = [];
  for (const c of parts) for (const a of c.annotations || []) {
    if (a.type === "url_citation" && a.url && !seen.has(a.url)) { seen.add(a.url); sources.push({ title: String(a.title || a.url).slice(0, 120), url: a.url }); }
  }
  return { text, sources: sources.slice(0, 5) };
}

// 인용 위치까지 꺼낸다: 글 전체(text)와, 글 안에서 각 인용 링크가 붙은 위치(start·end). 주제 만들기의 사실 은행이
// '인용 링크가 붙은 문장'만 받아들이는 데 쓴다. 메시지가 여러 개면 줄바꿈으로 잇고 위치를 그만큼 민다.
function parseCited(data) {
  const parts = (data.output || []).filter((o) => o.type === "message").flatMap((o) => o.content || []).filter((c) => c.type === "output_text");
  let text = "";
  const cites = [];
  for (const c of parts) {
    if (text) text += "\n";
    const base = text.length;
    for (const a of c.annotations || []) {
      if (a.type !== "url_citation" || !a.url) continue;
      cites.push({ url: a.url, title: String(a.title || "").slice(0, 200), start: base + (a.start_index ?? 0), end: base + (a.end_index ?? a.start_index ?? 0) });
    }
    text += c.text || "";
  }
  return { text, cites };
}

async function respondCited(opts) {
  const res = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${opts.apiKey}` },
    body: JSON.stringify(buildResponsesBody(opts)),
  });
  if (!res.ok) throw new Error(`OpenAI responses ${res.status}: ${(await res.text()).slice(0, 300)}`);
  return parseCited(await res.json());
}

async function respond(opts) {
  const res = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${opts.apiKey}` },
    body: JSON.stringify(buildResponsesBody(opts)),
  });
  if (!res.ok) throw new Error(`OpenAI responses ${res.status}: ${(await res.text()).slice(0, 300)}`);
  return parseResponses(await res.json());
}

module.exports = { chat, chatMessage, respond, respondCited, parseCited, buildBody, buildResponsesBody, parseResponses, extractJson, isReasoning, headroom, effortFor };
