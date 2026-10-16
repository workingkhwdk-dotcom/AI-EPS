const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { defineSecret, defineString } = require("firebase-functions/params");
const admin = require("firebase-admin");

const { EVENTS, PERSONAS, availablePersonas, personaSourceIds, toPublicSource, materialsFor, materialsAdmin } = require("./case");
const { checkGate, toList, proposalText } = require("./policy");
const prompts = require("./prompts");
const { chat, extractJson } = require("./openai");
const { guardMessages, parseVerdict, resolveOutput, piiFlags } = require("./guard");
const { isTeacherEmail } = require("./teachers");
const { validatePassword, hashPassword, verifyPassword, normNick, credKey, lockedSeconds, afterFail, afterTotalFail } = require("./password");
const { defaultMaterials, sanitizeMaterials, toStudentMaterials } = require("./materials");
const { chatWithLookup, webSearch } = require("./lookup");
const { sanitizeOverride, applyOverride } = require("./personaEdit");
const { onSchedule } = require("firebase-functions/v2/scheduler");
const { AUTO_CLOSE_CHOICES, autoCloseDue, staleAnonymousUids } = require("./maintenance");

admin.initializeApp();
const db = admin.firestore();

const OPENAI_API_KEY = defineSecret("OPENAI_API_KEY");
// 기본 모델과 용도별 모델. 비워 두면 OPENAI_MODEL 을 쓴다.
const OPENAI_MODEL = defineString("OPENAI_MODEL", { default: "gpt-5-mini" });
const PERSONA_MODEL = defineString("PERSONA_MODEL", { default: "gpt-5" }); // 1단계 인물 대화 전용
const SCENARIO_MODEL = defineString("SCENARIO_MODEL", { default: "" }); // 5단계 시뮬레이션 전용(더 강한 모델 지정 가능)
const GUARD_MODEL = defineString("GUARD_MODEL", { default: "" }); // 상위 AI(규범 감독) 전용
const FEEDBACK_MODELS = defineString("FEEDBACK_MODELS", { default: "" }); // 4단계 독립 검토에 쓸 모델들(쉼표). 비우면 OPENAI_MODEL 로 3회
const REASONING_EFFORT = defineString("REASONING_EFFORT", { default: "low" }); // 추론 모델의 사고량: minimal|low|medium|high
const PERSONA_WEB_SEARCH = defineString("PERSONA_WEB_SEARCH", { default: "true" }); // 인물이 모르는 사실은 웹에서 찾아 본다(false 로 끄기)
// 웹 검색을 허용할 도메인(쉼표). 비우면 제한 없음. 예: yna.co.kr,hani.co.kr,moj.go.kr,unhcr.org
const SEARCH_ALLOWED_DOMAINS = defineString("SEARCH_ALLOWED_DOMAINS", { default: "" });
const SEARCH_MODEL = defineString("SEARCH_MODEL", { default: "" }); // 웹 검색 호출 전용 모델(비우면 OPENAI_MODEL)
const TEACHER_EMAILS = defineString("TEACHER_EMAILS", { default: "" });
// true 이면 출처 원문 대조 전(verified:false) 페르소나·자료도 사용 가능. 리허설 전용, 실제 수업에서는 false 로 둔다.
const ALLOW_UNVERIFIED = defineString("ALLOW_UNVERIFIED_PERSONAS", { default: "false" });
const allowUnverified = () => ALLOW_UNVERIFIED.value() === "true";
const DEFAULT_EVENT = "jeju2018";

const REGION = "asia-northeast3"; // 서울
const MAX_AI_CALLS_PER_GROUP = 150; // 수업별로 정하지 않았을 때의 모둠당 한도
const AI_LIMIT_RANGE = [10, 500];
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

// 교사 + 내가 만든 수업인지 확인하고 수업 문서를 돌려준다
async function ownSession(req) {
  const auth = await requireTeacher(req);
  const code = String(req.data?.code || "").trim().toUpperCase();
  const snap = code ? await db.doc(`sessions/${code}`).get() : null;
  if (!snap?.exists) throw new HttpsError("not-found", "수업을 찾을 수 없습니다.");
  if (snap.data().teacherUid !== auth.uid) throw new HttpsError("permission-denied", "내가 만든 수업이 아닙니다.");
  return { auth, code, sess: snap.data() };
}

