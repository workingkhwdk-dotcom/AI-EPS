const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { defineSecret, defineString } = require("firebase-functions/params");
const admin = require("firebase-admin");

const { EVENTS, PERSONAS, availablePersonas, personaSourceIds, toPublicSource, materialsFor, materialsAdmin } = require("./case");
const { checkGate, toList, proposalText } = require("./policy");
const prompts = require("./prompts");
const { chat, extractJson } = require("./openai");
const { guardMessages, parseVerdict, resolveOutput } = require("./guard");
const { isTeacherEmail } = require("./teachers");

admin.initializeApp();
const db = admin.firestore();

const OPENAI_API_KEY = defineSecret("OPENAI_API_KEY");
// 기본 모델과 용도별 모델. 비워 두면 OPENAI_MODEL 을 쓴다.
const OPENAI_MODEL = defineString("OPENAI_MODEL", { default: "gpt-5-mini" });
const SCENARIO_MODEL = defineString("SCENARIO_MODEL", { default: "" }); // 5단계 시뮬레이션 전용(더 강한 모델 지정 가능)
const GUARD_MODEL = defineString("GUARD_MODEL", { default: "" }); // 상위 AI(규범 감독) 전용
const FEEDBACK_MODELS = defineString("FEEDBACK_MODELS", { default: "" }); // 4단계 독립 검토에 쓸 모델들(쉼표). 비우면 OPENAI_MODEL 로 3회
const REASONING_EFFORT = defineString("REASONING_EFFORT", { default: "low" }); // 추론 모델의 사고량: minimal|low|medium|high
const TEACHER_EMAILS = defineString("TEACHER_EMAILS", { default: "" });
// true 이면 출처 원문 대조 전(verified:false) 페르소나·자료도 사용 가능. 리허설 전용, 실제 수업에서는 false 로 둔다.
const ALLOW_UNVERIFIED = defineString("ALLOW_UNVERIFIED_PERSONAS", { default: "false" });
const allowUnverified = () => ALLOW_UNVERIFIED.value() === "true";
const DEFAULT_EVENT = "jeju2018";

const REGION = "asia-northeast3"; // 서울
const MAX_AI_CALLS_PER_GROUP = 150;
const MAX_GROUPS = 12;

const opts = { region: REGION, cors: true };
// 추론 모델(특히 5단계 시뮬레이션)은 응답에 1분 넘게 걸릴 수 있어 넉넉히 둔다.
const aiOpts = { ...opts, secrets: [OPENAI_API_KEY], timeoutSeconds: 300 };

const FieldValue = () => admin.firestore.FieldValue;

function requireAuth(req) {
  if (!req.auth) throw new HttpsError("unauthenticated", "로그인이 필요합니다.");
  return req.auth;
}

async function requireTeacher(req) {
  const auth = requireAuth(req);
  const ok = await isTeacherEmail(auth.token.email, {
    envList: TEACHER_EMAILS.value(),
    readDoc: async () => (await db.doc("config/teachers").get()).data(),
  });
  if (!ok) throw new HttpsError("permission-denied", "교사 계정이 아닙니다.");
  return auth;
}

async function newCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  for (let i = 0; i < 10; i++) {
    let code = "";
    for (let j = 0; j < 6; j++) code += chars[Math.floor(Math.random() * chars.length)];
    if (!(await db.doc(`sessions/${code}`).get()).exists) return code;
  }
  throw new HttpsError("internal", "수업 코드를 만들지 못했습니다.");
}

