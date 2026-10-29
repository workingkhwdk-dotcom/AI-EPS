const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { defineSecret, defineString, defineInt } = require("firebase-functions/params");
const admin = require("firebase-admin");
const crypto = require("crypto");

const {
  EVENTS, DEFAULT_EVENT, availablePersonas, personaSourceIds, toPublicSource, materialsFor, materialsAdmin,
  casesFor, casesAdmin, aftermathFor, aftermathAdmin, isRequired, makeBundle, BUNDLES,
} = require("./case");
const { checkGate, toList, proposalText } = require("./policy");
const conduct = require("./conduct");
const { isPersonal } = require("./charter");
const prompts = require("./prompts");
const { chat, extractJson, respondCited, respondTools } = require("./openai");
const { guardMessages, parseVerdict, resolveOutput, piiFlags } = require("./guard");
const { isTeacherEmail, trustedLogin } = require("./teachers");
const { validatePassword, hashPassword, verifyPassword, normNick, credKey, lockedSeconds, afterFail, afterTotalFail } = require("./password");
const { defaultMaterials, sanitizeMaterials, toStudentMaterials, materialsText } = require("./materials");
const { chatWithLookup, webSearch, isSmallTalk, lookupTool } = require("./lookup");
const { sanitizeOverride, applyOverride } = require("./personaEdit");
const demo = require("./demo");
const { makeTopicApi } = require("./topicApi");
const { fromStored } = require("./topicData");
const { onSchedule } = require("firebase-functions/v2/scheduler");
const { AUTO_CLOSE_CHOICES, autoCloseDue, staleAnonymousUids } = require("./maintenance");
const { LEVELS, LENSES_BY, levelOf, defaultDeep, deepOf, sanitizeDeep } = require("./level");

admin.initializeApp();
const db = admin.firestore();

const OPENAI_API_KEY = defineSecret("OPENAI_API_KEY");
// 기본 모델과 용도별 모델. 비워 두면 OPENAI_MODEL 을 쓴다. 기본값은 비용과 성능의 균형을 맞춘 조합이다(2026-10, GPT-5.6 계열).
//  - 학생이 가장 많이 쓰는 인물 대화·감독자: 균형 모델(terra). 감독자는 안전장치라 저가 모델로 낮추지 않는다.
//  - 양이 많고 비교적 단순한 보조(2단계 생각 도우미, 3단계 사실 확인, 4단계 검토, 웹 검색 요약, 체험): 저가 모델(luna)
//  - 추론이 필요한 5단계 시뮬레이션: terra. 가끔 쓰고 여러 수업에 오래 쓰이는 교사 주제 만들기: 최상위 모델(sol)
// functions/.env 의 값이 이 기본값보다 먼저다. 다만 지원이 끝나는 처음 GPT-5(gpt-5·gpt-5-mini·gpt-5-nano 와 날짜 붙은 스냅샷,
// 2026-12-11 API 종료)가 .env 에 남아 있으면 그 자리의 기본 모델로 바꿔 쓴다. 그래서 .env 를 고치지 않고 배포해도 새 모델로 돈다.
const RETIRED_MODEL = /^gpt-5(-mini|-nano)?(-\d{4}-\d{2}-\d{2})?$/;
const notRetired = (v, fallback) => (RETIRED_MODEL.test(String(v || "").trim()) ? fallback : String(v || "").trim());
const modelParam = (name, def) => { const p = defineString(name, { default: def }); return { value: () => notRetired(p.value(), def) }; };
// 이 기능 뒤에 생긴 설정은 Firebase 설정값(defineString)이 아니라 환경 변수로 읽는다. .env 에 줄이 없어도 배포 때 값을 묻지 않고 기본값을 쓴다.
const envParam = (name, def) => ({ value: () => String(process.env[name] ?? "").trim() || def });
const OPENAI_MODEL = modelParam("OPENAI_MODEL", "gpt-5.6-luna");
const PERSONA_MODEL = modelParam("PERSONA_MODEL", "gpt-5.6-terra"); // 1단계 인물 대화 전용
const SCENARIO_MODEL = modelParam("SCENARIO_MODEL", "gpt-5.6-terra"); // 5단계 시뮬레이션 전용
const GUARD_MODEL = modelParam("GUARD_MODEL", "gpt-5.6-terra"); // 상위 AI(규범 감독) 전용
// 4단계 독립 검토에 쓸 모델들(쉼표). 비우면 OPENAI_MODEL 로 3회. 지원이 끝난 이름은 빼고 OPENAI_MODEL 로 채운다.
const FEEDBACK_MODELS_RAW = defineString("FEEDBACK_MODELS", { default: "" });
const FEEDBACK_MODELS = { value: () => FEEDBACK_MODELS_RAW.value().split(",").map((m) => m.trim()).filter(Boolean).map((m) => notRetired(m, OPENAI_MODEL.value())).join(",") };
const REASONING_EFFORT = defineString("REASONING_EFFORT", { default: "low" }); // 추론 모델의 사고량: minimal(가장 가벼움)|low|medium|high. 모델에 맞는 값으로는 openai.js 가 바꾼다
const PERSONA_WEB_SEARCH = defineString("PERSONA_WEB_SEARCH", { default: "true" }); // 인물이 모르는 사실은 웹에서 찾아 본다(false 로 끄기)
// 웹 검색을 허용할 도메인(쉼표). 비우면 제한 없음. 예: yna.co.kr,hani.co.kr,moj.go.kr,unhcr.org
const SEARCH_ALLOWED_DOMAINS = defineString("SEARCH_ALLOWED_DOMAINS", { default: "" });
const SEARCH_MODEL = modelParam("SEARCH_MODEL", ""); // 웹 검색 호출 전용 모델(비우면 OPENAI_MODEL)
// 체험(demo) 페이지의 AI: 모델(비우면 OPENAI_MODEL)과 하루 전체 호출 한도(비용 보호)
const DEMO_MODEL = modelParam("DEMO_MODEL", "");
const DEMO_DAILY_CAP = defineInt("DEMO_DAILY_CAP", { default: 300 });
// 교사 주제 만들기(topics): 생성 모델, 웹 조사 모델(인용 링크가 문장에 정확히 붙어야 해서 저가 모델은 피한다), 교사 한 명이 하루에 새로 만들 수 있는 주제 수
const TOPIC_MODEL = { value: () => notRetired(envParam("TOPIC_MODEL", "gpt-5.6-sol").value(), "gpt-5.6-sol") };
const TOPIC_SEARCH_MODEL = { value: () => notRetired(envParam("TOPIC_SEARCH_MODEL", "gpt-5.6-terra").value(), "gpt-5.6-terra") };
// 새 주제 만들기(AI 조사·생성) 스위치. 비용이 커서 잠시 꺼 둔다: 기본값 false. 이미 만든 주제를 보고 고치고 수업에 쓰는 것은 그대로 된다.
// 다시 열려면 functions/.env 에 TOPIC_BUILDER_ENABLED=true 를 쓰고 배포한다.
const TOPIC_BUILDER_ENABLED = { value: () => envParam("TOPIC_BUILDER_ENABLED", "false").value() };
const TOPIC_DAILY_LIMIT = { value: () => Math.max(1, parseInt(envParam("TOPIC_DAILY_LIMIT", "3").value(), 10) || 3) };
const TEACHER_EMAILS = defineString("TEACHER_EMAILS", { default: "" });
// 교사 가입 인증 문구. 코드·저장소에는 두지 않고 functions/.env(git 에 올라가지 않음)의 TEACHER_SIGNUP_CODE 로만 정한다.
// 비어 있으면 교사 가입이 꺼진다(관리자·TEACHER_EMAILS·config/teachers 로만 교사 지정).
const TEACHER_SIGNUP_CODE = defineString("TEACHER_SIGNUP_CODE", { default: "" });
// 학생에게는 출처 원문 대조(verified)를 마친 인물·자료만 나간다. 예전의 리허설 설정(ALLOW_UNVERIFIED_PERSONAS)은 없앴다.
// 수업 전에 미리 해 보려면 체험(demo) 페이지를 쓴다. .env 에 그 줄이 남아 있어도 읽지 않는다.

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
// 교사 점검용 연결 확인: 가끔 한 번만 부르고 짧게 기다리기만 하므로 CPU 를 적게 잡는다
const checkOpts = { ...aiOpts, cpu: "gcf_gen1", maxInstances: 1 };
// 교사 주제 만들기: 단계마다 몇 분씩 AI 응답을 기다린다(대부분 기다리는 시간이라 CPU 는 적게, 시간은 길게).
const topicOpts = { region: REGION, cors: true, cpu: "gcf_gen1", memory: "256MiB", secrets: [OPENAI_API_KEY], timeoutSeconds: 540, maxInstances: 3 };

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
// 수업 코드: 영문 대문자·숫자만 받는다(Firestore 경로에 그대로 들어가므로 '/' 같은 글자를 막는다). 맞지 않으면 빈 문자열.
const sessCode = (v) => { const c = String(v ?? "").trim().toUpperCase(); return /^[A-Z0-9]{1,20}$/.test(c) ? c : ""; };
// 기본 주제 ID(constructor 같은 객체 기본 속성 이름은 주제가 아니다)
const eventIdOk = (id) => typeof id === "string" && Object.hasOwn(EVENTS, id);
async function requireTeacher(req) {
  const auth = requireAuth(req);
  if (!(await teacherOk(auth))) throw new HttpsError("permission-denied", "교사 계정이 아닙니다.");
  return auth;
}

// 교사 + 내가 만든 수업인지 확인하고 수업 문서를 돌려준다
async function ownSession(req) {
  const auth = await requireTeacher(req);
  const code = sessCode(req.data?.code);
  const snap = code ? await db.doc(`sessions/${code}`).get() : null;
  if (!snap?.exists) throw new HttpsError("not-found", "수업을 찾을 수 없습니다.");
  if (snap.data().teacherUid !== auth.uid) throw new HttpsError("permission-denied", "내가 만든 수업이 아닙니다.");
  return { auth, code, sess: snap.data() };
}

