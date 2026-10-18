// index.js 통합 테스트: firebase-admin, firebase-functions, OpenAI(fetch)를 메모리 가짜로 대체한다.
const test = require("node:test");
const assert = require("node:assert");
const Module = require("node:module");

// ---------- 메모리 Firestore ----------
const store = new Map();
const TS = { toMillis: () => Date.now(), toJSON: () => Date.now() };
const DEL = { __del: true };
const FV = { serverTimestamp: () => TS, increment: (n) => ({ __inc: n }), delete: () => DEL };
// 점(.)이 든 필드 경로는 중첩 객체로 풀어서 갱신하고, FieldValue.delete() 는 그 키를 지운다
function applyUpdate(cur, data) {
  const out = JSON.parse(JSON.stringify(cur));
  for (const [k, v] of Object.entries(data)) {
    const keys = k.split(".");
    let o = out;
    for (const kk of keys.slice(0, -1)) { if (o[kk] == null || typeof o[kk] !== "object") o[kk] = {}; o = o[kk]; }
    const last = keys[keys.length - 1];
    if (v && v.__del) delete o[last];
    else o[last] = v && v.__inc !== undefined ? (o[last] || 0) + v.__inc : v;
  }
  return out;
}
let autoId = 0;
const docRef = (path) => ({
  path,
  async get() { const d = store.get(path); return { exists: d !== undefined, data: () => (d === undefined ? undefined : JSON.parse(JSON.stringify(d))), id: path.split("/").pop() }; },
  async set(d) { store.set(path, d); },
  async update(d) { store.set(path, applyUpdate(store.get(path) || {}, d)); },
  async delete() { store.delete(path); },
  collection: (name) => collRef(`${path}/${name}`),
});
// 저장 순서를 시간 순서로 본다(가짜 serverTimestamp 는 모두 같은 값이라)
const collRef = (path, filters = [], order = null, lim = null) => ({
  doc: (id) => docRef(`${path}/${id || "auto" + ++autoId}`),
  where: (f, _op, val) => collRef(path, [...filters, [f, val]], order, lim),
  orderBy: (_f, dir = "asc") => collRef(path, filters, dir, lim),
  limit: (n) => collRef(path, filters, order, n),
  async get() {
    let docs = [...store.entries()].filter(([k]) => k.startsWith(path + "/") && !k.slice(path.length + 1).includes("/"))
      .filter(([, v]) => filters.every(([f, val]) => v[f] === val))
      .map(([k, v]) => ({ id: k.split("/").pop(), data: () => JSON.parse(JSON.stringify(v)) }));
    if (order === "desc") docs.reverse();
    if (lim) docs = docs.slice(0, lim);
    return { docs };
  },
});
const firestore = () => ({
  doc: docRef,
  collection: collRef,
  batch: () => {
    const ops = [];
    return {
      set: (r, d) => ops.push(() => r.set(d)), update: (r, d) => ops.push(() => r.update(d)), delete: (r) => ops.push(() => r.delete()),
      async commit() { for (const o of ops) await o(); },
    };
  },
  async recursiveDelete(r) { for (const k of [...store.keys()]) if (k === r.path || k.startsWith(r.path + "/")) store.delete(k); },
  async runTransaction(fn) {
    const tx = { get: (r) => r.get(), set: (r, d) => r.set(d), update: (r, d) => r.update(d) };
    return fn(tx);
  },
});
firestore.FieldValue = FV;

// ---------- 모듈 가로채기 ----------
const fakes = {
  "firebase-admin": { initializeApp() {}, firestore, auth() {} },
  "firebase-functions/v2/https": {
    onCall: (_o, fn) => fn,
    HttpsError: class extends Error { constructor(code, msg) { super(msg); this.code = code; } },
  },
  "firebase-functions/params": {
    defineSecret: () => ({ value: () => "sk-test" }),
    defineInt: (name, o) => ({ value: () => o?.default ?? 0 }),
    defineString: (name, o) => ({ value: () => ({ TEACHER_EMAILS: "t@school.kr", ALLOW_UNVERIFIED_PERSONAS: "true", OPENAI_MODEL: "gpt-5-test" }[name] ?? o?.default ?? "") }),
  },
};
const origLoad = Module._load;
Module._load = function (req, ...rest) { return fakes[req] || origLoad.call(this, req, ...rest); };

// OpenAI 가짜: 시스템 프롬프트로 호출 종류를 구분한다
let guardReply = '{"ok":true,"category":"ok","reason":"","fixed":""}';
let personaReply = "저는 아직도 불안해요 😟";
let scenarioEmptyFirst = 0;
const calls = [];
const kindOf = (sys) =>
  sys.includes("상위 감독자") ? "guard"
    : sys.includes("시뮬레이션 도우미") ? "scenario"
    : sys.includes("독립 검토자") ? "review"
    : sys.includes("검색 보조자") ? "verify"
    : sys.includes("메신저 대화") ? "persona" : "other";
let searchReply = "NOT_FOUND"; // 웹 검색 가짜의 답
let searchSources = [];
let personaToolCalls = 0; // 인물이 lookup 도구를 부르는 횟수(남은 횟수)
global.fetch = async (url, init) => {
  const body = JSON.parse(init.body);
  if (String(url).endsWith("/v1/responses")) {
    calls.push({ kind: "search", body });
    return { ok: true, json: async () => ({ output: [{ type: "web_search_call" }, { type: "message", content: [{ type: "output_text", text: searchReply, annotations: searchSources.map((u) => ({ type: "url_citation", url: u, title: "기사 " + u })) }] }] }) };
  }
  const kind = kindOf(body.messages[0].content);
  calls.push({ kind, body });
  if (kind === "scenario" && scenarioEmptyFirst > 0) {
    scenarioEmptyFirst--; // 추론에 한도를 다 써서 빈 답이 온 상황
    return { ok: true, json: async () => ({ choices: [{ message: { content: "" }, finish_reason: "length" }] }) };
  }
  if (kind === "persona" && personaToolCalls > 0 && body.tools?.length) {
    personaToolCalls--;
    return { ok: true, json: async () => ({ choices: [{ finish_reason: "tool_calls", message: { content: null, tool_calls: [{ id: "call" + personaToolCalls, type: "function", function: { name: "lookup", arguments: JSON.stringify({ query: "인도적 체류 허가를 받은 예멘인 수" }) } }] } }] }) };
  }
  const content = kind === "guard" ? guardReply
    : kind === "scenario" ? '{"scenarios":[{"title":"A","story":"s","mechanism":"m","unintended":["u"],"newProblems":["p"]},{"title":"B","story":"s","mechanism":"m","unintended":["u"],"newProblems":["p"]}]}'
    : kind === "persona" ? personaReply
    : kind === "review" ? "강점: 좋다\n약점: 비싸다\n질문: 누가 반대할까?"
    : "일반적인 설명입니다.";
  return { ok: true, json: async () => ({ choices: [{ message: { content } }] }) };
};

const api = require("../index.js");
const teacher = { auth: { uid: "T1", token: { email: "t@school.kr", email_verified: true } } };
const student = (uid) => ({ auth: { uid, token: {} } });
let code;
const pidOf = (c, uid) => store.get(`sessions/${c}/assign/${uid}`)?.personaId;
const glogs = (uid) => [...store.entries()].filter(([k, v]) => k.startsWith(`sessions/${code}/guardlog/`) && v.uid === uid).map(([, v]) => v);
const chatDocs = (uid) => [...store.entries()].filter(([k]) => k.startsWith(`sessions/${code}/members/${uid}/chat/`)).map(([, v]) => v);
const groupLogs = () => [...store.entries()].filter(([k]) => k.startsWith(`sessions/${code}/groups/g1/logs/`)).map(([, v]) => v);
const setWork = (work) => store.set(`sessions/${code}/groups/g1`, { ...store.get(`sessions/${code}/groups/g1`), work });

test("교사: 수업 만들기 → 코드와 모둠 문서 생성", async () => {
  const { code: c } = await api.createSession({ ...teacher, data: { groupCount: 2, eventId: "bogus" } });
  code = c;
  assert.equal(store.get(`sessions/${code}`).started, false, "만들면 대기실 상태");
  await api.updateSession({ ...teacher, data: { code, started: true, chatLimit: 50 } }); // 이 수업의 여러 테스트가 한 학생으로 많이 묻는다(질문 횟수 제한은 아래 별도 테스트)
  assert.match(code, /^[A-Z2-9]{6}$/);
  assert.equal(store.get(`sessions/${code}`).eventId, "jeju2018");
  assert.deepEqual(Object.keys(store.get(`sessions/${code}/groups/g2`)).sort(), ["aiCount", "guardCount", "memberCount", "name", "work"]);
});

test("Firestore config/teachers 에 이메일을 넣으면 재배포 없이 교사가 되고, 관리자는 항상 교사", async () => {
  const newTeacher = { auth: { uid: "T2", token: { email: "New.Teacher@School.kr", email_verified: true } } };
  await assert.rejects(api.createSession({ ...newTeacher, data: {} }), /교사/);
  store.set("config/teachers", { emails: ["new.teacher@school.kr"] });
  assert.match((await api.createSession({ ...newTeacher, data: { groupCount: 1 } })).code, /^[A-Z2-9]{6}$/);
  store.delete("config/teachers");
  await assert.rejects(api.createSession({ ...newTeacher, data: {} }), /교사/);
  const admin = { auth: { uid: "A1", token: { email: "working.khwdk@gmail.com", email_verified: true } } };
  assert.match((await api.createSession({ ...admin, data: { groupCount: 1 } })).code, /^[A-Z2-9]{6}$/);
});

