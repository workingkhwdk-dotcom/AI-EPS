// 체험용 가짜 서버: 학생 화면이 부르는 서버 함수(getCase·choosePersona·aiRequest)를 브라우저 안에서 대신 처리한다.
// AI 답은 서버의 demoRequest(실제와 같은 프롬프트, 체험용 가벼운 모델)에게 먼저 묻는다. 횟수(인물 5번·도우미 5번)를 다 썼거나 연결이 안 되면
// 준비된 예시 답으로 바꿔 보여 준다: 인물의 말은 인물 자료에서 고르고, 3~5단계 답은 모둠이 쓴 글과 수업 자료를 짜 맞춘 예시.
import * as st from "./store.js";
import { TOPIC, CODE, UID, NICK, LEVEL } from "./store.js";
import { demoReply, snippet } from "./chat.js";
import { firebaseConfig } from "../firebase-config.js";
import { toast } from "../fb.js";

let dataP = null;
const data = () => (dataP ||= fetch(`demo/data/${TOPIC}.json`).then((r) => r.json()));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fail = (msg) => { const e = new Error(msg); e.code = "functions/failed-precondition"; return e; };
const list = (m) => Object.entries(m || {}).map(([id, v]) => ({ id, ...(v && typeof v === "object" ? v : { text: v }) }));
const memberPath = `sessions/${CODE}/members/${UID}`, groupPath = "g1", assignPath = `sessions/${CODE}/assign/${UID}`;
const gPath = `sessions/${CODE}/groups/g1`;


// ---- 진짜 AI: 서버의 demoRequest(로그인 없이 부르는 함수)를 HTTP 로 부른다. 실패하면 null → 준비된 답으로 대신한다 ----
const AI_URL = `https://asia-northeast3-${firebaseConfig.projectId}.cloudfunctions.net/demoRequest`;
const DEVICE = (() => { // 이 기기 표시(서버가 기기마다 횟수를 센다). 초기화해도 바뀌지 않는다.
  try { let v = localStorage.getItem("eps_demo_device"); if (!v) { v = (crypto.randomUUID?.() || Date.now().toString(36) + Math.random().toString(36).slice(2)).replace(/[^A-Za-z0-9-]/g, "") + "0000000000"; localStorage.setItem("eps_demo_device", v); } return v.slice(0, 64); }
  catch { return "nostorage-" + Math.random().toString(36).slice(2, 12) + "00"; }
})();
async function askAI(body) {
  const ctl = new AbortController(), timer = setTimeout(() => ctl.abort(), 120000);
  try {
    const res = await fetch(AI_URL, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ data: { deviceId: DEVICE, topic: TOPIC, level: LEVEL, ...body } }), signal: ctl.signal });
    const j = await res.json().catch(() => ({}));
    if (res.ok && j.result) return j.result;
    toast(j.error?.status === "RESOURCE_EXHAUSTED" && j.error.message ? j.error.message : "AI와 연결되지 않아 준비된 예시 답으로 보여 드려요.");
  } catch { toast("AI와 연결되지 않아 준비된 예시 답으로 보여 드려요."); }
  finally { clearTimeout(timer); }
  return null;
}

