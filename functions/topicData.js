// 교사가 만든 주제의 데이터 모양.
//  - 메모리(서버 함수 안)에서는 기본 주제 파일(cases/*.js)과 같은 모양(file)을 쓴다: SOURCES·EVENT·PERSONAS·MATERIALS·POLICY_CASES·AFTERMATH·BRIEFS.
//  - Firestore 는 배열 안의 배열을 저장하지 못하므로, 저장할 때는 [문장, 출처, 종류] 같은 묶음을 객체로 바꾼다(toStored / fromStored).
//  - 교사가 화면에서 고친 주제는 sanitizeFile 로 칸·길이를 검사하고 정리한 뒤 저장한다(모르는 칸은 버린다).
const { KINDS, UI_KEYS } = require("./topicCheck");

const L = {
  title: 80, summary: 1500, teacherNote: 2000, axis: 12, stakeholder: 60, bg: 14, bgText: 400, now: 300, intro: 200,
  scEvent: 200, scTime: 400, scPlace: 300, topics: 12, topic: 300, uiText: 200, hint: 120, realNames: 40, realName: 30,
  personas: 12, label: 120, name: 12, setting: 800, voice: 400, letter: 12, para: 700, role: 300, stance: 300, views: 10, view: 400,
  story: 12, storyItem: 500, inner: 500, habits: 300, basis: 500, beliefs: 4, belief: 300, limits: 4, claims: 20, claim: 400,
  cats: 10, catTitle: 40, items: 30, date: 24, itemText: 600, stats: 6, stat: 30, srcPerItem: 4,
  cases: 8, country: 40, caseTitle: 80, caseText: 800, think: 500, after: 12,
  brief: 60, sources: 80, srcTitle: 200, outlet: 60, srcDate: 30, url: 500, check: 600,
};
const SRC_ID = /^T\d{1,3}$/;
const PERSONA_ID = /^[a-z][a-z0-9_]{0,23}$/;
const ITEM_ID = /^[\w-]{1,30}$/;

const str = (v, max) => String(v ?? "").replace(/\s+\n/g, "\n").trim().slice(0, max);
const list = (v, n, max) => (Array.isArray(v) ? v : []).slice(0, n).map((x) => str(x, max)).filter(Boolean);
const kindOf = (k) => (KINDS.includes(k) ? k : "사실");
// 자료·사례·이후 전개가 어느 사실(사실 은행 F1..)에서 왔는지. 교사 검토 화면에서 근거를 보여 주는 데만 쓴다.
const facts = (v) => { const x = (Array.isArray(v) ? v : []).map(String).filter((id) => /^F\d{1,3}$/.test(id)).slice(0, 6); return x.length ? { facts: x } : {}; };

// 메모리 모양 → 저장 모양
function toStored(file) {
  return {
    ...file,
    EVENT: file.EVENT ? { ...file.EVENT, background: (file.EVENT.background || []).map(([text, src, kind]) => ({ text, src, kind })) } : null,
    PERSONAS: (file.PERSONAS || []).map((p) => ({
      ...p,
      claims: (p.claims || []).map(([text, src, kind]) => ({ text, src, kind })),
      beliefs: (p.beliefs || []).map(([text, note]) => ({ text, note })),
    })),
  };
}
// 저장 모양 → 메모리 모양(예전에 묶음으로 저장된 값도 받아 준다)
const tuple = (x, keys) => (Array.isArray(x) ? x : keys.map((k) => x?.[k]));
function fromStored(st) {
  if (!st) return null;
  return {
    SOURCES: st.SOURCES || {}, MATERIALS: st.MATERIALS || [], POLICY_CASES: st.POLICY_CASES || [], AFTERMATH: st.AFTERMATH || [], BRIEFS: st.BRIEFS || {},
    EVENT: st.EVENT ? { ...st.EVENT, background: (st.EVENT.background || []).map((x) => tuple(x, ["text", "src", "kind"])) } : null,
    PERSONAS: (st.PERSONAS || []).map((p) => ({
      ...p,
      claims: (p.claims || []).map((x) => tuple(x, ["text", "src", "kind"])),
      beliefs: (p.beliefs || []).map((x) => tuple(x, ["text", "note"])),
    })),
  };
}

