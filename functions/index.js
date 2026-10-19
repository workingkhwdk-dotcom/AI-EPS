const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { defineSecret, defineString, defineInt } = require("firebase-functions/params");
const admin = require("firebase-admin");
const crypto = require("crypto");

const {
  EVENTS, PERSONAS, DEFAULT_EVENT, availablePersonas, personaSourceIds, toPublicSource, materialsFor, materialsAdmin,
  casesFor, casesAdmin, aftermathFor, aftermathAdmin, BRIEFS, isRequired,
} = require("./case");
const { checkGate, toList, proposalText } = require("./policy");
const conduct = require("./conduct");
const { isPersonal } = require("./charter");
const prompts = require("./prompts");
const { chat, extractJson } = require("./openai");
const { guardMessages, parseVerdict, resolveOutput, piiFlags } = require("./guard");
const { isTeacherEmail, trustedLogin } = require("./teachers");
const { validatePassword, hashPassword, verifyPassword, normNick, credKey, lockedSeconds, afterFail, afterTotalFail } = require("./password");
const { defaultMaterials, sanitizeMaterials, toStudentMaterials, materialsText } = require("./materials");
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
// 교사 가입 인증 문구. 코드·저장소에는 두지 않고 functions/.env(git 에 올라가지 않음)의 TEACHER_SIGNUP_CODE 로만 정한다.
// 비어 있으면 교사 가입이 꺼진다(관리자·TEACHER_EMAILS·config/teachers 로만 교사 지정).
const TEACHER_SIGNUP_CODE = defineString("TEACHER_SIGNUP_CODE", { default: "" });
// true 이면 출처 원문 대조 전(verified:false) 페르소나·자료도 사용 가능. 리허설 전용, 실제 수업에서는 false 로 둔다.
const ALLOW_UNVERIFIED = defineString("ALLOW_UNVERIFIED_PERSONAS", { default: "false" });
const allowUnverified = () => ALLOW_UNVERIFIED.value() === "true";

const REGION = "asia-northeast3"; // 서울
const MAX_AI_CALLS_PER_GROUP = 150; // 수업별로 정하지 않았을 때의 모둠당 한도(3~5단계)
const COACH_LIMIT = 8; // 2단계 생각 도우미: 학생 한 사람이 부를 수 있는 횟수
const AI_LIMIT_RANGE = [10, 500];
// 1단계 인물 대화는 학생마다 따로 센다. 횟수가 적어야 질문을 신중하게 고른다.
const CHAT_LIMIT = 5;
const CHAT_LIMIT_RANGE = [1, 50];
const MAX_GROUPS = 12;

// 지역 CPU 한도: Cloud Run 은 함수마다 "CPU × 최대 인스턴스 수"를 미리 잡아 두고, 그 합이 프로젝트의 지역별 한도를 넘으면
// 배포를 거절한다("Quota exceeded for total allowable CPU per project per region"). 2세대 함수는 기본이 CPU 1개라
// 함수가 20개를 넘으면 금방 넘친다. 그래서 함수를 세 가지로 나눠 잡는 CPU 합을 30개 아래로 둔다.
//  - opts: 교사가 가끔 부르는 함수(수업 만들기·자료 편집·설정 등). CPU 1/6 개(gcf_gen1), 인스턴스 하나가 요청 하나씩.
//          한 함수에 최대 5개 = 동시에 5건까지라 교사 몇 명이 함께 써도 충분하다. 합계 약 0.8 CPU × 함수 수.
//  - fastOpts: 학생이 한꺼번에 부르는 입장·인물 고르기·사건 불러오기. CPU 1개, 인스턴스 하나가 동시에 80건.
//  - aiOpts: AI 호출. 대부분 OpenAI 응답을 기다리는 시간이라 CPU 1개 인스턴스 하나가 동시에 80건을 받는다.
// 함수를 새로 만들 때는 이 셋 중 하나를 쓰고, 값을 키우기 전에 합계를 다시 계산할 것.
const opts = { region: REGION, cors: true, cpu: "gcf_gen1", maxInstances: 5 };
// 입장·시작처럼 학생이 기다리는 호출은 첫 호출이 느리지 않도록(콜드 스타트) CPU 를 넉넉히 주고,
// MIN_INSTANCES 가 1 이상이면 항상 켜 둔다(수업 시간에만 1로 올리면 비용이 거의 들지 않는다).
const MIN_INSTANCES = defineInt("MIN_INSTANCES", { default: 0 });
const fastOpts = { region: REGION, cors: true, cpu: 1, memory: "512MiB", minInstances: MIN_INSTANCES, maxInstances: 3 }; // 3 × 80 = 동시에 240건
// 추론 모델(특히 5단계 시뮬레이션)은 응답에 1분 넘게 걸릴 수 있어 넉넉히 둔다.
const aiOpts = { region: REGION, cors: true, cpu: 1, secrets: [OPENAI_API_KEY], timeoutSeconds: 300, maxInstances: 4 }; // 4 × 80 = 동시에 320건
// 교사 점검용 연결 확인: 가끔 한 번만 부른다
const checkOpts = { ...aiOpts, maxInstances: 1 };

const FieldValue = () => admin.firestore.FieldValue;

function requireAuth(req) {
  if (!req.auth) throw new HttpsError("unauthenticated", "로그인이 필요합니다.");
  return req.auth;
}