// 수업 설정값(AI 한도, 웹 검색, 자동 닫힘)을 검사해 저장할 값으로 바꾼다. 없는 값은 건드리지 않는다.
function sessionSettings(d) {
  const out = {};
  if (d?.aiLimit !== undefined) {
    const n = parseInt(d.aiLimit, 10);
    if (!(n >= AI_LIMIT_RANGE[0] && n <= AI_LIMIT_RANGE[1])) throw new HttpsError("invalid-argument", `모둠당 AI 한도는 ${AI_LIMIT_RANGE[0]}~${AI_LIMIT_RANGE[1]}회 사이로 정하세요.`);
    out.aiLimit = n;
  }
  if (d?.webSearch !== undefined) out.webSearch = d.webSearch === true;
  if (d?.autoCloseHours !== undefined) {
    const h = Number(d.autoCloseHours);
    if (!AUTO_CLOSE_CHOICES.includes(h)) throw new HttpsError("invalid-argument", "자동 닫힘 시간이 올바르지 않습니다.");
    out.autoCloseHours = h;
  }
  return out;
}

// 교사가 닫아 둔 수업인지(closed:true). 닫힌 수업에는 입장·AI 사용·사건 자료 조회가 모두 막힌다.
const CLOSED_MSG = "수업이 끝났거나 선생님이 닫아 둔 수업입니다. 입장할 수 없습니다.";

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
    closed: false,
    aiLimit: MAX_AI_CALLS_PER_GROUP, webSearch: true, autoCloseHours: 0,
    ...sessionSettings(req.data),
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

// 같은 학생이 다른 화면(로그아웃 후 다시 입장 등)에서 들어오면 새 익명 계정으로 바뀌므로,
// 대화 기록·개인 정리 같은 학생의 데이터를 옛 uid 에서 새 uid 로 옮긴다. 옮길 것이 없으면 false.
async function moveMember(code, groupId, fromUid, toUid) {
  const fromRef = db.doc(`sessions/${code}/members/${fromUid}`);
  const from = await fromRef.get();
  if (!from.exists) return false;
  const chats = (await db.collection(`sessions/${code}/members/${fromUid}/chat`).get()).docs;
  for (let i = 0; i < chats.length; i += 200) {
    const batch = db.batch();
    chats.slice(i, i + 200).forEach((d) => batch.set(db.doc(`sessions/${code}/members/${toUid}/chat/${d.id}`), d.data()));
    await batch.commit();
  }
  await db.doc(`sessions/${code}/members/${toUid}`).set({ ...from.data(), lastSeen: FieldValue().serverTimestamp() });
  // 인물 배정(서버 전용 문서)도 함께 옮긴다
  const asg = await db.doc(`sessions/${code}/assign/${fromUid}`).get();
  if (asg.exists) await db.doc(`sessions/${code}/assign/${toUid}`).set(asg.data());
  // 모둠 산출물에서 이 학생의 개인 칸(1단계 개인 정리)은 새 uid 로 옮기고, '입력 중' 표시는 지운다
  const groupRef = db.doc(`sessions/${code}/groups/${groupId}`);
  const work = (await groupRef.get()).data()?.work || {};
  const upd = {};
  if (work.s1?.findings?.[fromUid] !== undefined) {
    upd[`work.s1.findings.${toUid}`] = work.s1.findings[fromUid];
    upd[`work.s1.findings.${fromUid}`] = FieldValue().delete();
  }
  if (work.live?.[fromUid] !== undefined) upd[`work.live.${fromUid}`] = FieldValue().delete();
  if (Object.keys(upd).length) await groupRef.update(upd);
  for (let i = 0; i < chats.length; i += 200) {
    const batch = db.batch();
    chats.slice(i, i + 200).forEach((d) => batch.delete(db.doc(`sessions/${code}/members/${fromUid}/chat/${d.id}`)));
    await batch.commit();
  }
  if (asg.exists) await db.doc(`sessions/${code}/assign/${fromUid}`).delete();
  await fromRef.delete();
  return true;
}