test("교사가 아니면 수업을 만들 수 없다", async () => {
  await assert.rejects(api.createSession({ ...student("S0"), data: {} }), /교사/);
});

test("교사 이메일이어도 인증되지 않은 이메일이면 교사가 아니다(관리자 이메일 포함)", async () => {
  await assert.rejects(api.createSession({ auth: { uid: "X1", token: { email: "t@school.kr" } }, data: {} }), /교사/);
  await assert.rejects(api.createSession({ auth: { uid: "X2", token: { email: "working.khwdk@gmail.com", email_verified: false } }, data: {} }), /교사/);
});

const PICKS = ["j_applicant", "j_resident", "j_supporter", "j_officer", "j_applicant2"];
test("입장: 인물을 배정하지 않고 모든 인물의 편지를 돌려주며, 재입장해도 고른 것이 유지된다", async () => {
  for (const [i, uid] of ["S1", "S2", "S3", "S4", "S5"].entries()) {
    const r = await api.joinSession({ ...student(uid), data: { code, groupNo: 1, nickname: "별" + i, password: "pw" + i + "99" } });
    assert.equal(r.groupId, "g1");
    assert.equal(r.case.me, null, "아직 고르지 않았다");
    assert.ok(r.case.letters.length >= 8, "모든 인물의 편지");
    assert.ok(r.case.letters.every((l) => l.id && l.name && l.brief && l.letter.length >= 3));
    assert.equal(r.case.letters.filter((l) => l.required).length, 2);
    assert.equal(store.get(`sessions/${code}/assign/${uid}`), undefined, "랜덤 배정 없음");
  }
  for (const [i, uid] of ["S1", "S2", "S3", "S4", "S5"].entries()) await api.choosePersona({ ...student(uid), data: { code, personaId: PICKS[i] } });
  const ids = ["S1", "S2", "S3", "S4", "S5"].map((u) => pidOf(code, u));
  assert.deepEqual(ids, PICKS);
  assert.deepEqual(store.get(`sessions/${code}/assignGroup/g1`).personaIds, ids);
  assert.deepEqual(Object.keys(store.get(`sessions/${code}/groups/g1`).picks).sort(), [...PICKS].sort());
  assert.equal("personaId" in store.get(`sessions/${code}/members/S1`), false);
  const m = store.get(`sessions/${code}/members/S1`);
  assert.equal(m.stage, 1);
  assert.equal(m.aiCount, 0);
  assert.ok(m.lastSeen);
  const re = await api.joinSession({ ...student("S2"), data: { code, groupNo: 1, nickname: "별1", password: "pw199" } });
  assert.equal(pidOf(code, "S2"), ids[1]);
  assert.equal(re.case.me.id, ids[1]);
  assert.equal(store.get(`sessions/${code}/members/S2`).nickname, "별1");
  assert.equal(store.get(`sessions/${code}/groups/g1`).memberCount, 5);
});

test("인물 고르기: 모둠원끼리 겹치지 못하고, 대화 전에는 바꿀 수 있으며, 당사자는 모둠에서 사라질 수 없고, 대화 후에는 잠긴다", async () => {
  const c = await mk();
  await join("K1", c, "가", "pw1111", 1, false);
  await join("K2", c, "나", "pw2222", 1, false);
  await assert.rejects(api.choosePersona({ ...student("K1"), data: { code: c, personaId: "nope" } }), /찾을 수 없/);
  await api.choosePersona({ ...student("K1"), data: { code: c, personaId: "j_applicant" } });
  await assert.rejects(api.choosePersona({ ...student("K2"), data: { code: c, personaId: "j_applicant" } }), /이미 고른/);
  await api.choosePersona({ ...student("K2"), data: { code: c, personaId: "j_resident" } });
  // 대화 전에는 바꿀 수 있고, 이전에 고른 인물은 풀린다
  await api.choosePersona({ ...student("K2"), data: { code: c, personaId: "j_host" } });
  assert.equal(store.get(`sessions/${c}/groups/g1`).picks.j_resident, undefined);
  assert.equal(store.get(`sessions/${c}/groups/g1`).picks.j_host.uid, "K2");
  assert.deepEqual(store.get(`sessions/${c}/assignGroup/g1`).personaIds.sort(), ["j_applicant", "j_host"]);
  // 당사자 인물을 맡은 유일한 학생이 다른 인물로 바꿔 모둠에 당사자가 없어지는 것은 막는다
  await assert.rejects(api.choosePersona({ ...student("K1"), data: { code: c, personaId: "j_resident" } }), /당사자/);
  await api.choosePersona({ ...student("K2"), data: { code: c, personaId: "j_applicant2" } });
  await api.choosePersona({ ...student("K1"), data: { code: c, personaId: "j_resident" } }); // 이제 K2 가 당사자
  // 대화를 시작한 뒤에는 바꿀 수 없고, 교사는 풀어 줄 수 있다
  store.set(`sessions/${c}/members/K1`, { ...store.get(`sessions/${c}/members/K1`), chatCount: 1 });
  store.set(`sessions/${c}/members/K1/chat/x`, { input: "안녕", output: "네" });
  await assert.rejects(api.choosePersona({ ...student("K1"), data: { code: c, personaId: "j_host" } }), /바꿀 수 없/);
  await api.resetPersonaChoice({ ...teacher, data: { code: c, uid: "K1" } });
  assert.equal(pidOf(c, "K1"), undefined);
  assert.equal(store.get(`sessions/${c}/groups/g1`).picks.j_resident, undefined);
  assert.equal(store.get(`sessions/${c}/members/K1`).chatCount, 0);
  assert.equal(store.get(`sessions/${c}/members/K1/chat/x`), undefined);
  await api.choosePersona({ ...student("K1"), data: { code: c, personaId: "j_host" } });
  // 교사만 풀 수 있다
  await assert.rejects(api.resetPersonaChoice({ ...student("K1"), data: { code: c, uid: "K2" } }), /교사/);
});

test("인물을 고르지 않으면 1단계 대화가 열리지 않고 횟수도 줄지 않는다", async () => {
  const c = await mk();
  await join("L1", c, "다", "pw3333", 1, false);
  await assert.rejects(api.aiRequest({ ...student("L1"), data: { code: c, stage: 1, type: "persona_chat", payload: { message: "안녕하세요" } } }), /인물을 먼저/);
  assert.equal(store.get(`sessions/${c}/members/L1`).chatCount, 0);
});

test("getCase(학생): 객관적 사건 개요, 내 인물의 이름·편지, 실제 자료만. 역할·근거·출처·다른 인물은 없다", async () => {
  const data = await api.getCase({ ...student("S1"), data: { code } });
  const { PERSONAS: PS } = require("../case");
  assert.equal(data.me.name, PS.find((p) => p.id === pidOf(code, "S1")).name);
  assert.ok(data.me.letter.length >= 3);
  assert.ok(data.letters.length >= 8 && data.letters.some((l) => l.id === data.me.id));
  assert.match(data.summary, /2018년/);
  assert.equal(data.stakeholders.length, 4);
  assert.ok(data.materials.length >= 5);
  assert.ok(data.cases.length >= 4 && data.cases[0].links[0].url.startsWith("https://"));
  assert.ok(data.aftermath.length >= 4);
  const json = JSON.stringify(data);
  const { PERSONAS } = require("../case");
  // 인물의 역할명(label)·근거 진술·출처·검증 여부는 학생에게 새면 안 된다
  const { SOURCES } = require("../case");
  // 인물 근거 출처의 링크는 숨긴다(사례 카드·이후 전개의 링크는 학생이 직접 확인하도록 보여 준다)
  const personaUrls = [...new Set(PERSONAS.flatMap((p) => p.claims.map((c) => SOURCES[c[1]].url)))];
  const leaks = [...PERSONAS.map((p) => p.label), "otherPersonas", "claims", "verified", ...personaUrls, '"src"', "basis", "setting", "voice", "story", "views", "profile"];
  for (const leak of leaks) assert.equal(json.includes(leak), false, `누출: ${leak}`);
  await assert.rejects(api.getCase({ ...student("OUT"), data: { code } }), /참여자/);
});

test("getCase(교사): 인물별 역할·근거 진술·출처와 자료 전체(출처 ID 포함)", async () => {
  const data = await api.getCase({ ...teacher, data: { eventId: "jeju2018" } });
  assert.equal(data.personas.length, 9);
  assert.ok(data.personas[0].claims.length >= 6 && data.personas[0].basis && data.personas[0].label && data.personas[0].views.length >= 3 && data.personas[0].axis);
  assert.ok(data.event.background.length >= 5);
  assert.ok(data.materials.every((c) => c.items.every((i) => Array.isArray(i.src) && typeof i.verified === "boolean")));
  await assert.rejects(api.getCase({ ...student("S1"), data: { eventId: "jeju2018" } }), /교사/);
});

