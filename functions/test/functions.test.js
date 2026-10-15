// index.js 통합 테스트: firebase-admin, firebase-functions, OpenAI(fetch)를 메모리 가짜로 대체한다.
const test = require("node:test");
const assert = require("node:assert");
const Module = require("node:module");

// ---------- 메모리 Firestore ----------
const store = new Map();
const TS = { toMillis: () => 1 };
const FV = { serverTimestamp: () => TS, increment: (n) => ({ __inc: n }) };
function applyUpdate(cur, data) {
  const out = { ...cur };
  for (const [k, v] of Object.entries(data)) out[k] = v && v.__inc !== undefined ? (out[k] || 0) + v.__inc : v;
  return out;
}
const docRef = (path) => ({
  path,
  async get() { const d = store.get(path); return { exists: d !== undefined, data: () => (d === undefined ? undefined : JSON.parse(JSON.stringify(d))), id: path.split("/").pop() }; },
  async set(d) { store.set(path, d); },
  async update(d) { store.set(path, applyUpdate(store.get(path) || {}, d)); },
  collection: (name) => collRef(`${path}/${name}`),
});
const collRef = (path) => ({
  doc: (id) => docRef(`${path}/${id || "auto" + store.size + Math.random().toString(36).slice(2, 6)}`),
  where: (field, _op, value) => ({
    async get() {
      const docs = [...store.entries()].filter(([k, v]) => k.startsWith(path + "/") && !k.slice(path.length + 1).includes("/") && v[field] === value)
        .map(([k, v]) => ({ id: k.split("/").pop(), data: () => v }));
      return { docs };
    },
  }),
});
const firestore = () => ({
  doc: docRef,
  collection: collRef,
  batch: () => { const ops = []; return { set: (r, d) => ops.push(() => r.set(d)), async commit() { for (const o of ops) await o(); } }; },
  async runTransaction(fn) {
    const tx = { get: (r) => r.get(), set: (r, d) => r.set(d), update: (r, d) => r.update(d) };
    return fn(tx);
  },
});
firestore.FieldValue = FV;

// ---------- 모듈 가로채기 ----------
const handlers = {};
const fakes = {
  "firebase-admin": { initializeApp() {}, firestore, auth() {} },
  "firebase-functions/v2/https": {
    onCall: (_o, fn) => fn,
    HttpsError: class extends Error { constructor(code, msg) { super(msg); this.code = code; } },
  },
  "firebase-functions/params": {
    defineSecret: () => ({ value: () => "sk-test" }),
    defineString: (name, o) => ({ value: () => ({ TEACHER_EMAILS: "t@school.kr", ALLOW_UNVERIFIED_PERSONAS: "true", OPENAI_MODEL: "gpt-test" }[name] ?? o?.default ?? "") }),
  },
};
const origLoad = Module._load;
Module._load = function (req, ...rest) { return fakes[req] || origLoad.call(this, req, ...rest); };

// OpenAI 가짜: 시스템 프롬프트로 호출 종류를 구분한다
let guardReply = '{"ok":true,"category":"ok","reason":""}';
const calls = [];
global.fetch = async (_url, init) => {
  const body = JSON.parse(init.body);
  const sys = body.messages[0].content;
  calls.push({ kind: sys.includes("상위 감독자") ? "guard" : sys.includes("[역할] 너는 실제 보도") ? "persona" : "other", body });
  const content = sys.includes("상위 감독자") ? guardReply : "저는 집회에서 불안하다는 이야기가 나왔다고 알고 있어요. (자료1)";
  return { ok: true, json: async () => ({ choices: [{ message: { content } }] }) };
};

const api = require("../index.js");
const teacher = { auth: { uid: "T1", token: { email: "t@school.kr" } } };
const student = (uid) => ({ auth: { uid, token: {} } });
let code;

test("교사: 수업 만들기 → 코드와 모둠 문서 생성", async () => {
  const { code: c } = await api.createSession({ ...teacher, data: { groupCount: 2, eventId: "bogus" } });
  code = c;
  assert.match(code, /^[A-Z2-9]{6}$/);
  assert.equal(store.get(`sessions/${code}`).eventId, "jeju2018"); // 잘못된 사건 ID는 기본값으로
  assert.ok(store.has(`sessions/${code}/groups/g2`));
});

test("Firestore config/teachers 에 이메일을 넣으면 재배포 없이 교사가 되고, 관리자는 항상 교사", async () => {
  const newTeacher = { auth: { uid: "T2", token: { email: "New.Teacher@School.kr" } } };
  await assert.rejects(api.createSession({ ...newTeacher, data: {} }), /교사/);
  store.set("config/teachers", { emails: ["new.teacher@school.kr"] });
  const r = await api.createSession({ ...newTeacher, data: { groupCount: 1 } });
  assert.match(r.code, /^[A-Z2-9]{6}$/);
  store.delete("config/teachers");
  await assert.rejects(api.createSession({ ...newTeacher, data: {} }), /교사/);
  const admin = { auth: { uid: "A1", token: { email: "working.khwdk@gmail.com" } } };
  assert.match((await api.createSession({ ...admin, data: { groupCount: 1 } })).code, /^[A-Z2-9]{6}$/);
});