// 학생: 수업 코드 + 모둠 번호 + 별명 + 비밀번호로 입장
//  - 처음이면 그 비밀번호가 이 별명의 비밀번호가 된다. 다시 들어올 때는 같은 비밀번호가 필요하다.
//  - 비밀번호가 맞으면 이전에 하던 데이터(인물 배정, 대화, 개인 정리)가 지금 화면으로 이어진다.
exports.joinSession = onCall(opts, async (req) => {
  const auth = requireAuth(req);
  const code = String(req.data?.code || "").trim().toUpperCase();
  const groupNo = parseInt(req.data?.groupNo, 10);
  const nickname = String(req.data?.nickname || "").trim().slice(0, 12);
  const password = String(req.data?.password ?? "");
  if (!nickname) throw new HttpsError("invalid-argument", "별명을 입력하세요. (이름 대신 별명을 쓰세요)");
  const pwErr = validatePassword(password);
  if (pwErr) throw new HttpsError("invalid-argument", pwErr);
  const session = await db.doc(`sessions/${code}`).get();
  if (!session.exists) throw new HttpsError("not-found", "수업 코드를 찾을 수 없습니다.");
  if (!session.data().closed && session.data().autoCloseHours > 0) {
    const ms = (await db.collection(`sessions/${code}/members`).get()).docs.map((d) => d.data());
    if (autoCloseDue(session.data(), ms)) { await db.doc(`sessions/${code}`).update({ closed: true, closedAuto: true }); throw new HttpsError("failed-precondition", CLOSED_MSG); }
  }
  if (session.data().closed) throw new HttpsError("failed-precondition", CLOSED_MSG);
  if (!(groupNo >= 1 && groupNo <= session.data().groupCount))
    throw new HttpsError("invalid-argument", "모둠 번호가 올바르지 않습니다.");
  const groupId = `g${groupNo}`;
  const personas = availablePersonas(session.data().eventId, allowUnverified());
  if (!personas.length) throw new HttpsError("failed-precondition", "아직 사용할 수 있는 인물이 없습니다. 선생님께 문의하세요.");
  const memberRef = db.doc(`sessions/${code}/members/${auth.uid}`);
  const groupRef = db.doc(`sessions/${code}/groups/${groupId}`);
  const key = credKey(groupNo, nickname);
  const credRef = db.doc(`sessions/${code}/creds/${key}`);

  // 1) 비밀번호 확인. 잠금은 틀린 사람(접속 계정)별로 먼저 걸리고, 별명 전체에는 더 느슨하게 걸린다(친구가 일부러 틀려서 막는 일 방지).
  const credSnap = await credRef.get();
  const cred = credSnap.exists ? credSnap.data() : null;
  const attRef = db.doc(`sessions/${code}/attempts/${auth.uid}`);
  if (cred) {
    const att = (await attRef.get()).data() || {};
    const wait = Math.max(lockedSeconds(att), lockedSeconds(cred));
    if (wait) throw new HttpsError("resource-exhausted", `비밀번호를 여러 번 틀려서 ${wait}초 동안 입장할 수 없습니다.`);
    if (!verifyPassword(password, cred)) {
      await Promise.all([attRef.set(afterFail(att)), credRef.update(afterTotalFail(cred))]);
      throw new HttpsError("permission-denied", "비밀번호가 맞지 않습니다. 같은 모둠의 다른 친구가 이 별명을 이미 쓰고 있다면 다른 별명으로 입장하세요.");
    }
    await attRef.delete();
  }

  // 2) 이 기기에 이미 다른 학생이 로그인되어 있으면 막는다(공용 PC에서 남의 자리를 이어받지 않도록)
  const mine = await memberRef.get();
  if (mine.exists) {
    const d = mine.data();
    const same = d.credKey ? d.credKey === key : d.groupId === groupId && normNick(d.nickname) === normNick(nickname);
    if (!same) throw new HttpsError("failed-precondition", "이 화면에는 다른 학생이 로그인되어 있습니다. 먼저 로그아웃한 뒤 다시 입장하세요.");
  }

  // 3) 이 별명으로 전에 하던 데이터가 다른 계정에 있으면 지금 계정으로 옮긴다
  let fromUid = null;
  if (cred) {
    if (cred.uid !== auth.uid) fromUid = cred.uid;
  } else {
    // 비밀번호가 아직 없는 같은 별명의 기존 학생(비밀번호 도입 전 입장자, 교사가 초기화한 경우)
    const same = (await db.collection(`sessions/${code}/members`).where("groupId", "==", groupId).get()).docs
      .find((d) => normNick(d.data().nickname) === normNick(nickname));
    if (same && same.id !== auth.uid) fromUid = same.id;
  }
  if (fromUid) await moveMember(code, groupId, fromUid, auth.uid);

  // 4) 입장 처리. 모둠원마다 서로 다른 인물을 무작위로 배정한다(직소). 모둠 안에서 축(당사자·도민·시민사회·제도)이 겹치지 않게 고른다.
  // 배정은 교사에게만 보이며 학생은 모른다. 재입장 시에는 유지한다.
  // 인물 배정은 학생이 읽을 수 없는 서버 전용 문서(assign, assignGroup)에 둔다. 학생 문서에는 인물 정보가 없다.
  const assignRef = db.doc(`sessions/${code}/assign/${auth.uid}`);
  const agRef = db.doc(`sessions/${code}/assignGroup/${groupId}`);
  await db.runTransaction(async (tx) => {
    const [m, g, a, ag] = await Promise.all([tx.get(memberRef), tx.get(groupRef), tx.get(assignRef), tx.get(agRef)]);
    const curPid = a.exists ? a.data().personaId : m.data()?.personaId; // 옛 방식(학생 문서에 있던 인물 ID)도 읽는다
    if (m.exists && m.data().groupId === groupId && personas.some((p) => p.id === curPid)) {
      tx.update(memberRef, { nickname, credKey: key, personaId: FieldValue().delete() });
      if (!a.exists) tx.set(assignRef, { groupId, personaId: curPid });
      if (!ag.exists && g.data()?.personaIds) { tx.set(agRef, { personaIds: g.data().personaIds }); tx.update(groupRef, { personaIds: FieldValue().delete() }); }
      return;
    }
    const n = g.data()?.memberCount || 0;
    const used = ag.exists ? ag.data().personaIds || [] : g.data()?.personaIds || [];
    const persona = pickPersona(personas, used);
    tx.update(groupRef, { memberCount: n + 1, personaIds: FieldValue().delete() });
    tx.set(agRef, { personaIds: [...used, persona.id] });
    tx.set(assignRef, { groupId, personaId: persona.id });
    tx.set(memberRef, {
      groupId, nickname, credKey: key,
      stage: 1, aiCount: 0, joinedAt: FieldValue().serverTimestamp(), lastSeen: FieldValue().serverTimestamp(),
    });
  });

  // 5) 비밀번호 저장(처음이면 새로 만들고, 있으면 현재 계정으로 연결만 바꾼다)
  await credRef.set({ ...(cred ? { salt: cred.salt, hash: cred.hash } : hashPassword(password)), uid: auth.uid, groupId, fails: 0, lockUntil: 0 });
  return { groupId };
});

