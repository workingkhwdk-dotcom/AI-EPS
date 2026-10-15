// OpenAI Chat Completions 호출 (SDK 없이 fetch 사용)
//
// 모델 계열별 파라미터 차이를 한 곳에서 처리한다.
//  - GPT-5 계열·o 시리즈(추론 모델): max_tokens 와 기본값이 아닌 temperature 를 거부한다(400).
//    max_completion_tokens 를 쓰고, 추론에 쓰이는 토큰이 이 한도에 포함되므로 여유분을 더한다.
//    reasoning_effort 로 속도와 품질을 조절한다. (gpt-5-chat 처럼 비추론 모델에는 보내지 않는다)
//  - GPT-3/4 계열: temperature 사용 가능.

const isReasoning = (model) => /^(gpt-5|o\d)/.test(model) && !/chat/.test(model);
const supportsTemperature = (model) => /^gpt-(3|4)/.test(model);
const REASONING_HEADROOM = 1500;

function buildBody({ model, messages, json = false, maxTokens = 700, effort }) {
  const body = { model, messages, max_completion_tokens: maxTokens + (isReasoning(model) ? REASONING_HEADROOM : 0) };
  if (supportsTemperature(model)) body.temperature = 0.8;
  if (isReasoning(model) && effort) body.reasoning_effort = effort;
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

async function chat(opts) {
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
  const content = choice?.message?.content ?? "";
  // 추론에 한도를 다 써서 보이는 답이 비어 있으면 오류로 처리한다(조용히 빈 답을 보여 주지 않는다)
  if (!String(content).trim()) throw new Error(`OpenAI 빈 응답 (finish_reason=${choice?.finish_reason})`);
  return content;
}

module.exports = { chat, buildBody, extractJson, isReasoning };