// 교사: 수업 만들기 (모둠 문서 함께 생성)
exports.createSession = onCall(opts, async (req) => {
  const auth = await requireTeacher(req);
  const groupCount = Math.min(Math.max(parseInt(req.data?.groupCount, 10) || 6, 1), MAX_GROUPS);
  const eventId = EVENTS[req.data?.eventId] ? req.data.eventId : DEFAULT_EVENT;
  if (!availablePersonas(eventId, allowUnverified()).length)
    throw new HttpsError("failed-precondition", "원문 대조가 끝난 페르소나가 없습니다. case.js 의 출처 verified 를 확인하세요.");
  const title = String(req.data?.title || EVENTS[eventId].title).slice(0, 80);
  const code = await newCode();
  const batch = db.batch();
  batch.set(db.doc(`sessions/${code}`), {
    teacherUid: auth.uid,
    title,
    eventId,
    groupCount,
    createdAt: FieldValue().serverTimestamp(),
  });
  for (let i = 1; i <= groupCount; i++) {
    batch.set(db.doc(`sessions/${code}/groups/g${i}`), { name: `${i}모둠`, aiCount: 0, memberCount: 0, guardCount: 0, work: {} });
  }
  await batch.commit();
  return { code };
});

// 모둠에 아직 없는 축을 먼저, 그 축 안에서는 아직 안 쓴 인물을 무작위로 고른다. 모두 쓰였으면 가장 적게 쓰인 인물 중에서 고른다.
function pickPersona(personas, used, rand = Math.random) {
  const count = (pred) => used.filter((id) => pred(personas.find((p) => p.id === id))).length;
  const pickOne = (xs) => xs[Math.floor(rand() * xs.length)];
  const fresh = personas.filter((p) => !used.includes(p.id));
  // 아직 안 쓴 인물이 남은 축만 후보로 한다(모두 썼으면 전체가 후보)
  const axes = [...new Set((fresh.length ? fresh : personas).map((p) => p.axis))];
  const axisUse = (a) => count((p) => p && p.axis === a);
  const minAxis = Math.min(...axes.map(axisUse));
  const axis = pickOne(axes.filter((a) => axisUse(a) === minAxis));
  const inAxis = personas.filter((p) => p.axis === axis);
  const personUse = (p) => used.filter((id) => id === p.id).length;
  const minUse = Math.min(...inAxis.map(personUse));
  return pickOne(inAxis.filter((p) => personUse(p) === minUse));
}
exports._pickPersona = pickPersona; // 테스트용

// 학생: 수업 코드 + 모둠 번호 + 닉네임으로 입장
exports.joinSession = onCall(opts, async (req) => {
  const auth = requireAuth(req);
  const code = String(req.data?.code || "").trim().toUpperCase();
  const groupNo = parseInt(req.data?.groupNo, 10);
  const nickname = String(req.data?.nickname || "").trim().slice(0, 12);
  if (!nickname) throw new HttpsError("invalid-argument", "별명을 입력하세요. (이름 대신 별명을 쓰세요)");
  const session = await db.doc(`sessions/${code}`).get();
  if (!session.exists) throw new HttpsError("not-found", "수업 코드를 찾을 수 없습니다.");
  if (!(groupNo >= 1 && groupNo <= session.data().groupCount))
    throw new HttpsError("invalid-argument", "모둠 번호가 올바르지 않습니다.");
  const groupId = `g${groupNo}`;
  const personas = availablePersonas(session.data().eventId, allowUnverified());
  if (!personas.length) throw new HttpsError("failed-precondition", "아직 사용할 수 있는 인물이 없습니다. 선생님께 문의하세요.");
  const memberRef = db.doc(`sessions/${code}/members/${auth.uid}`);
  const groupRef = db.doc(`sessions/${code}/groups/${groupId}`);
  // 모둠원마다 서로 다른 인물을 무작위로 배정한다(직소). 모둠 안에서 축(당사자·도민·시민사회·제도)이 겹치지 않게 고른다.
  // 배정은 교사에게만 보이며 학생은 모른다. 재입장 시에는 유지한다.
  await db.runTransaction(async (tx) => {
    const [m, g] = await Promise.all([tx.get(memberRef), tx.get(groupRef)]);
    if (m.exists && m.data().groupId === groupId && personas.some((p) => p.id === m.data().personaId)) {
      tx.update(memberRef, { nickname });
      return;
    }
    const n = g.data()?.memberCount || 0;
    const used = g.data()?.personaIds || [];
    const persona = pickPersona(personas, used);
    tx.update(groupRef, { memberCount: n + 1, personaIds: [...used, persona.id] });
    tx.set(memberRef, {
      groupId, nickname, personaId: persona.id,
      stage: 1, aiCount: 0, joinedAt: FieldValue().serverTimestamp(), lastSeen: FieldValue().serverTimestamp(),
    });
  });
  return { groupId };
});