// 학생의 인물 ID: 서버 전용 배정 문서에서 읽는다(옛 방식으로 학생 문서에 있던 값도 받아 준다)
async function personaIdOf(code, uid, member) {
  const a = await db.doc(`sessions/${code}/assign/${uid}`).get();
  return a.exists ? a.data().personaId : member?.personaId;
}

// 교사: 학생의 비밀번호를 지운다(잊어버린 경우). 그 학생이 같은 별명으로 다시 입장하면서 새 비밀번호를 정한다.
exports.resetStudentPassword = onCall(opts, async (req) => {
  const { code } = await ownSession(req);
  const uids = (Array.isArray(req.data?.uids) ? req.data.uids : [req.data?.uid]).map((x) => String(x || "")).filter(Boolean).slice(0, 200);
  if (!uids.length) throw new HttpsError("invalid-argument", "학생을 고르세요.");
  const names = [];
  for (const uid of uids) {
    const m = await db.doc(`sessions/${code}/members/${uid}`).get();
    if (!m.exists) throw new HttpsError("not-found", "학생을 찾을 수 없습니다.");
    const d = m.data();
    await db.doc(`sessions/${code}/creds/${d.credKey || credKey(parseInt(String(d.groupId).slice(1), 10), d.nickname)}`).delete();
    names.push(d.nickname);
  }
  return { nickname: names[0], count: names.length };
});

// ---------- 교사: 수업 관리 ----------

// 수업 이름·모둠 수 바꾸기. 모둠을 줄일 때는 학생이 없는 뒤쪽 모둠만 지울 수 있다.
exports.updateSession = onCall(opts, async (req) => {
  const { code, sess } = await ownSession(req);
  const patch = {};
  if (req.data?.title !== undefined) {
    const title = String(req.data.title).trim().slice(0, 80);
    if (!title) throw new HttpsError("invalid-argument", "수업 이름을 입력하세요.");
    patch.title = title;
  }
  if (req.data?.closed !== undefined) {
    patch.closed = req.data.closed === true;
    if (!patch.closed) patch.openedAt = FieldValue().serverTimestamp(); // 다시 열면 자동 닫힘 시간을 새로 센다
  }
  Object.assign(patch, sessionSettings(req.data));
  if (req.data?.groupCount !== undefined) {
    const n = parseInt(req.data.groupCount, 10);
    if (!(n >= 1 && n <= MAX_GROUPS)) throw new HttpsError("invalid-argument", `모둠 수는 1~${MAX_GROUPS} 사이로 정하세요.`);
    const cur = sess.groupCount;
    const batch = db.batch();
    if (n > cur) {
      for (let i = cur + 1; i <= n; i++) batch.set(db.doc(`sessions/${code}/groups/g${i}`), { name: `${i}모둠`, aiCount: 0, memberCount: 0, guardCount: 0, work: {} });
    } else if (n < cur) {
      for (let i = n + 1; i <= cur; i++) {
        const g = (await db.doc(`sessions/${code}/groups/g${i}`).get()).data();
        if ((g?.memberCount || 0) > 0) throw new HttpsError("failed-precondition", `${i}모둠에 학생이 있어 모둠을 줄일 수 없습니다.`);
        batch.delete(db.doc(`sessions/${code}/groups/g${i}`));
      }
    }
    await batch.commit();
    patch.groupCount = n;
  }
  if (Object.keys(patch).length) await db.doc(`sessions/${code}`).update(patch);
  return { ...patch };
});