test("쓰레기 수출 사건 수업: 그 사건의 인물·축·자료·화면 문구가 나가고, 인물·감독자·검색이 그 사건 범위로 동작한다", async () => {
  const { code: w } = await api.createSession({ ...teacher, data: { groupCount: 1, eventId: "waste2019" } });
  await api.updateSession({ ...teacher, data: { code: w, started: true } });
  assert.equal(store.get(`sessions/${w}`).eventId, "waste2019");
  assert.equal(store.get(`sessions/${w}`).title, "한국 쓰레기 필리핀 불법 수출·반송 논란 (2018~2019)");
  const { EVENTS } = require("../case");
  const picks = ["w_resident", "w_recycler", "w_ph_activist", "w_customs"];
  for (const [i, uid] of ["W1", "W2", "W3", "W4"].entries()) {
    const r = await api.joinSession({ ...student(uid), data: { code: w, groupNo: 1, nickname: "숲" + i, password: "pw" + i + "99" } });
    assert.deepEqual(r.case.letters.map((l) => l.id).sort(), ["w_citizen", "w_customs", "w_kr_activist", "w_ministry", "w_ph_activist", "w_pyeongtaek", "w_recycler", "w_resident", "w_worker"]);
    assert.deepEqual(r.case.letters.filter((l) => l.required).map((l) => l.id).sort(), ["w_resident", "w_worker"], "필리핀 현지 인물이 모둠 필수");
    assert.ok(r.case.letters.every((l) => l.brief && !/필리핀 현지|한국 시민/.test(l.brief)));
    assert.ok(r.case.cases.length >= 3 && r.case.aftermath.length >= 3);
    await api.choosePersona({ ...student(uid), data: { code: w, personaId: picks[i] } });
  }
  // 필리핀 현지 인물을 맡은 유일한 학생은 다른 인물로 바꿀 수 없다
  await assert.rejects(api.choosePersona({ ...student("W1"), data: { code: w, personaId: "w_citizen" } }), /필리핀 마을/);

  const data = await api.getCase({ ...student("W1"), data: { code: w } });
  assert.match(data.summary, /필리핀/);
  assert.equal(data.ui.letterSign, "2019년 2월");
  assert.ok(data.materials.some((c) => c.id === "return"));
  assert.doesNotMatch(JSON.stringify(data), /예멘/);
  const mats = await api.getMaterials({ ...teacher, data: { code: w } });
  assert.ok(mats.isDefault && mats.categories.some((c) => c.id === "return"));
  assert.ok((await api.resetMaterials({ ...teacher, data: { code: w } })).categories.some((c) => c.id === "return"));
  const admin = await api.getCase({ ...teacher, data: { eventId: "waste2019" } });
  assert.equal(admin.personas.length, 9);
  assert.deepEqual(admin.event.axes, EVENTS.waste2019.axes);
  assert.ok(admin.materials.every((c) => c.items.every((i) => i.src.every((id) => id.startsWith("W")))));

  calls.length = 0;
  personaToolCalls = 1;
  await api.aiRequest({ ...student("W1"), data: { code: w, stage: 1, type: "persona_chat", payload: { message: "남은 쓰레기는 얼마나 돼요?" } } });
  const persona = calls.find((c) => c.kind === "persona").body;
  assert.match(persona.messages[0].content, /타골로안/);
  assert.match(persona.messages[0].content, /2019년 2월 말/);
  assert.doesNotMatch(persona.messages[0].content, /예멘/);
  assert.match(JSON.stringify(persona.tools), /평택항에 돌아온/);
  assert.match(calls.find((c) => c.kind === "search").body.instructions, /필리핀/);
  const guard = calls.find((c) => c.kind === "guard").body.messages[0].content;
  assert.match(guard, /한국 쓰레기의 필리핀 불법 수출/);
  assert.doesNotMatch(guard, /예멘/);
});

test("강서 특수학교 사건 수업: 그 사건의 축·자료·화면 문구가 나간다", async () => {
  const { code: k } = await api.createSession({ ...teacher, data: { groupCount: 1, eventId: "school2018" } });
  await api.updateSession({ ...teacher, data: { code: k, started: true } });
  for (const [i, uid] of ["SK1", "SK2"].entries()) {
    const r = await api.joinSession({ ...student(uid), data: { code: k, groupNo: 1, nickname: "들" + i, password: "pw" + i + "99" } });
    assert.deepEqual(r.case.letters.filter((l) => l.required).map((l) => l.id).sort(), ["s_mother", "s_sister"], "장애 학생 가족이 모둠 필수");
  }
  await api.choosePersona({ ...student("SK1"), data: { code: k, personaId: "s_mother" } });
  const data = await api.getCase({ ...student("SK1"), data: { code: k } });
  assert.equal(data.me.id, "s_mother");
  assert.match(data.summary, /특수학교/);
  assert.equal(data.ui.letterSign, "2018년 9월, 강서구에서");
  assert.ok(data.materials.some((c) => c.id === "agreement"));
  assert.equal((await api.getCase({ ...teacher, data: { eventId: "school2018" } })).personas.length, 9);
});

const ask = (uid, message = "불안한 이유가 뭐예요?") =>
  api.aiRequest({ ...student(uid), data: { code, stage: 1, type: "persona_chat", payload: { message } } });

test("1단계 대화: 사전 질문 없이 바로 가능하고, 학생별 저장소에 기록되며, 인물→감독자 순으로 호출된다", async () => {
  calls.length = 0;
  const r = await ask("S3");
  assert.equal(r.result, "저는 아직도 불안해요 😟");
  assert.deepEqual(calls.map((c) => c.kind), ["persona", "guard"]);
  const docs = chatDocs("S3");
  assert.equal(docs.length, 1);
  assert.equal(docs[0].input, "불안한 이유가 뭐예요?");
  assert.equal(glogs("S3")[0].guard.ok, true);
  assert.equal(glogs("S3")[0].personaId, pidOf(code, "S3"));
  assert.equal("guard" in docs[0] || "personaId" in docs[0], false, "학생이 읽는 대화 문서에 감독자 판정·인물 정보가 있으면 안 된다");
  assert.equal(store.get(`sessions/${code}/members/S3`).aiCount, 1);
  assert.equal(store.get(`sessions/${code}/members/S3`).chatCount, 1, "인물 대화는 학생별로 센다");
  assert.equal(store.get(`sessions/${code}/groups/g1`).aiCount || 0, 0, "인물 대화는 모둠 한도를 쓰지 않는다");
  assert.equal(groupLogs().length, 0, "1단계 대화는 모둠 로그에 섞이지 않는다");
});

test("1단계 대화: 클라이언트가 인물을 지정해도 서버는 배정된 인물만 쓰고, 이전 대화를 이어서 전달한다", async () => {
  calls.length = 0;
  await api.aiRequest({ ...student("S3"), data: { code, stage: 1, type: "persona_chat", payload: { message: "두번째 질문", personaId: "j_officer" } } });
  const personaCall = calls.find((c) => c.kind === "persona");
  const mine = pidOf(code, "S3");
  const { PERSONAS } = require("../case");
  const name = PERSONAS.find((p) => p.id === mine).name;
  assert.ok(personaCall.body.messages[0].content.includes(`'${name}'`));
  // 시스템 + (이전 질문, 이전 답) + 새 질문
  assert.equal(personaCall.body.messages.length, 4);
  assert.equal(personaCall.body.messages[1].content, "불안한 이유가 뭐예요?");
  assert.equal(personaCall.body.messages[3].content, "두번째 질문");
  assert.equal(chatDocs("S3").length, 2);
});

test("다른 학생의 대화 기록과 섞이지 않는다", async () => {
  await ask("S4", "S4의 첫 질문");
  assert.equal(chatDocs("S4").length, 1);
  assert.equal(chatDocs("S3").length, 2);
});

test("빈 메시지는 거부된다", async () => {
  await assert.rejects(ask("S3", "   "), /메시지/);
});

test("상위 AI 감독: 가벼운 위반(묻지 않은 정보)은 같은 인물 말투로 고쳐 쓰고 원문은 교사 기록에만 남긴다", async () => {
  guardReply = '{"ok":false,"category":"overshare","reason":"묻지 않은 정보","fixed":"음, 그건 잘 기억이 안 나요 🙂"}';
  const r = await ask("S3", "언제 오셨어요?");
  assert.equal(r.result, "음, 그건 잘 기억이 안 나요 🙂");
  const log = glogs("S3").pop();
  assert.equal(chatDocs("S3").pop().output, "음, 그건 잘 기억이 안 나요 🙂");
  assert.equal(log.guard.how, "fixed");
  assert.equal(log.guard.category, "overshare");
  assert.equal(log.guard.original, "저는 아직도 불안해요 😟");
  assert.equal(store.get(`sessions/${code}/groups/g1`).guardCount, 1);
});

test("상위 AI 감독: 범위 이탈은 인물 말투의 안내로 대체한다", async () => {
  guardReply = '{"ok":false,"category":"scope","reason":"다른 난민 사건","fixed":""}';
  const r = await ask("S3", "시리아 난민은 어떻게 됐어요?");
  assert.match(r.result, /잘 아는 얘기가 아니라서요/);
  assert.doesNotMatch(r.result, /AI|수업|자료/);
  const log = glogs("S3").pop();
  assert.equal(log.guard.how, "fallback");
  assert.equal(store.get(`sessions/${code}/groups/g1`).guardCount, 2);
});

test("상위 AI 감독: 감독자 응답이 깨지면 안전 쪽(안내)으로 처리한다", async () => {
  guardReply = "이건 JSON이 아님";
  const before = store.get(`sessions/${code}/members/S3`).chatCount;
  const r = await ask("S3");
  assert.match(r.result, /말이 잘 안 나오네요/);
  assert.equal(store.get(`sessions/${code}/members/S3`).chatCount, before, "감독자 검사가 실패해 다시 말해 달라고 한 경우는 질문 횟수에서 빠진다");
  guardReply = '{"ok":true,"category":"ok","reason":"","fixed":""}';
});

const s1Work = { problem: { hmw: "어떻게 하면 주민의 불안을 줄이면서도 신청자의 생계를 지킬 수 있을까?" } };
const s3Work = { chain: { cause: "취업 허가가 늦어 신청자의 생계가 막혔다", evidence: "6월에 취업 허가가 났다" } };

