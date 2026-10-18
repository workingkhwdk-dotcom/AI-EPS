const test = require("node:test");
const assert = require("node:assert");
const { isTeacherEmail, parseEmails, ADMIN_EMAILS, FIXED_TEACHERS } = require("../teachers");

const noDoc = async () => undefined;

test("관리자 이메일은 설정이 비어 있어도 항상 교사이고, 대소문자·공백을 무시한다", async () => {
  assert.ok(ADMIN_EMAILS.includes("working.khwdk@gmail.com"));
  assert.equal(await isTeacherEmail("working.khwdk@gmail.com", { envList: "", readDoc: noDoc }), true);
  assert.equal(await isTeacherEmail("  Working.KHWDK@Gmail.com ", { envList: "교사구글계정@gmail.com", readDoc: noDoc }), true);
});

test("환경 설정 목록(쉼표)의 이메일은 교사", async () => {
  assert.equal(await isTeacherEmail("b@school.kr", { envList: "a@x.com, B@school.kr", readDoc: noDoc }), true);
});

test("Firestore 목록(배열)에 있으면 교사, 지우면 즉시 아님", async () => {
  let doc = { emails: ["new@school.kr"] };
  const readDoc = async () => doc;
  assert.equal(await isTeacherEmail("new@school.kr", { readDoc }), true);
  doc = { emails: [] };
  assert.equal(await isTeacherEmail("new@school.kr", { readDoc }), false);
});

test("Firestore 값이 쉼표 문자열이어도 인정한다", async () => {
  assert.deepEqual(parseEmails("A@x.com, b@x.com ,"), ["a@x.com", "b@x.com"]);
  assert.equal(await isTeacherEmail("b@x.com", { readDoc: async () => ({ emails: "a@x.com, b@x.com" }) }), true);
});

test("목록에 없거나 이메일이 없으면(익명 학생) 교사가 아니다", async () => {
  const readDoc = async () => ({ emails: ["a@x.com"] });
  assert.equal(await isTeacherEmail("student@x.com", { envList: "z@x.com", readDoc }), false);
  assert.equal(await isTeacherEmail(undefined, { readDoc }), false);
  assert.equal(await isTeacherEmail("", { readDoc }), false);
});

test("Firestore 읽기가 실패해도 안전하게 거부하되, 관리자·환경 목록은 영향 없다", async () => {
  const readDoc = async () => { throw new Error("boom"); };
  assert.equal(await isTeacherEmail("x@x.com", { readDoc }), false);
  assert.equal(await isTeacherEmail("working.khwdk@gmail.com", { readDoc }), true);
});

test("잘못된 형식(null, 숫자)이 와도 오류 없이 빈 목록", () => {
  assert.deepEqual(parseEmails(null), []);
  assert.deepEqual(parseEmails(123), ["123"]);
});

test("코드에 고정한 교사(ccchoihy@gmail.com)는 설정 없이도 교사다", async () => {
  assert.ok(FIXED_TEACHERS.includes("ccchoihy@gmail.com"));
  assert.equal(await isTeacherEmail("CCChoiHY@gmail.com", { envList: "", readDoc: noDoc }), true);
});
