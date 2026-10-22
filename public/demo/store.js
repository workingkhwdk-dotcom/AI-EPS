// 체험(demo)용 저장소: 서버(Firestore) 대신 이 기기(localStorage)에 주제별로 따로 저장한다.
// 학생 화면(app.js)이 쓰는 Firestore 모양(문서 경로 → 값, 점(.)으로 이어진 필드 경로, 실시간 구독)만 흉내 낸다.
export const TOPIC = (() => { const t = new URLSearchParams(location.search).get("t") || ""; return /^[a-z0-9]+$/.test(t) ? t : ""; })();
export const CODE = TOPIC.toUpperCase();   // 수업 코드 자리에 쓰는 값(주제마다 다름)
export const UID = "demo-student";
export const NICK = "체험";
const KEY = `eps_demo_v1_${TOPIC}`;

// 서버 시각 표시: 저장할 때 지금 시각으로 바뀐다. 화면은 toMillis()/toDate() 만 쓴다.
export class Ts {
  constructor(ms) { this.ms = ms; }
  toMillis() { return this.ms; }
  toDate() { return new Date(this.ms); }
  toJSON() { return { __ts: this.ms }; }
}
export const SERVER_TS = { __sentinel: "ts" };
export const DELETE = { __sentinel: "delete" };
export const inc = (n) => ({ __sentinel: "inc", n });

const revive = (v) => {
  if (Array.isArray(v)) return v.map(revive);
  if (v && typeof v === "object") {
    if (typeof v.__ts === "number") return new Ts(v.__ts);
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, revive(x)]));
  }
  return v;
};
const clone = (v) => revive(JSON.parse(JSON.stringify(v)));

let docs = {};
try { docs = revive(JSON.parse(localStorage.getItem(KEY) || "{}")); } catch { docs = {}; }
let saveTimer = null, frozen = false; // frozen: 초기화한 뒤에는 남아 있는 내용을 다시 저장하지 않는다
const write = () => { if (frozen || !TOPIC) return; try { localStorage.setItem(KEY, JSON.stringify(docs)); } catch (e) { console.warn("저장 공간이 부족해요", e); } };
const persist = () => { clearTimeout(saveTimer); saveTimer = setTimeout(write, 50); };
export const flush = () => { clearTimeout(saveTimer); write(); };
addEventListener("pagehide", write);

const listeners = new Map(); // 경로 → Set(콜백). 문서 경로와 컬렉션 경로 모두.
const parentOf = (p) => p.split("/").slice(0, -1).join("/");
const isDocPath = (p) => p.split("/").length % 2 === 0;
const snapOf = (p) => ({ id: p.split("/").pop(), exists: () => p in docs, data: () => (p in docs ? clone(docs[p]) : undefined) });
const colDocs = (colPath) => Object.keys(docs).filter((k) => parentOf(k) === colPath).map((k) => snapOf(k));
const notify = (p) => {
  for (const cb of listeners.get(p) || []) cb();
  const col = parentOf(p);
  for (const cb of listeners.get(col) || []) cb();
};

export const get = (p) => (p in docs ? clone(docs[p]) : undefined);
export const exists = (p) => p in docs;
export const colList = (colPath) => colDocs(colPath).map((s) => ({ id: s.id, ...s.data() }));

// 값 바꾸기: data 의 키는 'work.s1.x' 처럼 점으로 이어진 경로일 수 있다. DELETE 는 지우기, inc 는 더하기, SERVER_TS 는 지금 시각.
function setIn(obj, keys, val) {
  let o = obj;
  for (const k of keys.slice(0, -1)) { if (o[k] == null || typeof o[k] !== "object") o[k] = {}; o = o[k]; }
  const last = keys[keys.length - 1];
  if (val && val.__sentinel === "delete") delete o[last];
  else if (val && val.__sentinel === "ts") o[last] = new Ts(Date.now());
  else if (val && val.__sentinel === "inc") o[last] = (typeof o[last] === "number" ? o[last] : 0) + val.n;
  else o[last] = clone(val === undefined ? null : val);
}
export function update(p, data) {
  if (!(p in docs)) docs[p] = {};
  for (const [k, v] of Object.entries(data)) setIn(docs[p], k.split("."), v);
  persist(); notify(p);
}
export function set(p, data) { docs[p] = {}; update(p, data); }
export function add(colPath, data) { const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6); set(`${colPath}/${id}`, data); return id; }

// 구독: 문서면 문서 하나, 컬렉션이면 문서 목록(orderBy 가 있으면 그 필드 순). 처음 한 번 바로 불러 준다.
export function subscribe(ref, cb) {
  const p = ref.p, field = ref.order;
  const fire = () => {
    if (isDocPath(p)) cb(snapOf(p));
    else {
      const ds = colDocs(p);
      if (field) ds.sort((a, b) => ((a.data()[field]?.toMillis?.() ?? 0) - (b.data()[field]?.toMillis?.() ?? 0)));
      cb({ docs: ds });
    }
  };
  if (!listeners.has(p)) listeners.set(p, new Set());
  listeners.get(p).add(fire);
  setTimeout(fire, 0);
  return () => listeners.get(p)?.delete(fire);
}
export const snapshotOf = snapOf;

// 처음 열었을 때의 기본 문서(수업 1개·모둠 1개·학생 1명). 이미 있으면 건드리지 않는다.
export function seed() {
  if (!TOPIC || exists(`sessions/${CODE}`)) return;
  set(`sessions/${CODE}`, { eventId: TOPIC, started: true, chatLimit: 5, groupCount: 1, coach: true });
  set(`sessions/${CODE}/members/${UID}`, { groupId: "g1", nickname: NICK, stage: 1 });
  set(`sessions/${CODE}/groups/g1`, { work: {}, picks: {}, memberCount: 1, names: { [UID]: NICK }, aiCount: 0 });
}

// 이 주제의 저장 내용을 모두 지운다(처음부터 다시 하기). 단계 안내를 이미 봤다는 표시도 함께 지운다.
export function resetTopic(topic) {
  frozen = true; clearTimeout(saveTimer);
  try {
    localStorage.removeItem(`eps_demo_v1_${topic}`);
    const code = topic.toUpperCase();
    for (const k of Object.keys(localStorage)) if (k.startsWith(`eps_help_${code}_`)) localStorage.removeItem(k);
  } catch {}
}
// 메뉴에서 '하던 것이 있어요' 표시용: 인물을 골랐거나 대화·AI 기록이 있거나 모둠 문서(work)에 쓴 것이 있으면 true
export function hasProgress(topic) {
  try {
    const d = JSON.parse(localStorage.getItem(`eps_demo_v1_${topic}`) || "null");
    if (!d) return false;
    if (Object.keys(d).some((k) => /\/(chat|logs)\/[^/]+$|\/assign\/[^/]+$/.test(k))) return true;
    return Object.keys(d[`sessions/${topic.toUpperCase()}/groups/g1`]?.work || {}).length > 0;
  } catch { return false; }
}
