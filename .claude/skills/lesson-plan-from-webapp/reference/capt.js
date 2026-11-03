const http = require("http"), fs = require("fs"), path = require("path");
const { chromium } = require("playwright");
const seed = require("./seed.js");
const src = fs.readFileSync(path.join(__dirname, "cap.js"), "utf8");
const stubs = eval("(" + src.match(/const stubs = (\{[\s\S]*?\n\});/)[1] + ")");
const ROOT = path.resolve(__dirname, "../../public"), OUT = path.join(__dirname, "shots");
const types = { ".webp": "image/webp", ".png": "image/png", ".ico": "image/x-icon", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".json": "application/json" };
const srv = http.createServer((req, res) => { const u = decodeURIComponent(req.url.split("?")[0]); const f = path.join(ROOT, u === "/" ? "index.html" : u); if (!f.startsWith(ROOT) || !fs.existsSync(f)) { res.writeHead(404); return res.end(); } res.writeHead(200, { "Content-Type": types[path.extname(f)] || "text/html; charset=utf-8" }); res.end(fs.readFileSync(f)); });
const IPAD = "Mozilla/5.0 (iPad; CPU OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1";
const DEEP = Object.fromEntries(["beliefs", "premise", "causeMap", "sources", "tradeoff", "chain", "power", "why"].map((k) => [k, true]));
(async () => {
  await new Promise((r) => srv.listen(0, r));
  const base = `http://localhost:${srv.address().port}`;
  const browser = await chromium.launch({ args: ["--no-sandbox"] });
  const ctx = await browser.newContext({ userAgent: IPAD, viewport: { width: 1000, height: 900 }, deviceScaleFactor: 2, hasTouch: true, locale: "ko-KR" });
  const pg = await ctx.newPage(); const errors = [];
  pg.on("pageerror", (e) => errors.push(e.message));
  await pg.route(/gstatic\.com\/firebasejs/, (r) => r.fulfill({ contentType: "text/javascript", body: stubs[r.request().url().split("/").pop()] || "" }));
  const FONTS = path.join(__dirname, "fonts/node_modules");
  srv.removeAllListeners("request");
  srv.on("request", (req, res) => { const u = decodeURIComponent(req.url.split("?")[0]); if (u.startsWith("/__f/")) { const f = path.join(FONTS, u.slice(5)); if (!fs.existsSync(f)) { res.writeHead(404); return res.end(); } res.writeHead(200, { "Content-Type": "font/woff2", "Access-Control-Allow-Origin": "*" }); return res.end(fs.readFileSync(f)); } const f = path.join(ROOT, u === "/" ? "index.html" : u); if (!f.startsWith(ROOT) || !fs.existsSync(f)) { res.writeHead(404); return res.end(); } res.writeHead(200, { "Content-Type": types[path.extname(f)] || "text/html; charset=utf-8" }); res.end(fs.readFileSync(f)); });
  await pg.route(/cdn\.jsdelivr/, (r) => r.fulfill({ contentType: "text/css", body: `@font-face{font-family:'Pretendard Variable';font-weight:45 920;font-style:normal;src:url(${base}/__f/pretendard/dist/web/variable/woff2/PretendardVariable.woff2) format('woff2-variations');}` }));
  await pg.route(/fonts\.(googleapis|gstatic)/, (r) => r.abort());
  await pg.addInitScript(({ work, DEEP }) => {
    try { for (const k of ["teacher-main", "teacher-class", "demo-menu", "demo-play"]) localStorage.setItem("eps_tour_" + k, "1"); } catch {}
    window.__user = { uid: "T1", email: "t@x.kr", isAnonymous: false };
    window.__docs = {};
    const now = { toMillis: () => Date.now(), toDate: () => new Date() };
    const keep = (n) => { const o = {}; for (let i = 1; i <= n; i++) o["s" + i] = work["s" + i]; return o; };
    const names = ["가람", "나래", "다온", "라온", "마루", "바다", "사랑", "아름", "하늘", "새봄", "도윤", "서윤", "지우", "예준", "시우", "하린", "지안", "유나", "로운", "소율", "다인", "이든", "나비", "보리"];
    const prog = [3, 4, 2, 5, 3, 1]; // 모둠별 진행 단계
    const members = [], groups = [];
    prog.forEach((st, gi) => {
      for (let k = 0; k < 4; k++) members.push({ id: `u${gi}${k}`, groupId: `g${gi + 1}`, nickname: names[gi * 4 + k], stage: Math.max(1, st - (k === 3 ? 1 : 0)), chatCount: 5, aiCount: 3, lastSeen: now });
      groups.push({ id: `g${gi + 1}`, name: `${gi + 1}모둠`, work: keep(st), aiCount: [18, 35, 6, 62, 24, 4][gi], guardCount: gi === 2 ? 3 : 0, memberCount: 4 });
    });
    window.__cols = {
      sessions: [{ id: "ABC234", title: "제주 예멘 난민 사건, 갈등 해결 방안 제안하기", groupCount: 6, teacherUid: "T1", level: "high", deep: DEEP, started: true, chatLimit: 5, aiLimit: 150, coach: true, eventId: "jeju2018" }],
      "sessions/ABC234/members": members,
      "sessions/ABC234/alerts": [],
      "sessions/ABC234/groups": groups,
    };
    window.__log = []; window.__writes = [];
    window.__fn = async (name) => (name === "getMaterials" ? { categories: [], isDefault: true } : name === "getCase" ? { personas: [], materials: [], event: { teacherNote: "", background: [] } } : {});
  }, { work: seed.work, DEEP });
  await pg.goto(`${base}/t-teacher.html`);
  await pg.waitForSelector("#sessions button[data-code]");
  await pg.click("#new-toggle"); await pg.waitForTimeout(500);
  await pg.evaluate(() => window.scrollTo(0, document.querySelector("#new-form").getBoundingClientRect().top + scrollY - 150)); await pg.waitForTimeout(300);
  await pg.screenshot({ path: path.join(OUT, "tv-new.jpg"), type: "jpeg", quality: 88 }); console.log("tv-new");
  await pg.click("#new-toggle");
  await pg.click("#sessions button[data-code]");
  await pg.waitForSelector("#students tr"); await pg.waitForTimeout(900);
  await pg.screenshot({ path: path.join(OUT, "tv-live.jpg"), type: "jpeg", quality: 88 }); console.log("tv-live");
  await pg.evaluate(() => window.scrollTo(0, document.querySelector("#groups").closest(".card").getBoundingClientRect().top + scrollY - 140)); await pg.waitForTimeout(300);
  await pg.screenshot({ path: path.join(OUT, "tv-groups.jpg"), type: "jpeg", quality: 88 }); console.log("tv-groups");
  console.log("errors", errors);
  await browser.close(); srv.close();
})().catch((e) => { console.error(e); process.exit(1); });
