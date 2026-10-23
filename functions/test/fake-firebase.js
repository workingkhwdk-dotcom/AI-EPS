// 서버 함수 테스트용 가짜 Firebase(메모리 Firestore, 함수 등록, 설정값). test/functions.test.js 와 같은 방식이다.
// require 하면 firebase-admin·firebase-functions 를 가로챈다. strings 로 설정값(defineString)을 정한다.
const Module = require("node:module");
// ALLOW_UNVERIFIED_PERSONAS: 예전 리허설 설정. .env 에 남아 있어도 서버가 읽지 않는다는 것을 보이려고 true 로 둔다(topics.test.js).
const strings = { TEACHER_EMAILS: "t@school.kr", ALLOW_UNVERIFIED_PERSONAS: "true", OPENAI_MODEL: "gpt-5-test", TEACHER_SIGNUP_CODE: "Knue-2026" };

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
// 실제 Firestore 처럼 undefined 값과 배열 안의 배열은 저장하지 못하게 한다(가짜 저장소가 놓치는 오류를 테스트에서 잡는다)
function assertStorable(v, path = "", inArray = false) {
  if (v === undefined) throw new Error(`Firestore 에 undefined 를 저장할 수 없음: ${path}`);
  if (Array.isArray(v)) {
    if (inArray) throw new Error(`Firestore 는 배열 안의 배열을 저장할 수 없음: ${path}`);
    v.forEach((x, i) => assertStorable(x, `${path}[${i}]`, true));
  } else if (v && typeof v === "object" && !v.__inc && !v.__del && v !== TS) {
    for (const [k, x] of Object.entries(v)) assertStorable(x, path ? `${path}.${k}` : k, false);
  }
}
let autoId = 0;
const docRef = (path) => ({
  path,
  async get() { const d = store.get(path); return { exists: d !== undefined, data: () => (d === undefined ? undefined : JSON.parse(JSON.stringify(d))), id: path.split("/").pop() }; },
  async set(d) { assertStorable(d, path); store.set(path, d); },
  async update(d) { assertStorable(d, path); store.set(path, applyUpdate(store.get(path) || {}, d)); },
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
    defineString: (name, o) => ({ value: () => (strings[name] ?? o?.default ?? "") }),
  },
};
const origLoad = Module._load;
Module._load = function (req, ...rest) { return fakes[req] || origLoad.call(this, req, ...rest); };


module.exports = { store, strings };
