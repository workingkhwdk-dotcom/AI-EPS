// Firestore 보안 규칙 테스트. 학생이 읽거나 쓰면 안 되는 것을 실제 규칙으로 확인한다.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const { initializeTestEnvironment, assertFails, assertSucceeds } = require("@firebase/rules-unit-testing");
const { doc, getDoc, getDocs, collection, updateDoc, setDoc, deleteField, serverTimestamp } = require("firebase/firestore");

const C = "ABC234";
let env;

test.before(async () => {
  env = await initializeTestEnvironment({ projectId: "demo-ai-eps", firestore: { rules: fs.readFileSync(path.join(__dirname, "../firestore.rules"), "utf8") } });
});
test.after(async () => { await env.cleanup(); });
test.beforeEach(async () => {
  await env.clearFirestore();
  await env.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore();
    await setDoc(doc(db, `sessions/${C}`), { teacherUid: "T1", title: "수업", groupCount: 2, closed: false });
    for (const [uid, gid, nick] of [["S1", "g1", "가람"], ["S2", "g1", "나래"], ["S3", "g2", "다솜"]]) {
      await setDoc(doc(db, `sessions/${C}/members/${uid}`), { groupId: gid, nickname: nick, stage: 1 });
      await setDoc(doc(db, `sessions/${C}/assign/${uid}`), { groupId: gid, personaId: "j_officer" });
      await setDoc(doc(db, `sessions/${C}/members/${uid}/chat/c1`), { input: "안녕", output: "네", uid });
      await setDoc(doc(db, `sessions/${C}/guardlog/${uid}c1`), { uid, personaId: "j_officer", guard: { original: "원래 응답" } });
    }
    await setDoc(doc(db, `sessions/${C}/alerts/a1`), { uid: "S1", category: "mockery", input: "욕설" });
    await setDoc(doc(db, `sessions/${C}/assignGroup/g1`), { personaIds: ["j_officer"] });
    await setDoc(doc(db, `sessions/${C}/creds/k`), { hash: "h", salt: "s", uid: "S1" });
    await setDoc(doc(db, `sessions/${C}/attempts/S1`), { fails: 1 });
    await setDoc(doc(db, `sessions/${C}/private/materials`), { categories: [] });
    await setDoc(doc(db, `sessions/${C}/groups/g1`), { name: "1모둠", work: { s1: { findings: { S1: { who: "a" }, S2: { who: "b" } } }, live: {} } });
    await setDoc(doc(db, `sessions/${C}/groups/g2`), { name: "2모둠", work: {} });
  });
});
const as = (uid) => env.authenticatedContext(uid, uid === "T1" ? { email: "t@x.kr" } : {}).firestore();
const P = (p) => `sessions/${C}/${p}`;

test("서버 전용 문서는 학생도 교사도 클라이언트로 읽거나 쓸 수 없다(비밀번호 해시, 시도 횟수, 수업별 자료)", async () => {
  for (const uid of ["S1", "T1"]) for (const p of ["creds/k", "attempts/S1", "private/materials"]) {
    await assertFails(getDoc(doc(as(uid), P(p))));
    await assertFails(setDoc(doc(as(uid), P(p)), { x: 1 }));
  }
});

test("인물 배정과 감독자 기록(원래 응답·판정)은 교사만 읽고, 학생은 자기 것도 못 읽는다", async () => {
  for (const p of ["assign/S1", "assignGroup/g1", "guardlog/S1c1"]) {
    await assertFails(getDoc(doc(as("S1"), P(p))));
    await assertSucceeds(getDoc(doc(as("T1"), P(p))));
    await assertFails(setDoc(doc(as("T1"), P(p)), { x: 1 }));
  }
  await assertFails(getDocs(collection(as("S1"), P("guardlog"))));
  await assertFails(getDocs(collection(as("S1"), P("assign"))));
});

test("대화 규칙 위반 신호(alerts)는 교사만 읽고, 학생은 자기 것도 못 읽으며 아무도 클라이언트로 쓸 수 없다", async () => {
  await assertSucceeds(getDoc(doc(as("T1"), P("alerts/a1"))));
  await assertFails(getDoc(doc(as("S1"), P("alerts/a1"))));
  await assertFails(getDocs(collection(as("S1"), P("alerts"))));
  await assertFails(setDoc(doc(as("T1"), P("alerts/a2")), { x: 1 }));
  await assertFails(setDoc(doc(as("S1"), P("alerts/a2")), { x: 1 }));
});

