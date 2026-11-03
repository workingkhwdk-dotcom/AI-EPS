// 배포용 보호 빌드: public/ 을 dist/ 로 복사하면서 자바스크립트를 난독화하고 주석을 지운다.
// 사용: cd tools && npm install && node build-dist.js     (firebase deploy 때 predeploy 로 자동 실행)
// 원본(public/)은 그대로 두고, 배포되는 것은 dist/ 뿐이다. 소스맵은 만들지 않는다.
// 한계: 브라우저가 실행하는 코드는 결국 사용자에게 전달되므로 난독화는 '베끼기 어렵게' 만들 뿐 완전히 막지는 못한다.
//       그래서 프롬프트·인물/사건 원자료·판정은 서버(functions/)에만 둔다.
const fs = require("fs"), path = require("path");
const JavaScriptObfuscator = require("javascript-obfuscator");

const SRC = path.join(__dirname, "../public");
const OUT = process.env.DIST_DIR || path.join(__dirname, "../dist");
const YEAR = new Date().getFullYear();
const BANNER = `/*! AI-EPS © ${YEAR} 한국교원대학교 AI-EPS 연구진. All rights reserved. 무단 복제·수정·재배포 금지 (see LICENSE). */\n`;

// 난독화하지 않을 파일: 외부 라이브러리(이미 최소화·크기만 커짐), 설정값(공개 값)
const SKIP_JS = new Set(["vendor/qrcode.js", "firebase-config.js"]);

const OBF = {
  compact: true,
  target: "browser",
  sourceMap: false,
  renameGlobals: false,            // ES 모듈·HTML 의 onclick 등과 이름이 어긋나지 않게
  identifierNamesGenerator: "hexadecimal",
  stringArray: true,
  stringArrayEncoding: ["base64"],
  stringArrayThreshold: 0.8,
  stringArrayRotate: true,
  stringArrayShuffle: true,
  stringArrayWrappersCount: 2,
  splitStrings: false,             // 한글 문자열을 쪼개면 느려지고 이득이 적다
  controlFlowFlattening: false,    // 속도 영향이 커서 쓰지 않는다(수업 중 휴대폰에서 느려지면 안 된다)
  deadCodeInjection: false,
  selfDefending: false,
  debugProtection: false,          // 개발자 도구를 막는 장치는 학교 점검·접근성에 방해라 쓰지 않는다
  disableConsoleOutput: false,
  unicodeEscapeSequence: false,
  transformObjectKeys: false,
  simplify: true,
};

const walk = (d, rel = "") => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => {
  const r = path.posix.join(rel, e.name);
  return e.isDirectory() ? walk(path.join(d, e.name), r) : [r];
});

fs.rmSync(OUT, { recursive: true, force: true });
let nJs = 0, nHtml = 0, before = 0, after = 0;
for (const rel of walk(SRC)) {
  const from = path.join(SRC, rel), to = path.join(OUT, rel);
  fs.mkdirSync(path.dirname(to), { recursive: true });
  if (rel.endsWith(".map")) continue;
  if (rel.endsWith(".js") && !SKIP_JS.has(rel)) {
    const code = fs.readFileSync(from, "utf8");
    const res = JavaScriptObfuscator.obfuscate(code, OBF).getObfuscatedCode();
    fs.writeFileSync(to, BANNER + res);
    nJs++; before += code.length; after += res.length;
  } else if (rel.endsWith(".html")) {
    let h = fs.readFileSync(from, "utf8");
    // HTML 주석(설계 설명)을 지운다. 조건부 주석·doctype 은 없다.
    h = h.replace(/<!--[\s\S]*?-->/g, "");
    // 인라인 <script>(src 없는 것)도 난독화한다. type="module" 도 그대로 둔다.
    h = h.replace(/<script(?![^>]*\bsrc=)([^>]*)>([\s\S]*?)<\/script>/g, (m, attrs, body) =>
      body.trim() && !/importmap|json/.test(attrs) ?`<script${attrs}>${JavaScriptObfuscator.obfuscate(body, OBF).getObfuscatedCode()}</script>` : m);
    fs.writeFileSync(to, h);
    nHtml++;
  } else if (rel.endsWith(".css")) {
    // CSS 주석 제거(문자열 안의 /* 는 쓰지 않는다)
    fs.writeFileSync(to, fs.readFileSync(from, "utf8").replace(/\/\*[\s\S]*?\*\//g, ""));
  } else {
    fs.copyFileSync(from, to);
  }
}
console.log(`dist 완료: JS ${nJs}개 난독화(${(before / 1024) | 0}KB → ${(after / 1024) | 0}KB), HTML ${nHtml}개 정리 → ${OUT}`);