// ---------- 교사: 인물 항목 편집 (말투·삶의 이야기·의견·편지만) ----------
const personasRef = (code) => db.doc(`sessions/${code}/private/personas`);
const overridesOf = async (code) => { const s = await personasRef(code).get(); return s.exists ? s.data().overrides || {} : {}; };
// 이 수업에서 쓰는 인물 목록(교사가 고친 항목을 반영)
async function personasFor(code, eventId) {
  const ov = await overridesOf(code);
  return availablePersonas(eventId, allowUnverified()).map((p) => applyOverride(p, ov[p.id]));
}

exports.getPersonaOverrides = onCall(opts, async (req) => {
  const { code } = await ownSession(req);
  return { overrides: await overridesOf(code) };
});

exports.savePersonaOverride = onCall(opts, async (req) => {
  const { code, sess } = await ownSession(req);
  const pid = String(req.data?.personaId || "");
  if (!availablePersonas(sess.eventId, true).some((p) => p.id === pid)) throw new HttpsError("not-found", "인물을 찾을 수 없습니다.");
  let fields;
  try { fields = sanitizeOverride(req.data?.fields); } catch (e) { throw new HttpsError("invalid-argument", e.message); }
  const ov = await overridesOf(code);
  ov[pid] = { ...(ov[pid] || {}), ...fields };
  await personasRef(code).set({ overrides: ov, updatedAt: FieldValue().serverTimestamp() });
  return { overrides: ov };
});

exports.resetPersonaOverride = onCall(opts, async (req) => {
  const { code } = await ownSession(req);
  const pid = String(req.data?.personaId || "");
  const ov = await overridesOf(code);
  delete ov[pid];
  await personasRef(code).set({ overrides: ov, updatedAt: FieldValue().serverTimestamp() });
  return { overrides: ov };
});

// 교사: 학생을 다른 모둠으로 옮긴다(모둠을 잘못 골랐을 때). 인물·대화·개인 정리·비밀번호는 그대로 따라간다.
exports.moveStudent = onCall(opts, async (req) => {
  const { code, sess } = await ownSession(req);
  const uid = String(req.data?.uid || "");
  const to = parseInt(req.data?.groupNo, 10);
  if (!(to >= 1 && to <= sess.groupCount)) throw new HttpsError("invalid-argument", "모둠 번호가 올바르지 않습니다.");
  const memberRef = db.doc(`sessions/${code}/members/${uid}`);
  const m = await memberRef.get();
  if (!m.exists) throw new HttpsError("not-found", "학생을 찾을 수 없습니다.");
  const d = m.data(), fromId = d.groupId, toId = `g${to}`;
  if (fromId === toId) return { groupId: toId };
  const fromNo = parseInt(fromId.slice(1), 10);
  const oldKey = d.credKey || credKey(fromNo, d.nickname), newKey = credKey(to, d.nickname);
  if ((await db.doc(`sessions/${code}/creds/${newKey}`).get()).exists) throw new HttpsError("failed-precondition", `${to}모둠에 같은 별명(${d.nickname})이 이미 있습니다. 별명이 겹치지 않게 해 주세요.`);
  const asg = await db.doc(`sessions/${code}/assign/${uid}`).get();
  const pid = asg.exists ? asg.data().personaId : d.personaId;
  const [ogRef, ngRef] = [`sessions/${code}/assignGroup/${fromId}`, `sessions/${code}/assignGroup/${toId}`].map((p) => db.doc(p));
  const [og, ng] = await Promise.all([ogRef.get(), ngRef.get()]);
  const oldIds = [...(og.data()?.personaIds || [])];
  const i = oldIds.indexOf(pid); if (i >= 0) oldIds.splice(i, 1);
  const fromG = db.doc(`sessions/${code}/groups/${fromId}`), toG = db.doc(`sessions/${code}/groups/${toId}`);
  const work = (await fromG.get()).data()?.work || {};
  const oldCred = await db.doc(`sessions/${code}/creds/${oldKey}`).get();
  const batch = db.batch();
  batch.update(memberRef, { groupId: toId, credKey: newKey });
  if (pid) batch.set(db.doc(`sessions/${code}/assign/${uid}`), { groupId: toId, personaId: pid });
  batch.set(ogRef, { personaIds: oldIds });
  batch.set(ngRef, { personaIds: [...(ng.data()?.personaIds || []), ...(pid ? [pid] : [])] });
  batch.update(fromG, { memberCount: FieldValue().increment(-1) });
  batch.update(toG, { memberCount: FieldValue().increment(1) });
  if (work.s1?.findings?.[uid] !== undefined) {
    batch.update(toG, { [`work.s1.findings.${uid}`]: work.s1.findings[uid] });
    batch.update(fromG, { [`work.s1.findings.${uid}`]: FieldValue().delete() });
  }
  if (work.live?.[uid] !== undefined) batch.update(fromG, { [`work.live.${uid}`]: FieldValue().delete() });
  if (oldCred.exists) { batch.set(db.doc(`sessions/${code}/creds/${newKey}`), { ...oldCred.data(), groupId: toId }); batch.delete(db.doc(`sessions/${code}/creds/${oldKey}`)); }
  await batch.commit();
  return { groupId: toId };
});

