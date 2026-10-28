// 태블릿 화면을 만든다: PC 화면(index.html, teacher.html)을 그대로 바탕으로 t.html, t-teacher.html 을 새로 쓴다.
// 동작은 같은 app.js·teacher.js 가 맡고(같은 id), 배치·크기는 tablet.css 가 태블릿(세로·가로)에 맞춘다.
// PC 화면을 고치면 다시 실행해서 결과를 함께 커밋한다: node tools/build-tablet.js
// (--check 로 실행하면 파일을 쓰지 않고, 지금 파일이 PC 화면과 맞는지만 확인한다. 화면 테스트가 쓴다)
const fs = require("fs"), path = require("path");
const pub = path.join(__dirname, "../public");
const must = (s, a, b) => { if (!s.includes(a)) throw new Error(`바꿀 부분을 찾지 못했어요: ${a.slice(0, 60)}`); return s.replace(a, b); };

function tablet(src, { out, mobile, bodyClass }) {
  let h = fs.readFileSync(path.join(pub, src), "utf8");
  h = must(h, '<meta charset="UTF-8" />', `<meta charset="UTF-8" />\n<!-- 태블릿 화면: ${src} 에서 tools/build-tablet.js 가 만든다. 직접 고치지 말고 ${src} 를 고친 뒤 다시 실행하세요. -->`);
  // 글을 쓸 때 화면 키보드만큼 화면이 줄어들게(입력 칸이 키보드에 가리지 않게)
  h = must(h, 'content="width=device-width, initial-scale=1.0, viewport-fit=cover"', 'content="width=device-width, initial-scale=1.0, viewport-fit=cover, interactive-widget=resizes-content"');
  // 휴대폰으로 열면 모바일 화면으로(태블릿에서는 그대로)
  h = h.replace(/<script src="device\.js"[^>]*><\/script>/, `<script src="device.js" data-mobile="${mobile}"></script>`);
  h = must(h, '<link rel="stylesheet" href="style.css" />', '<link rel="stylesheet" href="style.css" />\n<link rel="stylesheet" href="tablet.css" />');
  h = must(h, "<body>", `<body class="${bodyClass}">`);
  // 아래쪽 화면 바꾸기 링크: 태블릿 화면에서는 PC 화면으로 가는 링크를 늘 보인다
  h = h.replace(/<p class="m-switch hidden" id="to-tablet">.*?<\/p>/, `<p class="m-switch" id="to-pc"><a href="${src}?view=pc">PC 화면으로 보기</a></p>`);
  return [out, h];
}

const pages = [
  tablet("index.html", { out: "t.html", mobile: "m.html", bodyClass: "t" }),
  tablet("teacher.html", { out: "t-teacher.html", mobile: "m-teacher.html", bodyClass: "t t-teacher" }),
];
if (process.argv.includes("--check")) {
  const stale = pages.filter(([f, h]) => !fs.existsSync(path.join(pub, f)) || fs.readFileSync(path.join(pub, f), "utf8") !== h).map(([f]) => f);
  if (stale.length) { console.error(`PC 화면과 맞지 않아요: ${stale.join(", ")} → node tools/build-tablet.js 를 실행하세요.`); process.exit(1); }
  console.log("태블릿 화면이 PC 화면과 맞아요.");
} else {
  for (const [f, h] of pages) fs.writeFileSync(path.join(pub, f), h);
  console.log(pages.map(([f]) => f).join(", "));
}
