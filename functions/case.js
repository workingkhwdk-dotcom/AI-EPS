// 수업 사건 모음. 사건마다 cases/<사건 ID>.js 에 출처(SOURCES)·사건(EVENT)·인물(PERSONAS)·실제 자료(MATERIALS)를 둔다.
//
// 설계 원칙
//  1) 페르소나는 실제 보도·보고서·인터뷰에서 확인된 진술(claims)에 근거한다. 핵심 사건 사실은 claims 안에서만 말하고,
//     claims 에 없는 사소한 일상·감정은 어긋나지 않는 범위에서 자연스럽게 지어낼 수 있다(prompts.js 의 규칙).
//     학생 화면에는 사람 이름(name)만 보인다. 역할(label)·근거·출처는 교사에게만 보인다.
//  2) 같은 처지·같은 유형의 여러 인터뷰는 한 인물로 융합한다(composite). 융합 근거는 basis 에 적는다.
//  3) 진술 종류(kind): 증언(당사자가 말한 것) / 사실(공식 발표·보도된 사실) / 주장(집단의 주장, 사실 검증 필요) / 의견(개인·단체의 의견)
//  4) 모든 출처는 verified:false 로 시작한다. 교사가 원문과 대조해 true 로 바꾸기 전에는 학생에게 노출되지 않는다
//     (ALLOW_UNVERIFIED_PERSONAS=true 인 리허설 제외).
//  5) 인물 위에는 상위 AI(사건 규범 감독자, charter.js)가 있어 사건 범위(EVENT.scope)와 근거 진술을 벗어난 응답을 차단한다.
//  6) 출처 ID 는 사건마다 다른 머리글자를 쓴다(제주 J, 쓰레기 수출 W). 모든 사건의 출처를 한 목록으로 합쳐 쓰기 때문이다.
//
// 주의: 진술은 AI가 웹 검색 결과 요약을 바탕으로 정리했으며 원문을 직접 열람하지 못했다.
//       수업 전에 docs/PERSONA_SOURCES.md 의 체크리스트대로 반드시 원문과 대조할 것.

const CASES = [require("./cases/jeju2018"), require("./cases/waste2019")];

const SOURCES = {};
for (const c of CASES) for (const [id, s] of Object.entries(c.SOURCES)) {
  if (SOURCES[id]) throw new Error(`출처 ID 중복: ${id}`);
  SOURCES[id] = s;
}
Object.values(SOURCES).forEach((s) => { s.titleIsDescriptive = !!s.titleIsDescriptive; });
// 모든 출처는 미검증으로 시작. 교사가 원문 대조 후 해당 출처의 verified 를 true 로 바꾼다.
Object.values(SOURCES).forEach((s) => (s.verified = false));

const EVENTS = Object.fromEntries(CASES.map((c) => [c.EVENT.id, c.EVENT]));
const PERSONAS = CASES.flatMap((c) => c.PERSONAS);
// 2단계 "실제 사건 자료": 사건별로 학생에게 카테고리별로 보여 줄 객관적 정리. 항목마다 종류(사실·증언·주장·의견)와 출처 ID.
// 출처가 모두 검증된 항목만 학생에게 나간다. 학생에게는 출처 ID 대신 매체·날짜 캡션만 보인다.
const MATERIALS = Object.fromEntries(CASES.map((c) => [c.EVENT.id, c.MATERIALS]));
const DEFAULT_EVENT = "jeju2018";

const fmtDate = (d) => { const m = /^(\d{4})-(\d{2})(?:-(\d{2}))?$/.exec(d); return m ? `${m[1]}.${+m[2]}${m[3] ? "." + +m[3] : ""}` : ""; };
const captionOf = (src) => [...new Set(src.map((id) => { const x = SOURCES[id]; return `${x.outlet.replace(/\(.*\)/, "").trim()} ${fmtDate(x.date)}`.trim(); }))].slice(0, 2).join(" · ");
const itemVerified = (src) => src.every((id) => SOURCES[id].verified);
const materialsOf = (eventId) => MATERIALS[eventId] || MATERIALS[DEFAULT_EVENT];

// 학생용: 검증된 항목만, 출처 ID 없이 매체·날짜 캡션만
function materialsFor(eventId, allowUnverified = false) {
  return materialsOf(eventId).map((c) => ({
    id: c.id, title: c.title, type: c.type || "list",
    stats: c.stats && (allowUnverified || itemVerified(c.statsSrc)) ? c.stats : undefined,
    items: c.items.filter((it) => allowUnverified || itemVerified(it.src))
      .map((it) => ({ date: it.date, kind: it.kind, text: it.text, caption: captionOf(it.src) })),
  })).filter((c) => c.items.length || c.stats);
}
// 교사용: 출처 ID 포함 전체
const materialsAdmin = (eventId) => materialsOf(eventId).map((c) => ({ ...c, items: c.items.map((it) => ({ ...it, caption: captionOf(it.src) })) }));

function toPublicSource(id) {
  const s = SOURCES[id];
  return { id, title: s.title, titleIsDescriptive: !!s.titleIsDescriptive, outlet: s.outlet, date: s.date, url: s.url, verified: s.verified, check: s.check };
}

const personaSourceIds = (p) => [...new Set(p.claims.map((c) => c[1]))];
const backgroundSourceIds = (ev) => [...new Set((ev.background || []).map((c) => c[1]))];
// 인물의 진술 출처와, 그 인물이 쓰는 사건 공통 배경의 출처가 모두 검증되어야 학생에게 쓸 수 있다
const personaVerified = (p) => [...personaSourceIds(p), ...p.events.flatMap((e) => backgroundSourceIds(EVENTS[e]))].every((id) => SOURCES[id].verified);

// 이 사건에서 학생에게 쓸 수 있는 페르소나 (출처 검증 완료분. 리허설 모드는 전부)
function availablePersonas(eventId, allowUnverified = false) {
  return PERSONAS.filter((p) => p.events.includes(eventId) && (allowUnverified || personaVerified(p)));
}

module.exports = { SOURCES, EVENTS, PERSONAS, MATERIALS, DEFAULT_EVENT, availablePersonas, personaSourceIds, personaVerified, toPublicSource, materialsFor, materialsAdmin };
