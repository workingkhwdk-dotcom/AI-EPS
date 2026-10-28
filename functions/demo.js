// 체험(demo) 페이지용 AI 호출. 실제 수업과 같은 프롬프트·상위 AI(감독자)를 쓰되, 수업·모둠 문서 없이 요청에 담긴 내용만으로 답한다.
// 학생 화면(public/demo/)이 쓴 글은 그 기기에만 저장되므로, 필요한 내용은 요청에 실려 온다. 서버는 아무것도 저장하지 않는다(사용 횟수만 index.js 가 센다).
//  - 요청을 믿지 않는다: 글자 수를 자르고, 사건·인물·횟수 종류는 서버가 아는 값만 받는다.
//  - 웹 검색은 쓰지 않는다(비용). 3단계 검색 도우미는 수업 자료만 근거로 답한다.
//  - Firebase 에 의존하지 않는다(그래서 단위 테스트가 가능하다). 모델 호출은 호출하는 쪽이 넘겨 준다(call).
const { EVENTS, availablePersonas, materialsFor } = require("./case");
const prompts = require("./prompts");
const conduct = require("./conduct");
const { guardMessages, parseVerdict, resolveOutput } = require("./guard");
const { extractJson } = require("./openai");
const { isSmallTalk } = require("./lookup");
const { materialsText } = require("./materials");
const { LENSES_BY, ROUNDS_BY, defaultDeep } = require("./level");

// 체험 한도(기기마다·주제마다). 체험이라서 5번까지임을 화면에도 적는다.
const LIMITS = { chat: 5, ai: 5 };
const REVIEW_LABELS = { feasibility: "실행 가능성", stakeholders: "이해관계자 영향", sideEffects: "부작용·장기 영향" };
const REVIEW_LABELS_MID = { feasibility: "정말 할 수 있을까", stakeholders: "사람들의 반응", sideEffects: "나중에 생길 일" };

class DemoError extends Error { constructor(code, message) { super(message); this.code = code; } }
const bad = (m) => new DemoError("invalid-argument", m);
const clip = (v, n) => String(v ?? "").trim().slice(0, n);

// 요청 확인: 검사를 통과한 값만 돌려준다
function parse(data) {
  const d = data && typeof data === "object" ? data : {};
  const deviceId = String(d.deviceId || "");
  // day- 로 시작하는 이름은 하루 전체 횟수 문서(demoUsage/day-YYYY-MM-DD)와 겹치므로 받지 않는다
  if (!/^[A-Za-z0-9-]{12,64}$/.test(deviceId) || /^day-/i.test(deviceId)) throw bad("기기 표시가 올바르지 않아요.");
  const topic = String(d.topic || "");
  if (!Object.hasOwn(EVENTS, topic)) throw bad("주제를 찾을 수 없어요."); // constructor 같은 객체 기본 속성 이름은 주제가 아니다
  const kind = d.kind === "chat" ? "chat" : d.kind === "ai" ? "ai" : "";
  if (!kind) throw bad("요청 종류가 올바르지 않아요.");
  const stage = Number(d.stage);
  if (kind === "ai" && ![2, 3, 4, 5].includes(stage)) throw bad("단계가 올바르지 않아요.");
  // 학교급: 중학교 체험이면 middle. 심화 활동은 학교급의 기본값(새 수업과 같다: 고등학교 모두 켬, 중학교 모두 끔)
  const level = d.level === "middle" ? "middle" : "high";
  return { ...d, deviceId, topic, kind, stage, level, deep: defaultDeep(level) };
}

const personaOf = (topic, id) => {
  const p = availablePersonas(topic, false).find((x) => x.id === String(id || ""));
  if (!p) throw bad("인물을 찾을 수 없어요.");
  return p;
};

