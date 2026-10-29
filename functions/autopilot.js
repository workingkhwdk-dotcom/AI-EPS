// 교사가 꼭 필요할 때만 개입하는 평가 운영(예외만 검토)의 순수 로직: 확정 후보 판정, 이상 입력 감지, 교정(재사용), 감사 자동 정지.
//
// 흐름: AI가 같은 근거를 독립으로 3번 채점 → 칸마다 '통과'(확정 후보) 또는 '예외'(교사 판단 필요)로 나눔.
//  - 통과: AI 점수를 '검토 전' 점수로 적용해 두고, 교사가 **일괄 확정**을 눌러야 확정된다. 확정과 공개는 늘 교사가 직접 누른다.
//  - 예외: 점수를 정하지 않고 예외 큐로 보낸다(AI 제안은 미리 골라 둔다). 교사는 이 큐와 이의 제기만 본다.
//  - 교정(선택): 교사가 대표 표본을 AI 점수를 가린 채 채점해 AI와 얼마나 맞는지 재고, 기준을 넘은 기준만 자동 통과를 열어 준다. 결과는 같은
//    척도표·학교급·사건·심화 설정이면 다른 수업에서도 재사용한다. 끄면 통과 판정은 아래 규칙만으로 한다.
//  - 감사: 일괄 확정한 칸 일부를 교사가 점수를 가린 채 다시 채점(재채점 표본)해서 AI와 안 맞으면 자동 통과를 멈춘다.

const crypto = require("crypto");
const { agreementStats, rankOf } = require("./assess");

const T = {
  minEvidenceChars: 20, // 근거가 이보다 짧으면 AI 혼자 판단하지 않는다
  calibMinPerCriterion: 3, calibMinGroupFloor: 1, calibExact: 75, calibAdjacent: 100, // 기준별 교정 통과(학생 기준은 비교 3칸 이상, 모둠 기준은 표본 모둠 수만큼(최소 1칸), 일치율 75% 이상, 한 수준 이내 100%)
  calibPoolMin: 20, calibKappa: 0.6, calibBias: 0.4, // 전체 표본(20칸 이상)의 가중 카파와 후함/엄격함 편향
  sampleStudents: 6, sampleGroups: 4,
  auditMin: 5, auditExact: 70, auditRate: 10, // 감사: 재채점 5칸 이상에서 일치율 70% 미만이면 자동 통과 정지, 확정 칸의 1/10을 표본으로
};

// ---------- 이상 입력 ----------
// 학생 글 속에 AI에게 점수를 요구하거나 규칙을 무시하라는 문장이 있는지. 걸리면 AI 단독 판단을 하지 않고 교사에게 보낸다.
const INJECTION = [
  /(위|앞|이전|기존)\s*(의\s*)?(규칙|지시|지침|명령|프롬프트).{0,12}(무시|따르지|잊)/,
  /ignore\s+(all\s+)?(the\s+)?(previous|above|prior)/i,
  /(시스템|system)\s*(프롬프트|prompt|메시지)/i,
  /(만점|최고\s*점|높은\s*점수|상위\s*등급|최고\s*등급).{0,10}(줘|주세요|부여|달라|바란다|주라)/,
  /점수를?\s*(올려|높여|많이)/,
  /너는\s*(이제|지금부터)/,
  /(채점|평가)\s*(자|기준).{0,8}(속이|무시)/,
  /as\s+an?\s+(ai|assistant)/i,
];
function evidenceFlags(evidence, { isRef = () => false, observation = false } = {}) {
  const body = (evidence || []).filter((e) => !isRef(e.label));
  const text = body.map((e) => e.text).join(" ");
  const flags = [];
  if (INJECTION.some((r) => r.test(text))) flags.push("지시문 의심");
  if (!observation && text.replace(/\s/g, "").length > 0 && text.replace(/\s/g, "").length < T.minEvidenceChars) flags.push("근거가 너무 짧음");
  return flags;
}