// 교사가 고쳐 보낸 주제를 정리한다. 사건 ID 는 바꿀 수 없고(topicId), 출처는 원래 있던 ID 만 쓸 수 있다.
// prev: 지금 저장된 주제(메모리 모양). 출처 확인 여부(verified)는 주소가 바뀌면 풀린다.
function sanitizeFile(input, prev) {
  const f = input || {};
  const e = f.EVENT || {};
  const pe = prev.EVENT;
  // 출처: 원래 있던 ID 만. 제목·매체·날짜·주소·확인할 것을 고칠 수 있다.
  const SOURCES = {};
  for (const [id, old] of Object.entries(prev.SOURCES || {})) {
    if (!SRC_ID.test(id)) continue;
    const s = f.SOURCES?.[id] || old;
    const url = str(s.url, L.url);
    const okUrl = /^https?:\/\//i.test(url) ? url : old.url;
    SOURCES[id] = {
      title: str(s.title, L.srcTitle) || old.title, outlet: str(s.outlet, L.outlet) || old.outlet, date: str(s.date, L.srcDate),
      url: okUrl, check: str(s.check, L.check),
      verified: okUrl === old.url ? old.verified === true : false,
      ...(old.verifiedAt && okUrl === old.url ? { verifiedAt: old.verifiedAt } : {}),
    };
  }
  const src = (id) => (SOURCES[id] ? id : null);
  const srcs = (ids) => [...new Set((Array.isArray(ids) ? ids : []).map(String).filter((id) => SOURCES[id]))].slice(0, L.srcPerItem);

  const axes = list(e.axes, 4, L.axis);
  const EVENT = {
    id: pe.id,
    title: str(e.title, L.title) || pe.title, summary: str(e.summary, L.summary), teacherNote: str(e.teacherNote, L.teacherNote),
    axes, requiredAxis: str(e.requiredAxis, L.axis), personalAxes: list(e.personalAxes, 4, L.axis).filter((a) => axes.includes(a)),
    stakeholders: list(e.stakeholders, 6, L.stakeholder),
    background: (Array.isArray(e.background) ? e.background : []).slice(0, L.bg).map((c) => [str(c?.[0], L.bgText), src(c?.[1]), kindOf(c?.[2])]).filter((c) => c[0] && c[1]),
    now: str(e.now, L.now), backgroundIntro: str(e.backgroundIntro, L.intro),
    scope: {
      event: str(e.scope?.event, L.scEvent), time: str(e.scope?.time, L.scTime), place: str(e.scope?.place, L.scPlace),
      allowedTopics: list(e.scope?.allowedTopics, L.topics, L.topic), outOfScope: list(e.scope?.outOfScope, L.topics, L.topic),
    },
    search: { scope: str(e.search?.scope, L.scTime), example: str(e.search?.example, L.uiText) },
    ui: { ...Object.fromEntries(UI_KEYS.map((k) => [k, str(e.ui?.[k], L.uiText)])), sceneHints: list(e.ui?.sceneHints, 3, L.hint) },
    realNames: list(e.realNames, L.realNames, L.realName),
  };

  const seen = new Set();
  const PERSONAS = (Array.isArray(f.PERSONAS) ? f.PERSONAS : []).slice(0, L.personas).map((p) => {
    const id = str(p?.id, 24);
    if (!PERSONA_ID.test(id) || seen.has(id)) return null;
    seen.add(id);
    return {
      id, axis: str(p.axis, L.axis), label: str(p.label, L.label), name: str(p.name, L.name),
      setting: str(p.setting, L.setting), voice: str(p.voice, L.voice), letter: list(p.letter, L.letter, L.para),
      role: str(p.role, L.role), stance: str(p.stance, L.stance), views: list(p.views, L.views, L.view),
      story: list(p.story, L.story, L.storyItem), episodes: list(p.episodes, L.story, L.storyItem),
      inner: str(p.inner, L.inner), habits: str(p.habits, L.habits), basis: str(p.basis, L.basis),
      beliefs: (Array.isArray(p.beliefs) ? p.beliefs : []).slice(0, L.beliefs).map((b) => [str(b?.[0], L.belief), str(b?.[1], L.belief)]).filter((b) => b[0]),
      limits: list(p.limits, L.limits, L.belief),
      claims: (Array.isArray(p.claims) ? p.claims : []).slice(0, L.claims).map((c) => [str(c?.[0], L.claim), src(c?.[1]), kindOf(c?.[2])]).filter((c) => c[0] && c[1]),
    };
  }).filter(Boolean);

  const ids = new Set();
  const uid = (v, prefix, i) => { let x = ITEM_ID.test(String(v || "")) ? String(v) : `${prefix}${i + 1}`; while (ids.has(x)) x += "x"; ids.add(x); return x; };
  const MATERIALS = (Array.isArray(f.MATERIALS) ? f.MATERIALS : []).slice(0, L.cats).map((c, i) => {
    const stats = (Array.isArray(c?.stats) ? c.stats : []).slice(0, L.stats).map((s) => ({ label: str(s?.label, L.stat), value: str(s?.value, L.stat) })).filter((s) => s.label && s.value);
    return {
      id: uid(c?.id, "c", i), title: str(c?.title, L.catTitle), type: c?.type === "timeline" ? "timeline" : "list",
      items: (Array.isArray(c?.items) ? c.items : []).slice(0, L.items).map((it) => ({
        ...(str(it?.date, L.date) ? { date: str(it.date, L.date) } : {}), kind: kindOf(it?.kind), text: str(it?.text, L.itemText), src: srcs(it?.src), ...facts(it?.facts),
      })).filter((it) => it.text && it.src.length),
      ...(stats.length ? { stats, statsSrc: srcs(c.statsSrc) } : {}),
    };
  }).filter((c) => c.title && (c.items.length || c.stats));
  const POLICY_CASES = (Array.isArray(f.POLICY_CASES) ? f.POLICY_CASES : []).slice(0, L.cases).map((c, i) => ({
    id: uid(c?.id, "case", i), country: str(c?.country, L.country), title: str(c?.title, L.caseTitle),
    what: str(c?.what, L.caseText), result: str(c?.result, L.caseText), think: str(c?.think, L.think), src: srcs(c?.src), ...facts(c?.facts),
  })).filter((c) => c.title && c.src.length);
  const AFTERMATH = (Array.isArray(f.AFTERMATH) ? f.AFTERMATH : []).slice(0, L.after).map((a) => ({ kind: kindOf(a?.kind), text: str(a?.text, L.itemText), src: srcs(a?.src), ...facts(a?.facts) }))
    .filter((a) => a.text && a.src.length);
  const BRIEFS = Object.fromEntries(PERSONAS.map((p) => [p.id, str(f.BRIEFS?.[p.id], L.brief)]));
  return { SOURCES, EVENT, PERSONAS, MATERIALS, POLICY_CASES, AFTERMATH, BRIEFS };
}

// 목록 화면에 보일 요약: 인물 수, 출처 확인 수, 학생에게 지금 쓸 수 있는 인물 수, 검사 결과
function summarize(id, doc, { check, usable }) {
  const f = fromStored(doc.bundle);
  const sources = Object.values(f?.SOURCES || {});
  return {
    id, title: doc.title || f?.EVENT?.title || "새 주제", status: doc.status || "building", step: doc.build?.step || "",
    updatedAt: doc.updatedAt?.toMillis ? doc.updatedAt.toMillis() : doc.updatedAt || 0,
    personas: (f?.PERSONAS || []).length, sources: sources.length, verified: sources.filter((s) => s.verified).length,
    usable, errors: check ? check.errors.length : 0, warnings: check ? check.warnings.length : 0,
  };
}

module.exports = { toStored, fromStored, sanitizeFile, summarize, LIMITS: L, SRC_ID, PERSONA_ID };