test("교사가 아니면 수업을 만들 수 없다", async () => {
  await assert.rejects(api.createSession({ ...student("S0"), data: {} }), /교사/);
});

test("입장: 같은 모둠의 학생들에게 서로 다른 인물이 순서대로 배정되고, 재입장해도 유지된다", async () => {
  const got = [];
  for (const [i, uid] of ["S1", "S2", "S3", "S4", "S5"].entries())
    got.push((await api.joinSession({ ...student(uid), data: { code, groupNo: 1, nickname: "별" + i } })).personaId);
  assert.deepEqual(got.slice(0, 4).sort(), ["j_applicant", "j_officer", "j_resident", "j_supporter"]);
  assert.equal(new Set(got.slice(0, 4)).size, 4);
  assert.equal(got[4], got[0]); // 5번째 학생은 처음 인물과 겹침
  const again = await api.joinSession({ ...student("S2"), data: { code, groupNo: 1, nickname: "바뀐별" } });
  assert.equal(again.personaId, got[1]);
  assert.equal(store.get(`sessions/${code}/groups/g1`).memberCount, 5);
});

test("getCase: 학생에게는 내 인물만 근거 출처와 함께 주고 근거 진술 전문은 주지 않는다", async () => {
  const { data } = { data: await api.getCase({ ...student("S1"), data: { code } }) };
  assert.equal(data.myPersona.id, "j_applicant");
  assert.equal(data.otherPersonas.length, 3);
  assert.ok(data.myPersona.sources.length > 0);
  assert.equal(JSON.stringify(data).includes("징집되어 싸워야"), false);
  assert.equal(data.stakeholders.length, 4);
});

test("getCase: 교사는 근거 진술 전문과 융합 근거를 받는다", async () => {
  const data = await api.getCase({ ...teacher, data: { eventId: "jeju2018" } });
  assert.equal(data.personas.length, 4);
  assert.ok(data.personas[0].claims.length >= 8 && data.personas[0].basis);
  await assert.rejects(api.getCase({ ...student("S1"), data: { eventId: "jeju2018" } }), /교사/);
});

const work = { s1: { preQuestions: ["왜 제주에 왔나요?", "일자리는 어땠나요?", "가장 힘든 점은요?"] } };
const ask = (uid, personaId, message = "불안한 이유가 뭐예요?") =>
  api.aiRequest({ ...student(uid), data: { code, stage: 1, type: "persona_chat", payload: { personaId, message } } });

test("GYR 게이트: 사전 질문 없이는 대화 불가", async () => {
  await assert.rejects(ask("S3", "j_resident"), /사전 질문/);
});

test("1단계 대화: 내 인물과만 가능하고, 페르소나→감독자 순으로 호출되며 로그가 남는다", async () => {
  store.set(`sessions/${code}/groups/g1`, { ...store.get(`sessions/${code}/groups/g1`), work });
  const mine = store.get(`sessions/${code}/members/S3`).personaId;
  const other = ["j_applicant", "j_resident", "j_supporter", "j_officer"].find((p) => p !== mine);
  await assert.rejects(ask("S3", other), /인물/); // 다른 모둠원의 인물과는 대화 불가
  calls.length = 0;
  const r = await ask("S3", mine);
  assert.match(r.result, /자료1/);
  assert.deepEqual(calls.map((c) => c.kind), ["persona", "guard"]);
  const guardSys = calls[1].body.messages[0].content;
  assert.match(guardSys, /상위 감독자/);
  const logs = [...store.entries()].filter(([k]) => k.includes("/logs/"));
  assert.equal(logs.length, 1);
  assert.equal(logs[0][1].guard.ok, true);
  assert.equal(store.get(`sessions/${code}/groups/g1`).aiCount, 1);
});

test("상위 AI 감독: 범위 위반이면 응답을 안내문으로 바꾸고 원문은 교사용 로그에만 남긴다", async () => {
  guardReply = '{"ok":false,"category":"scope","reason":"다른 난민 사건을 언급"}';
  const mine = store.get(`sessions/${code}/members/S3`).personaId;
  const r = await ask("S3", mine, "시리아 난민은 어떻게 됐어요?");
  assert.match(r.result, /범위를 벗어나요/);
  assert.doesNotMatch(r.result, /자료1/);
  const log = [...store.entries()].filter(([k]) => k.includes("/logs/")).map(([, v]) => v).pop();
  assert.equal(log.guard.ok, false);
  assert.equal(log.guard.category, "scope");
  assert.match(log.guard.original, /자료1/);
  assert.match(log.output, /범위를 벗어나요/);
});

test("상위 AI 감독: 감독자 응답이 깨지면 안전 쪽(차단)으로 처리한다", async () => {
  guardReply = "이건 JSON이 아님";
  const mine = store.get(`sessions/${code}/members/S3`).personaId;
  const r = await ask("S3", mine);
  assert.match(r.result, /문제가 생겼어요/);
  guardReply = '{"ok":true,"category":"ok","reason":""}';
});