// 수업 전 점검: Firestore, 각 AI 모델, 웹 검색이 실제로 되는지 짧게 시험한다(교사 전용, 비용은 아주 적음)
exports.healthCheck = onCall(aiOpts, async (req) => {
  await requireTeacher(req);
  const apiKey = OPENAI_API_KEY.value();
  const timed = async (fn) => { const t = Date.now(); try { return { ok: true, ms: Date.now() - t, ...(await fn()) }; } catch (e) { return { ok: false, ms: Date.now() - t, error: String(e.message).slice(0, 200) }; } };
  const ask = (model) => timed(async () => ({ model, reply: String(await chat({ apiKey, model, messages: [{ role: "user", content: "'ok'라고만 답해." }], maxTokens: 20, effort: "minimal" })).slice(0, 30) }));
  const models = [...new Set([OPENAI_MODEL.value(), PERSONA_MODEL.value() || OPENAI_MODEL.value(), GUARD_MODEL.value() || OPENAI_MODEL.value(), SCENARIO_MODEL.value() || OPENAI_MODEL.value()])];
  const domains = SEARCH_ALLOWED_DOMAINS.value().split(",").map((x) => x.trim()).filter(Boolean);
  const [firestore, ...modelResults] = await Promise.all([
    timed(async () => { await db.doc("config/teachers").get(); return {}; }),
    ...models.map(ask),
  ]);
  const search = PERSONA_WEB_SEARCH.value() === "false" ? { skipped: true }
    : await timed(async () => { const r = await webSearch({ apiKey, model: SEARCH_MODEL.value() || OPENAI_MODEL.value(), query: "2018년 제주 예멘 난민 신청 인원", domains }); return { found: r.found, sources: r.sources.length, error: r.error ? "검색 호출 실패(모델이 web_search 를 지원하는지 확인)" : undefined }; });
  return {
    firestore, models: modelResults, search,
    config: { webSearch: PERSONA_WEB_SEARCH.value() !== "false", allowedDomains: domains.length, allowUnverified: allowUnverified(), personas: availablePersonas(DEFAULT_EVENT, allowUnverified()).length },
  };
});

// 수업 복제: 이름·모둠 수·설정과 이 수업에서 고친 자료를 새 수업으로 가져온다(학생과 기록은 가져오지 않는다)
exports.cloneSession = onCall(opts, async (req) => {
  const { auth, code, sess } = await ownSession(req);
  const title = String(req.data?.title || `${sess.title} (복사)`).trim().slice(0, 80);
  const newCodeStr = await newCode();
  const batch = db.batch();
  batch.set(db.doc(`sessions/${newCodeStr}`), {
    teacherUid: auth.uid, title, eventId: sess.eventId, groupCount: sess.groupCount, closed: false,
    aiLimit: sess.aiLimit || MAX_AI_CALLS_PER_GROUP, webSearch: sess.webSearch !== false, autoCloseHours: sess.autoCloseHours || 0,
    createdAt: FieldValue().serverTimestamp(),
  });
  for (let i = 1; i <= sess.groupCount; i++) batch.set(db.doc(`sessions/${newCodeStr}/groups/g${i}`), { name: `${i}모둠`, aiCount: 0, memberCount: 0, guardCount: 0, work: {} });
  const mats = await materialsRef(code).get();
  if (mats.exists) batch.set(materialsRef(newCodeStr), { categories: mats.data().categories, updatedAt: FieldValue().serverTimestamp() });
  const ovs = await personasRef(code).get();
  if (ovs.exists) batch.set(personasRef(newCodeStr), { overrides: ovs.data().overrides || {}, updatedAt: FieldValue().serverTimestamp() });
  await batch.commit();
  return { code: newCodeStr, title };
});

// 수업과 그 안의 모든 기록(모둠 산출물, AI 기록, 대화)을 지운다
exports.deleteSession = onCall(opts, async (req) => {
  const { code } = await ownSession(req);
  await db.recursiveDelete(db.doc(`sessions/${code}`));
  return { ok: true };
});

// ---------- 교사: 2단계 실제 자료 관리 ----------
const materialsRef = (code) => db.doc(`sessions/${code}/private/materials`);