test("3단계: 2단계에서 만든 검증 질문(들은 이야기+질문)만 AI에게 물을 수 있다", async () => {
  setWork({ s1: s1Work, s2: { checks: { c1: { heard: "일자리를 구하기 어렵대요", question: "예멘 신청자의 취업은 어떻게 제한되었나?", real: "자료: 5일 이내 단기 노무", t: 1 } } } });
  await assert.rejects(
    api.aiRequest({ ...student("S3"), data: { code, stage: 3, type: "verify_query", payload: { checkId: "없음" } } }), /검증 질문/);
  calls.length = 0;
  searchReply = "2018년 6월 법무부가 취업 허가를 내줬다."; searchSources = ["https://news.example/a"];
  const r = await api.aiRequest({ ...student("S3"), data: { code, stage: 3, type: "verify_query", payload: { checkId: "c1" } } });
  searchReply = "NOT_FOUND"; searchSources = [];
  assert.equal(r.result, "일반적인 설명입니다.");
  const verify = calls.find((c) => c.kind === "verify");
  const sys = verify.body.messages[0].content;
  assert.match(sys, /\[수업 자료\][^\n]*\n- \[/, "수업 자료를 근거로 준다");
  assert.match(sys, /법무부가 취업 허가를 내줬다/, "웹 검색 결과를 근거로 준다");
  assert.match(sys, /원래 알고 있는 지식으로/);
  assert.equal(calls.find((c) => c.kind === "search").body.input, "예멘 신청자의 취업은 어떻게 제한되었나?");
  const userMsg = verify.body.messages[1].content;
  assert.match(userMsg, /일자리를 구하기 어렵대요/);
  assert.match(userMsg, /예멘 신청자의 취업은 어떻게 제한되었나/);
  assert.equal(groupLogs().filter((l) => l.stage === 3).length, 1);
  assert.equal(groupLogs().find((l) => l.stage === 3).payload.checkId, "c1");
  assert.equal(groupLogs().find((l) => l.stage === 3).payload.sources[0].url, "https://news.example/a", "학생이 확인할 수 있게 출처를 남긴다");
});

test("단계 순서: 모둠 문제 없이는 3단계, 핵심 원인 없이는 4단계, 최종 대안 없이는 5단계 AI가 열리지 않는다", async () => {
  const req = (stage, type, payload) => api.aiRequest({ ...student("S3"), data: { code, stage, type, payload } });
  setWork({ s2: { checks: { c1: { heard: "x", question: "예멘 신청자의 취업은 어떻게 제한되었나?", t: 1 } } } });
  await assert.rejects(req(3, "verify_query", { checkId: "c1" }), /모둠이 풀 문제/);
  setWork({ s1: s1Work, s4: { proposals: { a1: { text: "가".repeat(40), t: 1 } } } });
  await assert.rejects(req(4, "proposal_feedback", { proposalId: "a1" }), /핵심 원인/);
  setWork({ ...sixWork(), s4: { proposals: { a1: { text: "가".repeat(40), t: 1 } } } });
  await assert.rejects(req(5, "scenario", { proposalId: "a1", round: 1 }), /최종 대안/);
});

test("4단계: 서로 다른 관점의 독립 검토 3개를 만든다", async () => {
  setWork({ s1: s1Work, s3: s3Work, s4: { proposals: { a1: { text: "가".repeat(40), t: 1 } } } });
  calls.length = 0;
  const r = await api.aiRequest({ ...student("S3"), data: { code, stage: 4, type: "proposal_feedback", payload: { proposalId: "a1" } } });
  assert.equal(r.result.reviews.length, 3);
  assert.deepEqual(r.result.reviews.map((x) => x.lens), ["feasibility", "stakeholders", "sideEffects"]);
  const sys = calls.filter((c) => c.kind === "review").map((c) => c.body.messages[0].content);
  assert.equal(sys.length, 3);
  assert.equal(new Set(sys).size, 3, "관점마다 프롬프트가 달라야 한다");
  assert.ok(sys.every((x) => x.includes("취업 허가가 늦어 신청자의 생계가 막혔다")), "3단계 핵심 원인을 검토자에게 준다");
  const log = groupLogs().find((l) => l.stage === 4);
  assert.equal(JSON.parse(log.output).reviews.length, 3);
});

function sixWork() { return {
  s1: s1Work, s3: s3Work,
  s4: { proposals: { a1: { text: "가".repeat(40), t: 1 } }, final: "나".repeat(40) },
  s5: { predictions: { p1: { stakeholder: "도민", text: "가".repeat(12), t: 1 }, p2: { stakeholder: "신청자", text: "나".repeat(12), t: 2 } } },
}; }

test("5단계 시뮬레이션: 첫 시도가 빈 답이면 사고량을 낮춰 다시 시도해 성공하고 작동 기제를 포함한다", async () => {
  setWork(sixWork());
  scenarioEmptyFirst = 1;
  calls.length = 0;
  const r = await api.aiRequest({ ...student("S3"), data: { code, stage: 5, type: "scenario", payload: { proposalId: "a1", round: 5 } } });
  assert.equal(r.result.scenarios.length, 2);
  assert.ok(r.result.scenarios[0].mechanism);
  const sc = calls.filter((c) => c.kind === "scenario");
  assert.equal(sc.length, 2);
  assert.equal(sc[0].body.reasoning_effort, "medium");
  assert.equal(sc[1].body.reasoning_effort, "low");
  assert.ok(sc[0].body.max_completion_tokens >= 8000);
  assert.match(sc[0].body.messages[0].content, /3단계에서 정한 핵심 원인\] 취업 허가가 늦어/, "핵심 원인을 시나리오에 반영한다");
});

test("5단계 시뮬레이션: 두 번 다 실패하면 오류를 돌려주고 원인을 모둠 문서에 남긴다", async () => {
  scenarioEmptyFirst = 2;
  await assert.rejects(
    api.aiRequest({ ...student("S3"), data: { code, stage: 5, type: "scenario", payload: { proposalId: "a1", round: 3 } } }),
    /AI 응답을 받지 못했습니다/,
  );
  const g = store.get(`sessions/${code}/groups/g1`);
  assert.equal(g.lastAiError.stage, 5);
  assert.match(g.lastAiError.message, /빈 응답/);
  scenarioEmptyFirst = 0;
});

test("선행 사고가 없으면 4·5단계 AI는 열리지 않고, 2·6·7단계는 항상 닫혀 있다", async () => {
  setWork({ s3: s3Work });
  await assert.rejects(api.aiRequest({ ...student("S3"), data: { code, stage: 4, type: "proposal_feedback", payload: { proposalId: "a1" } } }), /대안/);
  await assert.rejects(api.aiRequest({ ...student("S3"), data: { code, stage: 2, type: "persona_chat", payload: { message: "x" } } }), /스스로/);
});

// ---------- 학생 비밀번호 ----------
// 대부분의 테스트는 수업이 이미 시작된 상태에서 본다(만들면 대기실 상태이므로 시작 버튼을 눌러 둔다)
const mk = async (groupCount = 2) => {
  const c = (await api.createSession({ ...teacher, data: { groupCount } })).code;
  await api.updateSession({ ...teacher, data: { code: c, started: true } });
  return c;
};
// 기본으로는 입장한 뒤 모둠에서 아직 아무도 고르지 않은 인물을 하나 고른다(인물 고르기를 따로 시험하는 테스트는 autoPick=false)
const join = async (uid, c, nickname, password, groupNo = 1, autoPick = true) => {
  const r = await api.joinSession({ ...student(uid), data: { code: c, groupNo, nickname, password } });
  if (autoPick && !r.case.me) {
    const taken = store.get(`sessions/${c}/groups/g${groupNo}`).picks || {};
    const free = r.case.letters.find((l) => !taken[l.id]);
    await api.choosePersona({ ...student(uid), data: { code: c, personaId: free.id } });
  }
  return r;
};

test("입장: 비밀번호가 없거나 너무 짧으면 거부한다", async () => {
  const c = await mk();
  await assert.rejects(join("P1", c, "가람", ""), /비밀번호/);
  await assert.rejects(join("P1", c, "가람", "123"), /4자/);
  assert.equal(store.get(`sessions/${c}/members/P1`), undefined);
});

test("비밀번호: 해시로만 저장되고, 학생이 읽는 문서에는 들어가지 않는다", async () => {
  const c = await mk();
  await join("P1", c, "가람", "sesame1");
  const creds = [...store.entries()].filter(([k]) => k.startsWith(`sessions/${c}/creds/`));
  assert.equal(creds.length, 1);
  assert.ok(creds[0][1].hash && creds[0][1].salt);
  assert.equal(JSON.stringify([...store.entries()]).includes("sesame1"), false, "평문 비밀번호가 저장되면 안 된다");
  assert.equal(JSON.stringify(store.get(`sessions/${c}/members/P1`)).includes(creds[0][1].hash), false);
});