// 1단계: 인물 대화 한 번(인물 응답 → 상위 AI 검사)
async function chatTurn(d, { call, effort }) {
  const ev = EVENTS[d.topic], persona = personaOf(d.topic, d.personaId);
  const input = clip(d.message, 500);
  if (!input) throw bad("보낼 말이 없어요.");
  const past = (Array.isArray(d.history) ? d.history : []).slice(-8).map((h) => ({ input: clip(h?.input, 500), output: clip(h?.output, 1200) })).filter((h) => h.input && h.output);
  const pre = conduct.screenMessage(input);
  if (pre.category !== "ok") return { text: conduct.boundaryReply(pre.category), replaced: true };
  const smallTalk = isSmallTalk(input);
  const messages = [{ role: "system", content: prompts.personaPrompt(ev, persona, { lookup: false, level: d.level, subtle: d.deep.beliefs }) }];
  for (const h of past) messages.push({ role: "user", content: h.input }, { role: "assistant", content: h.output });
  messages.push({ role: "user", content: input });
  const reply = await call({ messages, maxTokens: smallTalk ? 300 : 600, efforts: smallTalk ? ["minimal", effort] : [effort] });
  let verdict;
  try {
    verdict = parseVerdict(await call({
      json: true, maxTokens: 900, efforts: smallTalk ? ["minimal", "low"] : ["low"],
      messages: guardMessages({ event: ev, persona, claims: persona.claims, history: past.slice(-3), studentMessage: input, reply, lookups: [], level: d.level }),
    }));
  } catch { verdict = { ok: false, category: "error", reason: "감독자 호출 실패", fixed: "", conduct: "ok" }; }
  if (verdict.conduct !== "ok") return { text: conduct.boundaryReply(verdict.conduct), replaced: true };
  const out = resolveOutput(verdict, reply);
  // 감독자 검사가 실패해 안내가 나간 경우는 횟수에서 빼 준다
  return { text: out.text, replaced: !!out.replaced, refunded: verdict.category === "error" };
}