// 2~5단계: 모둠이 쓴 글을 서버의 AI 에게 보내 답을 받는다. 못 받으면 null.
async function realAI(s, payload, work, d, pid) {
  const pb = work.s1?.problem || {};
  const ctx = { problem: [pb.situation, pb.hmw].filter(Boolean).join(" / "), cause: work.s3?.chain?.cause, evidence: work.s3?.chain?.evidence };
  let body, input = "", lp = {};
  if (s === 2) {
    if (payload.focus === "link") {
      const l = list(work.s2?.links).find((x) => x.id === payload.linkId) || {};
      body = { focus: "link", link: { prior: l.prior, surprise: l.surprise, source: l.source, scene: l.scene, angle: l.angle, question: l.question } };
      input = [l.surprise, l.scene, l.question].filter(Boolean).join(" / "); lp = { focus: "link", linkId: payload.linkId };
    } else {
      const cs = list(work.s2?.causes);
      // 원인 잇기(심화)를 했으면 이은 관계도 함께 보낸다(원인 글로 바꿔서)
      const textOf = (id) => cs.find((c) => c.id === id)?.text;
      const links = list(work.s2?.causeLinks).filter((l) => textOf(l.from) && textOf(l.to)).map((l) => ({ from: textOf(l.from), rel: l.rel, to: textOf(l.to) }));
      body = { focus: "cause", causes: cs.map((c) => ({ level: c.level, text: c.text })), ...(links.length ? { links } : {}) };
      input = cs.map((c) => `- ${c.level || ""} ${c.text || ""}`).join("\n"); lp = { focus: "cause" };
    }
  } else if (s === 3) {
    const c = list(work.s2?.checks).find((x) => x.id === payload.checkId) || {};
    const cause = c.causeId ? list(work.s2?.causes).find((x) => x.id === c.causeId)?.text : "";
    body = { check: { heard: c.heard, question: c.question, srcType: c.srcType, cause } };
    input = [c.heard && `확인할 말: ${c.heard}`, c.question && `검증 질문: ${c.question}`].filter(Boolean).join("\n"); lp = { checkId: payload.checkId, searched: false };
  } else if (s === 4) {
    const p = list(work.s4?.proposals).find((x) => x.id === payload.proposalId) || {};
    body = { proposal: { text: p.text, cause: p.cause, ref: p.ref, transfer: p.transfer } };
    input = String(p.text || ""); lp = { proposalId: payload.proposalId };
  } else {
    const text = payload.proposalId === "final" ? work.s4?.final : list(work.s4?.proposals).find((x) => x.id === payload.proposalId)?.text;
    body = { proposalText: text, round: payload.round, predictions: list(work.s5?.predictions).slice(0, 12).map((x) => ({ stakeholder: x.stakeholder, text: x.text })) };
    input = `대안: ${text || ""}\n시점: ${payload.round}년 후`; lp = { proposalId: payload.proposalId, round: payload.round };
  }
  const r = await askAI({ kind: "ai", stage: s, personaId: pid, ctx, payload: body });
  return r ? { result: r.result, output: r.output, input, lp } : null;
}

// 데모라서 실제와 다른 점은 답 안에서도 항상 밝힌다(화면 위의 '데모라서' 줄은 ui.js)
const TAG = "※ 데모라서 준비된 예시 답이에요.";
const NO_WEB = "※ 데모라서 웹 검색 없이 수업 자료만 근거로 답했어요(실제 수업에서는 웹 검색도 해요).";
function tagged(s, real, result) {
  if (real) return s === 3 ? `${result}\n\n${NO_WEB}` : result;
  if (s === 2) return { ...result, question: `${result.question} (${TAG})` };
  if (s === 3) return `${result}\n\n${TAG}`;
  if (s === 4) return { reviews: result.reviews.map((r) => ({ ...r, text: `${r.text}\n\n${TAG}` })) };
  return { scenarios: result.scenarios.map((x) => ({ ...x, title: `${x.title} (※ 데모 예시)` })) };
}