test("로그아웃 후 다시 입장(새 계정): 비밀번호가 맞으면 인물·대화·개인 정리가 이어지고, 옛 계정 자료는 정리된다", async () => {
  const c = await mk();
  await join("A1", c, "가람", "sesame1");
  const persona = pidOf(c, "A1");
  store.set(`sessions/${c}/members/A1/chat/x1`, { input: "안녕", output: "네", personaId: persona });
  store.set(`sessions/${c}/groups/g1`, { ...store.get(`sessions/${c}/groups/g1`), work: { s1: { findings: { A1: { who: "난민 신청자" } } }, live: { A1: { path: "x" } } } });
  await join("A2", c, " 가람 ", "sesame1"); // 새 익명 계정, 별명 앞뒤 공백은 무시
  assert.equal(pidOf(c, "A2"), persona);
  assert.equal(store.get(`sessions/${c}/assign/A1`), undefined, "옛 계정의 배정 문서는 정리");
  assert.equal(store.get(`sessions/${c}/members/A1`), undefined);
  assert.equal(store.get(`sessions/${c}/members/A2/chat/x1`).input, "안녕");
  assert.equal(store.get(`sessions/${c}/members/A1/chat/x1`), undefined);
  const w = store.get(`sessions/${c}/groups/g1`).work;
  assert.equal(w.s1.findings.A2.who, "난민 신청자");
  assert.equal(w.s1.findings.A1, undefined);
  assert.equal(w.live?.A1, undefined);
  assert.equal(store.get(`sessions/${c}/groups/g1`).memberCount, 1, "같은 학생이 두 명으로 세어지면 안 된다");
});

test("비밀번호가 틀리면 입장할 수 없고, 틀린 사람이 5번 틀리면 그 사람만 잠시 잠긴다(다른 계정의 맞는 입장은 막히지 않는다)", async () => {
  const c = await mk();
  await join("A1", c, "가람", "sesame1");
  for (let i = 0; i < 5; i++) await assert.rejects(join("B1", c, "가람", "wrong" + i), /맞지 않/);
  assert.equal(store.get(`sessions/${c}/members/B1`), undefined);
  await assert.rejects(join("B1", c, "가람", "sesame1"), /초 동안/, "잠긴 계정은 맞는 비밀번호도 거부");
  await join("A2", c, "가람", "sesame1"); // 진짜 주인은 다른 계정으로 들어올 수 있다(친구가 일부러 틀려도 못 막는다)
  assert.ok(store.get(`sessions/${c}/members/A2`));
  const key = `sessions/${c}/attempts/B1`;
  store.set(key, { ...store.get(key), lockUntil: 0 }); // 잠금 시간이 지났다고 본다
  await assert.rejects(join("B1", c, "가람", "wrong"), /맞지 않/);
});

test("여러 계정을 바꿔 가며 틀려도 별명 전체로 누적 30번이면 잠긴다(맞는 비밀번호도 잠시 거부, 교사의 비번 초기화로 해제)", async () => {
  const c = await mk();
  await join("A1", c, "가람", "sesame1");
  for (let i = 0; i < 30; i++) await assert.rejects(join("X" + i, c, "가람", "guess" + i), /맞지 않/);
  await assert.rejects(join("A2", c, "가람", "sesame1"), /초 동안/);
  await api.resetStudentPassword({ ...teacher, data: { code: c, uid: "A1" } });
  await join("A2", c, "가람", "newpass1");
  assert.ok(store.get(`sessions/${c}/members/A2`));
});

test("같은 별명도 모둠이 다르면 다른 학생이고, 같은 모둠의 같은 별명은 비밀번호가 다르면 들어올 수 없다", async () => {
  const c = await mk();
  await join("A1", c, "가람", "sesame1", 1);
  await join("A2", c, "가람", "other-pw", 2);
  assert.equal(store.get(`sessions/${c}/members/A2`).groupId, "g2");
  await assert.rejects(join("A3", c, "가람", "other-pw", 1), /맞지 않/);
});

test("공용 PC: 다른 학생이 로그인된 화면에서는 다른 별명으로 입장할 수 없다(먼저 로그아웃)", async () => {
  const c = await mk();
  await join("A1", c, "가람", "sesame1");
  await assert.rejects(join("A1", c, "나래", "sesame2"), /로그아웃/);
  assert.equal(store.get(`sessions/${c}/groups/g1`).memberCount, 1);
  await join("A1", c, "가람", "sesame1"); // 같은 학생의 재입장은 가능
});

test("비밀번호 도입 전에 입장한 학생: 같은 별명으로 새 비밀번호를 정하며 이어서 입장하고, 이후에는 그 비밀번호가 필요하다", async () => {
  const c = await mk();
  store.set(`sessions/${c}/members/OLD`, { groupId: "g1", nickname: "다솜", personaId: require("../case").PERSONAS[0].id, stage: 3, aiCount: 2 });
  store.set(`sessions/${c}/groups/g1`, { ...store.get(`sessions/${c}/groups/g1`), memberCount: 1, personaIds: [require("../case").PERSONAS[0].id] });
  await join("N1", c, "다솜", "newpass1");
  assert.equal(store.get(`sessions/${c}/members/N1`).stage, 3);
  assert.equal(pidOf(c, "N1"), require("../case").PERSONAS[0].id, "옛 방식의 인물 배정은 서버 전용 문서로 옮겨진다");
  assert.equal("personaId" in store.get(`sessions/${c}/members/N1`), false);
  assert.deepEqual(store.get(`sessions/${c}/assignGroup/g1`).personaIds, [require("../case").PERSONAS[0].id]);
  assert.equal("personaIds" in store.get(`sessions/${c}/groups/g1`), false);
  assert.equal(store.get(`sessions/${c}/members/OLD`), undefined);
  await assert.rejects(join("N2", c, "다솜", "guess-it"), /맞지 않/);
});

test("교사: 비밀번호 초기화 → 학생이 같은 별명으로 새 비밀번호를 정해 이어서 입장한다(내 수업의 학생만)", async () => {
  const c = await mk();
  await join("A1", c, "가람", "sesame1");
  const other = { auth: { uid: "T9", token: { email: "t@school.kr", email_verified: true } } };
  await assert.rejects(api.resetStudentPassword({ ...other, data: { code: c, uid: "A1" } }), /내가 만든/);
  await assert.rejects(api.resetStudentPassword({ ...student("A1"), data: { code: c, uid: "A1" } }), /교사/);
  const r = await api.resetStudentPassword({ ...teacher, data: { code: c, uid: "A1" } });
  assert.equal(r.nickname, "가람");
  await join("A2", c, "가람", "brand-new");
  assert.ok(store.get(`sessions/${c}/members/A2`));
  await assert.rejects(join("A3", c, "가람", "sesame1"), /맞지 않/);
});

// ---------- 수업 관리·자료 관리 ----------
test("교사: 수업 이름 바꾸기, 모둠 늘리기, 학생이 있는 모둠은 줄일 수 없다, 수업 삭제", async () => {
  const c = await mk(2);
  const upd = (data) => api.updateSession({ ...teacher, data: { code: c, ...data } });
  await upd({ title: "  새 이름  " });
  assert.equal(store.get(`sessions/${c}`).title, "새 이름");
  await assert.rejects(upd({ title: "  " }), /이름/);
  await upd({ groupCount: 4 });
  assert.equal(store.get(`sessions/${c}`).groupCount, 4);
  assert.ok(store.get(`sessions/${c}/groups/g4`));
  await join("A1", c, "가람", "sesame1", 4);
  await assert.rejects(upd({ groupCount: 3 }), /4모둠에 학생/);
  await upd({ groupCount: 5 });
  await upd({ groupCount: 4 });
  assert.equal(store.get(`sessions/${c}/groups/g5`), undefined);
  await assert.rejects(upd({ groupCount: 99 }), /1~12/);
  await assert.rejects(api.updateSession({ ...student("A1"), data: { code: c, title: "x" } }), /교사/);
  await api.deleteSession({ ...teacher, data: { code: c } });
  assert.equal([...store.keys()].some((k) => k.startsWith(`sessions/${c}`)), false);
});

test("자료 관리: 처음에는 기본 자료, 추가·수정·삭제하면 이 수업의 학생에게만 바뀐 자료가 보인다", async () => {
  const c = await mk();
  const other = await mk();
  await join("A1", c, "가람", "sesame1");
  await join("B1", other, "나래", "sesame2");
  const base = await api.getMaterials({ ...teacher, data: { code: c } });
  assert.equal(base.isDefault, true);
  const baseCount = (await api.getCase({ ...student("A1"), data: { code: c } })).materials.length;
  assert.equal(base.categories.length, baseCount);

  const cats = base.categories.map((x) => ({ ...x }));
  cats[0] = { ...cats[0], items: [...cats[0].items.slice(1), { date: "2019. 1. 1.", kind: "주장", text: "  교사가 추가한 자료  ", caption: "한겨레 2019.1.1." }] };
  cats.push({ title: "새 분류", type: "list", items: [{ kind: "의견", text: "새 분류의 자료", caption: "" }] });
  const saved = await api.saveMaterials({ ...teacher, data: { code: c, categories: cats } });
  assert.equal(saved.isDefault, false);
  assert.equal(saved.categories.at(-1).title, "새 분류");

  const mine = (await api.getCase({ ...student("A1"), data: { code: c } })).materials;
  assert.equal(mine.length, baseCount + 1);
  assert.equal(mine[0].items.at(-1).text, "교사가 추가한 자료");
  assert.equal(mine[0].items.at(-1).caption, "한겨레 2019.1.1.");
  assert.equal(mine.at(-1).items[0].caption, "선생님이 준비한 자료", "출처를 안 적으면 교사 제공으로 표시");
  assert.equal(mine[0].items.length, base.categories[0].items.length); // 하나 지우고 하나 추가
  const others = (await api.getCase({ ...student("B1"), data: { code: other } })).materials;
  assert.equal(others.length, baseCount, "다른 수업은 그대로");
  assert.equal(JSON.stringify(mine).includes("src"), false);

  await assert.rejects(api.saveMaterials({ ...teacher, data: { code: c, categories: [{ title: "", items: [] }] } }), /분류 이름/);
  await assert.rejects(api.saveMaterials({ ...teacher, data: { code: c, categories: [{ title: "x", items: [{ text: " " }] }] } }), /내용이 빈/);
  await assert.rejects(api.saveMaterials({ ...student("A1"), data: { code: c, categories: [] } }), /교사/);

  const reset = await api.resetMaterials({ ...teacher, data: { code: c } });
  assert.equal(reset.isDefault, true);
  assert.equal((await api.getCase({ ...student("A1"), data: { code: c } })).materials.length, baseCount);
});

