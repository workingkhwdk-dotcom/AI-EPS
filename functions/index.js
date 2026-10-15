const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { defineSecret, defineString } = require("firebase-functions/params");
const admin = require("firebase-admin");

const { EVENTS, PERSONAS, availablePersonas, personaSourceIds, toPublicSource } = require("./case");
const { checkGate } = require("./policy");
const prompts = require("./prompts");
const { chat, extractJson } = require("./openai");
const { guardMessages, parseVerdict, fallbackFor } = require("./guard");

admin.initializeApp();
const db = admin.firestore();

const OPENAI_API_KEY = defineSecret("OPENAI_API_KEY");
// 기본 모델과 용도별 모델. 비워 두면 OPENAI_MODEL 을 쓴다.
const OPENAI_MODEL = defineString("OPENAI_MODEL", { default: "gpt-5-mini" });
const SCENARIO_MODEL = defineString("SCENARIO_MODEL", { default: "" }); // 5단계 시뮬레이션 전용(더 강한 모델 지정 가능)
const GUARD_MODEL = defineString("GUARD_MODEL", { default: "" }); // 상위 AI(규범 감독) 전용
const REASONING_EFFORT = defineString("REASONING_EFFORT", { default: "low" }); // 추론 모델의 사고량: minimal|low|medium|high
const TEACHER_EMAILS = defineString("TEACHER_EMAILS", { default: "" });
// true 이면 출처 원문 대조 전(verified:false) 페르소나도 사용 가능. 리허설 전용, 실제 수업에서는 false 로 둔다.
const ALLOW_UNVERIFIED = defineString("ALLOW_UNVERIFIED_PERSONAS", { default: "false" });
const allowUnverified = () => ALLOW_UNVERIFIED.value() === "true";
const DEFAULT_EVENT = "jeju2018";

const REGION = "asia-northeast3"; // 서울
const MAX_AI_CALLS_PER_GROUP = 150;
const MAX_GROUPS = 12;

const opts = { region: REGION, cors: true };
const aiOpts = { ...opts, secrets: [OPENAI_API_KEY], timeoutSeconds: 90 };

function requireAuth(req) {
  if (!req.auth) throw new HttpsError("unauthenticated", "로그인이 필요합니다.");
  return req.auth;
}

function requireTeacher(req) {
  const auth = requireAuth(req);
  const allow = TEACHER_EMAILS.value().split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
  const email = (auth.token.email || "").toLowerCase();
  if (!email || !allow.includes(email)) throw new HttpsError("permission-denied", "교사 계정이 아닙니다.");
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
  const auth = requireTeacher(req);
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
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
  });
  for (let i = 1; i <= groupCount; i++) {
    batch.set(db.doc(`sessions/${code}/groups/g${i}`), {
      name: `${i}모둠`,
      aiCount: 0,
      memberCount: 0,
      work: {},
    });
  }
  await batch.commit();
  return { code };
});

// 학생: 수업 코드 + 모둠 번호 + 닉네임으로 입장
exports.joinSession = onCall(opts, async (req) => {
  const auth = requireAuth(req);
  const code = String(req.data?.code || "").trim().toUpperCase();
  const groupNo = parseInt(req.data?.groupNo, 10);
  const nickname = String(req.data?.nickname || "").trim().slice(0, 12);
  if (!nickname) throw new HttpsError("invalid-argument", "닉네임을 입력하세요. (이름 대신 별명을 쓰세요)");
  const session = await db.doc(`sessions/${code}`).get();
  if (!session.exists) throw new HttpsError("not-found", "수업 코드를 찾을 수 없습니다.");
  if (!(groupNo >= 1 && groupNo <= session.data().groupCount))
    throw new HttpsError("invalid-argument", "모둠 번호가 올바르지 않습니다.");
  const groupId = `g${groupNo}`;
  const personas = availablePersonas(session.data().eventId, allowUnverified());
  if (!personas.length) throw new HttpsError("failed-precondition", "아직 사용할 수 있는 인물이 없습니다. 선생님께 문의하세요.");
  const memberRef = db.doc(`sessions/${code}/members/${auth.uid}`);
  const groupRef = db.doc(`sessions/${code}/groups/${groupId}`);
  // 모둠원마다 서로 다른 인물을 순서대로 배정한다(직소). 재입장 시에는 기존 배정을 유지한다.
  const personaId = await db.runTransaction(async (tx) => {
    const [m, g] = await Promise.all([tx.get(memberRef), tx.get(groupRef)]);
    if (m.exists && m.data().groupId === groupId && personas.some((p) => p.id === m.data().personaId)) {
      tx.update(memberRef, { nickname });
      return m.data().personaId;
    }
    const n = g.data()?.memberCount || 0;
    const pid = personas[n % personas.length].id;
    tx.update(groupRef, { memberCount: n + 1 });
    tx.set(memberRef, { groupId, nickname, personaId: pid, joinedAt: admin.firestore.FieldValue.serverTimestamp() });
    return pid;
  });
  return { groupId, personaId };
});