test("학생은 자기 대화·자기 문서만 읽고 다른 학생 것은 못 읽는다. 교사는 모두 읽는다", async () => {
  await assertSucceeds(getDoc(doc(as("S1"), P("members/S1/chat/c1"))));
  await assertFails(getDoc(doc(as("S1"), P("members/S2/chat/c1"))));
  await assertFails(getDoc(doc(as("S1"), P("members/S2"))));
  await assertSucceeds(getDoc(doc(as("T1"), P("members/S2/chat/c1"))));
  await assertFails(setDoc(doc(as("S1"), P("members/S1/chat/c2")), { input: "x", output: "y" }));
  const m = (await getDoc(doc(as("S1"), P("members/S1")))).data();
  assert.equal("personaId" in m, false);
});

test("로그인하지 않았거나 다른 수업의 참여자는 아무것도 읽지 못한다", async () => {
  await assertFails(getDoc(doc(env.unauthenticatedContext().firestore(), P("groups/g1"))));
  await assertFails(getDoc(doc(as("OUT"), P("groups/g1"))));
  await assertFails(getDoc(doc(as("OUT"), P("members/S1"))));
});

test("모둠 산출물: 모둠원은 공용 칸을 고칠 수 있지만 다른 모둠은 못 고친다", async () => {
  await assertSucceeds(updateDoc(doc(as("S2"), P("groups/g1")), { "work.s2.causes.x": { text: "원인" } }));
  await assertFails(updateDoc(doc(as("S3"), P("groups/g1")), { "work.s2.causes.y": { text: "원인" } }));
  await assertFails(updateDoc(doc(as("S1"), P("groups/g1")), { aiCount: 0 }));
  await assertFails(updateDoc(doc(as("S1"), P("groups/g1")), { name: "해킹" }));
});

test("1단계 개인 정리와 '입력 중' 표시는 자기 칸만 고칠 수 있다", async () => {
  await assertSucceeds(updateDoc(doc(as("S1"), P("groups/g1")), { "work.s1.findings.S1.who": "내 것" }));
  await assertFails(updateDoc(doc(as("S1"), P("groups/g1")), { "work.s1.findings.S2.who": "남의 것" }));
  await assertFails(updateDoc(doc(as("S1"), P("groups/g1")), { "work.s1.findings.S2": deleteField() }));
  await assertSucceeds(updateDoc(doc(as("S1"), P("groups/g1")), { "work.live.S1": { path: "x", t: 1 } }));
  await assertSucceeds(updateDoc(doc(as("S1"), P("groups/g1")), { "work.live.S1": deleteField() }));
  await assertFails(updateDoc(doc(as("S1"), P("groups/g1")), { "work.live.S2": { path: "x", t: 1 } }));
  // 아직 개인 정리가 없는 모둠(g2)에서 처음 쓰는 경우
  await assertSucceeds(updateDoc(doc(as("S3"), P("groups/g2")), { "work.s1.findings.S3": { who: "처음" } }));
  await assertFails(updateDoc(doc(as("S3"), P("groups/g2")), { "work.s1.findings.S1": { who: "남의 것" } }));
});

test("접속 신호: 자기 문서의 stage·lastSeen만 고칠 수 있다", async () => {
  await assertSucceeds(updateDoc(doc(as("S1"), P("members/S1")), { stage: 3, lastSeen: serverTimestamp() }));
  await assertFails(updateDoc(doc(as("S1"), P("members/S1")), { stage: 8, lastSeen: serverTimestamp() }));
  await assertFails(updateDoc(doc(as("S1"), P("members/S1")), { nickname: "바꿈", lastSeen: serverTimestamp() }));
  await assertFails(updateDoc(doc(as("S1"), P("members/S2")), { stage: 3, lastSeen: serverTimestamp() }));
});

test("수업을 닫으면 학생의 저장·접속 신호가 막히고, 다시 열면 풀린다. 읽기는 가능하다", async () => {
  await env.withSecurityRulesDisabled((ctx) => updateDoc(doc(ctx.firestore(), `sessions/${C}`), { closed: true }));
  await assertFails(updateDoc(doc(as("S1"), P("groups/g1")), { "work.s2.causes.z": { text: "x" } }));
  await assertFails(updateDoc(doc(as("S1"), P("members/S1")), { stage: 2, lastSeen: serverTimestamp() }));
  await assertSucceeds(getDoc(doc(as("S1"), P("groups/g1"))));
  await env.withSecurityRulesDisabled((ctx) => updateDoc(doc(ctx.firestore(), `sessions/${C}`), { closed: false }));
  await assertSucceeds(updateDoc(doc(as("S1"), P("groups/g1")), { "work.s2.causes.z": { text: "x" } }));
});

test("수업 문서는 학생이 쓸 수 없고, 교사는 자기 수업만 읽는다", async () => {
  await assertFails(updateDoc(doc(as("S1"), `sessions/${C}`), { closed: true }));
  await assertSucceeds(getDoc(doc(as("T1"), `sessions/${C}`)));
  await assertFails(getDoc(doc(as("T2"), `sessions/${C}`)));
  await assertFails(getDoc(doc(as("S1"), "config/teachers")));
});