// 교사인지: ① 인증된 이메일(구글 로그인)이 교사 목록에 있거나 ② 관리자가 콘솔에서 만든 이메일·비밀번호 교사 계정이거나
// ③ 교사용 계정 만들기에서 인증 문구로 승인받은 이메일·비밀번호 계정(teacherAccounts/{uid}).
// 이메일·비밀번호 계정은 이메일 인증 표시가 없으므로 이메일이 아니라 계정(uid)으로 승인한다.
// 그래서 남의 교사 이메일로 새 비밀번호 계정을 만들어도 인증 문구 없이는 교사가 될 수 없다.
const provider = (auth) => auth?.token?.firebase?.sign_in_provider;
async function teacherOk(auth) {
  if (!auth || provider(auth) === "anonymous") return false;
  if (trustedLogin(auth.token)) {
    const ok = await isTeacherEmail(auth.token.email, {
      envList: TEACHER_EMAILS.value(),
      readDoc: async () => (await db.doc("config/teachers").get()).data(),
    });
    if (ok) return true;
  }
  if (provider(auth) !== "password") return false;
  const acc = await db.doc(`teacherAccounts/${auth.uid}`).get();
  return acc.exists && acc.data().disabled !== true;
}
async function requireTeacher(req) {
  const auth = requireAuth(req);
  if (!(await teacherOk(auth))) throw new HttpsError("permission-denied", "교사 계정이 아닙니다.");
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

// 수업 설정값(모둠 AI 한도, 학생별 대화 횟수, 웹 검색, 자동 닫힘)을 검사해 저장할 값으로 바꾼다. 없는 값은 건드리지 않는다.
function sessionSettings(d) {
  const out = {};
  if (d?.aiLimit !== undefined) {
    const n = parseInt(d.aiLimit, 10);
    if (!(n >= AI_LIMIT_RANGE[0] && n <= AI_LIMIT_RANGE[1])) throw new HttpsError("invalid-argument", `모둠당 AI 한도는 ${AI_LIMIT_RANGE[0]}~${AI_LIMIT_RANGE[1]}회 사이로 정하세요.`);
    out.aiLimit = n;
  }
  if (d?.chatLimit !== undefined) {
    const n = parseInt(d.chatLimit, 10);
    if (!(n >= CHAT_LIMIT_RANGE[0] && n <= CHAT_LIMIT_RANGE[1])) throw new HttpsError("invalid-argument", `학생별 인물 대화 횟수는 ${CHAT_LIMIT_RANGE[0]}~${CHAT_LIMIT_RANGE[1]}회 사이로 정하세요.`);
    out.chatLimit = n;
  }
  if (d?.webSearch !== undefined) out.webSearch = d.webSearch === true;
  if (d?.coach !== undefined) out.coach = d.coach === true;
  if (d?.autoCloseHours !== undefined) {
    const h = Number(d.autoCloseHours);
    if (!AUTO_CLOSE_CHOICES.includes(h)) throw new HttpsError("invalid-argument", "자동 닫힘 시간이 올바르지 않습니다.");
    out.autoCloseHours = h;
  }
  return out;
}

// 교사가 닫아 둔 수업인지(closed:true). 닫힌 수업에는 입장·AI 사용·사건 자료 조회가 모두 막힌다.
const CLOSED_MSG = "수업이 끝났거나 선생님이 닫아 둔 수업입니다. 입장할 수 없습니다.";
const WAITING_MSG = "아직 수업이 시작되지 않았어요. 선생님이 시작하면 할 수 있어요.";

// 자동 닫힘 시간이 지났으면 지금 닫는다(30분마다 도는 정기 작업을 기다리지 않는다). 닫혔으면 true.
async function closeIfDue(code, sess) {
  if (sess.closed) return true;
  if (!(sess.autoCloseHours > 0)) return false;
  const ms = (await db.collection(`sessions/${code}/members`).get()).docs.map((d) => d.data());
  if (!autoCloseDue(sess, ms)) return false;
  await db.doc(`sessions/${code}`).update({ closed: true, closedAuto: true });
  return true;
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
// ---------- 교사용 계정 만들기 ----------
// 로그인한 계정이 교사인지 알려 준다(교사 화면 첫 화면이 교사 화면을 보여 줄지 인증 문구 입력을 보여 줄지 정한다).
exports.teacherStatus = onCall(opts, async (req) => {
  const auth = requireAuth(req);
  if (provider(auth) === "anonymous") throw new HttpsError("permission-denied", "교사 계정으로 로그인하세요.");
  return { teacher: await teacherOk(auth), email: auth.token?.email || "", signupOpen: !!String(TEACHER_SIGNUP_CODE.value() || "").trim() };
});

// 인증 문구 비교: 대소문자·앞뒤 빈칸은 무시하고, 해시끼리 같은 시간에 비교한다
function signupCodeOk(code) {
  const want = String(TEACHER_SIGNUP_CODE.value() || "").trim().toLowerCase();
  if (!want) return false;
  const h = (x) => crypto.createHash("sha256").update(x).digest();
  return crypto.timingSafeEqual(h(String(code || "").trim().toLowerCase()), h(want));
}
const SIGNUP_MAX_FAILS = 5, SIGNUP_LOCK_MS = 10 * 60 * 1000; // 계정마다: 5번 틀리면 10분 잠금
const SIGNUP_GLOBAL_FAILS = 30, SIGNUP_WINDOW_MS = 60 * 60 * 1000; // 전체: 한 시간에 30번 넘게 틀리면 그 시간 동안 가입을 막는다(새 계정을 계속 만들어 맞히는 것 방지)

// 구글 계정이나 새로 만든 이메일·비밀번호 계정으로 로그인한 뒤 교사 인증 문구를 맞히면 교사로 승인한다.
exports.registerTeacher = onCall(opts, async (req) => {
  const auth = requireAuth(req);
  const email = String(auth.token?.email || "").trim().toLowerCase();
  const prov = provider(auth);
  if (prov === "anonymous" || !email) throw new HttpsError("permission-denied", "구글 계정이나 이메일 계정으로 로그인해야 합니다.");
  const google = auth.token?.email_verified === true;
  if (!google && prov !== "password") throw new HttpsError("permission-denied", "구글 계정이나 이메일 계정으로 로그인해야 합니다.");
  if (await teacherOk(auth)) return { teacher: true, email };
  if (!String(TEACHER_SIGNUP_CODE.value() || "").trim()) throw new HttpsError("failed-precondition", "지금은 교사 가입을 받지 않습니다. 관리자에게 문의하세요.");

  const now = Date.now();
  const attRef = db.doc(`teacherAttempts/${auth.uid}`), gRef = db.doc("teacherAttempts/_all");
  const att = (await attRef.get()).data() || {}, g = (await gRef.get()).data() || {};
  if (att.lockedUntil > now) throw new HttpsError("resource-exhausted", `인증 문구를 여러 번 틀렸습니다. ${Math.ceil((att.lockedUntil - now) / 60000)}분 뒤에 다시 시도하세요.`);
  const gFails = g.windowStart > now - SIGNUP_WINDOW_MS ? g.fails || 0 : 0;
  if (gFails >= SIGNUP_GLOBAL_FAILS) throw new HttpsError("resource-exhausted", "지금은 가입 시도가 너무 많습니다. 한 시간 뒤에 다시 시도하세요.");

  if (!signupCodeOk(req.data?.code)) {
    const fails = (att.lockedUntil && att.lockedUntil <= now ? 0 : att.fails || 0) + 1;
    await attRef.set(fails >= SIGNUP_MAX_FAILS ? { fails: 0, lockedUntil: now + SIGNUP_LOCK_MS } : { fails, lockedUntil: 0 });
    await gRef.set(gFails ? { windowStart: g.windowStart, fails: gFails + 1 } : { windowStart: now, fails: 1 });
    throw new HttpsError("permission-denied", "교사 인증 문구가 맞지 않습니다.");
  }

  if (google) {
    // 구글 계정: 이메일을 교사 목록(config/teachers 의 emails)에 넣는다
    const ref = db.doc("config/teachers");
    await db.runTransaction(async (t) => {
      const doc = (await t.get(ref)).data() || {};
      const emails = Array.isArray(doc.emails) ? doc.emails : String(doc.emails || "").split(",").map((x) => x.trim()).filter(Boolean);
      if (!emails.map((x) => String(x).toLowerCase()).includes(email)) t.set(ref, { ...doc, emails: [...emails, email] });
    });
  } else {
    // 이메일·비밀번호 계정: 이 계정(uid)을 승인한다
    await db.doc(`teacherAccounts/${auth.uid}`).set({ email, at: FieldValue().serverTimestamp() });
  }
  await db.doc(`teacherSignups/${auth.uid}`).set({ email, method: google ? "google" : "password", at: FieldValue().serverTimestamp() });
  await attRef.delete().catch(() => {});
  return { teacher: true, email };
});

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
    started: false, // 교사가 '수업 시작'을 누르기 전까지는 대기실. 이 값이 없는 예전 수업은 시작된 것으로 본다.
    aiLimit: MAX_AI_CALLS_PER_GROUP, chatLimit: CHAT_LIMIT, webSearch: true, coach: true, autoCloseHours: 0,
    ...sessionSettings(req.data),
    createdAt: FieldValue().serverTimestamp(),
  });
  for (let i = 1; i <= groupCount; i++) {
    batch.set(db.doc(`sessions/${code}/groups/g${i}`), { name: `${i}모둠`, aiCount: 0, memberCount: 0, guardCount: 0, work: {} });
  }
  await batch.commit();
  return { code };
});

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
  const grp = (await groupRef.get()).data() || {};
  const work = grp.work || {};
  const upd = {};
  if (work.s1?.findings?.[fromUid] !== undefined) {
    upd[`work.s1.findings.${toUid}`] = work.s1.findings[fromUid];
    upd[`work.s1.findings.${fromUid}`] = FieldValue().delete();
  }
  if (work.live?.[fromUid] !== undefined) upd[`work.live.${fromUid}`] = FieldValue().delete();
  for (const [pid, pk] of Object.entries(grp.picks || {})) if (pk?.uid === fromUid) upd[`picks.${pid}.uid`] = toUid;
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
//  - 비밀번호가 맞으면 이전에 하던 데이터(고른 인물, 대화, 개인 정리)가 지금 화면으로 이어진다.
//  - 인물은 입장할 때 정하지 않는다. 모둠원이 모든 인물의 편지를 보고 상의해서 각자 고른다(choosePersona).
//  - 입장 속도: 읽기는 가능한 한 동시에 하고, 비밀번호 해시는 다른 요청을 막지 않는 비동기로 하며,
//    화면에 필요한 수업 내용(studentCase)을 함께 돌려줘 getCase 를 따로 부르지 않아도 되게 한다.
exports.joinSession = onCall(fastOpts, async (req) => {
  const auth = requireAuth(req);
  const code = String(req.data?.code || "").trim().toUpperCase();
  const groupNo = parseInt(req.data?.groupNo, 10);
  const nickname = String(req.data?.nickname || "").trim().slice(0, 12);
  const password = String(req.data?.password ?? "");
  if (!nickname) throw new HttpsError("invalid-argument", "별명을 입력하세요. (이름 대신 별명을 쓰세요)");
  const pwErr = validatePassword(password);
  if (pwErr) throw new HttpsError("invalid-argument", pwErr);
  const memberRef = db.doc(`sessions/${code}/members/${auth.uid}`);
  const key = credKey(groupNo, nickname);
  const credRef = db.doc(`sessions/${code}/creds/${key}`);
  const attRef = db.doc(`sessions/${code}/attempts/${auth.uid}`);
  const [session, credSnap, mine, attSnap] = await Promise.all([db.doc(`sessions/${code}`).get(), credRef.get(), memberRef.get(), attRef.get()]);
  if (!session.exists) throw new HttpsError("not-found", "수업 코드를 찾을 수 없습니다.");
  const sess = session.data();
  if (await closeIfDue(code, sess)) throw new HttpsError("failed-precondition", CLOSED_MSG);
  if (!(groupNo >= 1 && groupNo <= sess.groupCount))
    throw new HttpsError("invalid-argument", "모둠 번호가 올바르지 않습니다.");
  const groupId = `g${groupNo}`;
  if (!availablePersonas(sess.eventId, allowUnverified()).length) throw new HttpsError("failed-precondition", "아직 사용할 수 있는 인물이 없습니다. 선생님께 문의하세요.");
  const groupRef = db.doc(`sessions/${code}/groups/${groupId}`);

  // 1) 비밀번호 확인. 잠금은 틀린 사람(접속 계정)별로 먼저 걸리고, 별명 전체에는 더 느슨하게 걸린다(친구가 일부러 틀려서 막는 일 방지).
  const cred = credSnap.exists ? credSnap.data() : null;
  if (cred) {
    const att = attSnap.data() || {};
    const wait = Math.max(lockedSeconds(att), lockedSeconds(cred));
    if (wait) throw new HttpsError("resource-exhausted", `비밀번호를 여러 번 틀려서 ${wait}초 동안 입장할 수 없습니다.`);
    if (!(await verifyPassword(password, cred))) {
      await Promise.all([attRef.set(afterFail(att)), credRef.update(afterTotalFail(cred))]);
      throw new HttpsError("permission-denied", "비밀번호가 맞지 않습니다. 같은 모둠의 다른 친구가 이 별명을 이미 쓰고 있다면 다른 별명으로 입장하세요.");
    }
    if (attSnap.exists) await attRef.delete();
  }
  // 처음 쓰는 별명이면 새 비밀번호의 해시를 지금부터 계산해 둔다(아래 작업과 겹쳐서 진행)
  const hashP = cred ? null : hashPassword(password);

  // 2) 이 기기에 이미 다른 학생이 로그인되어 있으면 막는다(공용 PC에서 남의 자리를 이어받지 않도록)
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

  // 4) 입장 처리. 인물은 배정하지 않는다(학생이 고른다). 이전에 고른 인물이 있으면 그대로 이어진다.
  const assignRef = db.doc(`sessions/${code}/assign/${auth.uid}`);
  const agRef = db.doc(`sessions/${code}/assignGroup/${groupId}`);
  await db.runTransaction(async (tx) => {
    const [m, g, a, ag] = await Promise.all([tx.get(memberRef), tx.get(groupRef), tx.get(assignRef), tx.get(agRef)]);
    if (m.exists && m.data().groupId === groupId) {
      const curPid = a.exists ? a.data().personaId : m.data()?.personaId; // 옛 방식(학생 문서에 있던 인물 ID)도 읽는다
      tx.update(memberRef, { nickname, credKey: key, personaId: FieldValue().delete() });
      if (curPid) {
        if (!a.exists) tx.set(assignRef, { groupId, personaId: curPid });
        if (!g.data()?.picks?.[curPid]) tx.update(groupRef, { [`picks.${curPid}`]: { uid: auth.uid, nick: nickname } });
      }
      if (!ag.exists && g.data()?.personaIds) { tx.set(agRef, { personaIds: g.data().personaIds }); tx.update(groupRef, { personaIds: FieldValue().delete() }); }
      return;
    }
    tx.update(groupRef, { memberCount: (g.data()?.memberCount || 0) + 1 });
    tx.set(memberRef, {
      groupId, nickname, credKey: key,
      stage: 1, aiCount: 0, chatCount: 0, joinedAt: FieldValue().serverTimestamp(), lastSeen: FieldValue().serverTimestamp(),
    });
  });

  // 5) 비밀번호 저장(처음이면 새로 만들고, 있으면 현재 계정으로 연결만 바꾼다)과 화면에 필요한 내용 준비를 함께 한다
  const saved = hashP ? await hashP : { salt: cred.salt, hash: cred.hash };
  const [, caseData] = await Promise.all([
    credRef.set({ ...saved, uid: auth.uid, groupId, fails: 0, lockUntil: 0 }),
    studentCase(code, sess, auth.uid),
  ]);
  return { groupId, nickname, started: sess.started !== false, chatLimit: sess.chatLimit || CHAT_LIMIT, case: caseData };
});