exports.getMaterials = onCall(opts, async (req) => {
  const { code } = await ownSession(req);
  const snap = await materialsRef(code).get();
  return snap.exists
    ? { categories: snap.data().categories || [], isDefault: false }
    : { categories: defaultMaterials(allowUnverified()), isDefault: true };
});

exports.saveMaterials = onCall(opts, async (req) => {
  const { code } = await ownSession(req);
  let categories;
  try { categories = sanitizeMaterials(req.data?.categories); } catch (e) { throw new HttpsError("invalid-argument", e.message); }
  await materialsRef(code).set({ categories, updatedAt: FieldValue().serverTimestamp() });
  return { categories, isDefault: false };
});

// 이 수업만의 자료를 지우고 기본 자료로 되돌린다
exports.resetMaterials = onCall(opts, async (req) => {
  const { code } = await ownSession(req);
  await materialsRef(code).delete();
  return { categories: defaultMaterials(allowUnverified()), isDefault: true };
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
      id: p.id, axis: p.axis, label: p.label, name: p.name, role: p.role, stance: p.stance, setting: p.setting, voice: p.voice, basis: p.basis, letter: p.letter, views: p.views, story: p.story, episodes: p.episodes, inner: p.inner, habits: p.habits, limits: p.limits || [],
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
  if (sess.data().closed) throw new HttpsError("failed-precondition", CLOSED_MSG);
  const ev = EVENTS[sess.data().eventId];
  const myPersonaId = await personaIdOf(code, auth.uid, mem.data());
  const mine = (await personasFor(code, ev.id)).find((p) => p.id === myPersonaId);
  const custom = await materialsRef(code).get(); // 교사가 이 수업의 자료를 고쳤다면 그 목록, 아니면 기본 자료
  return {
    title: ev.title,
    summary: ev.summary,
    stakeholders: ev.stakeholders,
    me: mine ? { name: mine.name, letter: mine.letter } : null,
    materials: custom.exists ? toStudentMaterials(custom.data().categories) : materialsFor(allowUnverified()),
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
  const { groupId, nickname } = memberSnap.data();
  const personaId = await personaIdOf(code, auth.uid, memberSnap.data());
  const sessData = (await db.doc(`sessions/${code}`).get()).data();
  if (sessData.closed) throw new HttpsError("failed-precondition", CLOSED_MSG);
  const ev = EVENTS[sessData.eventId];
  const evCtx = { summary: ev.summary, premise: ev.summary };
  const personas = await personasFor(code, ev.id);
  const groupRef = db.doc(`sessions/${code}/groups/${groupId}`);
  const group = (await groupRef.get()).data() || {};
  const work = group.work || {};
  const s = Number(stage);
  // 모둠이 1단계에서 함께 정한 문제(있으면 3~5단계 AI가 기준으로 삼는다)
  const pb = work.s1?.problem || {};
  evCtx.problem = [pb.situation, pb.hmw].map((x) => String(x || "").trim()).filter(Boolean).join(" / ").slice(0, 400);

  const gate = checkGate({ stage: s, type, work, payload });
  if (!gate.ok) throw new HttpsError("failed-precondition", gate.reason);
  // 한도 확인과 횟수 증가를 한 번에 처리한다(동시에 요청이 몰려도 한도를 넘지 않게). 실패하면 아래에서 되돌린다.
  await db.runTransaction(async (tx) => {
    const g = (await tx.get(groupRef)).data() || {};
    if ((g.aiCount || 0) >= (sessData.aiLimit || MAX_AI_CALLS_PER_GROUP))
      throw new HttpsError("resource-exhausted", "이 모둠의 AI 사용 한도에 도달했습니다. 선생님께 문의하세요.");
    tx.update(groupRef, { aiCount: FieldValue().increment(1) });
  });

  const apiKey = OPENAI_API_KEY.value();
  const baseModel = OPENAI_MODEL.value();
  const effort = REASONING_EFFORT.value();
  const bump = {};

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
      const lookupOn = PERSONA_WEB_SEARCH.value() !== "false" && sessData.webSearch !== false;
      const messages = [{ role: "system", content: prompts.personaPrompt(ev, persona, { lookup: lookupOn }) }];
      past.forEach((l) => {
        messages.push({ role: "user", content: l.input });
        messages.push({ role: "assistant", content: l.output });
      });
      messages.push({ role: "user", content: input });

      const personaModel = PERSONA_MODEL.value() || baseModel;
      // 인물이 자기 자료로 답할 수 없는 사실을 물으면 웹에서 찾아 본다. 못 찾으면 모른다고 답한다.
      let reply, lookups = [];
      if (lookupOn) {
        const r = await chatWithLookup({
          apiKey, model: personaModel, messages, maxTokens: 400, effort,
          search: (query) => webSearch({ apiKey, model: SEARCH_MODEL.value() || baseModel, query, domains: SEARCH_ALLOWED_DOMAINS.value().split(",").map((x) => x.trim()).filter(Boolean) }),
        });
        reply = r.content; lookups = r.lookups;
        if (!String(reply).trim()) throw new Error("인물 응답이 비어 있음");
      } else {
        reply = await callModel({ apiKey, model: personaModel, messages, maxTokens: 400, efforts: [effort] });
      }

      // 상위 AI(규범 감독자): 학생에게 보내기 전에 검사. 가벼운 위반은 고쳐 쓰고, 무거운 위반·검사 실패는 안내로 대체
      let verdict;
      try {
        const verdictText = await callModel({
          apiKey, model: GUARD_MODEL.value() || baseModel, json: true, maxTokens: 700, efforts: ["low"],
          messages: guardMessages({ persona, claims: persona.claims, background: ev.background, history: past.slice(-3), studentMessage: input, reply, lookups }),
        });
        verdict = parseVerdict(verdictText);
      } catch (e) {
        verdict = { ok: false, category: "error", reason: "감독자 호출 실패", fixed: "" };
      }
      const out = resolveOutput(verdict, reply);
      if (out.replaced) bump.guardCount = FieldValue().increment(1);

      const ref = chatCol.doc();
      // 학생이 읽는 대화 문서에는 학생에게 보인 내용만 둔다. 감독자 판정·원래 응답·인물 정보는 교사 전용 문서(guardlog)에 따로 남긴다.
      await Promise.all([
        ref.set({
          uid: auth.uid, nickname, input, output: out.text, model: personaModel,
          ...(lookups.length ? { lookups: lookups.map((l) => ({ query: l.query, found: l.found, summary: l.summary, sources: l.sources })) } : {}),
          createdAt: FieldValue().serverTimestamp(),
        }),
        db.doc(`sessions/${code}/guardlog/${ref.id}`).set({
          uid: auth.uid, groupId, personaId, pii: piiFlags(input),
          guard: { ok: verdict.ok, category: verdict.category, reason: verdict.reason, how: out.how || null, original: out.replaced || out.trimmed ? reply : null, trimmed: !!out.trimmed },
          createdAt: FieldValue().serverTimestamp(),
        }),
        Object.keys(bump).length ? groupRef.update(bump) : null,
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
      Object.keys(bump).length ? groupRef.update(bump) : null,
      memberRef.update({ aiCount: FieldValue().increment(1) }),
    ]);
    return { logId: logRef.id, result };
  } catch (e) {
    await groupRef.update({ aiCount: FieldValue().increment(-1) }).catch(() => {}); // 실패한 호출은 학생의 사용 횟수에서 뺀다
    if (e instanceof HttpsError) throw e;
    console.error(`aiRequest 실패 stage=${s}:`, e.message);
    // 교사 화면에서 원인을 볼 수 있도록 모둠 문서에 남긴다
    await groupRef.update({ lastAiError: { stage: s, message: String(e.message).slice(0, 300), at: FieldValue().serverTimestamp() } }).catch(() => {});
    throw new HttpsError("unavailable", "AI 응답을 받지 못했습니다. 잠시 후 다시 시도하세요.");
  }
});