// 수업 설정값(모둠 AI 한도, 학생별 대화 횟수, 웹 검색, 자동 닫힘)을 검사해 저장할 값으로 바꾼다. 없는 값은 건드리지 않는다.
const NOTICE_MAX = 100;
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
  // 학교급과 심화 활동(level.js). 학교급만 바꾸면 심화 활동은 그대로 둔다(교사 화면이 둘을 함께 보낸다).
  if (d?.level !== undefined) {
    if (!LEVELS.includes(d.level)) throw new HttpsError("invalid-argument", "학교급은 중학교 또는 고등학교로 정하세요.");
    out.level = d.level;
  }
  if (d?.deep !== undefined) {
    const deep = sanitizeDeep(d.deep);
    if (!deep) throw new HttpsError("invalid-argument", "심화 활동 설정이 올바르지 않습니다.");
    out.deep = deep;
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

// 수업의 주제 묶음. 기본 주제는 코드(cases/*.js)에서, 교사가 만든 주제는 수업을 만들 때 복사해 둔 사본(private/topic)에서 읽는다.
// 사본은 수업마다 따로라서, 교사가 원본 주제를 고치거나 지워도 진행 중인 수업은 그대로다. 같은 인스턴스에서는 잠깐 기억해 둔다.
const topicRef = (code) => db.doc(`sessions/${code}/private/topic`);
const topicCache = new Map();
const TOPIC_CACHE_MS = 30 * 1000;
async function bundleOf(code, sess) {
  if (!sess?.topicId) return BUNDLES[eventIdOk(sess?.eventId) ? sess.eventId : DEFAULT_EVENT];
  const hit = topicCache.get(code);
  if (hit && Date.now() - hit.t < TOPIC_CACHE_MS) return hit.b;
  const snap = await topicRef(code).get();
  if (!snap.exists) throw new HttpsError("failed-precondition", "이 수업의 주제 자료를 찾을 수 없습니다. 선생님께 문의하세요.");
  const b = makeBundle(fromStored(snap.data().bundle), { custom: true });
  topicCache.set(code, { t: Date.now(), b });
  return b;
}
const forgetTopic = (code) => topicCache.delete(code);

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
  // 교사가 만든 주제(topicId)면 그 주제의 지금 내용을 수업에 복사한다. 아니면 기본 주제(eventId).
  const topic = req.data?.topicId ? await topicApi.forClass(auth, req.data.topicId) : null;
  const eventId = topic ? topic.bundle.EVENT.id : eventIdOk(req.data?.eventId) ? req.data.eventId : DEFAULT_EVENT;
  const b = topic ? makeBundle(fromStored(topic.bundle), { custom: true }) : BUNDLES[eventId];
  if (!availablePersonas(b).length)
    throw new HttpsError("failed-precondition", topic ? "원문 확인을 마친 인물이 없습니다. 내 주제에서 출처를 확인하세요." : "원문 대조가 끝난 페르소나가 없습니다. case.js 의 출처 verified 를 확인하세요.");
  const title = String(req.data?.title || b.event.title).slice(0, 80);
  const settings = sessionSettings(req.data);
  const level = settings.level || "high";
  const code = await newCode();
  const batch = db.batch();
  if (topic) batch.set(topicRef(code), { topicId: topic.id, title: topic.title, bundle: topic.bundle, copiedAt: FieldValue().serverTimestamp() });
  batch.set(db.doc(`sessions/${code}`), {
    teacherUid: auth.uid,
    title,
    eventId,
    ...(topic ? { topicId: topic.id } : {}),
    groupCount,
    closed: false,
    started: false, // 교사가 '수업 시작'을 누르기 전까지는 대기실. 이 값이 없는 예전 수업은 시작된 것으로 본다.
    aiLimit: MAX_AI_CALLS_PER_GROUP, chatLimit: CHAT_LIMIT, webSearch: true, coach: true, autoCloseHours: 0,
    level, deep: defaultDeep(level), // 심화 활동을 따로 보내지 않으면 학교급의 기본값
    ...settings,
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
  if (work.s7?.after?.[fromUid] !== undefined) {
    upd[`work.s7.after.${toUid}`] = work.s7.after[fromUid];
    upd[`work.s7.after.${fromUid}`] = FieldValue().delete();
  }
  if (work.live?.[fromUid] !== undefined) upd[`work.live.${fromUid}`] = FieldValue().delete();
  for (const [pid, pk] of Object.entries(grp.picks || {})) if (pk?.uid === fromUid) upd[`picks.${pid}.uid`] = toUid;
  upd[`names.${fromUid}`] = FieldValue().delete(); // 모둠원 별명 목록(대기실에 보인다)은 입장 처리에서 새 uid 로 다시 적는다
  await groupRef.update(upd);
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
  const code = sessCode(req.data?.code);
  const groupNo = parseInt(req.data?.groupNo, 10);
  const nickname = String(req.data?.nickname || "").trim().slice(0, 12);
  const password = String(req.data?.password ?? "");
  if (!nickname) throw new HttpsError("invalid-argument", "별명을 입력하세요. (이름 대신 별명을 쓰세요)");
  const pwErr = validatePassword(password);
  if (pwErr) throw new HttpsError("invalid-argument", pwErr);
  if (!code) throw new HttpsError("not-found", "수업 코드를 찾을 수 없습니다.");
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
  const b = await bundleOf(code, sess);
  if (!availablePersonas(b).length) throw new HttpsError("failed-precondition", "아직 사용할 수 있는 인물이 없습니다. 선생님께 문의하세요.");
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
      tx.update(groupRef, { [`names.${auth.uid}`]: nickname });
      if (curPid) {
        if (!a.exists) tx.set(assignRef, { groupId, personaId: curPid });
        if (!g.data()?.picks?.[curPid]) tx.update(groupRef, { [`picks.${curPid}`]: { uid: auth.uid, nick: nickname } });
      }
      if (!ag.exists && g.data()?.personaIds) { tx.set(agRef, { personaIds: g.data().personaIds }); tx.update(groupRef, { personaIds: FieldValue().delete() }); }
      return;
    }
    // names: 모둠원 별명 목록. 모둠원이 읽을 수 있는 모둠 문서에 두어 대기실에서 누가 들어왔는지 보여 준다(인물 정보는 없다).
    tx.update(groupRef, { memberCount: (g.data()?.memberCount || 0) + 1, [`names.${auth.uid}`]: nickname });
    tx.set(memberRef, {
      groupId, nickname, credKey: key,
      stage: 1, aiCount: 0, chatCount: 0, joinedAt: FieldValue().serverTimestamp(), lastSeen: FieldValue().serverTimestamp(),
    });
  });

  // 5) 비밀번호 저장(처음이면 새로 만들고, 있으면 현재 계정으로 연결만 바꾼다)과 화면에 필요한 내용 준비를 함께 한다
  const saved = hashP ? await hashP : { salt: cred.salt, hash: cred.hash };
  const [, caseData] = await Promise.all([
    credRef.set({ ...saved, uid: auth.uid, groupId, fails: 0, lockUntil: 0 }),
    studentCase(code, sess, auth.uid, undefined, b),
  ]);
  return { groupId, nickname, started: sess.started !== false, chatLimit: sess.chatLimit || CHAT_LIMIT, level: levelOf(sess), deep: deepOf(sess), case: caseData };
});

// 학생의 인물 ID: 서버 전용 배정 문서에서 읽는다(옛 방식으로 학생 문서에 있던 값도 받아 준다)
async function personaIdOf(code, uid, member) {
  const a = await db.doc(`sessions/${code}/assign/${uid}`).get();
  return a.exists ? a.data().personaId : member?.personaId;
}

// 학생 화면이 쓰는 수업 내용. 모든 인물의 편지(이름·한 줄 소개·편지)와 내가 고른 인물, 모둠원이 고른 인물을 함께 보낸다.
// 인물의 역할·근거·출처·말투는 보내지 않는다.
async function studentCase(code, sess, uid, member, bundle) {
  const b = bundle || (await bundleOf(code, sess));
  const ev = b.event;
  const gid = member?.groupId;
  const [personas, materials, a, groupSnap] = await Promise.all([
    personasFor(code, b),
    studentMaterials(code, b),
    db.doc(`sessions/${code}/assign/${uid}`).get(),
    gid ? db.doc(`sessions/${code}/groups/${gid}`).get() : Promise.resolve(null),
  ]);
  const myId = a.exists ? a.data().personaId : member?.personaId;
  const mine = personas.find((p) => p.id === myId);
  return {
    title: ev.title,
    summary: ev.summary,
    stakeholders: ev.stakeholders,
    letters: personas.map((p) => ({ id: p.id, name: p.name, brief: b.briefs[p.id] || p.label || "", letter: p.letter, required: isRequired(p), personal: isPersonal(p) })),
    me: mine ? { id: mine.id, name: mine.name, letter: mine.letter, personal: isPersonal(mine) } : null,
    ui: ev.ui,
    materials,
    cases: casesFor(b),
    aftermath: aftermathFor(b),
  };
}

// 학생: 이 모둠에서 내가 대화할 인물을 고른다. 모둠원마다 서로 다른 인물이어야 하고, 대화를 시작한 뒤에는 바꿀 수 없다.
//  - 사건마다 정한 축(제주는 난민 신청자)의 인물은 모둠에 꼭 한 명 있어야 한다. 그 인물을 맡은 학생이 다른 인물로 바꿔 모둠에서 없어지는 것은 막는다.
exports.choosePersona = onCall(fastOpts, async (req) => {
  const auth = requireAuth(req);
  const code = sessCode(req.data?.code);
  const pid = String(req.data?.personaId || "");
  if (!code) throw new HttpsError("permission-denied", "이 수업의 참여자가 아닙니다.");
  const memberRef = db.doc(`sessions/${code}/members/${auth.uid}`);
  const [sessSnap, memSnap] = await Promise.all([db.doc(`sessions/${code}`).get(), memberRef.get()]);
  if (!sessSnap.exists || !memSnap.exists) throw new HttpsError("permission-denied", "이 수업의 참여자가 아닙니다.");
  const sess = sessSnap.data();
  if (await closeIfDue(code, sess)) throw new HttpsError("failed-precondition", CLOSED_MSG);
  const b = await bundleOf(code, sess);
  const personas = await personasFor(code, b);
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
      const who = b.event.ui.requiredWho;
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
  // 선생님 한마디: 학생 화면 위쪽에 띄우는 짧은 공지. groups 를 주면 그 모둠에만, 빈 글이면 지운다.
  if (req.data?.notice !== undefined) {
    const text = String(req.data.notice?.text ?? req.data.notice ?? "").trim().slice(0, NOTICE_MAX);
    const groups = Array.isArray(req.data.notice?.groups) ? req.data.notice.groups.map(String).filter((g) => /^g\d{1,2}$/.test(g)).slice(0, MAX_GROUPS) : [];
    patch.notice = text ? { text, groups, t: Date.now() } : FieldValue().delete();
  }
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
  // 지운 한마디(FieldValue)는 응답으로 보낼 수 없으므로 null 로 돌려준다
  return { ...patch, ...(patch.notice && !patch.notice.text ? { notice: null } : {}) };
});