// 학생의 인물 ID: 서버 전용 배정 문서에서 읽는다(옛 방식으로 학생 문서에 있던 값도 받아 준다)
async function personaIdOf(code, uid, member) {
  const a = await db.doc(`sessions/${code}/assign/${uid}`).get();
  return a.exists ? a.data().personaId : member?.personaId;
}

// 학생 화면이 쓰는 수업 내용. 모든 인물의 편지(이름·한 줄 소개·편지)와 내가 고른 인물, 모둠원이 고른 인물을 함께 보낸다.
// 인물의 역할·근거·출처·말투는 보내지 않는다.
async function studentCase(code, sess, uid, member) {
  const ev = EVENTS[sess.eventId];
  const gid = member?.groupId;
  const [personas, materials, a, groupSnap] = await Promise.all([
    personasFor(code, ev.id),
    studentMaterials(code, ev.id),
    db.doc(`sessions/${code}/assign/${uid}`).get(),
    gid ? db.doc(`sessions/${code}/groups/${gid}`).get() : Promise.resolve(null),
  ]);
  const myId = a.exists ? a.data().personaId : member?.personaId;
  const mine = personas.find((p) => p.id === myId);
  return {
    title: ev.title,
    summary: ev.summary,
    stakeholders: ev.stakeholders,
    letters: personas.map((p) => ({ id: p.id, name: p.name, brief: BRIEFS[p.id] || p.label || "", letter: p.letter, required: isRequired(p), personal: isPersonal(p) })),
    me: mine ? { id: mine.id, name: mine.name, letter: mine.letter, personal: isPersonal(mine) } : null,
    ui: ev.ui,
    materials,
    cases: casesFor(ev.id, allowUnverified()),
    aftermath: aftermathFor(ev.id, allowUnverified()),
  };
}

