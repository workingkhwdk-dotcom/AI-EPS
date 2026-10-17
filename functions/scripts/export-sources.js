// case.js 의 인물·출처를 원문 대조용 마크다운 점검표로 내보낸다: node scripts/export-sources.js > ../docs/PERSONA_SOURCES.md
const { SOURCES, EVENTS, PERSONAS, MATERIALS, CASES, AFTERMATH } = require("../case");
const CROSS = { ok: "교차 확인", partial: "일부 확인", fixed: "고쳐 씀", todo: "확인 못 함" };
const out = [];
out.push("# 페르소나 근거 자료 점검표", "");
out.push("> 이 문서는 `functions/case.js`에서 자동 생성됩니다 (`cd functions && npm run export-sources`).");
out.push("> 근거 진술은 AI가 웹 검색 결과 요약을 바탕으로 정리한 것이며 **원문을 직접 열람하지 못했습니다.** 수업 전에 각 출처의 원문을 열어 아래 항목을 확인한 뒤, 맞으면 `case.js`에서 해당 출처의 `verified`를 true로 바꾸세요. 틀린 진술은 고치거나 지우세요.", "");
out.push("> **검색 교차 확인(2026-10)**: 원문 페이지를 열 수 없는 환경이라, 검색으로 원문 기사 요약과 다른 매체 보도를 대조했습니다. 결과는 맨 아래 출처 목록의 '교차 확인' 열에 있습니다(교차 확인 / 일부 확인 / 고쳐 씀 / 확인 못 함). 교차 확인은 원문 대조를 대신하지 않습니다. '일부 확인'과 '확인 못 함'부터 원문을 보세요.", "");
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
      "- 학생에게 보이는 편지:", ...p.letter.map((t) => `  > ${t}`), "- 근거 진술 (종류 / 출처):");
    p.claims.forEach(([t, id, kind]) => out.push(`  - [ ] **[${kind}]** ${t} **(${id})**`));
    out.push("");
  }
}
out.push("## 3단계 실제 자료 (학생에게 보이는 카테고리별 정리)", "", "> 출처가 모두 검증된 항목만 학생에게 보입니다. 학생에게는 출처 ID 대신 매체·날짜만 표시됩니다.", "");
for (const c of MATERIALS) {
  out.push(`### ${c.title}`);
  if (c.stats) out.push(`- 통계 타일: ${c.stats.map((x) => `${x.label} ${x.value}`).join(" / ")} **(${c.statsSrc.join(", ")})**`);
  c.items.forEach((it) => out.push(`  - [ ] **[${it.kind}]** ${it.date ? `${it.date} ` : ""}${it.text} **(${it.src.join(", ")})**`));
  out.push("");
}
out.push("## 4단계 다른 나라 사례 카드 (학생에게 출처 링크가 보입니다)", "");
for (const c of CASES) {
  out.push(`### ${c.country}: ${c.title} **(${c.src.join(", ")})**`, `- [ ] 무엇을 했나: ${c.what}`, `- [ ] 어떻게 되었나: ${c.result}`, `- 생각해 볼 점: ${c.think}`, "");
}
out.push("## 7단계 실제 이후 전개", "");
AFTERMATH.forEach((it) => out.push(`  - [ ] **[${it.kind}]** ${it.text} **(${it.src.join(", ")})**`));
out.push("");
out.push("## 출처 목록", "", "| ID | 제목 | 매체 | 날짜 | 확인할 것 | 교차 확인 | 원문 대조 |", "|---|---|---|---|---|---|---|");
for (const [id, s] of Object.entries(SOURCES)) {
  const t = s.titleIsDescriptive ? `${s.title} *(설명 문구, 실제 제목 확인)*` : s.title;
  const cc = s.crossCheck ? `**${CROSS[s.crossCheck.status]}** ${s.crossCheck.note}` : "";
  out.push(`| ${id} | [${t.replace(/\|/g, "/")}](${s.url}) | ${s.outlet} | ${s.date} | ${s.check} | ${cc.replace(/\|/g, "/")} | ${s.verified ? "✅" : "☐"} |`);
}
console.log(out.join("\n"));