// ---------- 교사: 인물 항목 편집 (말투·삶의 이야기·의견·편지만) ----------
const personasRef = (code) => db.doc(`sessions/${code}/private/personas`);
const overridesOf = async (code) => { const s = await personasRef(code).get(); return s.exists ? s.data().overrides || {} : {}; };
// 이 수업에서 쓰는 인물 목록(교사가 고친 항목을 반영)
async function personasFor(code, bundle) {
  const ov = await overridesOf(code);
  return availablePersonas(bundle).map((p) => applyOverride(p, ov[p.id]));
}

exports.getPersonaOverrides = onCall(opts, async (req) => {
  const { code } = await ownSession(req);
  return { overrides: await overridesOf(code) };
});

exports.savePersonaOverride = onCall(opts, async (req) => {
  const { code, sess } = await ownSession(req);
  const pid = String(req.data?.personaId || "");
  if (!availablePersonas(await bundleOf(code, sess), true).some((p) => p.id === pid)) throw new HttpsError("not-found", "인물을 찾을 수 없습니다.");
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
  batch.update(fromG, { memberCount: FieldValue().increment(-1), [`names.${uid}`]: FieldValue().delete() });
  batch.update(toG, { memberCount: FieldValue().increment(1), [`names.${uid}`]: d.nickname });
  if (work.s1?.findings?.[uid] !== undefined) {
    batch.update(toG, { [`work.s1.findings.${uid}`]: work.s1.findings[uid] });
    batch.update(fromG, { [`work.s1.findings.${uid}`]: FieldValue().delete() });
  }
  if (work.live?.[uid] !== undefined) batch.update(fromG, { [`work.live.${uid}`]: FieldValue().delete() });
  if (oldCred.exists) { batch.set(db.doc(`sessions/${code}/creds/${newKey}`), { ...oldCred.data(), groupId: toId }); batch.delete(db.doc(`sessions/${code}/creds/${oldKey}`)); }
  await batch.commit();
  await moveAssessKey(code, oldKey, newKey).catch((e) => console.error("평가 기록 옮기기 실패:", e.message));
  return { groupId: toId };
});

// 수업 전 점검: Firestore, 각 AI 모델, 웹 검색이 실제로 되는지 짧게 시험한다(교사 전용, 비용은 아주 적음)
exports.healthCheck = onCall(checkOpts, async (req) => {
  await requireTeacher(req);
  const apiKey = OPENAI_API_KEY.value();
  const timed = async (fn) => { const t = Date.now(); try { return { ok: true, ms: Date.now() - t, ...(await fn()) }; } catch (e) { return { ok: false, ms: Date.now() - t, error: String(e.message).slice(0, 200) }; } };
  // 모델마다 어디에 쓰이는지 함께 보여 준다. 모델 이름을 바꾼 뒤 이 점검으로 모두 되는지 확인한다.
  const base = OPENAI_MODEL.value();
  const roles = new Map();
  const use = (model, role) => { if (model) roles.set(model, [...(roles.get(model) || []), role]); };
  use(base, "기본(2단계 도우미·3단계 확인·4단계 검토)");
  use(PERSONA_MODEL.value() || base, "1단계 인물 대화");
  use(GUARD_MODEL.value() || base, "감독자");
  use(SCENARIO_MODEL.value() || base, "5단계 시뮬레이션");
  FEEDBACK_MODELS.value().split(",").map((m) => m.trim()).filter(Boolean).forEach((m) => use(m, "4단계 검토"));
  use(DEMO_MODEL.value() || base, "체험 페이지");
  use(TOPIC_MODEL.value() || base, "내 주제 만들기");
  // JSON 모드로 묻는다(감독자·도우미·시뮬레이션·주제 만들기가 JSON 으로 답을 받는다). 가장 가벼운 사고량은 모델에 맞게 바뀐다(openai.js).
  const ask = (model) => timed(async () => ({ model, roles: roles.get(model), reply: JSON.stringify(extractJson(await chat({ apiKey, model, json: true, messages: [{ role: "user", content: 'JSON 으로 {"ok":true} 라고만 답해.' }], maxTokens: 40, effort: "minimal" }))).slice(0, 30) }));
  const domains = SEARCH_ALLOWED_DOMAINS.value().split(",").map((x) => x.trim()).filter(Boolean);
  const ev = EVENTS[DEFAULT_EVENT];
  const personaModel = PERSONA_MODEL.value() || base;
  const searchOff = PERSONA_WEB_SEARCH.value() === "false";
  const [firestore, models, lookup, search, topicSearch] = await Promise.all([
    timed(async () => { await db.doc("config/teachers").get(); return {}; }),
    Promise.all([...roles.keys()].map(ask)),
    // 인물의 사실 찾아보기: 인물 모델에 함수 도구(lookup)를 주고 정한 사고량으로 Responses API 를 부른다(lookup.js 와 같은 경로)
    searchOff ? { skipped: true } : timed(async () => {
      const f = lookupTool(ev).function;
      const r = await respondTools({ apiKey, model: personaModel, maxTokens: 60, effort: REASONING_EFFORT.value(), tools: [{ type: "function", name: f.name, description: f.description, parameters: f.parameters }],
        input: [{ role: "system", content: "도구는 쓰지 말고 '안녕하세요'라고만 답한다." }, { role: "user", content: "안녕하세요" }] });
      return { model: personaModel, reply: (r.text || (r.calls.length ? "(도구 호출)" : "")).slice(0, 30) };
    }),
    searchOff ? { skipped: true } : timed(async () => { const r = await webSearch({ apiKey, model: SEARCH_MODEL.value() || base, event: ev, query: ev.search.example, domains }); if (r.error) throw new Error("검색 호출 실패(모델이 web_search 를 지원하는지 확인)"); return { model: SEARCH_MODEL.value() || base, found: r.found, sources: r.sources.length }; }),
    // 주제 조사: 문장에 인용 링크가 붙어야 사실 은행에 들어간다(topicBuild.js). 인용이 붙는지 본다.
    timed(async () => {
      const model = TOPIC_SEARCH_MODEL.value() || TOPIC_MODEL.value() || base;
      const r = await respondCited({ apiKey, model, effort: "low", maxTokens: 600, input: ev.search.example,
        instructions: "웹에서 찾아 한국어로 '- [사실] 문장' 형식의 줄 2개만 쓴다. 문장마다 끝에 근거 기사를 인용한다." });
      return { model, cites: r.cites.length };
    }),
  ]);
  return {
    firestore, models, lookup, search: searchOff ? { skipped: true } : search, topicSearch,
    config: { webSearch: !searchOff, allowedDomains: domains.length, personas: availablePersonas(DEFAULT_EVENT).length },
  };
});

// 수업 복제: 이름·모둠 수·설정과 이 수업에서 고친 자료를 새 수업으로 가져온다(학생과 기록은 가져오지 않는다)
exports.cloneSession = onCall(opts, async (req) => {
  const { auth, code, sess } = await ownSession(req);
  const title = String(req.data?.title || `${sess.title} (복사)`).trim().slice(0, 80);
  const newCodeStr = await newCode();
  const batch = db.batch();
  batch.set(db.doc(`sessions/${newCodeStr}`), {
    teacherUid: auth.uid, title, eventId: sess.eventId, ...(sess.topicId ? { topicId: sess.topicId } : {}), groupCount: sess.groupCount, closed: false, started: false,
    aiLimit: sess.aiLimit || MAX_AI_CALLS_PER_GROUP, chatLimit: sess.chatLimit || CHAT_LIMIT, webSearch: sess.webSearch !== false, coach: sess.coach !== false, autoCloseHours: sess.autoCloseHours || 0,
    ...(sess.level ? { level: sess.level } : {}), ...(sess.deep ? { deep: deepOf(sess) } : {}),
    createdAt: FieldValue().serverTimestamp(),
  });
  for (let i = 1; i <= sess.groupCount; i++) batch.set(db.doc(`sessions/${newCodeStr}/groups/g${i}`), { name: `${i}모둠`, aiCount: 0, memberCount: 0, guardCount: 0, work: {} });
  const mats = await materialsRef(code).get();
  if (mats.exists) batch.set(materialsRef(newCodeStr), { categories: mats.data().categories, updatedAt: FieldValue().serverTimestamp() });
  const ovs = await personasRef(code).get();
  if (ovs.exists) batch.set(personasRef(newCodeStr), { overrides: ovs.data().overrides || {}, updatedAt: FieldValue().serverTimestamp() });
  // 교사가 만든 주제의 수업이면 주제 사본도 함께 가져간다(원본 주제를 지웠어도 복제할 수 있다)
  if (sess.topicId) {
    const t = await topicRef(code).get();
    if (t.exists) batch.set(topicRef(newCodeStr), { ...t.data(), copiedAt: FieldValue().serverTimestamp() });
  }
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
    : { categories: defaultMaterials(await bundleOf(code, sess)), isDefault: true };
});

exports.saveMaterials = onCall(opts, async (req) => {
  const { code } = await ownSession(req);
  let categories;
  try { categories = sanitizeMaterials(req.data?.categories); } catch (e) { throw new HttpsError("invalid-argument", e.message); }
  await materialsRef(code).set({ categories, updatedAt: FieldValue().serverTimestamp() });
  return { categories, isDefault: false };
});

// 학생이 보는 2단계 자료: 교사가 이 수업의 자료를 고쳤다면 그 목록, 아니면 기본 자료
async function studentMaterials(code, bundle) {
  const custom = await materialsRef(code).get();
  return custom.exists ? toStudentMaterials(custom.data().categories) : materialsFor(bundle);
}

// 이 수업만의 자료를 지우고 기본 자료로 되돌린다
exports.resetMaterials = onCall(opts, async (req) => {
  const { code, sess } = await ownSession(req);
  await materialsRef(code).delete();
  return { categories: defaultMaterials(await bundleOf(code, sess)), isDefault: true };
});

