const { chromium } = require("playwright");
(async () => {
  const b = await chromium.launch({ args: ["--no-sandbox"] });
  const p = await b.newPage();
  await p.route(/fonts\.(googleapis|gstatic)/, (r) => r.abort());
  await p.goto("file://" + require("path").resolve(__dirname, "../lesson-plan.html"));
  await p.waitForTimeout(800);
  await p.pdf({ path: process.argv[2] || "out.pdf", preferCSSPageSize: true, printBackground: true });
  await b.close();
})();
