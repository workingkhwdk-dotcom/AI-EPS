// 체험(demo) 페이지용 데이터를 만든다. 서버 없이 브라우저에서 학생 화면을 돌리기 위해,
// 학생에게 이미 보이는 내용(편지·수업 자료·사례·이후 전개)과 인물이 '대답할 말 후보'만 public/demo/ 에 내보낸다.
// 교사 전용 정보(역할 label·근거 basis·출처·조심할 이야기 등)는 내보내지 않는다.
// 사용: node tools/build-demo-data.js   (functions/cases 를 고쳤다면 다시 실행해서 결과를 함께 커밋)
const fs = require("fs"), path = require("path");
const c = require("../functions/case");
const { isPersonal } = require("../functions/charter");

const out = path.join(__dirname, "../public/demo");
fs.mkdirSync(path.join(out, "data"), { recursive: true });

const topics = [];
for (const id of Object.keys(c.EVENTS)) {
  const ev = c.EVENTS[id];
  const personas = c.availablePersonas(id, false);
  // 원문 대조(verified)를 마치지 않아 학생에게 보일 인물이 없는 사건은 체험에도 내보내지 않는다
  if (!personas.length) { console.log(`건너뜀(원문 대조 전): ${id}`); continue; }
  const data = {
    id, title: ev.title, summary: ev.summary, stakeholders: ev.stakeholders, ui: ev.ui,
    letters: personas.map((p) => ({ id: p.id, name: p.name, brief: c.BRIEFS[p.id] || p.label || "", letter: p.letter, required: c.isRequired(p), personal: isPersonal(p) })),
    // 인물이 대화에서 고를 수 있는 말: 편지 문단(1인칭)과 입장 문장. 인사·마무리 문단은 따로 둔다.
    say: Object.fromEntries(personas.map((p) => [p.id, { hello: p.letter[0], paras: p.letter.slice(1), views: p.views }])),
    materials: c.materialsFor(id),
    cases: c.casesFor(id),
    aftermath: c.aftermathFor(id),
  };
  fs.writeFileSync(path.join(out, "data", `${id}.json`), JSON.stringify(data));
  topics.push({ id, title: ev.title, summary: ev.summary, personas: personas.length, stakeholders: ev.stakeholders });
}
fs.writeFileSync(path.join(out, "topics.json"), JSON.stringify(topics, null, 1));
console.log(topics.map((t) => `${t.id}: ${t.title} (${t.personas}명)`).join("\n"));

// ---- 체험 화면(PC·모바일·태블릿): 학생 화면 index.html / m.html / t.html 을 그대로 바탕으로 한다(화면 구성이 바뀌어도 따라가도록 매번 새로 만든다) ----
// (t.html 은 tools/build-tablet.js 가 만든다. index.html 을 고쳤다면 그것부터 실행한다)
const pub = path.join(__dirname, "../public");
const IMPORTS = ["firebase-app", "firebase-auth", "firebase-firestore", "firebase-functions"]
  .map((n) => `"https://www.gstatic.com/firebasejs/10.12.2/${n}.js": "./demo/stubs/${n}.js"`).join(", ");
const must = (s, a, b) => { if (!s.includes(a)) throw new Error(`바꿀 부분을 찾지 못했어요: ${a.slice(0, 50)}`); return s.replace(a, b); };
// 기기에 맞는 화면으로 옮길 때도 체험 화면끼리 오간다
const DEMO = { "m.html": "demo-play-m.html", "t.html": "demo-play-t.html" };
function page(src) {
  let h = fs.readFileSync(path.join(pub, src), "utf8");
  h = h.replace(/<title>[\s\S]*?<\/title>/, "<title>AI-EPS 체험</title>");
  h = h.replace(/<link rel="manifest"[^>]*>\n?/, "");
  h = must(h, '<meta charset="UTF-8" />', `<meta charset="UTF-8" />\n<!-- 체험 화면: ${src} 에서 tools/build-demo-data.js 가 만든다. 직접 고치지 말고 그 스크립트를 고치세요. -->\n<script src="demo/boot.js"></script>\n<script type="importmap">{"imports": {${IMPORTS}}}</script>`);
  h = h.replace(/data-(mobile|tablet)="(m\.html|t\.html)"/g, (_, k, f) => `data-${k}="${DEMO[f]}"`);
  h = must(h, "</head>", '<link rel="stylesheet" href="demo/demo.css" />\n</head>');
  h = must(h, '<script type="module" src="app.js"></script>', '<script type="module" src="app.js"></script>\n<script type="module" src="demo/ui.js"></script>');
  return h;
}
fs.writeFileSync(path.join(pub, "demo-play.html"), page("index.html"));
fs.writeFileSync(path.join(pub, "demo-play-m.html"), page("m.html"));
fs.writeFileSync(path.join(pub, "demo-play-t.html"), page("t.html"));
console.log("demo-play.html, demo-play-m.html, demo-play-t.html");