// 화면이 쓰는 수업 설정.
//  - 학생: { code } → 사건 개요(객관적 설명), 내 인물의 이름과 편지, 실제 자료. 인물의 역할·근거·출처는 보내지 않는다.
//  - 교사: { eventId } → 인물별 근거 진술·출처 검증 현황, 자료 전체
exports.getCase = onCall(opts, async (req) => {
  const auth = requireAuth(req);

  if (req.data?.eventId) {
    await requireTeacher(req);
    const ev = EVENTS[req.data.eventId];
    if (!ev) throw new HttpsError("not-found", "사건을 찾을 수 없습니다.");
    const full = (p) => ({
      id: p.id, axis: p.axis, label: p.label, name: p.name, role: p.role, stance: p.stance, setting: p.setting, voice: p.voice, basis: p.basis, letter: p.letter, views: p.views, story: p.story, episodes: p.episodes, inner: p.inner, habits: p.habits,
      sources: personaSourceIds(p).map(toPublicSource),
      claims: p.claims.map(([text, src, kind]) => ({ text, src, kind })),
    });
    const materials = materialsAdmin().map((c) => ({
      ...c,
      items: c.items.map((it) => ({ ...it, verified: it.src.every((id) => toPublicSource(id).verified) })),
    }));
    return {
      event: { id: ev.id, title: ev.title, summary: ev.summary, teacherNote: ev.teacherNote,
        background: (ev.background || []).map(([text, src, kind]) => ({ text, src, kind, verified: toPublicSource(src).verified })) },
      personas: PERSONAS.filter((p) => p.events.includes(ev.id)).map(full),
      materials,
      allowUnverified: allowUnverified(),
    };
  }

  const code = String(req.data?.code || "").toUpperCase();
  const [sess, mem] = await Promise.all([db.doc(`sessions/${code}`).get(), db.doc(`sessions/${code}/members/${auth.uid}`).get()]);
  if (!sess.exists || !mem.exists) throw new HttpsError("permission-denied", "이 수업의 참여자가 아닙니다.");
  const ev = EVENTS[sess.data().eventId];
  const mine = availablePersonas(ev.id, allowUnverified()).find((p) => p.id === mem.data().personaId);
  return {
    title: ev.title,
    summary: ev.summary,
    stakeholders: ev.stakeholders,
    me: mine ? { name: mine.name, letter: mine.letter } : null,
    materials: materialsFor(allowUnverified()),
  };
});

// ---------- AI 호출 ----------

// 사고량을 바꿔 가며 시도한다(사고에 한도를 다 쓰거나 시간이 오래 걸린 경우 대비). 모두 실패하면 마지막 오류를 던진다.
async function callModel({ apiKey, model, messages, json = false, maxTokens, efforts }) {
  let lastErr;
  for (const effort of [...new Set(efforts)]) {
    try {
      return await chat({ apiKey, model, messages, json, maxTokens, effort });
    } catch (e) {
      lastErr = e;
      console.error(`AI 호출 실패 model=${model} effort=${effort}:`, e.message);
    }
  }
  throw lastErr;
}

const REVIEW_LABELS = { feasibility: "실행 가능성", stakeholders: "이해관계자 영향", sideEffects: "부작용·장기 영향" };