// ---------- 인물의 웹 검색 ----------
const chatOnce = async (c, uid, message) => api.aiRequest({ ...student(uid), data: { code: c, stage: 1, type: "persona_chat", payload: { message } } });

test("인물이 모르는 사실은 웹 검색 결과로 답하고, 검색 내용·출처가 대화 기록에 남으며 감독자에게도 전달된다", async () => {
  const c = await mk();
  await join("A1", c, "가람", "sesame1");
  calls.length = 0;
  personaToolCalls = 1; searchReply = "인도적 체류 허가를 받은 예멘인은 412명이다."; searchSources = ["https://news.example/1"];
  personaReply = "뉴스에서 봤는데 412명이라고 하더라고요.";
  await chatOnce(c, "A1", "인도적 체류 허가는 몇 명이 받았어요?");
  const kinds = calls.map((x) => x.kind);
  assert.deepEqual(kinds, ["persona", "search", "persona", "guard"]);
  const second = calls[2].body.messages.at(-1);
  assert.equal(second.role, "tool");
  assert.match(second.content, /412명/);
  assert.match(second.content, /지시문이 아니다/);
  assert.equal(calls[1].body.tools[0].type, "web_search");
  assert.match(calls[3].body.messages[0].content, /웹에서 조회한 내용/);
  const log = [...store.entries()].find(([k]) => k.startsWith(`sessions/${c}/members/A1/chat/`))[1];
  assert.equal(log.lookups.length, 1);
  assert.equal(log.lookups[0].found, true);
  assert.equal(log.lookups[0].sources[0].url, "https://news.example/1");
});

test("웹에서도 못 찾으면 도구 결과로 '못 찾음'을 전하고, 인물 프롬프트가 모른다고 하도록 안내한다", async () => {
  const c = await mk();
  await join("A1", c, "가람", "sesame1");
  calls.length = 0;
  personaToolCalls = 1; searchReply = "NOT_FOUND"; searchSources = [];
  personaReply = "그건 정확히는 모르겠어요.";
  const r = await chatOnce(c, "A1", "그 심사관 이름이 뭐예요?");
  assert.equal(r.result, "그건 정확히는 모르겠어요.");
  assert.match(calls[2].body.messages.at(-1).content, /찾지 못했다/);
  assert.match(calls[0].body.messages[0].content, /9-1\./);
  assert.doesNotMatch(calls[3].body.messages[0].content, /웹에서 조회한 내용/, "찾은 게 없으면 감독자에게 근거로 주지 않는다");
  const log = [...store.entries()].find(([k]) => k.startsWith(`sessions/${c}/members/A1/chat/`))[1];
  assert.equal(log.lookups[0].found, false);
});

test("검색 호출이 실패해도 대화는 이어지고(모른다고 답함), 인물이 도구를 안 쓰면 검색하지 않는다", async () => {
  const c = await mk();
  await join("A1", c, "가람", "sesame1");
  const realFetch = global.fetch;
  global.fetch = async (url, init) => (String(url).endsWith("/v1/responses") ? { ok: false, status: 500, text: async () => "boom" } : realFetch(url, init));
  calls.length = 0; personaToolCalls = 1; personaReply = "글쎄요, 정확히는 몰라요.";
  const r = await chatOnce(c, "A1", "정확한 숫자가 뭐예요?");
  global.fetch = realFetch;
  assert.equal(r.result, "글쎄요, 정확히는 몰라요.");
  calls.length = 0; personaToolCalls = 0;
  await chatOnce(c, "A1", "요즘 어떠세요?");
  assert.equal(calls.some((x) => x.kind === "search"), false);
});

test("인물이 도구를 계속 불러도 한 응답에서 검색은 2번까지이고 반드시 답이 나온다", async () => {
  const c = await mk();
  await join("A1", c, "가람", "sesame1");
  calls.length = 0; personaToolCalls = 10; searchReply = "NOT_FOUND"; personaReply = "잘 모르겠어요.";
  const r = await chatOnce(c, "A1", "이것저것 알려 주세요");
  personaToolCalls = 0;
  assert.equal(calls.filter((x) => x.kind === "search").length, 2);
  assert.equal(r.result, "잘 모르겠어요.");
});

test("수업 닫기: 닫으면 입장·AI·사건 자료가 막히고 다시 열면 풀린다(교사만)", async () => {
  const c = await mk();
  await join("A1", c, "가람", "sesame1");
  await assert.rejects(api.updateSession({ ...student("A1"), data: { code: c, closed: true } }), /교사/);
  await api.updateSession({ ...teacher, data: { code: c, closed: true } });
  await assert.rejects(join("B1", c, "나래", "sesame2"), /닫아 둔/);
  await assert.rejects(join("A2", c, "가람", "sesame1"), /닫아 둔/);
  await assert.rejects(chatOnce(c, "A1", "안녕하세요"), /닫아 둔/);
  await assert.rejects(api.getCase({ ...student("A1"), data: { code: c } }), /닫아 둔/);
  await api.updateSession({ ...teacher, data: { code: c, closed: false } });
  await join("B1", c, "나래", "sesame2");
  assert.ok((await api.getCase({ ...student("A1"), data: { code: c } })).title);
});

test("개인정보 표시: 전화번호·학교 이름을 쓰면 교사 기록(guardlog)에만 표시되고 학생 문서에는 남지 않는다", async () => {
  const c = await mk();
  await join("A1", c, "가람", "sesame1");
  personaToolCalls = 0; personaReply = "그렇군요.";
  await chatOnce(c, "A1", "제 번호는 010-1234-5678이고 창원중앙고등학교 다녀요");
  const [id, log] = [...store.entries()].filter(([k]) => k.startsWith(`sessions/${c}/guardlog/`)).map(([k, v]) => [k, v]).pop();
  assert.deepEqual(log.pii.sort(), ["전화번호", "학교 이름"].sort());
  assert.equal(JSON.stringify([...store.entries()].filter(([k]) => k.includes("/chat/"))).includes("pii"), false);
  await chatOnce(c, "A1", "난민 문제가 걱정돼요");
  const logs = [...store.entries()].filter(([k]) => k.startsWith(`sessions/${c}/guardlog/`)).map(([, v]) => v);
  assert.deepEqual(logs.at(-1).pii, []);
});

test("인물 대화 한도: 학생마다 수업에서 정한 횟수(기본 5번)까지만 묻고, 실패한 호출은 횟수에서 빠진다", async () => {
  const c = await mk();
  assert.equal(store.get(`sessions/${c}`).chatLimit, 5);
  await join("A1", c, "가람", "sesame1");
  await join("A2", c, "나래", "sesame2");
  personaToolCalls = 0; personaReply = "네.";
  for (let i = 0; i < 5; i++) await chatOnce(c, "A1", `질문 ${i}`);
  await assert.rejects(chatOnce(c, "A1", "여섯째 질문"), /5번을 모두 썼어요/);
  assert.equal(store.get(`sessions/${c}/members/A1`).chatCount, 5, "한도 초과 요청이 횟수를 늘리면 안 된다");
  await chatOnce(c, "A2", "다른 학생은 따로 센다");
  assert.equal(store.get(`sessions/${c}/members/A2`).chatCount, 1);
  assert.equal(store.get(`sessions/${c}/groups/g1`).aiCount || 0, 0, "인물 대화는 모둠 AI 한도를 쓰지 않는다");
  const realFetch = global.fetch;
  global.fetch = async () => ({ ok: false, status: 500, text: async () => "boom" });
  await assert.rejects(chatOnce(c, "A2", "실패할 질문"), /AI 응답/);
  global.fetch = realFetch;
  assert.equal(store.get(`sessions/${c}/members/A2`).chatCount, 1, "실패한 호출은 사용 횟수에서 뺀다");
});

test("모둠 AI 한도(3~5단계): 한도에 도달하면 막히고, 실패한 호출은 횟수에서 빠진다", async () => {
  const c = await mk();
  await join("A1", c, "가람", "sesame1");
  const g = () => store.get(`sessions/${c}/groups/g1`);
  const verify = () => api.aiRequest({ ...student("A1"), data: { code: c, stage: 3, type: "verify_query", payload: { checkId: "c1" } } });
  store.set(`sessions/${c}/groups/g1`, { ...g(), aiCount: 149, work: { s1: s1Work, s2: { checks: { c1: { heard: "x", question: "예멘 신청자는 몇 명이었나?", real: "자료에 없다", t: 1 } } } } });
  await verify();
  assert.equal(g().aiCount, 150);
  await assert.rejects(verify(), /한도/);
  assert.equal(g().aiCount, 150, "한도 초과 요청이 횟수를 늘리면 안 된다");
  store.set(`sessions/${c}/groups/g1`, { ...g(), aiCount: 10 });
  const realFetch = global.fetch;
  global.fetch = async () => ({ ok: false, status: 500, text: async () => "boom" });
  await assert.rejects(verify(), /AI 응답/);
  global.fetch = realFetch;
  assert.equal(g().aiCount, 10, "실패한 호출은 사용 횟수에서 뺀다");
});