// 화면이 쓰는 수업 설정. 시스템 프롬프트와 근거 진술 전문은 보내지 않는다.
//  - 학생: { code } → 자기 수업의 사건·내 인물·자료 목록
//  - 교사: { eventId } → 사건별 인물 및 출처 검증 현황
exports.getCase = onCall(opts, async (req) => {
  const auth = requireAuth(req);
  const pub = (p) => ({ id: p.id, name: p.name, role: p.role, sources: personaSourceIds(p).map(toPublicSource) });

  if (req.data?.eventId) {
    requireTeacher(req);
    const ev = EVENTS[req.data.eventId];
    if (!ev) throw new HttpsError("not-found", "사건을 찾을 수 없습니다.");
    const all = PERSONAS.filter((p) => p.events.includes(ev.id));
    // 교사에게는 원문 대조를 위해 융합 근거와 근거 진술 전문을 함께 보낸다(학생에게는 보내지 않음)
    const full = (p) => ({ ...pub(p), basis: p.basis, stance: p.stance, claims: p.claims.map(([text, src, kind]) => ({ text, src, kind })) });
    return { event: { id: ev.id, title: ev.title, teacherNote: ev.teacherNote }, personas: all.map(full), allowUnverified: allowUnverified() };
  }

  const code = String(req.data?.code || "").toUpperCase();
  const [sess, mem] = await Promise.all([db.doc(`sessions/${code}`).get(), db.doc(`sessions/${code}/members/${auth.uid}`).get()]);
  if (!sess.exists || !mem.exists) throw new HttpsError("permission-denied", "이 수업의 참여자가 아닙니다.");
  const ev = EVENTS[sess.data().eventId];
  const personas = availablePersonas(ev.id, allowUnverified());
  const mine = personas.find((p) => p.id === mem.data().personaId);
  return {
    title: ev.title,
    premise: ev.summary,
    stakeholders: ev.stakeholders,
    myPersona: mine ? pub(mine) : null,
    // 같은 사건의 다른 인물(모둠원이 알아 올 인물): 이름과 역할만 공개
    otherPersonas: personas.filter((p) => !mine || p.id !== mine.id).map(({ id, name, role }) => ({ id, name, role })),
    materials: ev.sources.map(toPublicSource),
  };
});

