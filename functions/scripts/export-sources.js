// cases/*.js 의 인물·출처를 원문 대조용 마크다운 점검표로 내보낸다: node scripts/export-sources.js > ../docs/PERSONA_SOURCES.md
const { SOURCES, EVENTS, PERSONAS, MATERIALS, CASES, AFTERMATH } = require("../case");
const CROSS = { ok: "교차 확인", partial: "일부 확인", fixed: "고쳐 씀", todo: "확인 못 함" };
const out = [];
out.push("# 페르소나 근거 자료 점검표", "");
out.push("> 이 문서는 `functions/cases/`의 사건 파일에서 자동 생성됩니다 (`cd functions && npm run export-sources`).");
out.push("> 근거 진술은 AI가 웹 검색 결과 요약을 바탕으로 정리한 것입니다. 원문과 대조한 출처는 그 사건 파일(`functions/cases/<사건>.js`)에 `verified: true`가 적혀 있고, 그 출처만 학생에게 쓰입니다. 틀린 진술은 고치거나 지우세요.", "");
out.push("> **검색 교차 확인(2026-10)**: 원문 페이지를 열 수 없는 환경이라, 검색으로 원문 기사 요약과 다른 매체 보도를 대조했습니다. 제주 사건은 '교차 확인' 열에, 쓰레기 수출·강서 특수학교·주남저수지·창원 인구·국민연금 개혁 사건은 '확인할 것' 열의 **[대조함]** 메모에 결과가 있습니다.", "");
out.push("**확인 방법**: 진술이 원문에 있는가 / 표현이 과장·왜곡되지 않았는가 / 누구의 발언·주장인가(기자 서술, 인터뷰, 칼럼 의견) / 날짜와 수치가 맞는가 / **진술 종류(증언·사실·주장·의견)가 맞는가**(주장을 사실로 쓰지 않았는가)", "");
for (const ev of Object.values(EVENTS)) {
  out.push(`## ${ev.title}`, "", ev.summary, "", `> 교사 메모: ${ev.teacherNote}`, "");
  out.push("### 사건 공통 배경 (모든 인물이 아는 사실)", "");
  (ev.background || []).forEach(([t, id, kind]) => out.push(`  - [ ] **[${kind}]** ${t} **(${id})**`));
  out.push("");
  for (const p of PERSONAS.filter((x) => x.events.includes(ev.id))) {
    out.push(`### ${p.name} (${p.axis} · ${p.label})`, `- 역할: ${p.role}`, `- 입장: ${p.stance}`, `- 설정(지어낼 수 있는 범위의 기준): ${p.setting}`, `- 말투: ${p.voice}`, `- 융합 근거: ${p.basis}`,
      "- 인물의 생각 (학생이 물으면 말하는 의견, 창작이므로 입장·근거와 어긋나지 않는지 검토):", ...(p.views || []).map((v) => `  - ${v}`),
      "- 삶의 이야기 (창작):", ...(p.story || []).map((v) => `  - ${v}`),
      "- 기억나는 장면 (창작):", ...(p.episodes || []).map((v) => `  - ${v}`),
      `- 마음속 고민: ${p.inner || ""}`, `- 말버릇: ${p.habits || ""}`,
      ...((p.limits || []).length ? ["- 조심할 이야기 (경계):", ...p.limits.map((v) => `  - ${v}`)] : []),
      ...((p.beliefs || []).length ? ["- 인물이 사실이라고 믿는 것 (틀리거나 과장일 수 있음, 학생 검증용):", ...p.beliefs.map(([t, n]) => `  - ${t} — *실제: ${n}*`)] : []),
      "- 학생에게 보이는 편지:", ...p.letter.map((t) => `  > ${t}`), "- 근거 진술 (종류 / 출처):");
    p.claims.forEach(([t, id, kind]) => out.push(`  - [ ] **[${kind}]** ${t} **(${id})**`));
    out.push("");
  }
  out.push(`### 실제 자료 (학생에게 보이는 카테고리별 정리)`, "", "> 출처가 모두 검증된 항목만 학생에게 보입니다. 학생에게는 출처 ID 대신 매체·날짜만 표시됩니다.", "");
  for (const c of MATERIALS[ev.id]) {
    out.push(`#### ${c.title}`);
    if (c.stats) out.push(`- 통계 타일: ${c.stats.map((x) => `${x.label} ${x.value}`).join(" / ")} **(${c.statsSrc.join(", ")})**`);
    c.items.forEach((it) => out.push(`  - [ ] **[${it.kind}]** ${it.date ? `${it.date} ` : ""}${it.text} **(${it.src.join(", ")})**`));
    out.push("");
  }
  if (CASES[ev.id].length) {
    out.push("### 4단계 다른 나라(다른 곳) 사례 카드 (학생에게 출처 링크가 보입니다)", "");
    for (const c of CASES[ev.id]) {
      out.push(`#### ${c.country}: ${c.title} **(${c.src.join(", ")})**`, `- [ ] 무엇을 했나: ${c.what}`, `- [ ] 어떻게 되었나: ${c.result}`, `- 생각해 볼 점: ${c.think}`, "");
    }
  }
  if (AFTERMATH[ev.id].length) {
    out.push("### 7단계 실제 이후 전개", "");
    AFTERMATH[ev.id].forEach((it) => out.push(`  - [ ] **[${it.kind}]** ${it.text} **(${it.src.join(", ")})**`));
    out.push("");
  }
}
out.push("## 출처 목록", "", "| ID | 제목 | 매체 | 날짜 | 확인할 것 | 교차 확인 | 원문 대조 |", "|---|---|---|---|---|---|---|");
for (const [id, s] of Object.entries(SOURCES)) {
  const t = s.titleIsDescriptive ? `${s.title} *(설명 문구, 실제 제목 확인)*` : s.title;
  const cc = s.crossCheck ? `**${CROSS[s.crossCheck.status]}** ${s.crossCheck.note}` : "";
  out.push(`| ${id} | [${t.replace(/\|/g, "/")}](${s.url}) | ${s.outlet} | ${s.date} | ${s.check.replace(/\|/g, "/")} | ${cc.replace(/\|/g, "/")} | ${s.verified ? "✅" : "☐"} |`);
}
console.log(out.join("\n"));