// 화면이 쓰는 수업 설정.
//  - 학생: { code } → 내 인물의 이름과 편지, 3단계 실제 자료, 4단계 해외 사례 카드, 7단계 이후 전개(사건 개요는 화면에 보이지 않지만 함께 보낸다). 인물의 역할·근거·출처는 보내지 않는다.
//  - 교사: { eventId } → 인물별 근거 진술·출처 검증 현황, 자료 전체
exports.getCase = onCall(fastOpts, async (req) => {
  const auth = requireAuth(req);

  // 교사: 기본 주제(eventId), 내가 만든 주제(topicId), 내 수업의 주제(code + admin)
  if (req.data?.eventId || req.data?.topicId || req.data?.admin) {
    let b;
    if (req.data.admin) { const { code, sess } = await ownSession(req); b = await bundleOf(code, sess); }
    else if (req.data.topicId) {
      const auth = await requireTeacher(req);
      const t = await topicApi.own(auth, req.data.topicId);
      if (!t.file?.EVENT || !(t.file.PERSONAS || []).length) throw new HttpsError("failed-precondition", "아직 다 만들지 않은 주제입니다.");
      b = makeBundle(t.file, { custom: true });
    }
    else {
      await requireTeacher(req);
      b = eventIdOk(req.data.eventId) ? BUNDLES[req.data.eventId] : null;
      if (!b) throw new HttpsError("not-found", "사건을 찾을 수 없습니다.");
    }
    return adminCase(b);
  }

  const code = sessCode(req.data?.code);
  if (!code) throw new HttpsError("permission-denied", "이 수업의 참여자가 아닙니다.");
  const [sess, mem] = await Promise.all([db.doc(`sessions/${code}`).get(), db.doc(`sessions/${code}/members/${auth.uid}`).get()]);
  if (!sess.exists || !mem.exists) throw new HttpsError("permission-denied", "이 수업의 참여자가 아닙니다.");
  if (await closeIfDue(code, sess.data())) throw new HttpsError("failed-precondition", CLOSED_MSG);
  return studentCase(code, sess.data(), auth.uid, mem.data());
});

// 교사용 주제 전체: 인물별 근거 진술·출처 검증 현황, 자료 전체
function adminCase(b) {
  const ev = b.event, src = (id) => toPublicSource(id, b);
  const full = (p) => ({
    id: p.id, axis: p.axis, label: p.label, name: p.name, role: p.role, stance: p.stance, setting: p.setting, voice: p.voice, basis: p.basis, letter: p.letter, views: p.views, story: p.story, episodes: p.episodes, inner: p.inner, habits: p.habits, limits: p.limits || [], beliefs: (p.beliefs || []).map(([text, note]) => ({ text, note })),
    sources: personaSourceIds(p).map(src),
    claims: p.claims.map(([text, s, kind]) => ({ text, src: s, kind })),
  });
  const materials = materialsAdmin(b).map((c) => ({
    ...c,
    items: c.items.map((it) => ({ ...it, verified: it.src.every((id) => src(id).verified) })),
  }));
  return {
    event: { id: ev.id, title: ev.title, summary: ev.summary, teacherNote: ev.teacherNote, axes: ev.axes, requiredAxis: ev.requiredAxis,
      background: (ev.background || []).map(([text, s, kind]) => ({ text, src: s, kind, verified: src(s).verified })) },
    personas: b.personas.filter((p) => p.events.includes(ev.id)).map(full),
    materials,
    cases: casesAdmin(b).map((c) => ({ ...c, sources: c.src.map(src) })),
    aftermath: aftermathAdmin(b).map((a) => ({ ...a, sources: a.src.map(src) })),
    custom: b.custom,
  };
}

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
const REVIEW_LABELS_MID = { feasibility: "정말 할 수 있을까", stakeholders: "사람들의 반응", sideEffects: "나중에 생길 일" };