// 학생: 이 모둠에서 내가 대화할 인물을 고른다. 모둠원마다 서로 다른 인물이어야 하고, 대화를 시작한 뒤에는 바꿀 수 없다.
//  - 사건마다 정한 축(제주는 난민 신청자)의 인물은 모둠에 꼭 한 명 있어야 한다. 그 인물을 맡은 학생이 다른 인물로 바꿔 모둠에서 없어지는 것은 막는다.
exports.choosePersona = onCall(fastOpts, async (req) => {
  const auth = requireAuth(req);
  const code = String(req.data?.code || "").toUpperCase();
  const pid = String(req.data?.personaId || "");
  const memberRef = db.doc(`sessions/${code}/members/${auth.uid}`);
  const [sessSnap, memSnap] = await Promise.all([db.doc(`sessions/${code}`).get(), memberRef.get()]);
  if (!sessSnap.exists || !memSnap.exists) throw new HttpsError("permission-denied", "이 수업의 참여자가 아닙니다.");
  const sess = sessSnap.data();
  if (await closeIfDue(code, sess)) throw new HttpsError("failed-precondition", CLOSED_MSG);
  const personas = await personasFor(code, sess.eventId);
  const persona = personas.find((p) => p.id === pid);
  if (!persona) throw new HttpsError("not-found", "인물을 찾을 수 없습니다.");
  const { groupId, nickname } = memSnap.data();
  const groupRef = db.doc(`sessions/${code}/groups/${groupId}`);
  const assignRef = db.doc(`sessions/${code}/assign/${auth.uid}`);
  const agRef = db.doc(`sessions/${code}/assignGroup/${groupId}`);
  await db.runTransaction(async (tx) => {
    const [m, g, a, ag] = await Promise.all([tx.get(memberRef), tx.get(groupRef), tx.get(assignRef), tx.get(agRef)]);
    const picks = g.data()?.picks || {};
    const cur = a.exists ? a.data().personaId : m.data()?.personaId;
    if (cur === pid) return;
    if ((m.data()?.chatCount || 0) > 0) throw new HttpsError("failed-precondition", "인물과 대화를 시작한 뒤에는 인물을 바꿀 수 없어요. 바꾸고 싶으면 선생님께 말씀드리세요.");
    if (picks[pid] && picks[pid].uid !== auth.uid) throw new HttpsError("already-exists", `${picks[pid].nick || "다른 친구"}가 이미 고른 인물이에요. 다른 인물을 골라 보세요.`);
    if (cur && isRequired(personas.find((p) => p.id === cur)) && !isRequired(persona)) {
      const another = Object.entries(picks).some(([id, pk]) => pk?.uid !== auth.uid && isRequired(personas.find((p) => p.id === id)));
      const who = EVENTS[sess.eventId].ui.requiredWho;
      if (!another) throw new HttpsError("failed-precondition", `모둠에 ${who} 인물을 맡은 친구가 한 명은 있어야 해요. 다른 친구가 그 인물을 고른 뒤에 바꿀 수 있어요.`);
    }
    const used = (ag.exists ? ag.data().personaIds || [] : []).slice();
    if (cur) { const i = used.indexOf(cur); if (i >= 0) used.splice(i, 1); }
    used.push(pid);
    const upd = { [`picks.${pid}`]: { uid: auth.uid, nick: nickname } };
    if (cur) upd[`picks.${cur}`] = FieldValue().delete();
    tx.update(groupRef, upd);
    tx.set(agRef, { personaIds: used });
    tx.set(assignRef, { groupId, personaId: pid });
    if (m.data()?.personaId) tx.update(memberRef, { personaId: FieldValue().delete() });
  });
  return { me: { id: persona.id, name: persona.name, letter: persona.letter, personal: isPersonal(persona) } };
});

