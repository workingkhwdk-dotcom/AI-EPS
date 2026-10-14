// OpenAI Chat Completions 호출 (SDK 없이 fetch 사용)
async function chat({ apiKey, model, messages, json = false, maxTokens = 700 }) {
  const body = { model, messages, max_tokens: maxTokens, temperature: 0.8 };
  if (json) body.response_format = { type: "json_object" };
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`OpenAI ${res.status}: ${t.slice(0, 300)}`);
  }
  const data = await res.json();
  return data.choices?.[0]?.message?.content ?? "";
}

module.exports = { chat };