// 2~5단계: 모둠 AI(생각 도우미·검색 도우미·AI 의견·미래 이야기). 학생이 쓴 글은 payload 로 온다.
async function aiTurn(d, { call, effort }) {
  const ev = EVENTS[d.topic];
  const c = d.ctx || {}, p = d.payload || {};
  const evCtx = { summary: ev.summary, premise: ev.summary, level: d.level, deep: d.deep, problem: clip(c.problem, 400), cause: clip(c.cause, 400), evidence: clip(c.evidence, 400) };
  if (d.stage === 2) {
    const focus = p.focus === "cause" ? "cause" : "link";
    let input;
    if (focus === "link") {
      const l = p.link || {}, me = d.personaId ? personaOf(d.topic, d.personaId) : null;
      input = [`학생이 만난 인물: ${me ? `${me.name} (${me.role})` : "(모름)"}`,
        `대화 전 처음 생각: ${clip(l.prior, 300) || "(없음)"}`, `대화하며 흔들린 순간: ${clip(l.surprise, 300) || "(없음)"}`,
        `그 생각은 어디서 왔을까: ${clip(l.source, 400) || "(없음)"}`, `내 생활의 장면${l.angle ? `(${clip(l.angle, 40)})` : ""}: ${clip(l.scene, 400) || "(없음)"}`,
        `그래서 생긴 질문: ${clip(l.question, 300) || "(없음)"}`].join("\n");
    } else {
      input = "모둠이 쓴 원인 추측:\n" + (Array.isArray(p.causes) ? p.causes : []).slice(0, 12).map((q) => `- ${q?.level ? `[${clip(q.level, 20)}] ` : ""}${clip(q?.text, 200)}`).join("\n");
      if (d.deep.causeMap) input += "\n모둠이 이은 원인 관계:\n" + ((Array.isArray(p.links) ? p.links : []).slice(0, 12).map((l) => `- ${clip(l?.from, 80)} → ${clip(l?.rel, 20) || "이어짐"} → ${clip(l?.to, 80)}`).join("\n") || "- (아직 잇지 않음)");
    }
    const out = await call({ messages: [{ role: "system", content: prompts.coachPrompt(evCtx, focus) }, { role: "user", content: input }], json: true, maxTokens: 400, efforts: ["low"] });
    let v; try { v = extractJson(out); } catch { throw new DemoError("internal", "생각 도우미의 답을 읽지 못했어요."); }
    const kinds = Object.keys(prompts.coachKinds(focus, { level: d.level, causeMap: d.deep.causeMap }));
    const result = { kind: kinds.includes(v.kind) ? v.kind : "", question: clip(v.question, 300) };
    if (!result.question) throw new DemoError("internal", "생각 도우미의 답이 비어 있어요.");
    return { result, output: JSON.stringify(result) };
  }
  if (d.stage === 3) {
    const k = p.check || {};
    const input = (k.cause ? `학생들이 확인하려는 원인 가설: ${clip(k.cause, 300)}\n확인할 말: ${clip(k.heard, 300) || "(적지 않음)"}` : `학생들이 인터뷰에서 들은 말: ${clip(k.heard, 300) || "(적지 않음)"}`) +
      `\n검증 질문: ${clip(k.question, 300)}` + (k.srcType ? `\n학생들이 확인하려는 자료 종류: ${clip(k.srcType, 40)}` : "");
    const mats = materialsText(materialsFor(d.topic));
    const out = await call({ messages: [{ role: "system", content: prompts.verifyPrompt(evCtx, { materials: mats, search: null }) }, { role: "user", content: input }], maxTokens: 900, efforts: [effort] });
    return { result: out, output: out };
  }
  if (d.stage === 4) {
    const pr = p.proposal || {};
    const input = clip(pr.text, 1500);
    if (!input) throw bad("해결책이 비어 있어요.");
    const extra = [pr.cause && `이 대안이 겨냥하는 원인: ${clip(pr.cause, 300)}`, pr.ref && `참고한 사례: ${clip(pr.ref, 300)}`, pr.transfer && `그 사례와 우리 사건의 다른 점(모둠이 쓴 것): ${clip(pr.transfer, 300)}`].filter(Boolean).join("\n");
    const labels = d.level === "middle" ? REVIEW_LABELS_MID : REVIEW_LABELS;
    const settled = await Promise.allSettled(LENSES_BY[d.level].map((lens) => call({
      maxTokens: 500, efforts: [effort],
      messages: [{ role: "system", content: prompts.feedbackPrompt(evCtx, lens) }, { role: "user", content: `우리 모둠의 대안:\n${input}${extra ? `\n${extra}` : ""}` }],
    }).then((text) => ({ lens, label: labels[lens], text }))));
    const reviews = settled.filter((r) => r.status === "fulfilled").map((r) => r.value);
    if (!reviews.length) throw settled[0].reason;
    return { result: { reviews }, output: JSON.stringify({ reviews }) };
  }
  // 5단계
  const rounds = ROUNDS_BY[d.level], round = rounds.includes(Number(p.round)) ? Number(p.round) : rounds[Math.floor(rounds.length / 2)];
  const text = clip(p.proposalText, 1500);
  if (!text) throw bad("해결책이 비어 있어요.");
  const preds = (Array.isArray(p.predictions) ? p.predictions : []).slice(0, 12).map((x) => `- ${clip(x?.stakeholder, 40) || "이해관계자"}: ${clip(x?.text, 300)}`).join("\n");
  const out = await call({ messages: [{ role: "system", content: prompts.scenarioPrompt(evCtx, round) }, { role: "user", content: `대안: ${text}\n시점: ${round}년 후\n학생들의 예측:\n${preds}` }], json: true, maxTokens: 1800, efforts: ["medium", "low"] });
  let result; try { result = extractJson(out); } catch { throw new DemoError("internal", "시나리오 형식 오류예요."); }
  return { result, output: JSON.stringify(result) };
}

const run = (d, deps) => (d.kind === "chat" ? chatTurn(d, deps) : aiTurn(d, deps));

module.exports = { LIMITS, DemoError, parse, run, REVIEW_LABELS };