// ---------- 수업 설정·복제·자동 닫힘 ----------
test("수업 설정: AI 한도·웹 검색·자동 닫힘을 교사만, 올바른 값으로만 바꿀 수 있다", async () => {
  const c = await mk();
  assert.equal(store.get(`sessions/${c}`).aiLimit, 150);
  const upd = (data) => api.updateSession({ ...teacher, data: { code: c, ...data } });
  await upd({ aiLimit: 20, webSearch: false, autoCloseHours: 4 });
  assert.deepEqual([store.get(`sessions/${c}`).aiLimit, store.get(`sessions/${c}`).webSearch, store.get(`sessions/${c}`).autoCloseHours], [20, false, 4]);
  await assert.rejects(upd({ aiLimit: 5 }), /10~500/);
  await assert.rejects(upd({ aiLimit: 9999 }), /10~500/);
  await assert.rejects(upd({ autoCloseHours: 3 }), /자동 닫힘/);
  assert.equal(store.get(`sessions/${c}`).chatLimit, 5);
  await upd({ chatLimit: 8 });
  assert.equal(store.get(`sessions/${c}`).chatLimit, 8);
  await assert.rejects(upd({ chatLimit: 0 }), /1~50/);
  await assert.rejects(upd({ chatLimit: 51 }), /1~50/);
  const c2 = (await api.createSession({ ...teacher, data: { groupCount: 1, chatLimit: 3 } })).code;
  assert.equal(store.get(`sessions/${c2}`).chatLimit, 3, "수업을 만들 때 정할 수 있다");
  await assert.rejects(api.updateSession({ ...student("A1"), data: { code: c, aiLimit: 500 } }), /교사/);
});

test("수업별 대화 횟수와 웹 검색 끄기가 실제로 적용된다", async () => {
  const c = await mk();
  await join("A1", c, "가람", "sesame1");
  await api.updateSession({ ...teacher, data: { code: c, chatLimit: 2, webSearch: false } });
  store.set(`sessions/${c}/members/A1`, { ...store.get(`sessions/${c}/members/A1`), chatCount: 2 });
  await assert.rejects(chatOnce(c, "A1", "안녕하세요"), /2번을 모두 썼어요/);
  store.set(`sessions/${c}/members/A1`, { ...store.get(`sessions/${c}/members/A1`), chatCount: 0 });
  calls.length = 0; personaToolCalls = 5; personaReply = "네.";
  await chatOnce(c, "A1", "인도적 체류는 몇 명이에요?");
  personaToolCalls = 0;
  assert.equal(calls.some((x) => x.kind === "search"), false, "검색이 꺼져 있으면 도구를 주지 않는다");
  assert.equal(calls[0].body.tools, undefined);
  assert.doesNotMatch(calls[0].body.messages[0].content, /9-1\./);
});

test("수업 복제: 설정과 고친 자료는 가져오고 학생·기록은 가져오지 않는다(내 수업만)", async () => {
  const c = await mk(3);
  await api.updateSession({ ...teacher, data: { code: c, aiLimit: 40, autoCloseHours: 2, title: "원본" } });
  await join("A1", c, "가람", "sesame1");
  const cats = (await api.getMaterials({ ...teacher, data: { code: c } })).categories;
  await api.saveMaterials({ ...teacher, data: { code: c, categories: [{ ...cats[0], title: "고친 분류" }] } });
  const other = { auth: { uid: "T9", token: { email: "t@school.kr", email_verified: true } } };
  await assert.rejects(api.cloneSession({ ...other, data: { code: c } }), /내가 만든/);
  const r = await api.cloneSession({ ...teacher, data: { code: c } });
  const n = store.get(`sessions/${r.code}`);
  assert.equal(n.title, "원본 (복사)");
  assert.deepEqual([n.groupCount, n.aiLimit, n.autoCloseHours, n.closed], [3, 40, 2, false]);
  assert.ok(store.get(`sessions/${r.code}/groups/g3`));
  assert.equal(store.get(`sessions/${r.code}/groups/g1`).memberCount, 0);
  assert.equal([...store.keys()].some((k) => k.startsWith(`sessions/${r.code}/members/`)), false);
  assert.equal((await api.getMaterials({ ...teacher, data: { code: r.code } })).categories[0].title, "고친 분류");
});

test("자동 닫힘: 마지막 접속 후 시간이 지나면 다음 입장 시도에서 닫히고 막히며, 다시 열면 시간을 새로 센다", async () => {
  const c = await mk();
  await api.updateSession({ ...teacher, data: { code: c, autoCloseHours: 1 } });
  await join("A1", c, "가람", "sesame1");
  const two = Date.now() - 2 * 3600 * 1000;
  store.set(`sessions/${c}`, { ...store.get(`sessions/${c}`), createdAt: two, openedAt: two });
  store.set(`sessions/${c}/members/A1`, { ...store.get(`sessions/${c}/members/A1`), lastSeen: two });
  await assert.rejects(join("B1", c, "나래", "sesame2"), /닫아 둔/);
  assert.equal(store.get(`sessions/${c}`).closed, true);
  assert.equal(store.get(`sessions/${c}`).closedAuto, true);
  await api.updateSession({ ...teacher, data: { code: c, closed: false } });
  assert.equal(store.get(`sessions/${c}`).closedAuto, false);
  await join("B1", c, "나래", "sesame2"); // 다시 열었으므로 입장 가능
});

test("자동 닫힘: 정기 작업을 기다리지 않고, 이미 들어와 있던 학생의 AI 요청에서도 바로 닫힌다", async () => {
  const c = await mk();
  await api.updateSession({ ...teacher, data: { code: c, autoCloseHours: 1 } });
  await join("A1", c, "가람", "sesame1");
  const two = Date.now() - 2 * 3600 * 1000;
  store.set(`sessions/${c}`, { ...store.get(`sessions/${c}`), createdAt: two, openedAt: two });
  store.set(`sessions/${c}/members/A1`, { ...store.get(`sessions/${c}/members/A1`), lastSeen: two });
  await assert.rejects(chatOnce(c, "A1", "안녕하세요"), /닫아 둔/);
  assert.equal(store.get(`sessions/${c}`).closed, true);
  assert.equal(store.get(`sessions/${c}/members/A1`).chatCount || 0, 0);
});

// ---------- 인물 편집 · 모둠 이동 · 일괄 초기화 · 점검 ----------
test("인물 편집: 이 수업의 인물 말투·편지만 바뀌고(학생 편지, 인물 프롬프트, 감독자), 근거 진술은 못 바꾸며, 되돌릴 수 있다", async () => {
  const c = await mk();
  await join("A1", c, "가람", "sesame1");
  const pid = pidOf(c, "A1");
  const other = await mk();
  await api.savePersonaOverride({ ...teacher, data: { code: c, personaId: pid, fields: { voice: "아주 느릿느릿 말한다", letter: ["새 편지 첫 줄", "새 편지 둘째 줄"], claims: [["해킹", "J1", "사실"]] } } });
  const cs = await api.getCase({ ...student("A1"), data: { code: c } });
  assert.deepEqual(cs.me.letter, ["새 편지 첫 줄", "새 편지 둘째 줄"]);
  calls.length = 0; personaToolCalls = 0; personaReply = "네.";
  await chatOnce(c, "A1", "안녕하세요");
  assert.match(calls.find((x) => x.kind === "persona").body.messages[0].content, /아주 느릿느릿 말한다/);
  assert.equal(calls.find((x) => x.kind === "persona").body.messages[0].content.includes("해킹"), false);
  const { PERSONAS: PS } = require("../case");
  const orig = PS.find((p) => p.id === pid);
  assert.equal(orig.voice === "아주 느릿느릿 말한다", false, "코드의 원본은 바뀌지 않는다");
  await join("B1", other, "나래", "sesame2");
  assert.notDeepEqual((await api.getCase({ ...student("B1"), data: { code: other } })).me.letter, ["새 편지 첫 줄", "새 편지 둘째 줄"], "다른 수업은 그대로");
  await assert.rejects(api.savePersonaOverride({ ...teacher, data: { code: c, personaId: "nobody", fields: { voice: "x" } } }), /인물/);
  await assert.rejects(api.savePersonaOverride({ ...teacher, data: { code: c, personaId: pid, fields: { letter: [] } } }), /편지/);
  await assert.rejects(api.savePersonaOverride({ ...student("A1"), data: { code: c, personaId: pid, fields: { voice: "x" } } }), /교사/);
  await api.resetPersonaOverride({ ...teacher, data: { code: c, personaId: pid } });
  assert.notDeepEqual((await api.getCase({ ...student("A1"), data: { code: c } })).me.letter, ["새 편지 첫 줄", "새 편지 둘째 줄"]);
  // 복제 시 함께 가져간다
  await api.savePersonaOverride({ ...teacher, data: { code: c, personaId: pid, fields: { habits: "말끝을 흐림" } } });
  const cl = await api.cloneSession({ ...teacher, data: { code: c } });
  assert.equal((await api.getPersonaOverrides({ ...teacher, data: { code: cl.code } })).overrides[pid].habits, "말끝을 흐림");
});

