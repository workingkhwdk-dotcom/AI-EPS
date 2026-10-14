// case.js 의 인물·출처를 원문 대조용 마크다운 점검표로 내보낸다: node scripts/export-sources.js > ../docs/PERSONA_SOURCES.md
const { SOURCES, EVENTS, PERSONAS, personaSourceIds } = require("../case");
const out = [];
out.push("# 페르소나 근거 자료 점검표", "");
out.push("> 이 문서는 `functions/case.js`에서 자동 생성됩니다 (`cd functions && npm run export-sources`).");
out.push("> 근거 진술은 AI가 웹 검색 결과 요약을 바탕으로 정리한 것이며 **원문을 직접 열람하지 못했습니다.** 수업 전에 각 출처의 원문을 열어 아래 항목을 확인한 뒤, 맞으면 `case.js`에서 해당 출처의 `verified`를 true로 바꾸세요. 틀린 진술은 고치거나 지우세요.", "");
out.push("**확인 방법**: 진술이 원문에 있는가 / 표현이 과장·왜곡되지 않았는가 / 누구의 발언·주장인가(기자 서술, 인터뷰, 칼럼 의견) / 날짜와 수치가 맞는가", "");
for (const ev of Object.values(EVENTS)) {
  out.push(`## ${ev.title}`, "", ev.summary, "", `> 교사 메모: ${ev.teacherNote}`, "");
  for (const p of PERSONAS.filter((x) => x.events.includes(ev.id))) {
    out.push(`### ${p.name}`, `- 역할: ${p.role}`, `- 입장: ${p.stance}`, "- 근거 진술:");
    p.claims.forEach(([t, id]) => out.push(`  - [ ] ${t} **(${id})**`));
    out.push("");
  }
}
out.push("## 출처 목록", "", "| ID | 제목 | 매체 | 날짜 | 확인할 것 | 확인 |", "|---|---|---|---|---|---|");
for (const [id, s] of Object.entries(SOURCES)) {
  const t = s.titleIsDescriptive ? `${s.title} *(설명 문구, 실제 제목 확인)*` : s.title;
  out.push(`| ${id} | [${t.replace(/\|/g, "/")}](${s.url}) | ${s.outlet} | ${s.date} | ${s.check} | ${s.verified ? "✅" : "☐"} |`);
}
console.log(out.join("\n"));