// AI 호출의 단일 관문: 인증 → 모둠 확인 → GYR 게이트 → 횟수 한도 → OpenAI → (1단계) 상위 AI 감독 → 로그
//  - 1단계 인물 대화는 학생별 횟수(chatLimit)로, 3~5단계는 모둠 횟수(aiLimit)로 센다.
exports.aiRequest = onCall(aiOpts, async (req) => {
  const auth = requireAuth(req);
  const { stage, type, payload = {} } = req.data || {};
  const code = sessCode(req.data?.code);
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
  const bundle = await bundleOf(code, sessData);
  const ev = bundle.event;
  // 학교급과 심화 활동(level.js): 2~5단계 AI의 말 수준과 짚을 점이 달라진다
  const level = levelOf(sessData), deep = deepOf(sessData);
  const evCtx = { summary: ev.summary, premise: ev.summary, level, deep };
  const personas = await personasFor(code, bundle);
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

  const gate = checkGate({ stage: s, type, work, payload, level });
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
      // 인사·맞장구에는 검색 도구를 주지 않고 짧게 생각해 바로 답한다(첫 인사에 오래 기다리지 않게)
      const smallTalk = isSmallTalk(input);
      const useLookup = searchOn && !smallTalk;
      const messages = [{ role: "system", content: prompts.personaPrompt(ev, persona, { lookup: useLookup, level, subtle: deep.beliefs }) }];
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
        if (useLookup) {
          const r = await chatWithLookup({ apiKey, model: personaModel, event: ev, messages, maxTokens: 600, effort, search });
          reply = r.content; lookups = r.lookups;
          if (!String(reply).trim()) throw new Error("인물 응답이 비어 있음");
        } else {
          reply = await callModel({ apiKey, model: personaModel, messages, maxTokens: smallTalk ? 300 : 600, efforts: smallTalk ? ["minimal", effort] : [effort] });
        }

        // 상위 AI(규범 감독자): 학생에게 보내기 전에 검사. 가벼운 위반은 고쳐 쓰고, 무거운 위반·검사 실패는 안내로 대체.
        // 학생 메시지의 태도(conduct)도 함께 판정한다.
        try {
          const verdictText = await callModel({
            apiKey, model: GUARD_MODEL.value() || baseModel, json: true, maxTokens: 900, efforts: smallTalk ? ["minimal", "low"] : ["low"],
            messages: guardMessages({ event: ev, persona, claims: persona.claims, history: past.slice(-3), studentMessage: input, reply, lookups, level }),
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
        const causes = toList(work.s2.causes).slice(0, 12);
        input = "모둠이 쓴 원인 추측:\n" + causes.map((q) => `- ${q.level ? `[${clip(q.level, 20)}] ` : ""}${clip(q.text, 200)}`).join("\n");
        // 원인 잇기(심화): 모둠이 이은 원인끼리의 관계도 보여 준다
        if (deep.causeMap) {
          const textOf = (id) => clip(causes.find((q) => q.id === id)?.text, 80);
          const links = toList(work.s2?.causeLinks).filter((l) => textOf(l.from) && textOf(l.to)).slice(0, 12);
          input += "\n모둠이 이은 원인 관계:\n" + (links.map((l) => `- ${textOf(l.from)} → ${clip(l.rel, 20) || "이어짐"} → ${textOf(l.to)}`).join("\n") || "- (아직 잇지 않음)");
        }
      }
      messages = [{ role: "system", content: prompts.coachPrompt(evCtx, focus) }, { role: "user", content: input }];
      output = await callModel({ apiKey, model, messages, json: true, maxTokens: 400, efforts: ["low"] });
      let v;
      try { v = extractJson(output); } catch { throw new HttpsError("internal", "생각 도우미의 답을 읽지 못했어요. 다시 시도하세요."); }
      const kinds = Object.keys(prompts.coachKinds(focus, { level, causeMap: deep.causeMap }));
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
        studentMaterials(code, bundle).then((cats) => materialsText(cats)),
        searchOn ? search(clip(c.question, 200)) : Promise.resolve(null),
      ]);
      messages = [{ role: "system", content: prompts.verifyPrompt(evCtx, { materials: mats, search: found }) }, { role: "user", content: input }];
      output = await callModel({ apiKey, model, messages, maxTokens: 900, efforts: [effort] });
      result = output;
      logPayload = { checkId: c.id, searched: !!found, ...(found?.found ? { sources: found.sources } : {}) };
    } else if (s === 4) {
      const p = toList(work.s4.proposals).find((x) => x.id === payload.proposalId);
      input = clip(p.text, 1500);
      const extra = [p.cause && `이 대안이 겨냥하는 원인: ${clip(p.cause, 300)}`, p.ref && `참고한 사례: ${clip(p.ref, 300)}`, p.transfer && `그 사례와 우리 사건의 다른 점(모둠이 쓴 것): ${clip(p.transfer, 300)}`].filter(Boolean).join("\n");
      const models = FEEDBACK_MODELS.value().split(",").map((m) => m.trim()).filter(Boolean);
      const lenses = LENSES_BY[level];
      // 서로 다른 관점의 독립 검토(고등학교 3개, 중학교 2개). AI의 판단이 하나의 권위가 되지 않도록 학생이 비교하게 한다.
      const settled = await Promise.allSettled(
        lenses.map((lens, i) => {
          const m = models.length ? models[i % models.length] : baseModel;
          return callModel({
            apiKey, model: m, maxTokens: 500, efforts: [effort],
            messages: [{ role: "system", content: prompts.feedbackPrompt(evCtx, lens) }, { role: "user", content: `우리 모둠의 대안:\n${input}${extra ? `\n${extra}` : ""}` }],
          }).then((text) => ({ lens, label: (level === "middle" ? REVIEW_LABELS_MID : REVIEW_LABELS)[lens], text, model: m }));
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

// ---------- 교사 주제 만들기 ----------
// AI 연결: 웹 조사(인용 위치 포함)와 JSON 답. JSON 을 읽지 못하면 한 번 더 묻는다.
const topicAi = {
  search: ({ instructions, input, maxTokens }) => respondCited({
    apiKey: OPENAI_API_KEY.value(), model: TOPIC_SEARCH_MODEL.value() || TOPIC_MODEL.value() || OPENAI_MODEL.value(), instructions, input, maxTokens, effort: "low",
  }),
  json: async ({ messages, maxTokens, effort = "medium" }) => {
    let last;
    for (let i = 0; i < 2; i++) {
      try {
        return extractJson(await callModel({ apiKey: OPENAI_API_KEY.value(), model: TOPIC_MODEL.value() || OPENAI_MODEL.value(), messages, json: true, maxTokens, efforts: [effort] }));
      } catch (e) { last = e; }
    }
    throw last;
  },
};
const topicApi = makeTopicApi({
  db, FieldValue, HttpsError, requireTeacher, ai: topicAi,
  dailyLimit: () => TOPIC_DAILY_LIMIT.value(), onSessionTopic: forgetTopic,
  builderOpen: () => TOPIC_BUILDER_ENABLED.value() === "true",
});
exports.topics = onCall(topicOpts, (req) => topicApi.handle(req));

// ---------- 체험(demo) 페이지의 AI ----------
// 로그인 없이 누구나 부를 수 있어서 비용을 지키는 장치가 여러 겹이다: 기기·주제마다 횟수(인물 5번, 도우미 5번), 하루 전체 한도(DEMO_DAILY_CAP),
// 저렴한 모델(DEMO_MODEL), 웹 검색 없음, OpenAI 키 쪽의 사용 한도. 서버에는 아무 글도 저장하지 않고 횟수만 센다(demoUsage, 서버만 읽고 쓴다).
// 실패하면 화면이 준비된 답으로 대신하므로, 횟수는 실패한 호출만큼 돌려준다.
const demoCodes = { "invalid-argument": "invalid-argument", internal: "internal" };
exports.demoRequest = onCall({ ...aiOpts, maxInstances: 2 }, async (req) => {
  let d;
  try { d = demo.parse(req.data); } catch (e) { throw new HttpsError(demoCodes[e.code] || "invalid-argument", e.message); }
  const field = `${d.topic}_${d.kind}`, limit = demo.LIMITS[d.kind];
  const day = new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10); // 한국 날짜(UTC 로 세면 오전 9시에 바뀐다)
  const mineRef = db.doc(`demoUsage/${d.deviceId}`), dayRef = db.doc(`demoUsage/day-${day}`);
  await db.runTransaction(async (tx) => {
    const [mine, today] = await Promise.all([tx.get(mineRef), tx.get(dayRef)]);
    if ((mine.data()?.[field] || 0) >= limit)
      throw new HttpsError("resource-exhausted", `체험에서는 ${d.kind === "chat" ? "인물에게 묻기를" : "AI 도우미를"} 이 주제에서 ${limit}번까지 쓸 수 있어요. 이제 준비된 예시 답으로 보여 드려요.`);
    if ((today.data()?.n || 0) >= DEMO_DAILY_CAP.value())
      throw new HttpsError("resource-exhausted", "오늘 체험용 AI 사용량이 모두 찼어요. 준비된 예시 답으로 보여 드려요.");
    tx.set(mineRef, { [field]: FieldValue().increment(1), updatedAt: FieldValue().serverTimestamp() }, { merge: true });
    tx.set(dayRef, { n: FieldValue().increment(1) }, { merge: true });
  });
  const refund = () => Promise.all([mineRef.set({ [field]: FieldValue().increment(-1) }, { merge: true }), dayRef.set({ n: FieldValue().increment(-1) }, { merge: true })]).catch(() => {});
  const apiKey = OPENAI_API_KEY.value(), model = DEMO_MODEL.value() || OPENAI_MODEL.value(), effort = REASONING_EFFORT.value();
  try {
    const out = await demo.run(d, { effort, call: (o) => callModel({ apiKey, model, messages: o.messages, json: o.json, maxTokens: o.maxTokens, efforts: o.efforts }) });
    if (out.refunded) await refund();
    return out;
  } catch (e) {
    await refund();
    if (e instanceof demo.DemoError) throw new HttpsError(demoCodes[e.code] || "internal", e.message);
    console.error(`demoRequest 실패 kind=${d.kind} stage=${d.stage}:`, e.message);
    throw new HttpsError("unavailable", "AI 응답을 받지 못했어요.");
  }
});

// ---------- 수행평가: 교사 채점, AI 제2평정자, 세특 초안, 학생 결과 공개 ----------
// 점수·평가 근거·AI 제안·세특은 모두 sessions/{code}/assess/{g1 | s_<별명 열쇠>} 에 서버만 쓰고 읽는다(규칙으로 학생·클라이언트 접근 막음).
// 학생은 myResult 로만 본다. 공개 여부(sessions/{code}.release.score·seteuk)는 서로 독립이고, 읽을 때마다 서버가 걸러 준다.
// 학생 열쇠는 uid 가 아니라 별명 열쇠(credKey)다: 로그아웃 후 다시 들어와 uid 가 바뀌어도 같은 학생으로 이어진다.
const A = require("./assess");
const { rubricFor, totals } = require("./rubric");
// 비용과 성능을 나누는 하이브리드: 대부분은 빠른(저가) 모델이 하고, 어려운 곳만 고성능 모델이 맡는다.
//  - 채점 제안: 정확도가 중요해 빠른 모델이 같은 근거를 3번 채점하고, 3번이 갈리거나 인용문을 못 찾은 기준만 고성능 모델이 한 번 더 판정한다(그 판정이 최종 AI 제안)
//  - 세특: 수준 판정은 빠른 모델(OPENAI_MODEL), 첫 초안은 고성능, 분량 보정 반복은 빠른 모델. 보정이 구조를 깨거나 3번 넘게 걸리면 고성능으로 올린다
const ASSESS_FAST_MODEL = modelParam("ASSESS_FAST_MODEL", "gpt-5.6-luna"); // 채점 제안(제2평정자) 3번 채점
const ASSESS_MODEL = modelParam("ASSESS_MODEL", "gpt-5.6-terra"); // 갈리거나 인용을 못 찾은 기준의 고성능 재판정
const SETEUK_MODEL = modelParam("SETEUK_MODEL", "gpt-5.6-terra"); // 세특 첫 초안과 올려 쓴 보정
const SETEUK_FIX_MODEL = modelParam("SETEUK_FIX_MODEL", "gpt-5.6-luna"); // 세특 분량 보정(압축·보강)
const ASSESS_RUNS = 3; // 같은 근거를 AI가 몇 번 채점해 가운데 값과 흔들림을 구하는지
const ASSESS_AI_CAP = 1500; // 수업 하나에서 평가용 AI 호출 한도(비용 보호)
const assessAiOpts = { ...aiOpts, cpu: "gcf_gen1", maxInstances: 2 };

const assessRef = (code, key) => db.doc(`sessions/${code}/assess/${key}`);
const subjKey = (kind, id) => (kind === "group" ? id : `s_${id}`);
const studentKeyOf = (m) => m.credKey || credKey(parseInt(String(m.groupId).slice(1), 10), m.nickname);
const blindCode = (key) => `S-${crypto.createHash("sha1").update(String(key)).digest("hex").slice(0, 4).toUpperCase()}`;
const rubricOfSession = (sess) => rubricFor(levelOf(sess), deepOf(sess));

async function patchAssess(ref, patch) {
  if (!(await ref.get()).exists) await ref.set({});
  await ref.update(patch);
}

// 모둠을 옮겨 별명 열쇠가 바뀌면 평가 기록도 새 열쇠로 옮긴다
async function moveAssessKey(code, oldKey, newKey) {
  if (oldKey === newKey) return;
  const from = assessRef(code, `s_${oldKey}`), snap = await from.get();
  if (!snap.exists) return;
  await assessRef(code, `s_${newKey}`).set(snap.data());
  await from.delete();
}

async function membersOf(code) {
  const snap = await db.collection(`sessions/${code}/members`).get();
  return snap.docs.map((d) => { const m = d.data(); return { uid: d.id, nick: m.nickname, groupId: m.groupId, key: studentKeyOf(m), chatCount: m.chatCount || 0, coachCount: m.coachCount || 0 }; });
}

// 대상(모둠 또는 학생)의 근거를 기준마다 모은다
async function loadEvidence(code, sess, kind, id, members) {
  const rubric = rubricOfSession(sess), deep = deepOf(sess);
  let gid = id, stu = null;
  if (kind === "student") {
    stu = members.find((m) => m.key === id);
    if (!stu) throw new HttpsError("not-found", "학생을 찾을 수 없습니다.");
    gid = stu.groupId;
  } else if (!/^g\d{1,2}$/.test(id) || parseInt(id.slice(1), 10) > sess.groupCount) throw new HttpsError("invalid-argument", "모둠이 올바르지 않습니다.");
  const grp = (await db.doc(`sessions/${code}/groups/${gid}`).get()).data() || {};
  const logs3 = (await db.collection(`sessions/${code}/groups/${gid}/logs`).where("stage", "==", 3).get()).docs.map((d) => ({ id: d.id, ...d.data() }));
  const ctx = { work: grp.work || {}, logs3, deep, groupAi: grp.aiCount || 0, members: members.filter((m) => m.groupId === gid) };
  if (stu) {
    const chat = (await db.collection(`sessions/${code}/members/${stu.uid}/chat`).orderBy("createdAt").limit(30).get()).docs.map((d) => d.data());
    ctx.student = { uid: stu.uid, nick: stu.nick, chat, chatCount: stu.chatCount, coachCount: stu.coachCount };
  }
  const scope = kind === "student" ? "student" : "group";
  const evidence = {}, empty = {};
  for (const c of rubric.criteria.filter((x) => x.scope === scope)) {
    evidence[c.id] = A.evidenceFor(c.id, ctx);
    empty[c.id] = A.evidenceEmpty(evidence[c.id]);
  }
  return { rubric, evidence, empty, ctx, gid };
}

const subjectArgs = (req, sess, members) => {
  const kind = req.data?.kind === "student" ? "student" : req.data?.kind === "group" ? "group" : "";
  const id = String(req.data?.id ?? "");
  if (!kind || !id) throw new HttpsError("invalid-argument", "평가할 대상을 고르세요.");
  if (kind === "student" && !members.some((m) => m.key === id)) throw new HttpsError("not-found", "학생을 찾을 수 없습니다.");
  return { kind, id, key: subjKey(kind, id) };
};

// AI 제안은 교사가 그 기준의 수준을 저장한 뒤에만 내보낸다(독립 채점)
const aiRevealed = (doc) => Object.fromEntries(Object.entries(doc.ai || {}).filter(([cid]) => doc.scores?.[cid]));
// 교사 점수가 AI 제안과 두 수준 이상 다른데 평가 근거가 짧으면 '확인 필요'
function reviewFlags(rubric, doc) {
  const out = {};
  for (const c of rubric.criteria) {
    const t = doc.scores?.[c.id], a = doc.ai?.[c.id];
    if (!t || !a || !Number.isInteger(a.level)) continue;
    const n = c.levels.length;
    if (Math.abs(A.rankOf(t.level, n) - A.rankOf(a.level, n)) >= 2 && A.clip(t.note, 500).length < A.NOTE_MIN) out[c.id] = "dev";
  }
  return out;
}

// 채점 방식: ai_first(기본) — AI가 먼저 채점하고 교사가 검토·수정한다. independent — 교사가 먼저 채점하고 그 뒤에 AI 제안을 본다(독립 채점, 신뢰도 연구용).
const modeOf = (sess) => (sess.assessMode === "independent" ? "independent" : "ai_first");
const scopeOf = (kind) => (kind === "student" ? "student" : "group");
function releaseOf(sess) { return { score: sess.release?.score === true, seteuk: sess.release?.seteuk === true }; }

exports.assess = onCall(opts, async (req) => {
  const { auth, code, sess } = await ownSession(req);
  const action = String(req.data?.action || "");
  const rubric = rubricOfSession(sess);

  if (action === "get") {
    const members = await membersOf(code);
    const docs = Object.fromEntries((await db.collection(`sessions/${code}/assess`).get()).docs.map((d) => [d.id, d.data()]));
    const cnt = (doc, scope) => rubric.criteria.filter((c) => c.scope === scope && doc?.scores?.[c.id]).length;
    const cntAi = (doc, scope) => rubric.criteria.filter((c) => c.scope === scope && c.ai && doc?.ai?.[c.id]).length;
    const cntUnrev = (doc) => Object.values(doc?.scores || {}).filter((x) => x.src === "ai" && x.reviewed === false).length;
    const nG = rubric.criteria.filter((c) => c.scope === "group").length, nS = rubric.criteria.filter((c) => c.scope === "student").length;
    const groups = Array.from({ length: sess.groupCount }, (_, i) => `g${i + 1}`).map((id) => ({ id, name: `${id.slice(1)}모둠`, members: members.filter((m) => m.groupId === id).length, scored: cnt(docs[id], "group"), total: nG, ai: cntAi(docs[id], "group"), unreviewed: cntUnrev(docs[id]) }));
    const students = members.map((m) => ({ key: m.key, nick: m.nick, code: blindCode(m.key), groupId: m.groupId, scored: cnt(docs[`s_${m.key}`], "student"), total: nS, ai: cntAi(docs[`s_${m.key}`], "student"), unreviewed: cntUnrev(docs[`s_${m.key}`]), hasSeteuk: !!docs[`s_${m.key}`]?.seteuk?.text }))
      .sort((a, b) => a.groupId.localeCompare(b.groupId, "en", { numeric: true }) || a.code.localeCompare(b.code));
    const done = groups.reduce((s, g) => s + g.scored, 0) + students.reduce((s, x) => s + x.scored, 0);
    const total = groups.reduce((s, g) => s + g.total, 0) + students.reduce((s, x) => s + x.total, 0);
    const unreviewed = Object.values(docs).reduce((n, d) => n + cntUnrev(d), 0);
    const reviewCount = Object.values(docs).reduce((n, d) => n + Object.keys(reviewFlags(rubric, d)).length, 0);
    return {
      rubric, groups, students, progress: { done, total, reviewCount, unreviewed }, mode: modeOf(sess), aiTotal: { group: rubric.criteria.filter((c) => c.scope === "group" && c.ai).length, student: rubric.criteria.filter((c) => c.scope === "student" && c.ai).length }, release: releaseOf(sess), seteukMax: sess.seteukMax || A.SETEUK_MAX.def, seteukRange: [A.SETEUK_MAX.min, A.SETEUK_MAX.max],
      aiUsed: sess.assessAiCount || 0, aiCap: ASSESS_AI_CAP, aiRuns: ASSESS_RUNS, thresholds: A.THRESHOLDS,
    };
  }

  if (action === "subject") {
    const members = await membersOf(code);
    const { kind, id, key } = subjectArgs(req, sess, members);
    const [{ evidence, empty }, snap] = await Promise.all([loadEvidence(code, sess, kind, id, members), assessRef(code, key).get()]);
    const doc = snap.data() || {};
    return {
      kind, id, mode: modeOf(sess), evidence, empty, scores: doc.scores || {}, ai: modeOf(sess) === "ai_first" ? doc.ai || {} : aiRevealed(doc), hasAi: Object.fromEntries(Object.keys(doc.ai || {}).map((c) => [c, true])),
      review: reviewFlags(rubric, doc), seteuk: kind === "student" ? { text: doc.seteuk?.text || "", t: doc.seteuk?.t || 0 } : null,
    };
  }

  if (action === "save") {
    const members = await membersOf(code);
    const { kind, id, key } = subjectArgs(req, sess, members);
    const c = rubric.criteria.find((x) => x.id === String(req.data?.criterion));
    if (!c || c.scope !== (kind === "student" ? "student" : "group")) throw new HttpsError("invalid-argument", "기준이 올바르지 않습니다.");
    const level = Number(req.data?.level), note = A.clip(req.data?.note, 500);
    const { evidence, empty } = await loadEvidence(code, sess, kind, id, members);
    const doc = (await assessRef(code, key).get()).data() || {};
    const prev = doc.scores?.[c.id];
    // AI가 먼저 채점하는 방식(ai_first)에서는 AI 제안을 보고 정하므로 처음 저장부터 AI 제안과의 차이를 따진다.
    // 교사가 먼저 채점하는 방식(independent)에서는 첫 저장 전에는 AI 제안을 못 봤으므로 두 번째 저장부터만 따진다(독립 채점을 지킨다).
    const mode = modeOf(sess), aiRec = doc.ai?.[c.id];
    const err = A.checkScoreInput({ c, level, note, evidenceIsEmpty: empty[c.id], aiLevel: mode === "ai_first" || prev ? aiRec?.level : undefined });
    if (err) throw new HttpsError("invalid-argument", err);
    const pts = level === -1 ? 0 : c.levels[level].pts;
    const revs = [...(prev?.revs || []), ...(prev ? [{ level: prev.level, note: prev.note || "", t: prev.t }] : [])].slice(-5);
    // src: ai(AI 제안 그대로) · edited(교사가 고침) · teacher(AI를 보기 전에 매김). reviewed: 교사가 저장·확인함
    let src = "teacher";
    if (aiRec && Number.isInteger(aiRec.level) && (mode === "ai_first" || (prev && prev.src !== "teacher"))) src = level === aiRec.level ? "ai" : "edited";
    const score = { level, pts, note, t: Date.now(), by: auth.uid, src, reviewed: true, ...(src === "edited" ? { aiLevel: aiRec.level } : {}), ...(revs.length ? { revs } : {}) };
    await patchAssess(assessRef(code, key), { [`scores.${c.id}`]: score, kind, name: kind === "group" ? `${id.slice(1)}모둠` : members.find((m) => m.key === id)?.nick || "" });
    const merged = { ...doc, scores: { ...(doc.scores || {}), [c.id]: score } };
    return { score, ai: (mode === "ai_first" ? merged.ai || {} : aiRevealed(merged))[c.id] || null, review: reviewFlags(rubric, merged)[c.id] || null, evidenceEmpty: empty[c.id], evidence: evidence[c.id] };
  }

  // AI 제안을 점수로 적용한다(교사가 아직 채점하지 않은 칸만). 적용한 점수는 '검토 전'이고, 교사가 저장·확인하면 검토 완료가 된다.
  if (action === "applyAi") {
    const members = await membersOf(code);
    const targets = req.data?.all === true
      ? [...Array.from({ length: sess.groupCount }, (_, i) => ({ kind: "group", id: `g${i + 1}` })), ...members.map((m) => ({ kind: "student", id: m.key }))]
      : [subjectArgs(req, sess, members)];
    let applied = 0, skipped = 0, subjects = 0;
    for (const t of targets) {
      const key = subjKey(t.kind, t.id);
      const doc = (await assessRef(code, key).get()).data() || {};
      const cands = Object.entries(doc.ai || {}).filter(([cid]) => !doc.scores?.[cid]);
      if (!cands.length) continue;
      const { empty } = await loadEvidence(code, sess, t.kind, t.id, members);
      const patch = {};
      for (const [cid, a] of cands) {
        const c = rubric.criteria.find((x) => x.id === cid && x.scope === scopeOf(t.kind));
        if (!c || !Number.isInteger(a.level)) continue;
        const note = A.clip(`AI 제안: ${a.reason || "수준 설명에 비추어 판단"}`, 500);
        if (A.checkScoreInput({ c, level: a.level, note, evidenceIsEmpty: empty[cid] })) { skipped++; continue; }
        patch[`scores.${cid}`] = { level: a.level, pts: a.level === -1 ? 0 : c.levels[a.level].pts, note, t: Date.now(), by: "ai", src: "ai", reviewed: false };
        applied++;
      }
      if (Object.keys(patch).length) { subjects++; await patchAssess(assessRef(code, key), { ...patch, kind: t.kind, name: t.kind === "group" ? `${t.id.slice(1)}모둠` : members.find((m) => m.key === t.id)?.nick || "" }); }
    }
    return { applied, skipped, subjects };
  }

  if (action === "recheck") {
    const members = await membersOf(code);
    const docsSnap = (await db.collection(`sessions/${code}/assess`).get()).docs;
    if (req.data?.op === "save") {
      const { kind, id, key } = subjectArgs(req, sess, members);
      const c = rubric.criteria.find((x) => x.id === String(req.data?.criterion));
      const level = Number(req.data?.level);
      const doc = docsSnap.find((d) => d.id === key)?.data();
      if (!c || !doc?.scores?.[c.id]) throw new HttpsError("failed-precondition", "먼저 채점한 칸만 다시 채점할 수 있어요.");
      if (!Number.isInteger(level) || level < -1 || level >= c.levels.length) throw new HttpsError("invalid-argument", "수준을 고르세요.");
      await patchAssess(assessRef(code, key), { [`recheck.${c.id}`]: { level, t: Date.now() } });
      return { ok: true };
    }
    // 목록: 이미 채점한 칸 중 해시로 고른 표본(약 1/5). 첫 채점 수준은 내보내지 않는다.
    const items = [];
    let left = 0;
    for (const d of docsSnap) {
      const doc = d.data(), kind = d.id.startsWith("s_") ? "student" : "group", id = kind === "student" ? d.id.slice(2) : d.id;
      if (kind === "student" && !members.some((m) => m.key === id)) continue;
      for (const c of rubric.criteria) {
        if (c.scope !== (kind === "student" ? "student" : "group") || !doc.scores?.[c.id] || doc.scores[c.id].reviewed === false || doc.recheck?.[c.id]) continue;
        if (!A.inRecheckSample(`${d.id}:${c.id}`)) continue;
        left++;
        if (items.length < 6) items.push({ kind, id, criterion: c.id });
      }
    }
    const cache = new Map(), out = [];
    for (const it of items) {
      const ck = `${it.kind}:${it.id}`;
      if (!cache.has(ck)) cache.set(ck, await loadEvidence(code, sess, it.kind, it.id, members));
      const ev = cache.get(ck);
      out.push({ ...it, code: it.kind === "student" ? blindCode(it.id) : `${it.id.slice(1)}모둠`, evidence: ev.evidence[it.criterion], empty: ev.empty[it.criterion] });
    }
    return { items: out, left, total: docsSnap.length };
  }

  if (action === "reliability") {
    const members = await membersOf(code);
    const docs = (await db.collection(`sessions/${code}/assess`).get()).docs
      .filter((d) => !d.id.startsWith("s_") || members.some((m) => `s_${m.key}` === d.id)).map((d) => ({ id: d.id, ...d.data() }));
    const report = A.reliabilityReport(rubric, docs);
    // 모둠별 합계와 개인 점수 분포(공정성 점검): 학생 한 명의 합계 = 개인 칸 + 소속 모둠 칸
    const gSum = (g) => rubric.criteria.filter((c) => c.scope === "group").reduce((s, c) => s + (docs.find((d) => d.id === g)?.scores?.[c.id]?.pts || 0), 0);
    const groups = Array.from({ length: sess.groupCount }, (_, i) => `g${i + 1}`).map((g) => ({ id: g, name: `${g.slice(1)}모둠`, group: gSum(g) }));
    return { ...report, groups, scored: docs.length };
  }

  if (action === "release") {
    const patch = {};
    if (req.data?.score !== undefined) patch["release.score"] = req.data.score === true;
    if (req.data?.seteuk !== undefined) patch["release.seteuk"] = req.data.seteuk === true;
    if (!Object.keys(patch).length) throw new HttpsError("invalid-argument", "공개할 항목을 고르세요.");
    patch["release.t"] = Date.now();
    await db.doc(`sessions/${code}`).update(patch);
    return { release: { ...releaseOf(sess), ...(patch["release.score"] !== undefined ? { score: patch["release.score"] } : {}), ...(patch["release.seteuk"] !== undefined ? { seteuk: patch["release.seteuk"] } : {}) } };
  }

  if (action === "config" && req.data?.assessMode !== undefined) {
    if (!["ai_first", "independent"].includes(req.data.assessMode)) throw new HttpsError("invalid-argument", "채점 방식이 올바르지 않습니다.");
    await db.doc(`sessions/${code}`).update({ assessMode: req.data.assessMode });
    return { mode: req.data.assessMode };
  }
  if (action === "config") {
    const n = parseInt(req.data?.seteukMax, 10);
    if (!(n >= A.SETEUK_MAX.min && n <= A.SETEUK_MAX.max)) throw new HttpsError("invalid-argument", `세특 한도는 ${A.SETEUK_MAX.min}~${A.SETEUK_MAX.max}바이트 사이로 정하세요.`);
    await db.doc(`sessions/${code}`).update({ seteukMax: n });
    return { seteukMax: n };
  }

  if (action === "seteukSave") {
    const members = await membersOf(code);
    const m = members.find((x) => x.key === String(req.data?.id));
    if (!m) throw new HttpsError("not-found", "학생을 찾을 수 없습니다.");
    const text = String(req.data?.text ?? "").trim();
    const max = sess.seteukMax || A.SETEUK_MAX.def;
    if (!text) { await patchAssess(assessRef(code, `s_${m.key}`), { "seteuk.text": FieldValue().delete(), "seteuk.t": Date.now() }); return { text: "", bytes: 0, warnings: [] }; }
    const chk = A.checkSeteuk(text, { nick: m.nick, maxBytes: max });
    if (chk.errors.length) throw new HttpsError("invalid-argument", chk.errors[0]);
    await patchAssess(assessRef(code, `s_${m.key}`), { "seteuk.text": text, "seteuk.bytes": chk.bytes, "seteuk.t": Date.now(), "seteuk.by": auth.uid, kind: "student", name: m.nick });
    return { text, bytes: chk.bytes, warnings: chk.warnings };
  }

  throw new HttpsError("invalid-argument", "알 수 없는 요청입니다.");
});

const SK = require("./seteuk");
// 세특의 근거: 이 학생의 개인 활동 + 모둠이 함께 한 활동(다른 학생의 개인 글과 별명은 넣지 않는다). 기승전결 어느 부분에 어울리는지 힌트(role)를 단다.
async function seteukEvidence(code, sess, id, stu, members) {
  const mine = await loadEvidence(code, sess, "student", id, members);
  const grp = await loadEvidence(code, sess, "group", stu.groupId, members);
  const picks = [["c11", mine], ["c21", mine], ["c22", mine], ["c31", mine], ["c41", mine], ["c52", mine], ["c12", grp], ["c23", grp], ["c32", grp], ["c42", grp], ["c51", grp]];
  const items = [];
  for (const [cid, src] of picks) for (const e of src.evidence[cid] || []) {
    if (A.isRefLabel(e.label)) continue; // 참고용 기록(건수·점검표 등)은 세특 근거가 아니다
    items.push({ id: `e${items.length + 1}`, label: `${src === mine ? "내 활동" : "모둠 활동"} · ${e.label}`, text: A.clip(e.text, 320), role: SK.ROLE_OF[cid] });
  }
  let size = 0;
  return items.filter((e) => (size += e.text.length + e.label.length) <= 6000);
}
async function seteukScoreLines(code, sess, id, stu) {
  const rubric = rubricOfSession(sess);
  const docs = await Promise.all([assessRef(code, `s_${id}`).get(), assessRef(code, stu.groupId).get()]);
  const out = [];
  docs.forEach((d) => { for (const [cid, v] of Object.entries(d.data()?.scores || {})) { const c = rubric.criteria.find((x) => x.id === cid); if (c) out.push({ name: c.name, levelLabel: v.level === -1 ? "미제출" : c.levels[v.level]?.label, note: v.note }); } });
  return out;
}

// AI 제2평정자와 세특 초안(교사 전용). 학생 글은 근거로만 쓰고 지시로 따르지 않는다.
exports.assessAi = onCall(assessAiOpts, async (req) => {
  const { code, sess } = await ownSession(req);
  const action = String(req.data?.action || "");
  const members = await membersOf(code);
  const { kind, id, key } = subjectArgs(req, sess, members);
  const used = sess.assessAiCount || 0;
  const apiKey = OPENAI_API_KEY.value();
  const effort = REASONING_EFFORT.value();
  const level = levelOf(sess);
  const bump = (n) => db.doc(`sessions/${code}`).update({ assessAiCount: FieldValue().increment(n) }).catch(() => {});

  if (action === "score") {
    const { rubric, evidence, empty } = await loadEvidence(code, sess, kind, id, members);
    const crits = rubric.criteria.filter((c) => c.scope === (kind === "student" ? "student" : "group") && c.ai);
    const items = crits.filter((c) => !empty[c.id]).map((c) => ({ c, evidence: evidence[c.id] }));
    const patch = {};
    for (const c of crits.filter((x) => empty[x.id])) patch[`ai.${c.id}`] = { level: -1, levels: [-1], spread: 0, quote: "", quoteOk: true, reason: "학생이 쓴 근거가 비어 있음", n: 0, auto: true, t: Date.now() };
    let ok = 0, failed = 0, escalatedCount = 0;
    if (items.length) {
      if (used + ASSESS_RUNS + 1 > ASSESS_AI_CAP) throw new HttpsError("resource-exhausted", `이 수업의 평가용 AI 호출 한도(${ASSESS_AI_CAP}회)에 가까워 더 받을 수 없어요.`);
      await bump(ASSESS_RUNS);
      const messages = A.scorerMessages({ rubric, items, scope: scopeOf(kind) });
      const one = async () => A.parseScorer(extractJson(await callModel({ apiKey, model: ASSESS_FAST_MODEL.value(), messages, json: true, maxTokens: 1800, efforts: [effort === "minimal" ? "low" : effort, "low"] })), items);
      const settle = (rs) => rs.map((r) => (r.status === "fulfilled" ? r.value : (failed++, console.error("AI 채점 실패:", r.reason?.message), null))).filter(Boolean);
      // 같은 프롬프트라 첫 호출이 끝나 캐시가 만들어진 뒤에 나머지를 보내면 입력 요금이 줄어든다(OpenAI 자동 프롬프트 캐시)
      const runs = settle(await Promise.allSettled([one()]));
      runs.push(...settle(await Promise.allSettled(Array.from({ length: ASSESS_RUNS - 1 }, one))));
      let combined = A.combineRuns(runs, items);
      // 갈리거나 인용을 못 찾은 기준(또는 빠른 모델이 답하지 못한 기준)만 고성능 모델이 한 번 더 판정한다
      const hard = items.filter(({ c }) => A.needsEscalation(combined[c.id]));
      if (hard.length) {
        await bump(1);
        const [h] = await Promise.allSettled([(async () => A.parseScorer(extractJson(await callModel({ apiKey, model: ASSESS_MODEL.value(), messages: A.scorerMessages({ rubric, items: hard, scope: scopeOf(kind) }), json: true, maxTokens: 1800, efforts: [effort === "minimal" ? "low" : effort, "low"] })), hard))()]);
        if (h.status === "rejected") { failed++; console.error("AI 재판정 실패:", h.reason?.message); }
        combined = A.applyAdjudication(combined, h.status === "fulfilled" ? h.value : null, hard);
        escalatedCount = hard.length;
      }
      for (const [cid, v] of Object.entries(combined)) { patch[`ai.${cid}`] = { ...v, t: Date.now() }; ok++; }
      if (!ok) throw new HttpsError("unavailable", "AI 응답을 받지 못했어요. 잠시 뒤에 다시 시도하세요.");
    }
    if (Object.keys(patch).length) await patchAssess(assessRef(code, key), patch);
    return { ok, auto: crits.length - items.length, failedRuns: failed, escalated: escalatedCount };
  }

  // ---- 세특 ①② 근거 확인과 수준 판정(경량 모델). 결과는 교사에게 보여 주고, 빈약하면 하향·유지·취소를 고르게 한다. ----
  if (action === "seteukPrep" || action === "seteukGenerate") {
    if (kind !== "student") throw new HttpsError("invalid-argument", "세특은 학생마다 만들어요.");
    const target = sess.seteukMax || SK.SETEUK_MAX.def;
    const stu = members.find((m) => m.key === id);
    const items = await seteukEvidence(code, sess, id, stu, members);
    if (!items.length) throw new HttpsError("failed-precondition", "아직 학생이 쓴 활동 기록이 없어 세특을 만들 수 없어요. (주제만 보고 쓰지 않아요)");
    const ref = assessRef(code, `s_${id}`);
    const doc = (await ref.get()).data() || {};

    if (action === "seteukPrep") {
      if (used + 2 > ASSESS_AI_CAP) throw new HttpsError("resource-exhausted", `이 수업의 평가용 AI 호출 한도(${ASSESS_AI_CAP}회)에 가까워 더 받을 수 없어요.`);
      const inputBytes = SK.neisBytes(items.map((e) => e.text).join(" "));
      let lv, last;
      for (let i = 0; i < 2 && !lv; i++) {
        await bump(1);
        try { lv = SK.parseLevel(extractJson(await callModel({ apiKey, model: OPENAI_MODEL.value(), messages: SK.levelMessages({ level, items, targetBytes: target }), json: true, maxTokens: 1500, efforts: [effort === "minimal" ? "low" : effort, "low"] }))); }
        catch (e) { last = e; console.error("수준 판정 실패:", e.message); }
      }
      if (!lv) throw new HttpsError("unavailable", "AI 응답을 받지 못했어요. 잠시 뒤에 다시 시도하세요.");
      const rich = SK.richnessFromQuality(lv.quality, lv.factInsufficient);
      const safe = SK.computeSafeTarget(inputBytes, target, lv.grade);
      const suggestedMax = Math.min(safe.safeMaxBytes, rich.cap ?? Infinity);
      const prep = { grade: lv.grade, gradeScore: lv.gradeScore, criteria: lv.criteria, suspicion: lv.suspicion, quality: lv.quality, factInsufficient: lv.factInsufficient,
        richness: rich, inputBytes, ratio: safe.ratio, target, suggestedMax, needsAdjustment: suggestedMax < target || rich.isPoor, evidenceCount: items.length, t: Date.now() };
      await patchAssess(ref, { "seteuk.prep": prep, kind: "student", name: stu.nick });
      return prep;
    }

    // ---- ④⑤ 초안(기승전결 4부분) + NEIS 바이트 수렴 ----
    const prep = doc.seteuk?.prep;
    if (!prep || prep.target !== target) throw new HttpsError("failed-precondition", "먼저 수준 판정을 해 주세요. (글자 수 한도를 바꿨다면 다시 판정해야 해요)");
    const grade = SK.GRADES.includes(req.data?.grade) ? req.data.grade : prep.grade;
    const emphasis = SK.EMPHASIS[req.data?.emphasis] ? req.data.emphasis : "balance";
    let decision = String(req.data?.decision || "");
    if (prep.needsAdjustment && !["lower", "keep", "cancel"].includes(decision)) throw new HttpsError("failed-precondition", "근거가 목표 분량에 비해 적어요. 분량을 낮출지 유지할지 먼저 골라 주세요.");
    if (decision === "cancel") return { cancelled: true };
    if (!prep.needsAdjustment) decision = "keep";
    const dec = SK.resolveDecision(decision, target, prep.suggestedMax);
    const effTarget = prep.needsAdjustment ? dec.effectiveTargetBytes : target;
    const allowCreation = prep.needsAdjustment && dec.allowCreation;
    const contentFirst = prep.needsAdjustment && decision === "lower";
    const scoreLines = await seteukScoreLines(code, sess, id, stu);
    const params = { level, items, scores: scoreLines, grade, emphasis, effectiveTarget: effTarget, targetBytes: target, allowCreation, filledCount: items.length };
    const base = SK.draftMessages(params);
    const validIds = items.map((e) => e.id);
    const budget = ASSESS_AI_CAP - used;
    if (budget < 2) throw new HttpsError("resource-exhausted", `이 수업의 평가용 AI 호출 한도(${ASSESS_AI_CAP}회)에 가까워 더 받을 수 없어요.`);
    let calls = 0, lastParts = null;
    const made = new Map(), log = [];
    const used_models = { strong: 0, fast: 0 };
    let fixes = 0, strongFix = false;
    const ask = async (messages, strong) => {
      calls++;
      await bump(1);
      used_models[strong ? "strong" : "fast"]++;
      return extractJson(await callModel({ apiKey, model: (strong ? SETEUK_MODEL : SETEUK_FIX_MODEL).value(), messages, json: true, maxTokens: SK.maxTokens(effTarget) + 600, efforts: [effort === "minimal" ? "low" : effort, "low"] }));
    };
    const generate = async (direction, prevText, bytes) => {
      let messages = direction === "init" ? base : SK.fixMessages({ base, parts: lastParts, direction, bytes, effectiveTarget: effTarget, items });
      let parsed, flow;
      if (direction !== "init" && ++fixes > 3) strongFix = true; // 보정이 3번 넘게 걸리면 고성능 모델로 올린다
      for (let k = 0; k < 2; k++) {
        // 첫 초안과 구조를 다시 잡는 재시도는 고성능, 분량만 맞추는 보정은 빠른 모델
        parsed = SK.parseDraft(await ask(messages, direction === "init" || k > 0 || strongFix), { validIds, nick: stu.nick });
        flow = SK.checkFlow(parsed.parts);
        if (!flow.errors.length) break;
        if (direction !== "init") strongFix = true; // 빠른 모델의 보정이 기승전결을 깨면 이후는 고성능
        if (k === 0 && calls + 1 < budget) { lastParts = parsed.parts.filter((p) => p.sentences.length); messages = SK.fixMessages({ base, parts: parsed.parts, direction: "fix", bytes, effectiveTarget: effTarget, items, feedback: `${flow.errors.join(", ")}. 기승전결 네 부분이 모두 있도록 근거가 있는 문장으로 채운다.` }); }
      }
      lastParts = parsed.parts;
      const text = SK.assemble(parsed.parts);
      made.set(text, { parts: parsed.parts, dropped: parsed.dropped, flow });
      return text;
    };
    let conv;
    try {
      conv = await SK.convergeLength(generate, { target: effTarget, contentFirst, maxAdjust: Math.max(1, Math.min(SK.PRESET.maxAdjust, budget - 3)), deadline: Date.now() + 200 * 1000, onTry: (t) => log.push(t) });
    } catch (e) {
      if (e instanceof HttpsError) throw e;
      console.error("세특 초안 실패:", e.message);
      throw new HttpsError("unavailable", "AI 응답을 받지 못했어요. 잠시 뒤에 다시 시도하세요.");
    }
    const got = made.get(conv.text);
    if (!conv.text || !got) throw new HttpsError("unavailable", "쓸 만한 초안을 만들지 못했어요. 다시 시도하세요.");
    const lint = SK.lintStyle(conv.text, { nick: stu.nick });
    const warnings = [...got.flow.errors, ...got.flow.warnings, ...lint];
    if (conv.bytes > target) warnings.unshift(`글자 수가 ${conv.bytes}바이트로 한도(${target}바이트)를 넘어요. 줄여서 저장하세요.`);
    await patchAssess(ref, { "seteuk.gen": { t: Date.now(), grade, emphasis, decision, target: effTarget, bytes: conv.bytes, reason: conv.reason, tries: conv.tries, models: used_models } });
    return { text: conv.text, parts: got.parts, dropped: got.dropped, warnings, bytes: conv.bytes, max: target, target: effTarget, reason: conv.reason, tries: conv.tries, log, calls, models: used_models, grade, emphasis, decision,
      evidence: Object.fromEntries(items.map((e) => [e.id, { label: e.label, text: e.text }])) };
  }

  throw new HttpsError("invalid-argument", "알 수 없는 요청입니다.");
});

// 학생: 내 점수·평가 이유·세특 보기. 수업 중에는 로그인한 계정으로, 수업이 닫힌 뒤에는 입장할 때와 같은 모둠·별명·비밀번호로 확인한다.
// 교사가 공개한 항목(점수, 세특)만 돌려준다. 공개를 끄면 바로 보이지 않는다.
exports.myResult = onCall(opts, async (req) => {
  const auth = requireAuth(req);
  const code = sessCode(req.data?.code);
  if (!code) throw new HttpsError("not-found", "수업 코드를 찾을 수 없습니다.");
  const sessSnap = await db.doc(`sessions/${code}`).get();
  if (!sessSnap.exists) throw new HttpsError("not-found", "수업 코드를 찾을 수 없습니다.");
  const sess = sessSnap.data();
  const rel = releaseOf(sess);
  const mine = await db.doc(`sessions/${code}/members/${auth.uid}`).get();
  let m = null;
  if (mine.exists && req.data?.password === undefined) m = mine.data();
  else {
    const groupNo = parseInt(req.data?.groupNo, 10), nickname = String(req.data?.nickname || "").trim().slice(0, 12), password = String(req.data?.password ?? "");
    if (!(groupNo >= 1 && groupNo <= sess.groupCount) || !nickname || !password) throw new HttpsError("invalid-argument", "수업 코드, 모둠 번호, 별명, 비밀번호를 모두 입력하세요.");
    const key = credKey(groupNo, nickname);
    const credRef = db.doc(`sessions/${code}/creds/${key}`), attRef = db.doc(`sessions/${code}/attempts/${auth.uid}`);
    const [credSnap, attSnap] = await Promise.all([credRef.get(), attRef.get()]);
    const cred = credSnap.exists ? credSnap.data() : null;
    if (!cred) throw new HttpsError("not-found", "이 별명으로 입장한 기록이 없어요. 모둠 번호와 별명을 확인하세요.");
    const att = attSnap.data() || {};
    const wait = Math.max(lockedSeconds(att), lockedSeconds(cred));
    if (wait) throw new HttpsError("resource-exhausted", `비밀번호를 여러 번 틀려서 ${wait}초 동안 확인할 수 없습니다.`);
    if (!(await verifyPassword(password, cred))) {
      await Promise.all([attRef.set(afterFail(att)), credRef.update(afterTotalFail(cred))]);
      throw new HttpsError("permission-denied", "비밀번호가 맞지 않습니다.");
    }
    if (attSnap.exists) await attRef.delete();
    m = { nickname, groupId: `g${groupNo}`, credKey: key };
  }
  const base = { title: sess.title, nickname: m.nickname, groupId: m.groupId, released: rel };
  if (!rel.score && !rel.seteuk) return base;
  const key = studentKeyOf(m);
  const [stuSnap, grpSnap] = await Promise.all([assessRef(code, `s_${key}`).get(), assessRef(code, m.groupId).get()]);
  const stu = stuSnap.data() || {}, grp = grpSnap.data() || {};
  const out = { ...base };
  if (rel.score) {
    const rubric = rubricOfSession(sess);
    const scores = {};
    const items = rubric.criteria.map((c) => {
      const s = (c.scope === "student" ? stu : grp).scores?.[c.id];
      if (s) scores[c.id] = s;
      return { id: c.id, element: c.elName, name: c.name, scope: c.scope, max: c.max, scored: !!s, pts: s ? s.pts : null,
        level: s ? (s.level === -1 ? "미제출" : c.levels[s.level].label) : null, desc: s && s.level !== -1 ? c.levels[s.level].desc : "", note: s?.note || "" };
    });
    out.score = { ...totals(rubric, scores), indivMax: rubric.indivMax, groupMax: rubric.total - rubric.indivMax, items, labels: rubric.labels };
  }
  if (rel.seteuk) out.seteuk = { text: stu.seteuk?.text || "" };
  return out;
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