// 교사: 학생이 고른 인물을 풀어 준다(잘못 골랐거나 대화를 시작해서 학생이 바꿀 수 없을 때). 대화 기록은 지우고 질문 횟수를 되돌린다.
exports.resetPersonaChoice = onCall(opts, async (req) => {
  const { code } = await ownSession(req);
  const uid = String(req.data?.uid || "");
  const memberRef = db.doc(`sessions/${code}/members/${uid}`);
  const m = await memberRef.get();
  if (!m.exists) throw new HttpsError("not-found", "학생을 찾을 수 없습니다.");
  const { groupId } = m.data();
  const [a, ag] = await Promise.all([db.doc(`sessions/${code}/assign/${uid}`).get(), db.doc(`sessions/${code}/assignGroup/${groupId}`).get()]);
  const pid = a.exists ? a.data().personaId : m.data().personaId;
  const chats = (await db.collection(`sessions/${code}/members/${uid}/chat`).get()).docs;
  for (let i = 0; i < chats.length; i += 400) {
    const batch = db.batch();
    chats.slice(i, i + 400).forEach((d) => batch.delete(db.doc(`sessions/${code}/members/${uid}/chat/${d.id}`)));
    await batch.commit();
  }
  const batch = db.batch();
  batch.update(memberRef, { chatCount: 0, personaId: FieldValue().delete() });
  if (a.exists) batch.delete(db.doc(`sessions/${code}/assign/${uid}`));
  if (pid) {
    batch.update(db.doc(`sessions/${code}/groups/${groupId}`), { [`picks.${pid}`]: FieldValue().delete() });
    batch.set(db.doc(`sessions/${code}/assignGroup/${groupId}`), { personaIds: (ag.data()?.personaIds || []).filter((id) => id !== pid) });
  }
  await batch.commit();
  return { ok: true };
});

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
    if (!patch.closed) { patch.openedAt = FieldValue().serverTimestamp(); patch.closedAuto = false; } // 다시 열면 자동 닫힘 시간을 새로 센다
  }
  // 수업 시작: 대기실의 학생들이 활동을 시작할 수 있게 된다(되돌릴 수 없다). 자동 닫힘 시간은 시작한 때부터 센다.
  if (req.data?.started === true && sess.started === false) {
    patch.started = true;
    patch.startedAt = FieldValue().serverTimestamp();
    patch.openedAt = FieldValue().serverTimestamp();
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
  const fromG = db.doc(`sessions/${code}/groups/${fromId}`), toG = db.doc(`sessions/${code}/groups/${toId}`);
  const [og, ng, fromSnap, toSnap] = await Promise.all([ogRef.get(), ngRef.get(), fromG.get(), toG.get()]);
  const toPicks = toSnap.data()?.picks || {};
  if (pid && toPicks[pid]) throw new HttpsError("failed-precondition", `${to}모둠에는 같은 인물을 고른 친구(${toPicks[pid].nick})가 있습니다. 한쪽의 인물 선택을 먼저 풀어 주세요.`);
  const oldIds = [...(og.data()?.personaIds || [])];
  const i = oldIds.indexOf(pid); if (i >= 0) oldIds.splice(i, 1);
  const work = fromSnap.data()?.work || {};
  const oldCred = await db.doc(`sessions/${code}/creds/${oldKey}`).get();
  const batch = db.batch();
  batch.update(memberRef, { groupId: toId, credKey: newKey });
  if (pid) batch.set(db.doc(`sessions/${code}/assign/${uid}`), { groupId: toId, personaId: pid });
  batch.set(ogRef, { personaIds: oldIds });
  batch.set(ngRef, { personaIds: [...(ng.data()?.personaIds || []), ...(pid ? [pid] : [])] });
  if (pid) {
    batch.update(fromG, { [`picks.${pid}`]: FieldValue().delete() });
    batch.update(toG, { [`picks.${pid}`]: { uid, nick: d.nickname } });
  }
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
exports.healthCheck = onCall(checkOpts, async (req) => {
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
    : await timed(async () => { const ev = EVENTS[DEFAULT_EVENT]; const r = await webSearch({ apiKey, model: SEARCH_MODEL.value() || OPENAI_MODEL.value(), event: ev, query: ev.search.example, domains }); return { found: r.found, sources: r.sources.length, error: r.error ? "검색 호출 실패(모델이 web_search 를 지원하는지 확인)" : undefined }; });
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
    teacherUid: auth.uid, title, eventId: sess.eventId, groupCount: sess.groupCount, closed: false, started: false,
    aiLimit: sess.aiLimit || MAX_AI_CALLS_PER_GROUP, chatLimit: sess.chatLimit || CHAT_LIMIT, webSearch: sess.webSearch !== false, coach: sess.coach !== false, autoCloseHours: sess.autoCloseHours || 0,
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
  const { code, sess } = await ownSession(req);
  const snap = await materialsRef(code).get();
  return snap.exists
    ? { categories: snap.data().categories || [], isDefault: false }
    : { categories: defaultMaterials(sess.eventId, allowUnverified()), isDefault: true };
});

exports.saveMaterials = onCall(opts, async (req) => {
  const { code } = await ownSession(req);
  let categories;
  try { categories = sanitizeMaterials(req.data?.categories); } catch (e) { throw new HttpsError("invalid-argument", e.message); }
  await materialsRef(code).set({ categories, updatedAt: FieldValue().serverTimestamp() });
  return { categories, isDefault: false };
});

// 학생이 보는 2단계 자료: 교사가 이 수업의 자료를 고쳤다면 그 목록, 아니면 기본 자료
async function studentMaterials(code, eventId) {
  const custom = await materialsRef(code).get();
  return custom.exists ? toStudentMaterials(custom.data().categories) : materialsFor(eventId, allowUnverified());
}

// 이 수업만의 자료를 지우고 기본 자료로 되돌린다
exports.resetMaterials = onCall(opts, async (req) => {
  const { code, sess } = await ownSession(req);
  await materialsRef(code).delete();
  return { categories: defaultMaterials(sess.eventId, allowUnverified()), isDefault: true };
});

// 화면이 쓰는 수업 설정.
//  - 학생: { code } → 내 인물의 이름과 편지, 3단계 실제 자료, 4단계 해외 사례 카드, 7단계 이후 전개(사건 개요는 화면에 보이지 않지만 함께 보낸다). 인물의 역할·근거·출처는 보내지 않는다.
//  - 교사: { eventId } → 인물별 근거 진술·출처 검증 현황, 자료 전체
exports.getCase = onCall(fastOpts, async (req) => {
  const auth = requireAuth(req);

  if (req.data?.eventId) {
    await requireTeacher(req);
    const ev = EVENTS[req.data.eventId];
    if (!ev) throw new HttpsError("not-found", "사건을 찾을 수 없습니다.");
    const full = (p) => ({
      id: p.id, axis: p.axis, label: p.label, name: p.name, role: p.role, stance: p.stance, setting: p.setting, voice: p.voice, basis: p.basis, letter: p.letter, views: p.views, story: p.story, episodes: p.episodes, inner: p.inner, habits: p.habits, limits: p.limits || [], beliefs: (p.beliefs || []).map(([text, note]) => ({ text, note })),
      sources: personaSourceIds(p).map(toPublicSource),
      claims: p.claims.map(([text, src, kind]) => ({ text, src, kind })),
    });
    const materials = materialsAdmin(ev.id).map((c) => ({
      ...c,
      items: c.items.map((it) => ({ ...it, verified: it.src.every((id) => toPublicSource(id).verified) })),
    }));
    return {
      event: { id: ev.id, title: ev.title, summary: ev.summary, teacherNote: ev.teacherNote, axes: ev.axes, requiredAxis: ev.requiredAxis,
        background: (ev.background || []).map(([text, src, kind]) => ({ text, src, kind, verified: toPublicSource(src).verified })) },
      personas: PERSONAS.filter((p) => p.events.includes(ev.id)).map(full),
      materials,
      cases: casesAdmin(ev.id).map((c) => ({ ...c, sources: c.src.map(toPublicSource) })),
      aftermath: aftermathAdmin(ev.id).map((a) => ({ ...a, sources: a.src.map(toPublicSource) })),
      allowUnverified: allowUnverified(),
    };
  }

  const code = String(req.data?.code || "").toUpperCase();
  const [sess, mem] = await Promise.all([db.doc(`sessions/${code}`).get(), db.doc(`sessions/${code}/members/${auth.uid}`).get()]);
  if (!sess.exists || !mem.exists) throw new HttpsError("permission-denied", "이 수업의 참여자가 아닙니다.");
  if (await closeIfDue(code, sess.data())) throw new HttpsError("failed-precondition", CLOSED_MSG);
  return studentCase(code, sess.data(), auth.uid, mem.data());
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

// AI 호출의 단일 관문: 인증 → 모둠 확인 → GYR 게이트 → 횟수 한도 → OpenAI → (1단계) 상위 AI 감독 → 로그
//  - 1단계 인물 대화는 학생별 횟수(chatLimit)로, 3~5단계는 모둠 횟수(aiLimit)로 센다.
exports.aiRequest = onCall(aiOpts, async (req) => {
  const auth = requireAuth(req);
  const { code, stage, type, payload = {} } = req.data || {};
  if (!code) throw new HttpsError("invalid-argument", "수업 코드가 없습니다.");

  const memberRef = db.doc(`sessions/${code}/members/${auth.uid}`);
  const memberSnap = await memberRef.get();
  if (!memberSnap.exists) throw new HttpsError("permission-denied", "이 수업의 참여자가 아닙니다.");
  const { groupId, nickname } = memberSnap.data();
  const personaId = await personaIdOf(code, auth.uid, memberSnap.data());
  const member = memberSnap.data();
  const sessData = (await db.doc(`sessions/${code}`).get()).data();
  if (!sessData || (await closeIfDue(code, sessData))) throw new HttpsError("failed-precondition", CLOSED_MSG);
  if (sessData.started === false) throw new HttpsError("failed-precondition", WAITING_MSG);
  const ev = EVENTS[sessData.eventId];
  const evCtx = { summary: ev.summary, premise: ev.summary };
  const personas = await personasFor(code, ev.id);
  const groupRef = db.doc(`sessions/${code}/groups/${groupId}`);
  const group = (await groupRef.get()).data() || {};
  const work = group.work || {};
  const s = Number(stage);
  const clip = (v, n) => String(v || "").trim().slice(0, n);
  // 모둠이 앞 단계에서 정한 것(있으면 3~5단계 AI가 기준으로 삼는다)
  const pb = work.s1?.problem || {};
  evCtx.problem = [pb.situation, pb.hmw].map((x) => clip(x, 400)).filter(Boolean).join(" / ").slice(0, 400);
  evCtx.cause = clip(work.s3?.chain?.cause, 400);
  evCtx.evidence = clip(work.s3?.chain?.evidence, 400);

  const gate = checkGate({ stage: s, type, work, payload });
  if (!gate.ok) throw new HttpsError("failed-precondition", gate.reason);
  // 한도 확인과 횟수 증가를 한 번에 처리한다(동시에 요청이 몰려도 한도를 넘지 않게). 실패하면 아래에서 되돌린다.
  const chatLimit = sessData.chatLimit || CHAT_LIMIT;
  // 생각 도우미(2단계)는 학생마다 따로 센다. 모둠의 3~5단계 AI 한도를 깎지 않는다.
  const counter = s === 1 ? { ref: memberRef, field: "chatCount" } : s === 2 ? { ref: memberRef, field: "coachCount" } : { ref: groupRef, field: "aiCount" };
  await db.runTransaction(async (tx) => {
    const d = (await tx.get(counter.ref)).data() || {};
    if (s === 1 && (d.chatCount || 0) >= chatLimit)
      throw new HttpsError("resource-exhausted", `인물에게 물을 수 있는 ${chatLimit}번을 모두 썼어요. 지금까지 들은 이야기로 ② 정리를 해 보세요.`);
    if (s === 2 && (d.coachCount || 0) >= COACH_LIMIT)
      throw new HttpsError("resource-exhausted", `생각 도우미는 한 사람이 ${COACH_LIMIT}번까지 부를 수 있어요. 이제 모둠원과 이야기하며 다듬어 보세요.`);
    if (s > 2 && (d.aiCount || 0) >= (sessData.aiLimit || MAX_AI_CALLS_PER_GROUP))
      throw new HttpsError("resource-exhausted", "이 모둠의 AI 사용 한도에 도달했습니다. 선생님께 문의하세요.");
    tx.update(counter.ref, { [counter.field]: FieldValue().increment(1) });
  });
  const refund = () => counter.ref.update({ [counter.field]: FieldValue().increment(-1) }).catch(() => {});

  const apiKey = OPENAI_API_KEY.value();
  const baseModel = OPENAI_MODEL.value();
  const effort = REASONING_EFFORT.value();
  const searchOn = PERSONA_WEB_SEARCH.value() !== "false" && sessData.webSearch !== false;
  const domains = SEARCH_ALLOWED_DOMAINS.value().split(",").map((x) => x.trim()).filter(Boolean);
  const search = (query) => webSearch({ apiKey, model: SEARCH_MODEL.value() || baseModel, event: ev, query, domains });
  const bump = {};

  try {
    // ---- 1단계: 학생별 메신저 대화 ----
    if (s === 1) {
      const persona = personas.find((p) => p.id === personaId);
      if (!persona) throw new HttpsError("failed-precondition", "대화할 인물을 먼저 골라 주세요.");
      if (member.chatLocked) throw new HttpsError("failed-precondition", conduct.strikeNotice(conduct.STRIKE_LIMIT));
      const chatCol = db.collection(`sessions/${code}/members/${auth.uid}/chat`);
      // 최근 대화만 시간순으로 가져온다(전체를 읽지 않는다)
      const past = (await chatCol.orderBy("createdAt", "desc").limit(16).get()).docs.map((d) => d.data()).reverse();
      const input = String(payload.message).trim();
      const messages = [{ role: "system", content: prompts.personaPrompt(ev, persona, { lookup: searchOn }) }];
      past.forEach((l) => {
        messages.push({ role: "user", content: l.input });
        messages.push({ role: "assistant", content: l.output });
      });
      messages.push({ role: "user", content: input });

      const personaModel = PERSONA_MODEL.value() || baseModel;
      // 학생 태도 1차 검사: 명백한 조롱·성적 희롱은 인물 응답을 만들지 않고 바로 선을 긋는다
      const pre = conduct.screenMessage(input);
      let reply = "", lookups = [], verdict, out, conductCat = "ok", conductBy = null;
      if (pre.category !== "ok") {
        conductCat = pre.category; conductBy = "rule";
        verdict = { ok: false, category: "conduct", reason: `학생 메시지 규칙 검사: ${conduct.LABELS[pre.category]}`, fixed: "", conduct: pre.category };
      } else {
        // 인물이 자기 자료로 답할 수 없는 사실을 물으면 웹에서 찾아 본다. 못 찾으면 모른다고 답한다.
        if (searchOn) {
          const r = await chatWithLookup({ apiKey, model: personaModel, event: ev, messages, maxTokens: 400, effort, search });
          reply = r.content; lookups = r.lookups;
          if (!String(reply).trim()) throw new Error("인물 응답이 비어 있음");
        } else {
          reply = await callModel({ apiKey, model: personaModel, messages, maxTokens: 400, efforts: [effort] });
        }

        // 상위 AI(규범 감독자): 학생에게 보내기 전에 검사. 가벼운 위반은 고쳐 쓰고, 무거운 위반·검사 실패는 안내로 대체.
        // 학생 메시지의 태도(conduct)도 함께 판정한다.
        try {
          const verdictText = await callModel({
            apiKey, model: GUARD_MODEL.value() || baseModel, json: true, maxTokens: 900, efforts: ["low"],
            messages: guardMessages({ event: ev, persona, claims: persona.claims, history: past.slice(-3), studentMessage: input, reply, lookups }),
          });
          verdict = parseVerdict(verdictText);
        } catch (e) {
          verdict = { ok: false, category: "error", reason: "감독자 호출 실패", fixed: "", conduct: "ok" };
        }
        if (verdict.conduct !== "ok") { conductCat = verdict.conduct; conductBy = "guard"; }
      }
      if (conductCat !== "ok") out = { text: conduct.boundaryReply(conductCat), replaced: true, how: "conduct" };
      else out = resolveOutput(verdict, reply);
      if (out.replaced) bump.guardCount = FieldValue().increment(1);
      // 감독자 검사가 실패해 '다시 말해 달라'는 안내가 나간 경우는 학생의 질문 횟수에서 빼 준다
      const refunded = verdict.category === "error";

      // 위반 기록: 학생 경고 횟수(strikes)가 한도에 이르면 교사가 풀어 줄 때까지 대화를 멈춘다. 교사 화면에는 신호(alerts)가 간다.
      const memberUpd = { aiCount: FieldValue().increment(1), ...(refunded ? { chatCount: FieldValue().increment(-1) } : {}) };
      let conductLog = null;
      const writes = [];
      if (conductCat !== "ok") {
        const strikes = (member.conduct?.strikes || 0) + 1;
        const locked = strikes >= conduct.STRIKE_LIMIT;
        conductLog = { category: conductCat, by: conductBy, strikes, locked, notice: conduct.strikeNotice(strikes) };
        memberUpd.conduct = { strikes, total: (member.conduct?.total || 0) + 1, last: conductCat, lastAt: FieldValue().serverTimestamp() };
        if (locked) memberUpd.chatLocked = true;
        bump.conductCount = FieldValue().increment(1);
        writes.push(db.collection(`sessions/${code}/alerts`).doc().set({
          uid: auth.uid, nickname, groupId, personaId, category: conductCat, by: conductBy, input, strikes, locked,
          createdAt: FieldValue().serverTimestamp(),
        }));
      }

      const ref = chatCol.doc();
      // 학생이 읽는 대화 문서에는 학생에게 보인 내용만 둔다. 감독자 판정·원래 응답·인물 정보는 교사 전용 문서(guardlog)에 따로 남긴다.
      await Promise.all([
        ref.set({
          uid: auth.uid, nickname, input, output: out.text, model: conductBy === "rule" ? "rule" : personaModel,
          ...(lookups.length ? { lookups: lookups.map((l) => ({ query: l.query, found: l.found, summary: l.summary, sources: l.sources })) } : {}),
          ...(refunded ? { refunded: true } : {}),
          // 학생 화면에 보이는 경고 문구와 횟수만 둔다(위반 종류·판정 방식은 교사 전용 문서에)
          conduct: conductLog ? { notice: conductLog.notice, strikes: conductLog.strikes, locked: conductLog.locked } : null,
          createdAt: FieldValue().serverTimestamp(),
        }),
        db.doc(`sessions/${code}/guardlog/${ref.id}`).set({
          uid: auth.uid, groupId, personaId, pii: piiFlags(input),
          guard: { ok: verdict.ok && !conductLog, category: conductLog ? "conduct" : verdict.category, reason: verdict.reason, how: out.how || null, original: out.replaced && reply ? reply : null, trimmed: !!out.trimmed },
          conduct: conductLog,
          createdAt: FieldValue().serverTimestamp(),
        }),
        Object.keys(bump).length ? groupRef.update(bump) : null,
        memberRef.update(memberUpd),
        ...writes,
      ]);
      return { logId: ref.id, result: out.text, conduct: conductLog };
    }

    // ---- 3~5단계: 모둠 로그 ----
    let messages, input, output, result, logPayload = {};
    let model = baseModel;
    if (s === 2) {
      // 생각 도우미: 학생이 쓴 연결(또는 모둠의 원인 추측)을 보고 질문 하나만 한다
      if (sessData.coach === false) throw new HttpsError("failed-precondition", "선생님이 이 수업에서 생각 도우미를 껐어요.");
      const focus = payload.focus;
      if (focus === "link") {
        const l = toList(work.s2.links).find((x) => x.id === payload.linkId);
        if ((l.by || l.uid) !== auth.uid) throw new HttpsError("permission-denied", "내가 쓴 생각만 생각 도우미에게 보여 줄 수 있어요.");
        const me = personas.find((p) => p.id === personaId);
        input = [`학생이 만난 인물: ${me ? `${me.name} (${me.role})` : "(모름)"}`,
          `대화 전 처음 생각: ${clip(l.prior, 300) || "(없음)"}`, `대화하며 흔들린 순간: ${clip(l.surprise, 300) || "(없음)"}`,
          `그 생각은 어디서 왔을까: ${clip(l.source, 400) || "(없음)"}`, `내 생활의 장면${l.angle ? `(${clip(l.angle, 40)})` : ""}: ${clip(l.scene, 400) || "(없음)"}`,
          `그래서 생긴 질문: ${clip(l.question, 300) || "(없음)"}`].join("\n");
      } else {
        input = "모둠이 쓴 원인 추측:\n" + toList(work.s2.causes).slice(0, 12).map((q) => `- ${q.level ? `[${clip(q.level, 20)}] ` : ""}${clip(q.text, 200)}`).join("\n");
      }
      messages = [{ role: "system", content: prompts.coachPrompt(evCtx, focus) }, { role: "user", content: input }];
      output = await callModel({ apiKey, model, messages, json: true, maxTokens: 400, efforts: ["low"] });
      let v;
      try { v = extractJson(output); } catch { throw new HttpsError("internal", "생각 도우미의 답을 읽지 못했어요. 다시 시도하세요."); }
      const kinds = Object.keys(prompts.COACH_KINDS[focus]);
      result = { kind: kinds.includes(v.kind) ? v.kind : "", question: clip(v.question, 300) };
      if (!result.question) throw new HttpsError("internal", "생각 도우미의 답이 비어 있어요. 다시 시도하세요.");
      output = JSON.stringify(result);
      logPayload = { focus, ...(focus === "link" ? { linkId: payload.linkId } : {}), kind: result.kind };
    } else if (s === 3) {
      const c = toList(work.s2.checks).find((x) => x.id === payload.checkId);
      const cause = c.causeId ? toList(work.s2?.causes).find((x) => x.id === c.causeId) : null;
      input = (cause ? `학생들이 확인하려는 원인 가설: ${clip(cause.text, 300)}\n확인할 말: ${clip(c.heard, 300) || "(적지 않음)"}` : `학생들이 인터뷰에서 들은 말: ${clip(c.heard, 300) || "(적지 않음)"}`) +
        `\n검증 질문: ${clip(c.question, 300)}` +
        (c.srcType ? `\n학생들이 확인하려는 자료 종류: ${clip(c.srcType, 40)}` : "");
      // 모델의 기억이 아니라 수업 자료와 웹 검색 결과를 근거로 답하게 한다
      const [mats, found] = await Promise.all([
        studentMaterials(code, ev.id).then((cats) => materialsText(cats)),
        searchOn ? search(clip(c.question, 200)) : Promise.resolve(null),
      ]);
      messages = [{ role: "system", content: prompts.verifyPrompt(evCtx, { materials: mats, search: found }) }, { role: "user", content: input }];
      output = await callModel({ apiKey, model, messages, maxTokens: 900, efforts: [effort] });
      result = output;
      logPayload = { checkId: c.id, searched: !!found, ...(found?.found ? { sources: found.sources } : {}) };
    } else if (s === 4) {
      const p = toList(work.s4.proposals).find((x) => x.id === payload.proposalId);
      input = clip(p.text, 1500);
      const extra = [p.cause && `이 대안이 겨냥하는 원인: ${clip(p.cause, 300)}`, p.ref && `참고한 사례: ${clip(p.ref, 300)}`].filter(Boolean).join("\n");
      const models = FEEDBACK_MODELS.value().split(",").map((m) => m.trim()).filter(Boolean);
      const lenses = Object.keys(REVIEW_LABELS);
      // 서로 다른 관점의 독립 검토 3개. AI의 판단이 하나의 권위가 되지 않도록 학생이 비교하게 한다.
      const settled = await Promise.allSettled(
        lenses.map((lens, i) => {
          const m = models.length ? models[i % models.length] : baseModel;
          return callModel({
            apiKey, model: m, maxTokens: 500, efforts: [effort],
            messages: [{ role: "system", content: prompts.feedbackPrompt(evCtx, lens) }, { role: "user", content: `우리 모둠의 대안:\n${input}${extra ? `\n${extra}` : ""}` }],
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
      const p = { id: payload.proposalId, text: clip(proposalText(work, payload.proposalId), 1500) };
      const preds = toList(work.s5.predictions).slice(0, 12).map((x) => `- ${clip(x.stakeholder, 40) || "이해관계자"}: ${clip(x.text, 300)}`).join("\n");
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
      s === 2 ? null : memberRef.update({ aiCount: FieldValue().increment(1) }),
    ]);
    return { logId: logRef.id, result };
  } catch (e) {
    await refund(); // 실패한 호출은 사용 횟수에서 뺀다
    if (e instanceof HttpsError) throw e;
    console.error(`aiRequest 실패 stage=${s}:`, e.message);
    // 교사 화면에서 원인을 볼 수 있도록 모둠 문서에 남긴다
    await groupRef.update({ lastAiError: { stage: s, message: String(e.message).slice(0, 300), at: FieldValue().serverTimestamp() } }).catch(() => {});
    throw new HttpsError("unavailable", "AI 응답을 받지 못했습니다. 잠시 후 다시 시도하세요.");
  }
});

// ---------- 정기 작업 ----------
// 마지막 접속 후 정한 시간이 지난 수업을 자동으로 닫는다(수업이 끝나고 누가 접속하는 것을 막기 위해). 30분마다.
exports.autoCloseSessions = onSchedule({ region: REGION, schedule: "every 30 minutes", timeZone: "Asia/Seoul", cpu: "gcf_gen1", maxInstances: 1 }, async () => {
  const open = await db.collection("sessions").where("closed", "==", false).get();
  for (const d of open.docs) {
    if (!(d.data().autoCloseHours > 0)) continue;
    const members = (await db.collection(`sessions/${d.id}/members`).get()).docs.map((m) => m.data());
    if (autoCloseDue(d.data(), members)) await d.ref.update({ closed: true, closedAuto: true });
  }
});

// 학생이 로그아웃·재입장하며 쌓인 익명 계정 중 30일 넘게 쓰지 않은 것을 지운다(교사의 구글 계정은 건드리지 않는다). 매주 일요일 새벽.
exports.cleanAnonymousUsers = onSchedule({ region: REGION, schedule: "every sunday 04:00", timeZone: "Asia/Seoul", cpu: "gcf_gen1", maxInstances: 1 }, async () => {
  let token, removed = 0;
  do {
    const page = await admin.auth().listUsers(1000, token);
    const uids = staleAnonymousUids(page.users);
    if (uids.length) { await admin.auth().deleteUsers(uids); removed += uids.length; }
    token = page.pageToken;
  } while (token);
  console.log(`오래된 익명 계정 ${removed}개 삭제`);
});

// 교사: 대화 규칙 위반으로 멈춘 학생의 대화를 다시 연다(경고 횟수 초기화, 누적 기록은 유지)
exports.unlockChat = onCall(opts, async (req) => {
  const { code } = await ownSession(req);
  const uid = String(req.data?.uid || "");
  const ref = db.doc(`sessions/${code}/members/${uid}`);
  const m = await ref.get();
  if (!m.exists) throw new HttpsError("not-found", "학생을 찾을 수 없습니다.");
  await ref.update({ chatLocked: false, conduct: { ...(m.data().conduct || {}), strikes: 0, lastAt: m.data().conduct?.lastAt || null } });
  return { ok: true };
});