// ---------- 정기 작업 ----------
// 마지막 접속 후 정한 시간이 지난 수업을 자동으로 닫는다(수업이 끝나고 누가 접속하는 것을 막기 위해). 30분마다.
exports.autoCloseSessions = onSchedule({ region: REGION, schedule: "every 30 minutes", timeZone: "Asia/Seoul" }, async () => {
  const open = await db.collection("sessions").where("closed", "==", false).get();
  for (const d of open.docs) {
    if (!(d.data().autoCloseHours > 0)) continue;
    const members = (await db.collection(`sessions/${d.id}/members`).get()).docs.map((m) => m.data());
    if (autoCloseDue(d.data(), members)) await d.ref.update({ closed: true, closedAuto: true });
  }
});

// 학생이 로그아웃·재입장하며 쌓인 익명 계정 중 30일 넘게 쓰지 않은 것을 지운다(교사의 구글 계정은 건드리지 않는다). 매주 일요일 새벽.
exports.cleanAnonymousUsers = onSchedule({ region: REGION, schedule: "every sunday 04:00", timeZone: "Asia/Seoul" }, async () => {
  let token, removed = 0;
  do {
    const page = await admin.auth().listUsers(1000, token);
    const uids = staleAnonymousUids(page.users);
    if (uids.length) { await admin.auth().deleteUsers(uids); removed += uids.length; }
    token = page.pageToken;
  } while (token);
  console.log(`오래된 익명 계정 ${removed}개 삭제`);
});