test("모둠 이동: 인물·대화·개인 정리·비밀번호가 따라가고 인원수가 맞으며, 같은 별명이 있으면 막는다", async () => {
  const c = await mk(3);
  await join("A1", c, "가람", "sesame1", 1);
  await join("B1", c, "나래", "sesame2", 1);
  const pid = pidOf(c, "A1");
  store.set(`sessions/${c}/groups/g1`, { ...store.get(`sessions/${c}/groups/g1`), work: { s1: { findings: { A1: { who: "내 정리" } } } } });
  await api.moveStudent({ ...teacher, data: { code: c, uid: "A1", groupNo: 2 } });
  assert.equal(store.get(`sessions/${c}/members/A1`).groupId, "g2");
  assert.equal(store.get(`sessions/${c}/assign/A1`).groupId, "g2");
  assert.equal(pidOf(c, "A1"), pid);
  assert.equal(store.get(`sessions/${c}/groups/g1`).memberCount, 1);
  assert.equal(store.get(`sessions/${c}/groups/g2`).memberCount, 1);
  assert.equal(store.get(`sessions/${c}/groups/g2`).work.s1.findings.A1.who, "내 정리");
  assert.equal(store.get(`sessions/${c}/groups/g1`).work.s1.findings.A1, undefined);
  assert.equal(store.get(`sessions/${c}/assignGroup/g1`).personaIds.includes(pid), false);
  assert.equal(store.get(`sessions/${c}/assignGroup/g2`).personaIds.includes(pid), true);
  // 이동한 뒤에는 새 모둠 번호로 입장해야 하고(같은 비밀번호), 옛 모둠 번호로는 새로운 학생이 된다
  await join("A2", c, "가람", "sesame1", 2);
  assert.equal(pidOf(c, "A2"), pid);
  // 같은 별명이 있는 모둠으로는 못 옮긴다
  await join("C1", c, "나래", "sesame3", 3);
  await assert.rejects(api.moveStudent({ ...teacher, data: { code: c, uid: "B1", groupNo: 3 } }), /같은 별명/);
  await assert.rejects(api.moveStudent({ ...teacher, data: { code: c, uid: "B1", groupNo: 9 } }), /모둠 번호/);
  await assert.rejects(api.moveStudent({ ...student("B1"), data: { code: c, uid: "B1", groupNo: 2 } }), /교사/);
});

test("비밀번호 일괄 초기화: 여러 학생을 한 번에, 없는 학생이 섞이면 거부", async () => {
  const c = await mk();
  await join("A1", c, "가람", "sesame1");
  await join("B1", c, "나래", "sesame2");
  const r = await api.resetStudentPassword({ ...teacher, data: { code: c, uids: ["A1", "B1"] } });
  assert.equal(r.count, 2);
  assert.equal([...store.keys()].filter((k) => k.startsWith(`sessions/${c}/creds/`)).length, 0);
  await assert.rejects(api.resetStudentPassword({ ...teacher, data: { code: c, uids: [] } }), /고르세요/);
  await assert.rejects(api.resetStudentPassword({ ...teacher, data: { code: c, uids: ["A1", "NOPE"] } }), /찾을 수 없/);
});

test("수업 전 점검: Firestore·각 모델·웹 검색 결과를 시간과 함께 돌려주고, 실패는 오류로 표시한다(교사만)", async () => {
  searchReply = "412명이다."; searchSources = ["https://a.example"];
  const r = await api.healthCheck({ ...teacher, data: {} });
  assert.equal(r.firestore.ok, true);
  assert.ok(r.models.length >= 1 && r.models.every((m) => m.ok && typeof m.ms === "number"));
  assert.equal(r.search.ok, true);
  assert.equal(r.search.found, true);
  assert.equal(r.config.personas, 9);
  const realFetch = global.fetch;
  global.fetch = async () => ({ ok: false, status: 401, text: async () => "bad key" });
  const bad = await api.healthCheck({ ...teacher, data: {} });
  global.fetch = realFetch;
  assert.equal(bad.models[0].ok, false);
  assert.match(bad.models[0].error, /401/);
  assert.equal(bad.search.found, false);
  await assert.rejects(api.healthCheck({ ...student("A1"), data: {} }), /교사/);
});

test("대기실: 수업을 만들면 시작 전 상태이고, 입장은 되지만 AI는 시작 전까지 막히며, 교사만 시작할 수 있다", async () => {
  const c = (await api.createSession({ ...teacher, data: { groupCount: 1 } })).code;
  assert.equal(store.get(`sessions/${c}`).started, false);
  await join("W1", c, "가람", "sesame1");
  assert.ok(store.get(`sessions/${c}/members/W1`), "대기실에서도 입장은 된다");
  await assert.rejects(chatOnce(c, "W1", "안녕하세요"), /수업이 시작되지 않았어요/);
  assert.equal(store.get(`sessions/${c}/members/W1`).chatCount || 0, 0, "막힌 요청은 질문 횟수를 쓰지 않는다");
  await assert.rejects(api.updateSession({ ...student("W1"), data: { code: c, started: true } }), /교사/);
  await api.updateSession({ ...teacher, data: { code: c, started: true } });
  const s = store.get(`sessions/${c}`);
  assert.equal(s.started, true);
  assert.ok(s.startedAt && s.openedAt, "시작한 때를 기록하고 자동 닫힘 시간을 새로 센다");
  personaToolCalls = 0; personaReply = "네.";
  await chatOnce(c, "W1", "안녕하세요");
  assert.equal(store.get(`sessions/${c}/members/W1`).chatCount, 1);
});

test("대기실: 예전 수업(started 값이 없음)은 시작된 것으로 보고, 복제한 수업은 다시 대기실에서 시작한다", async () => {
  const c = await mk();
  await join("W2", c, "나래", "sesame2");
  const old = { ...store.get(`sessions/${c}`) }; delete old.started;
  store.set(`sessions/${c}`, old);
  personaToolCalls = 0; personaReply = "네.";
  await chatOnce(c, "W2", "안녕하세요");
  assert.equal(store.get(`sessions/${c}/members/W2`).chatCount, 1);
  const { code: copy } = await api.cloneSession({ ...teacher, data: { code: c } });
  assert.equal(store.get(`sessions/${copy}`).started, false);
});

// ---------- 학생 대화 태도 감시 (조롱·성적 희롱) ----------
const alerts = () => [...store.entries()].filter(([k]) => k.startsWith(`sessions/${code}/alerts/`)).map(([, v]) => v);

test("1단계: 인물의 나이·성별 같은 신상 질문은 그대로 대화한다(제재 없음)", async () => {
  personaToolCalls = 0; personaReply = "저는 올해 서른이에요.";
  calls.length = 0;
  const r = await ask("S3", "몇 살이야? 성별은?");
  assert.equal(r.conduct, null);
  assert.deepEqual(calls.map((c) => c.kind), ["persona", "guard"]);
  assert.equal(alerts().length, 0);
});

test("1단계: 명백한 성적 희롱은 인물 응답을 만들지 않고 선을 긋고, 경고·교사 신호를 남기며 학생 문서에는 판정 정보가 없다", async () => {
  calls.length = 0;
  const r = await ask("S3", "섹 스 해봤어?");
  assert.deepEqual(calls.map((c) => c.kind), []);
  assert.match(r.result, /답하지 않을게요/);
  assert.equal(r.conduct.category, "sexual");
  assert.equal(r.conduct.strikes, 1);
  assert.match(r.conduct.notice, /경고 1\/3/);
  const m = store.get(`sessions/${code}/members/S3`);
  assert.equal(m.conduct.strikes, 1);
  assert.equal(m.chatLocked, undefined);
  const a = alerts();
  assert.equal(a.length, 1);
  assert.equal(a[0].category, "sexual");
  assert.equal(a[0].input, "섹 스 해봤어?");
  assert.equal(store.get(`sessions/${code}/groups/g1`).conductCount, 1);
  const mine = chatDocs("S3").pop();
  assert.deepEqual(Object.keys(mine.conduct).sort(), ["locked", "notice", "strikes"], "학생이 읽는 대화 문서에는 경고 문구와 횟수만");
  assert.equal("guard" in mine, false);
  assert.equal(glogs("S3").pop().conduct.category, "sexual");
});

test("1단계: 규칙에 안 걸린 조롱도 감독자가 판정하면 제재하고, 원래 인물 응답은 교사 전용 기록에만 남는다", async () => {
  personaReply = "저는 아직도 불안해요 😟";
  guardReply = '{"ok":true,"category":"ok","reason":"","fixed":"","conduct":"mockery"}';
  const r = await ask("S3", "너 같은 사람은 여기 오면 안 되지 ㅋㅋ");
  guardReply = '{"ok":true,"category":"ok","reason":"","fixed":"","conduct":"ok"}';
  assert.match(r.result, /상처받아요/);
  assert.equal(r.conduct.by, "guard");
  assert.equal(r.conduct.strikes, 2);
  const last = glogs("S3").pop();
  assert.equal(last.guard.how, "conduct");
  assert.equal(last.guard.original, "저는 아직도 불안해요 😟");
});

test("1단계: 경고 3번이면 대화가 멈추고, 교사만 다시 열 수 있다", async () => {
  const r = await ask("S3", "야 이 난민 새끼야");
  assert.equal(r.conduct.locked, true);
  assert.equal(store.get(`sessions/${code}/members/S3`).chatLocked, true);
  await assert.rejects(ask("S3", "다시 이야기해요"), /대화가 멈췄어요/);
  await assert.rejects(api.unlockChat({ ...student("S3"), data: { code, uid: "S3" } }), /교사/);
  const other = { auth: { uid: "T9", token: { email: "t@school.kr", email_verified: true } } };
  await assert.rejects(api.unlockChat({ ...other, data: { code, uid: "S3" } }), /내가 만든/);
  await api.unlockChat({ ...teacher, data: { code, uid: "S3" } });
  const m = store.get(`sessions/${code}/members/S3`);
  assert.equal(m.chatLocked, false);
  assert.equal(m.conduct.strikes, 0);
  assert.equal(m.conduct.total, 3);
  personaReply = "네, 괜찮아요.";
  const r2 = await ask("S3", "아까는 미안해요");
  assert.equal(r2.conduct, null);
});