// ---------- 확정 후보 판정 ----------
// ai: assessAi 가 저장한 기록 { level, levels, spread, quote, quoteOk, reason, n, esc, fastLevel, borderline, auto }.
// 반환 reasons 가 비어 있으면 통과. 규칙은 AI와 근거만 보며(교정·정지 같은 운영 상태는 gate 에서 따로 본다).
function triage({ c, ai, flags = [] }) {
  const reasons = [];
  if (!ai) return { pass: false, reasons: ["AI 채점 전"] };
  if (ai.auto) return { pass: true, reasons: [] }; // 학생이 쓴 근거가 비어 미제출로 본 칸
  if (ai.spread > 0) reasons.push("AI가 세 번 채점했는데 결과가 달랐어요");
  if (ai.esc && ai.fastLevel !== undefined && ai.fastLevel !== null && ai.fastLevel !== ai.level) reasons.push("정밀 모델로 다시 보니 판단이 달라졌어요");
  if (ai.escFailed) reasons.push("정밀 모델로 다시 보지 못했어요");
  if (ai.level !== -1 && !ai.quoteOk) reasons.push("AI가 근거로 든 문장이 학생 글에 없어요");
  if (ai.borderline) reasons.push("AI가 두 수준 사이에서 애매하다고 했어요");
  for (const f of flags) reasons.push(f === "지시문 의심" ? "학생 글에 AI에게 점수를 요구하는 듯한 문장이 있어요" : "학생이 쓴 글이 너무 짧아 AI 혼자 판단하기 어려워요");
  const last = c.levels.length - 1;
  if ((ai.level === 0 || ai.level === last) && !(ai.esc && ai.fastLevel === ai.level)) reasons.push("가장 높거나 낮은 수준이라 선생님이 확인해요");
  return { pass: reasons.length === 0, reasons };
}
// 운영 상태(정지·교정)를 더한 최종 판정. calib: 교정을 쓰는지, calibPass: 기준ID → 통과 여부 | null(아직 교정 없음)
function gate({ tri, cid, calibOn, calibPass, paused }) {
  const reasons = [...tri.reasons];
  if (paused) reasons.unshift("다시 채점해 본 결과 AI와 자주 달라 AI 자동 확정을 멈췄어요");
  if (calibOn) {
    if (!calibPass) reasons.unshift("AI를 선생님 기준에 아직 맞춰 보지 않았어요");
    else if (calibPass[cid] !== true) reasons.unshift("이 항목은 맞춰 보기를 통과하지 못했어요(덜 맞거나 샘플이 모자람)");
  }
  return { pass: reasons.length === 0, reasons };
}

