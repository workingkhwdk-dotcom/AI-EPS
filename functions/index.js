const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { defineSecret, defineString } = require("firebase-functions/params");
const admin = require("firebase-admin");

const { CASE, REAL_CASE_MATERIALS } = require("./case");
const { checkGate } = require("./policy");
const prompts = require("./prompts");
const { chat } = require("./openai");

admin.initializeApp();
const db = admin.firestore();

const OPENAI_API_KEY = defineSecret("OPENAI_API_KEY");
const OPENAI_MODEL = defineString("OPENAI_MODEL", { default: "gpt-4o-mini" });
const TEACHER_EMAILS = defineString("TEACHER_EMAILS", { default: "" });

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
  const title = String(req.data?.title || CASE.title).slice(0, 80);
  const code = await newCode();
  const batch = db.batch();
  batch.set(db.doc(`sessions/${code}`), {
    teacherUid: auth.uid,
    title,
    caseId: CASE.id,
    groupCount,
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
  });
  for (let i = 1; i <= groupCount; i++) {
    batch.set(db.doc(`sessions/${code}/groups/g${i}`), {
      name: `${i}모둠`,
      aiCount: 0,
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
  await db.doc(`sessions/${code}/members/${auth.uid}`).set({
    groupId,
    nickname,
    joinedAt: admin.firestore.FieldValue.serverTimestamp(),
  });
  return { groupId };
});

// 학생/교사 화면이 쓰는 수업 설정(사건·페르소나·실제 자료). 시스템 프롬프트는 포함하지 않는다.
exports.getCase = onCall(opts, async (req) => {
  requireAuth(req);
  return {
    title: CASE.title,
    premise: CASE.premise,
    stakeholders: CASE.stakeholders,
    personas: CASE.personas.map(({ id, name, role }) => ({ id, name, role })),
    realCaseMaterials: REAL_CASE_MATERIALS,
  };
});

// AI 호출의 단일 관문: 인증 → 모둠 확인 → GYR 게이트 → OpenAI → 로그
exports.aiRequest = onCall(aiOpts, async (req) => {
  const auth = requireAuth(req);
  const { code, stage, type, payload = {} } = req.data || {};
  if (!code) throw new HttpsError("invalid-argument", "수업 코드가 없습니다.");

  const memberSnap = await db.doc(`sessions/${code}/members/${auth.uid}`).get();
  if (!memberSnap.exists) throw new HttpsError("permission-denied", "이 수업의 참여자가 아닙니다.");
  const { groupId, nickname } = memberSnap.data();
  const groupRef = db.doc(`sessions/${code}/groups/${groupId}`);
  const group = (await groupRef.get()).data() || {};
  const work = group.work || {};

  const gate = checkGate({
    stage: Number(stage),
    type,
    work,
    payload,
    personaIds: CASE.personas.map((p) => p.id),
  });
  if (!gate.ok) throw new HttpsError("failed-precondition", gate.reason);
  if ((group.aiCount || 0) >= MAX_AI_CALLS_PER_GROUP)
    throw new HttpsError("resource-exhausted", "이 모둠의 AI 사용 한도에 도달했습니다. 선생님께 문의하세요.");

  const model = OPENAI_MODEL.value();
  const apiKey = OPENAI_API_KEY.value();
  let messages, json = false, input, threadKey = null, maxTokens = 700;
  const s = Number(stage);

  if (s === 1) {
    const persona = CASE.personas.find((p) => p.id === payload.personaId);
    threadKey = `${groupId}:p:${persona.id}`;
    const hist = await db
      .collection(`sessions/${code}/groups/${groupId}/logs`)
      .where("threadKey", "==", threadKey)
      .get();
    const past = hist.docs
      .map((d) => d.data())
      .sort((a, b) => (a.createdAt?.toMillis?.() || 0) - (b.createdAt?.toMillis?.() || 0))
      .slice(-10);
    messages = [{ role: "system", content: prompts.personaPrompt(CASE, persona) }];
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
      { role: "system", content: prompts.verifyPrompt(CASE) },
      { role: "user", content: input },
    ];
  } else if (s === 4) {
    const p = work.s4.proposals.find((x) => x.id === payload.proposalId);
    input = p.text.trim();
    messages = [
      { role: "system", content: prompts.feedbackPrompt(CASE) },
      { role: "user", content: `우리 모둠의 대안:\n${input}` },
    ];
  } else if (s === 5) {
    const p = work.s4.proposals.find((x) => x.id === payload.proposalId);
    const preds = work.s5.predictions
      .map((x) => `- ${x.stakeholder || "이해관계자"}: ${x.text}`)
      .join("\n");
    input = `대안: ${p.text}\n시점: ${payload.round}년 후\n학생들의 예측:\n${preds}`;
    messages = [
      { role: "system", content: prompts.scenarioPrompt(CASE, payload.round) },
      { role: "user", content: input },
    ];
    json = true;
    maxTokens = 1400;
  }

  let output;
  try {
    output = await chat({ apiKey, model, messages, json, maxTokens });
  } catch (e) {
    console.error(e);
    throw new HttpsError("unavailable", "AI 응답을 받지 못했습니다. 잠시 후 다시 시도하세요.");
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
      threadKey,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    }),
    groupRef.update({ aiCount: admin.firestore.FieldValue.increment(1) }),
  ]);

  let result = output;
  if (json) {
    try { result = JSON.parse(output); } catch { throw new HttpsError("internal", "시나리오 형식 오류입니다. 다시 시도하세요."); }
  }
  return { logId: logRef.id, result };
});