// AI 호출의 단일 관문: 인증 → 모둠 확인 → GYR 게이트 → OpenAI → 로그
exports.aiRequest = onCall(aiOpts, async (req) => {
  const auth = requireAuth(req);
  const { code, stage, type, payload = {} } = req.data || {};
  if (!code) throw new HttpsError("invalid-argument", "수업 코드가 없습니다.");

  const memberSnap = await db.doc(`sessions/${code}/members/${auth.uid}`).get();
  if (!memberSnap.exists) throw new HttpsError("permission-denied", "이 수업의 참여자가 아닙니다.");
  const { groupId, nickname, personaId } = memberSnap.data();
  const sessData = (await db.doc(`sessions/${code}`).get()).data();
  const ev = EVENTS[sessData.eventId];
  const evCtx = { summary: ev.summary, premise: ev.summary };
  const personas = availablePersonas(ev.id, allowUnverified());
  const groupRef = db.doc(`sessions/${code}/groups/${groupId}`);
  const group = (await groupRef.get()).data() || {};
  const work = group.work || {};

  const gate = checkGate({
    stage: Number(stage),
    type,
    work,
    payload,
    // 1단계는 배정된 내 인물과만 대화할 수 있다(모둠원이 서로 다른 인물과 대화해 정보를 나눈다)
    personaIds: personas.some((p) => p.id === personaId) ? [personaId] : [],
  });
  if (!gate.ok) throw new HttpsError("failed-precondition", gate.reason);
  if ((group.aiCount || 0) >= MAX_AI_CALLS_PER_GROUP)
    throw new HttpsError("resource-exhausted", "이 모둠의 AI 사용 한도에 도달했습니다. 선생님께 문의하세요.");

  const s = Number(stage);
  const model = (s === 5 && SCENARIO_MODEL.value()) || OPENAI_MODEL.value();
  const effort = s === 5 ? "medium" : REASONING_EFFORT.value();
  const apiKey = OPENAI_API_KEY.value();
  let messages, json = false, input, threadKey = null, maxTokens = 700;

  if (s === 1) {
    const persona = personas.find((p) => p.id === payload.personaId);
    threadKey = `${groupId}:p:${persona.id}`;
    const hist = await db
      .collection(`sessions/${code}/groups/${groupId}/logs`)
      .where("threadKey", "==", threadKey)
      .get();
    const past = hist.docs
      .map((d) => d.data())
      .sort((a, b) => (a.createdAt?.toMillis?.() || 0) - (b.createdAt?.toMillis?.() || 0))
      .slice(-10);
    messages = [{ role: "system", content: prompts.personaPrompt(ev, persona) }];
    past.forEach((l) => {
      messages.push({ role: "user", content: l.input });
      messages.push({ role: "assistant", content: l.output });
    });
    input = String(payload.message).trim();
    messages.push({ role: "user", content: input });
    maxTokens = 400;
  } else if (s === 3) {
    input = String(payload.question).trim();
    messages = [
      { role: "system", content: prompts.verifyPrompt(evCtx) },
      { role: "user", content: input },
    ];
  } else if (s === 4) {
    const p = work.s4.proposals.find((x) => x.id === payload.proposalId);
    input = p.text.trim();
    messages = [
      { role: "system", content: prompts.feedbackPrompt(evCtx) },
      { role: "user", content: `우리 모둠의 대안:\n${input}` },
    ];
  } else if (s === 5) {
    const p = work.s4.proposals.find((x) => x.id === payload.proposalId);
    const preds = work.s5.predictions
      .map((x) => `- ${x.stakeholder || "이해관계자"}: ${x.text}`)
      .join("\n");
    input = `대안: ${p.text}\n시점: ${payload.round}년 후\n학생들의 예측:\n${preds}`;
    messages = [
      { role: "system", content: prompts.scenarioPrompt(evCtx, payload.round) },
      { role: "user", content: input },
    ];
    json = true;
    maxTokens = 1400;
  }

  let output;
  try {
    output = await chat({ apiKey, model, messages, json, maxTokens, effort });
  } catch (e) {
    console.error(e);
    throw new HttpsError("unavailable", "AI 응답을 받지 못했습니다. 잠시 후 다시 시도하세요.");
  }

  // 상위 AI(규범 감독자): 페르소나 응답을 학생에게 보내기 전에 검사한다. 위반이거나 검사 실패 시 안내문으로 대체.
  let guard = null;
  if (s === 1) {
    const persona = personas.find((p) => p.id === payload.personaId);
    try {
      const verdictText = await chat({
        apiKey, model: GUARD_MODEL.value() || OPENAI_MODEL.value(), effort: "low", json: true, maxTokens: 200,
        messages: guardMessages({ persona, claims: persona.claims, studentMessage: input, reply: output }),
      });
      guard = parseVerdict(verdictText);
    } catch (e) {
      console.error(e);
      guard = { ok: false, category: "error", reason: "감독자 호출 실패" };
    }
    if (!guard.ok) { guard.original = output; output = fallbackFor(guard.category); }
  }

  const logRef = groupRef.collection("logs").doc();
  await Promise.all([
    logRef.set({
      uid: auth.uid,
      nickname,
      stage: s,
      type,
      input,
      output,
      payload: {
        personaId: payload.personaId || null,
        proposalId: payload.proposalId || null,
        round: payload.round || null,
      },
      model,
      guard: guard || null,
      threadKey,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    }),
    groupRef.update({ aiCount: admin.firestore.FieldValue.increment(1) }),
  ]);

  let result = output;
  if (json) {
    try { result = extractJson(output); } catch { throw new HttpsError("internal", "시나리오 형식 오류입니다. 다시 시도하세요."); }
  }
  return { logId: logRef.id, result };
});