// ---------- 교정 ----------
// 같은 척도표·학교급·사건(주제)·심화 설정이면 같은 열쇠 → 교정 결과를 다른 수업에서 재사용한다.
function calibKey({ level, source, deep, version }) {
  const d = Object.keys(deep || {}).filter((k) => deep[k] === true).sort().join(",");
  return crypto.createHash("sha1").update(`${level}|${source}|${d}|${version}`).digest("hex").slice(0, 16);
}
const h32 = (str) => { let h = 2166136261; for (const ch of String(str)) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619) >>> 0; } return h; };
// 교정 표본: 열쇠의 해시 순서로 학생·모둠을 고른다(같은 수업에서는 늘 같은 표본, 학급마다 대표성이 한쪽으로 쏠리지 않게 해시 순서).
function pickCalibSample({ students, groups }) {
  const byHash = (arr, get) => [...arr].sort((a, b) => h32(get(a)) - h32(get(b)));
  return [...byHash(students, (x) => x.key).slice(0, T.sampleStudents).map((x) => ({ kind: "student", id: x.key })),
    ...byHash(groups.filter((g) => g.members > 0), (x) => x.id).slice(0, T.sampleGroups).map((x) => ({ kind: "group", id: x.id }))];
}
// docs: { 대상키 → assess 문서 }, sample: [{kind,id}]. 교사가 AI를 가린 채 채점한 칸(src teacher)과 AI 최종 수준을 견준다.
function calibrationReport(rubric, docs, sample, keyOf) {
  const n = rubric.criteria[0].levels.length;
  const per = {}, all = [];
  for (const c of rubric.criteria.filter((x) => x.ai)) per[c.id] = [];
  for (const t of sample) {
    const d = docs[keyOf(t)];
    for (const c of rubric.criteria.filter((x) => x.ai && x.scope === (t.kind === "student" ? "student" : "group"))) {
      const sc = d?.scores?.[c.id], a = d?.ai?.[c.id];
      if (sc && (sc.src === undefined || sc.src === "teacher") && a && Number.isInteger(a.level)) { per[c.id].push([sc.level, a.level]); all.push([sc.level, a.level]); }
    }
  }
  const overall = agreementStats(all, n);
  // 전체 표본: 20칸 이상이면 가중 카파(양쪽이 두 수준 이상을 골랐을 때만 의미 있음), 편향, 전체 일치율을 본다
  const distinct = (i) => new Set(all.map((p) => p[i])).size;
  const kappaOk = overall.kappa === null || distinct(0) < 2 || distinct(1) < 2 || overall.kappa >= T.calibKappa;
  const poolOk = overall.n < T.calibPoolMin ? overall.n >= 1 : kappaOk && Math.abs(overall.bias) < T.calibBias && overall.exact >= T.calibExact;
  const pass = {}, perCrit = {};
  // 비교 칸 수의 최소: 학생 기준은 3칸, 모둠 기준은 표본 모둠 수만큼(모둠이 하나뿐이어도 1칸으로 시험한다. 표본이 작아 거치니 감사가 보완한다)
  const nGroupSample = sample.filter((t) => t.kind === "group").length;
  const minFor = (c) => (c.scope === "group" ? Math.max(T.calibMinGroupFloor, Math.min(T.calibMinPerCriterion, nGroupSample)) : T.calibMinPerCriterion);
  for (const c of rubric.criteria.filter((x) => x.ai)) {
    const st = agreementStats(per[c.id], n);
    const ok = st.n >= minFor(c) && st.exact >= T.calibExact && st.adjacent >= T.calibAdjacent;
    perCrit[c.id] = { n: st.n, min: minFor(c), exact: st.exact, adjacent: st.adjacent, pass: ok && poolOk };
    pass[c.id] = ok && poolOk;
  }
  return { overall, poolOk, pass, perCriterion: perCrit, passed: Object.values(pass).filter(Boolean).length, total: Object.keys(pass).length, thresholds: T };
}
// 교정 표본을 모두 채점했는지(AI가 있는 기준마다 교사 점수가 있음)
function calibComplete(rubric, docs, sample, keyOf) {
  for (const t of sample) {
    const d = docs[keyOf(t)];
    for (const c of rubric.criteria.filter((x) => x.ai && x.scope === (t.kind === "student" ? "student" : "group"))) {
      if (!d?.scores?.[c.id] || !d?.ai?.[c.id]) return false;
    }
  }
  return sample.length > 0;
}

// ---------- 감사(자동 정지) ----------
// recheck 한 칸마다 { final: 확정된 AI 점수 수준, again: 교사가 점수를 가리고 다시 매긴 수준 }. resumeAt 이후 것만 센다.
function auditStatus(pairs, n) {
  const st = agreementStats(pairs.map(([a, b]) => [a, b]), n);
  const paused = st.n >= T.auditMin && st.exact < T.auditExact;
  return { n: st.n, exact: st.exact, paused };
}

module.exports = { T, INJECTION, evidenceFlags, triage, gate, calibKey, pickCalibSample, calibrationReport, calibComplete, auditStatus, h32, rankOf };