const handlers = {
  async joinSession() { return {}; }, // 체험에서는 입장 화면 없이 바로 들어간다

  async getCase() {
    const d = await data();
    const a = st.get(assignPath);
    const me = a && d.letters.find((l) => l.id === a.personaId);
    return {
      title: d.title, summary: d.summary, stakeholders: d.stakeholders, letters: d.letters, ui: d.ui,
      me: me ? { id: me.id, name: me.name, letter: me.letter, personal: me.personal } : null,
      materials: d.materials, cases: d.cases, aftermath: d.aftermath,
    };
  },

  async choosePersona({ personaId }) {
    const d = await data();
    const p = d.letters.find((l) => l.id === personaId);
    if (!p) throw fail("인물을 찾을 수 없습니다.");
    const cur = st.get(assignPath)?.personaId;
    if (cur === personaId) return { me: { id: p.id, name: p.name, letter: p.letter, personal: p.personal } };
    if ((st.get(memberPath)?.chatCount || 0) > 0) throw fail("인물과 대화를 시작한 뒤에는 인물을 바꿀 수 없어요. 처음부터 다시 하려면 위쪽 '초기화'를 누르세요.");
    const upd = { [`picks.${personaId}`]: { uid: UID, nick: NICK } };
    if (cur) upd[`picks.${cur}`] = st.DELETE;
    st.update(gPath, upd);
    st.set(assignPath, { groupId: "g1", personaId });
    return { me: { id: p.id, name: p.name, letter: p.letter, personal: p.personal } };
  },

  async aiRequest({ stage, type, payload = {} }) {
    const d = await data();
    const s = Number(stage);
    const m = st.get(memberPath) || {}, g = st.get(gPath) || {}, work = g.work || {};
    const now = st.SERVER_TS;

    if (s === 1) {
      const limit = st.get(`sessions/${CODE}`)?.chatLimit || 5;
      if ((m.chatCount || 0) >= limit) throw fail(`인물에게 물을 수 있는 ${limit}번을 모두 썼어요. 지금까지 들은 이야기로 ② 정리를 해 보세요.`);
      const pid = st.get(assignPath)?.personaId;
      const say = d.say[pid];
      if (!say) throw fail("대화할 인물을 먼저 골라 주세요.");
      const input = String(payload.message || "").trim();
      const prev = st.colList(`sessions/${CODE}/members/${UID}/chat`).sort((a, b) => (a.createdAt?.toMillis?.() || 0) - (b.createdAt?.toMillis?.() || 0));
      const real = await askAI({ kind: "chat", personaId: pid, message: input, history: prev.slice(-8).map((c) => ({ input: c.input, output: c.output })) });
      let output, model = "ai", refunded = false;
      if (real?.text) { output = real.text; refunded = !!real.refunded; }
      else { await sleep(700 + Math.random() * 700); output = `${demoReply(input, say, prev.map((c) => c.output))}\n\n(${TAG})`; model = "demo"; }
      st.add(`sessions/${CODE}/members/${UID}/chat`, { uid: UID, nickname: NICK, input, output, model, conduct: null, ...(refunded ? { refunded: true } : {}), createdAt: now });
      st.update(memberPath, { chatCount: st.inc(refunded ? 0 : 1), aiCount: st.inc(1) });
      return { result: output };
    }

    let output, result, lp = {}, input = "";
    const real = await realAI(s, payload, work, d, st.get(assignPath)?.personaId);
    if (real) ({ result, output, input, lp } = real);
    else if (s === 2) {
      await sleep(900);
      const focus = payload.focus;
      if (focus === "link") {
        const l = list(work.s2?.links).find((x) => x.id === payload.linkId) || {};
        input = [l.surprise, l.scene, l.question].filter(Boolean).join(" / ");
        const base = l.scene || l.surprise || l.source || l.prior || "";
        const kind = /그 사람들|상관없|남의/.test(base) ? "멀리 둠" : /해야|잘못|당연히/.test(base) ? "판단부터 함" : base.length < 25 ? "겉모습만 닮음" : "잘 이어짐";
        const q = { "멀리 둠": `'${snippet(base)}'라고 썼는데, 나와 떨어진 일처럼 느껴지나요? 나도 낯선 곳에 처음 가 봤던 때를 한 장면만 떠올려 볼래요?`,
          "판단부터 함": `'${snippet(base)}'라고 썼는데, 잠깐 결론은 내려놓고 그렇게 생각하게 된 내 경험이나 들은 말은 무엇이었는지 적어 볼래요?`,
          "겉모습만 닮음": `'${snippet(base)}'라고 썼는데, 그 장면에서 내가 당연하게 여긴 것은 무엇이었고 어떤 마음이었나요?`,
          "잘 이어짐": `'${snippet(base)}'라는 경험이 한 사람의 일을 넘어 어떤 규칙이나 동네 분위기와 이어져 있을까요?` }[kind];
        result = { kind, question: q }; lp = { focus, linkId: payload.linkId, kind };
      } else {
        const cs = list(work.s2?.causes);
        input = cs.map((c) => `- ${c.level || ""} ${c.text || ""}`).join("\n");
        const levels = new Set(cs.map((c) => c.level).filter(Boolean));
        const first = cs[0]?.text || "";
        let kind, question;
        if (cs.length && levels.size === 1) { kind = "한 군데만 봄"; question = `원인이 모두 '${[...levels][0]}' 쪽에 몰려 있어요. 아직 살펴보지 않은 쪽에서는 어떤 이유가 있었을까요?`; }
        else if (first.length < 12) { kind = "너무 막연함"; question = `'${snippet(first)}'를 언제, 어디서, 누가로 좁히면 어떻게 말할 수 있을까요?`; }
        else { kind = "잘 짜임"; question = `'${snippet(first)}'는 3단계에서 무엇으로 사실인지 확인해 볼 수 있을까요?`; }
        result = { kind, question }; lp = { focus, kind };
      }
      output = JSON.stringify(result);
    } else if (s === 3) {
      await sleep(1300);
      const c = list(work.s2?.checks).find((x) => x.id === payload.checkId) || {};
      input = [c.heard && `확인할 말: ${c.heard}`, c.question && `검증 질문: ${c.question}`].filter(Boolean).join("\n");
      const qg = new Set([...String(c.question || "") + " " + String(c.heard || "")].join("").replace(/[^가-힣a-z0-9\s]/gi, " ").split(/\s+/).flatMap((w) => Array.from({ length: Math.max(0, w.length - 1) }, (_, i) => w.slice(i, i + 2))));
      const items = d.materials.flatMap((cat) => cat.items.map((it) => ({ cat: cat.title, ...it })));
      const sc = items.map((it) => { let n = 0; for (const g2 of new Set(it.text.replace(/[^가-힣a-z0-9\s]/gi, " ").split(/\s+/).flatMap((w) => Array.from({ length: Math.max(0, w.length - 1) }, (_, i) => w.slice(i, i + 2))))) if (qg.has(g2)) n++; return { it, n }; }).sort((a, b) => b.n - a.n);
      const hit = sc.filter((x) => x.n >= 3).slice(0, 2);
      output = hit.length
        ? `수업 자료에서 찾아본 내용이에요.\n\n${hit.map((h, i) => `${i + 1}. [${h.it.cat}] ${h.it.text}${h.it.caption ? ` (${h.it.caption})` : ""}`).join("\n\n")}\n\n이 도우미는 '사실이다/아니다'를 판정하지 않아요. 위 자료와 우리가 들은 말을 직접 비교해서 우리가 판정해 보세요.`
        : `수업 자료에서는 이 질문에 바로 맞는 내용을 찾지 못했어요. 자료 목록을 다시 훑어보거나, 공식 발표문·통계·언론 보도처럼 확인할 수 있는 곳을 직접 찾아보세요.\n\n이 도우미는 '사실이다/아니다'를 판정하지 않아요. 확인한 자료와 들은 말을 직접 비교해서 우리가 판정해 보세요.`;
      result = output; lp = { checkId: payload.checkId, searched: false };
    } else if (s === 4) {
      await sleep(1800);
      const p = list(work.s4?.proposals).find((x) => x.id === payload.proposalId) || {};
      const text = String(p.text || "");
      input = text;
      const sh = d.stakeholders, a = sh[0] || "당사자", b = sh[1] || "주민";
      const sn = snippet(text, 30);
      const reviews = [
        { lens: "feasibility", label: "실행 가능성", text: `강점: '${sn}'은(는) 누가 무엇을 하는지가 비교적 분명해요.\n약점: 필요한 예산·사람·법적 권한이 어디서 오는지는 아직 보이지 않아요.\n생각할 질문: 첫 한 달 안에 실제로 시작할 수 있는 일은 무엇일까요?`, model: "demo" },
        { lens: "stakeholders", label: "이해관계자 영향", text: `강점: ${a}에게 도움이 될 길을 열어 줄 수 있어요.\n약점: ${b}의 걱정은 이 해결책 안에서 어떻게 다뤄지는지 드러나지 않아요.\n생각할 질문: ${a}과(와) ${b}가 각자 이 해결책을 들으면 무엇을 가장 먼저 물어볼까요?`, model: "demo" },
        { lens: "sideEffects", label: "부작용·장기 영향", text: `강점: 문제의 한 부분을 줄이려는 방향이 분명해요.\n약점: 시간이 지나면 이 방법을 피하는 요령이나 의도하지 않은 결과가 생길 수 있어요.\n생각할 질문: 3년 뒤에 이 해결책 때문에 새로 생길 수 있는 문제 하나를 떠올려 본다면 무엇일까요?`, model: "demo" },
      ];
      // 중학교 체험은 실제 중학교 수업처럼 조언자 2명(쉬운 이름)
      const mid = { feasibility: "정말 할 수 있을까", stakeholders: "사람들의 반응" };
      result = { reviews: LEVEL === "middle" ? reviews.filter((r) => mid[r.lens]).map((r) => ({ ...r, label: mid[r.lens] })) : reviews }; output = JSON.stringify(result); lp = { proposalId: payload.proposalId };
    } else if (s === 5) {
      await sleep(2200);
      const pid = payload.proposalId, yrs = payload.round;
      const text = pid === "final" ? work.s4?.final : list(work.s4?.proposals).find((x) => x.id === pid)?.text;
      const preds = list(work.s5?.predictions).slice(0, 3);
      input = `대안: ${text || ""}\n시점: ${yrs}년 후`;
      const sn = snippet(text, 40);
      const who = preds.map((x) => x.stakeholder).filter(Boolean)[0] || d.stakeholders[0] || "이해관계자";
      result = { scenarios: [
        { title: "A. 천천히 자리 잡은 경우", story: `해결책 '${sn}'이(가) 시작되고 첫해에는 작은 시범으로 출발했다. 준비가 부족해 어긋난 곳도 있었지만, ${who}의 의견을 들어 방법을 고쳐 나갔다. 2년째에는 참여하는 사람이 늘었고, 비슷한 어려움을 겪던 곳에서도 문의가 왔다. ${yrs}년이 지나자 처음 문제로 꼽았던 일이 눈에 띄게 줄었다고 느끼는 사람이 많아졌다. 다만 모두가 같은 만큼 느끼는 것은 아니었다.`, mechanism: `${who}가 직접 의견을 낼 자리가 있었고, 의견이 방법을 바꾸는 데 쓰였기 때문에 참여가 이어졌다. 처음 원인으로 꼽은 일도 조금씩 줄었다.`, unintended: ["혜택을 받는 사람과 못 받는 사람 사이에 새로운 서운함이 생긴다"], newProblems: ["돈과 사람이 계속 필요해서 해마다 예산 논쟁이 생긴다"] },
        { title: "B. 기대와 다르게 흘러간 경우", story: `해결책 '${sn}'이(가) 발표되자 기대와 걱정이 함께 나왔다. 준비 없이 서둘러 시작해 현장에서는 혼란이 컸고, ${who}는 자신의 이야기가 반영되지 않았다고 느꼈다. 몇몇 사람은 방법의 허점을 찾아 피해 가기 시작했다. ${yrs}년이 지나도 원래 문제는 크게 줄지 않았고, 다른 모습으로 바뀌어 나타났다. 결국 방법을 다시 고치자는 이야기가 나왔다.`, mechanism: `충분한 설명과 참여 없이 시작해 신뢰가 쌓이지 않았고, 사람들이 자기 이익에 맞게 행동하면서 원래 원인이 그대로 남거나 모양만 바뀌었다.`, unintended: ["방법을 피하려는 새로운 요령이 퍼진다"], newProblems: ["서로를 믿지 못하는 분위기가 더 커진다"] },
      ] };
      output = JSON.stringify(result); lp = { proposalId: pid, round: yrs };
    }
    result = tagged(s, !!real, result);
    output = typeof result === "string" ? result : JSON.stringify(result);
    const id = st.add(`${gPath}/logs`, { uid: UID, nickname: NICK, stage: s, type, input, output, payload: lp, model: real ? "ai" : "demo", createdAt: now });
    st.update(gPath, { aiCount: st.inc(1) });
    st.update(memberPath, { aiCount: st.inc(1) });
    return { logId: id, result };
  },
};

export async function callFunction(name, data) {
  const h = handlers[name];
  if (!h) throw fail(`체험에서는 쓸 수 없는 기능이에요 (${name}).`);
  return h(data);
}