// AI 호출의 단일 관문: 인증 → 모둠 확인 → GYR 게이트 → OpenAI → (1단계) 상위 AI 감독 → 로그
exports.aiRequest = onCall(aiOpts, async (req) => {
  const auth = requireAuth(req);
  const { code, stage, type, payload = {} } = req.data || {};
  if (!code) throw new HttpsError("invalid-argument", "수업 코드가 없습니다.");

  const memberRef = db.doc(`sessions/${code}/members/${auth.uid}`);
  const memberSnap = await memberRef.get();
  if (!memberSnap.exists) throw new HttpsError("permission-denied", "이 수업의 참여자가 아닙니다.");
  const { groupId, nickname, personaId } = memberSnap.data();
  const sessData = (await db.doc(`sessions/${code}`).get()).data();
  const ev = EVENTS[sessData.eventId];
  const evCtx = { summary: ev.summary, premise: ev.summary };
  const personas = availablePersonas(ev.id, allowUnverified());
  const groupRef = db.doc(`sessions/${code}/groups/${groupId}`);
  const group = (await groupRef.get()).data() || {};
  const work = group.work || {};
  const s = Number(stage);
  // 모둠이 1단계에서 함께 정한 문제(있으면 3~5단계 AI가 기준으로 삼는다)
  const pb = work.s1?.problem || {};
  evCtx.problem = [pb.situation, pb.hmw].map((x) => String(x || "").trim()).filter(Boolean).join(" / ").slice(0, 400);

  const gate = checkGate({ stage: s, type, work, payload });
  if (!gate.ok) throw new HttpsError("failed-precondition", gate.reason);
  if ((group.aiCount || 0) >= MAX_AI_CALLS_PER_GROUP)
    throw new HttpsError("resource-exhausted", "이 모둠의 AI 사용 한도에 도달했습니다. 선생님께 문의하세요.");

  const apiKey = OPENAI_API_KEY.value();
  const baseModel = OPENAI_MODEL.value();
  const effort = REASONING_EFFORT.value();
  const bump = { aiCount: FieldValue().increment(1) };

  try {
    // ---- 1단계: 학생별 메신저 대화 ----
    if (s === 1) {
      const persona = personas.find((p) => p.id === personaId);
      if (!persona) throw new HttpsError("failed-precondition", "배정된 인물이 없습니다. 선생님께 알려 주세요.");
      const chatCol = db.collection(`sessions/${code}/members/${auth.uid}/chat`);
      const past = (await chatCol.get()).docs
        .map((d) => d.data())
        .sort((a, b) => (a.createdAt?.toMillis?.() || 0) - (b.createdAt?.toMillis?.() || 0))
        .slice(-16);
      const input = String(payload.message).trim();
      const messages = [{ role: "system", content: prompts.personaPrompt(ev, persona) }];
      past.forEach((l) => {
        messages.push({ role: "user", content: l.input });
        messages.push({ role: "assistant", content: l.output });
      });
      messages.push({ role: "user", content: input });

      const reply = await callModel({ apiKey, model: baseModel, messages, maxTokens: 400, efforts: [effort] });

      // 상위 AI(규범 감독자): 학생에게 보내기 전에 검사. 가벼운 위반은 고쳐 쓰고, 무거운 위반·검사 실패는 안내로 대체
      let verdict;
      try {
        const verdictText = await callModel({
          apiKey, model: GUARD_MODEL.value() || baseModel, json: true, maxTokens: 700, efforts: ["low"],
          messages: guardMessages({ persona, claims: persona.claims, background: ev.background, history: past.slice(-3), studentMessage: input, reply }),
        });
        verdict = parseVerdict(verdictText);
      } catch (e) {
        verdict = { ok: false, category: "error", reason: "감독자 호출 실패", fixed: "" };
      }
      const out = resolveOutput(verdict, reply);
      if (out.replaced) bump.guardCount = FieldValue().increment(1);

      const ref = chatCol.doc();
      await Promise.all([
        ref.set({
          uid: auth.uid, nickname, personaId, input, output: out.text, model: baseModel,
          guard: { ok: verdict.ok, category: verdict.category, reason: verdict.reason, how: out.how || null, original: out.replaced ? reply : null },
          createdAt: FieldValue().serverTimestamp(),
        }),
        groupRef.update(bump),
        memberRef.update({ aiCount: FieldValue().increment(1) }),
      ]);
      return { logId: ref.id, result: out.text };
    }

    // ---- 3~5단계: 모둠 로그 ----
    let messages, input, output, result, logPayload = {};
    let model = baseModel;
    if (s === 3) {
      const c = toList(work.s2.checks).find((x) => x.id === payload.checkId);
      const cause = c.causeId ? toList(work.s2?.causes).find((x) => x.id === c.causeId) : null;
      input = (cause ? `학생들이 확인하려는 원인 가설: ${cause.text}\n확인할 말: ${c.heard || "(적지 않음)"}` : `학생들이 인터뷰에서 들은 말: ${c.heard || "(적지 않음)"}`) +
        `\n검증 질문: ${c.question}` +
        (c.srcType ? `\n학생들이 확인하려는 자료 종류: ${c.srcType}` : "");
      messages = [{ role: "system", content: prompts.verifyPrompt(evCtx) }, { role: "user", content: input }];
      output = await callModel({ apiKey, model, messages, maxTokens: 700, efforts: [effort] });
      result = output;
      logPayload = { checkId: c.id };
    } else if (s === 4) {
      const p = toList(work.s4.proposals).find((x) => x.id === payload.proposalId);
      input = p.text.trim();
      const models = FEEDBACK_MODELS.value().split(",").map((m) => m.trim()).filter(Boolean);
      const lenses = Object.keys(REVIEW_LABELS);
      // 서로 다른 관점의 독립 검토 3개. AI의 판단이 하나의 권위가 되지 않도록 학생이 비교하게 한다.
      const settled = await Promise.allSettled(
        lenses.map((lens, i) => {
          const m = models.length ? models[i % models.length] : baseModel;
          return callModel({
            apiKey, model: m, maxTokens: 500, efforts: [effort],
            messages: [{ role: "system", content: prompts.feedbackPrompt(evCtx, lens) }, { role: "user", content: `우리 모둠의 대안:\n${input}` }],
          }).then((text) => ({ lens, label: REVIEW_LABELS[lens], text, model: m }));
        }),
      );
      const reviews = settled.filter((r) => r.status === "fulfilled").map((r) => r.value);
      if (!reviews.length) throw settled[0].reason;
      output = JSON.stringify({ reviews });
      result = { reviews };
      model = [...new Set(reviews.map((r) => r.model))].join(",");
      logPayload = { proposalId: p.id };
    } else if (s === 5) {
      const p = { id: payload.proposalId, text: proposalText(work, payload.proposalId) };
      const preds = toList(work.s5.predictions).map((x) => `- ${x.stakeholder || "이해관계자"}: ${x.text}`).join("\n");
      input = `대안: ${p.text}\n시점: ${payload.round}년 후\n학생들의 예측:\n${preds}`;
      messages = [{ role: "system", content: prompts.scenarioPrompt(evCtx, payload.round) }, { role: "user", content: input }];
      model = SCENARIO_MODEL.value() || baseModel;
      // 사고량을 낮춰 한 번 더 시도한다
      output = await callModel({ apiKey, model, messages, json: true, maxTokens: 1800, efforts: ["medium", "low"] });
      try { result = extractJson(output); } catch { throw new HttpsError("internal", "시나리오 형식 오류입니다. 다시 시도하세요."); }
      logPayload = { proposalId: p.id, round: payload.round };
    }

    const logRef = groupRef.collection("logs").doc();
    await Promise.all([
      logRef.set({ uid: auth.uid, nickname, stage: s, type, input, output, payload: logPayload, model, createdAt: FieldValue().serverTimestamp() }),
      groupRef.update(bump),
      memberRef.update({ aiCount: FieldValue().increment(1) }),
    ]);
    return { logId: logRef.id, result };
  } catch (e) {
    if (e instanceof HttpsError) throw e;
    console.error(`aiRequest 실패 stage=${s}:`, e.message);
    // 교사 화면에서 원인을 볼 수 있도록 모둠 문서에 남긴다
    await groupRef.update({ lastAiError: { stage: s, message: String(e.message).slice(0, 300), at: FieldValue().serverTimestamp() } }).catch(() => {});
    throw new HttpsError("unavailable", "AI 응답을 받지 못했습니다. 잠시 후 다시 시도하세요.");
  }
});
