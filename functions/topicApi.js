// 교사 주제 만들기의 서버 함수(topics). 한 함수가 action 으로 나뉜다(Cloud Run CPU 한도 때문에 함수 수를 늘리지 않는다).
//  - 저장: list / get / save / plan / verifySource / delete / syncSession
//  - AI  : ideas / start / research / frame / personas / extras / review / regenPersona
// 주제는 만든 교사만 읽고 고친다(ownerUid). Firestore 규칙은 클라이언트의 직접 읽기·쓰기를 모두 막는다.
// 설계와 단계는 docs/TOPIC_BUILDER.md.
const crypto = require("crypto");
const build = require("./topicBuild");
const compose = require("./topicCompose");
const { checkBundle } = require("./topicCheck");
const { toStored, fromStored, sanitizeFile, summarize } = require("./topicData");
const { makeBundle, availablePersonas, isRequired } = require("./case");

const STEPS = ["start", "research", "frame", "personas", "extras", "review"];
const AI_ACTIONS = ["ideas", "start", "research", "frame", "personas", "extras", "review", "regenPersona"]; // 비용이 드는 AI 단계(스위치로 막는다)
const MAX_TOPICS = 30; // 교사 한 명이 가질 수 있는 주제 수
const MAX_CALLS = 120; // 주제 하나에 쓸 수 있는 AI 호출 수(다시 만들기 포함)
const IDEAS_PER_DAY = 10;
const PERSONA_BATCH = 3; // 인물 만들기 한 번에 만드는 인물 수
const BUSY_MS = 9 * 60 * 1000; // 한 단계가 이보다 오래 '진행 중'이면 끝난 것으로 본다(함수 시간 제한 540초)

const day = () => new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10); // 한국 날짜
const newTopicId = () => "t" + crypto.randomBytes(5).toString("hex");

function makeTopicApi({ db, FieldValue, HttpsError, requireTeacher, ai, dailyLimit, onSessionTopic, builderOpen = () => true }) {
  const ref = (id) => db.doc(`teacherTopics/${id}`);
  const researchRef = (id) => db.doc(`teacherTopics/${id}/parts/research`);
  const usageRef = (uid) => db.doc(`topicUsage/${uid}`);
  const fail = (code, msg) => { throw new HttpsError(code, msg); };

  async function own(auth, id) {
    const tid = String(id || "");
    if (!/^t[0-9a-f]{10}$/.test(tid)) fail("invalid-argument", "주제를 찾을 수 없습니다.");
    const snap = await ref(tid).get();
    if (!snap.exists) fail("not-found", "주제를 찾을 수 없습니다.");
    const d = snap.data();
    if (d.ownerUid !== auth.uid) fail("permission-denied", "내가 만든 주제가 아닙니다.");
    return { id: tid, ...d, file: fromStored(d.bundle) };
  }
  // 수업에 쓸 수 있는 주제인지: 구조 검사 오류가 없고, 원문 확인을 마친 인물이 있고, 꼭 있어야 하는 축의 인물이 있어야 한다
  function usableInfo(file) {
    if (!file?.EVENT?.id || !(file.PERSONAS || []).length) return { check: null, usable: 0, required: false };
    const check = checkBundle(file);
    const b = makeBundle(file, { custom: true });
    const ok = availablePersonas(b);
    return { check, usable: ok.length, required: ok.some(isRequired) };
  }
  async function forClass(auth, id) {
    const t = await own(auth, id);
    const { check, usable, required } = usableInfo(t.file);
    if (!check) fail("failed-precondition", "아직 다 만들지 않은 주제입니다.");
    if (check.errors.length) fail("failed-precondition", `주제에 고칠 곳이 있습니다: ${check.errors[0].where} — ${check.errors[0].msg}`);
    if (!usable) fail("failed-precondition", "원문 확인을 마친 인물이 없습니다. 내 주제에서 출처의 원문을 확인하세요.");
    if (!required) fail("failed-precondition", `'${t.file.EVENT.requiredAxis}' 처지의 인물 출처를 먼저 확인하세요(모둠마다 꼭 한 명 있어야 합니다).`);
    return { id: t.id, title: t.title, bundle: toStored(t.file) };
  }

  // 단계 하나를 맡는다: 다른 단계가 진행 중이면 막고, 호출 한도를 확인한다. fn 이 끝나면 진행 중 표시를 푼다.
  async function step(auth, id, name, allowed, fn) {
    const t = await own(auth, id);
    const b = t.build || {};
    if (!allowed.includes(b.step || "start")) fail("failed-precondition", `지금은 이 단계를 할 수 없습니다(현재: ${b.step || "start"}).`);
    if ((b.calls || 0) >= MAX_CALLS) fail("resource-exhausted", "이 주제에 쓸 수 있는 AI 사용량을 모두 썼습니다. 새 주제로 다시 만들어 주세요.");
    await db.runTransaction(async (tx) => {
      const cur = (await tx.get(ref(id))).data()?.build || {};
      if (cur.busy && cur.busyUntil > Date.now()) fail("failed-precondition", "이 주제는 지금 다른 작업을 하고 있어요. 끝난 뒤 다시 시도하세요.");
      tx.update(ref(id), { "build.busy": name, "build.busyUntil": Date.now() + BUSY_MS });
    });
    let calls = 0;
    try {
      const r = await fn(t, (n) => { calls += n || 0; });
      return r;
    } catch (e) {
      calls += e.calls || 0;
      await ref(id).update({ "build.lastError": { step: name, message: String(e.message).slice(0, 300), at: Date.now() } }).catch(() => {});
      if (e instanceof HttpsError) throw e;
      console.error(`topics ${name} 실패:`, e.message);
      fail("unavailable", String(e.message || "").includes("찾지 못했어요") || String(e.message || "").startsWith("사건 틀을") ? e.message : "AI 응답을 받지 못했습니다. 잠시 후 다시 시도하세요.");
    } finally {
      await ref(id).update({ "build.busy": FieldValue().delete(), "build.busyUntil": 0, "build.calls": FieldValue().increment(calls), updatedAt: FieldValue().serverTimestamp() }).catch(() => {});
    }
  }
  const save = (id, patch) => ref(id).update({ ...patch, updatedAt: FieldValue().serverTimestamp() });
  const loadResearch = async (id) => { const s = await researchRef(id).get(); if (!s.exists) fail("failed-precondition", "조사 결과가 없습니다. 조사부터 다시 하세요."); return s.data(); };

  // 교사에게 보낼 주제 전체(조사 결과의 사실 은행 포함: 검토 화면에서 근거를 보여 준다)
  async function full(t) {
    const r = await researchRef(t.id).get();
    const info = usableInfo(t.file);
    return {
      id: t.id, title: t.title, status: t.status, input: t.input || {}, build: { step: t.build?.step || "start", calls: t.build?.calls || 0, busy: t.build?.busy || null, lastError: t.build?.lastError || null },
      plan: t.plan || null, review: t.review || null, file: t.file,
      research: r.exists ? { facts: r.data().facts || [], names: r.data().names || [], sources: r.data().SOURCES || {} } : null,
      check: info.check, usable: info.usable, requiredOk: info.required, maxCalls: MAX_CALLS,
    };
  }

  // 사용량(하루 주제 수·아이디어 찾기 수)
  async function bump(uid, field, limit, msg) {
    await db.runTransaction(async (tx) => {
      const u = (await tx.get(usageRef(uid))).data() || {};
      const today = u.day === day() ? u : { day: day() };
      if ((today[field] || 0) >= limit) fail("resource-exhausted", msg);
      tx.set(usageRef(uid), { ...today, [field]: (today[field] || 0) + 1 });
    });
  }
  const unbump = (uid, field) => usageRef(uid).get().then((s) => { const u = s.data(); if (u?.day === day() && u[field] > 0) return usageRef(uid).set({ ...u, [field]: u[field] - 1 }); }).catch(() => {});
  const usage = async (uid) => { const u = (await usageRef(uid).get()).data() || {}; const t = u.day === day() ? u : {}; return { topics: t.topics || 0, ideas: t.ideas || 0, topicLimit: dailyLimit(), ideaLimit: IDEAS_PER_DAY }; };

  const actions = {
    // ---------- 저장 ----------
    async list(auth) {
      const snap = await db.collection("teacherTopics").where("ownerUid", "==", auth.uid).get();
      const topics = snap.docs.map((d) => { const x = d.data(); return summarize(d.id, x, usableInfo(fromStored(x.bundle))); }).sort((a, b) => b.updatedAt - a.updatedAt);
      return { topics, usage: await usage(auth.uid), builderOpen: builderOpen() };
    },
    async get(auth, d) { return full(await own(auth, d.topicId)); },
    // 교사가 고친 주제 저장(검토 화면). 만드는 중에는 막는다.
    async save(auth, d) {
      const t = await own(auth, d.topicId);
      if (t.build?.step !== "review") fail("failed-precondition", "주제를 다 만든 뒤에 고칠 수 있습니다.");
      if (t.build?.busy && t.build.busyUntil > Date.now()) fail("failed-precondition", "지금 AI 가 이 주제를 고치고 있어요. 끝난 뒤 저장하세요.");
      const file = sanitizeFile(d.file, t.file);
      await save(t.id, { bundle: toStored(file), title: file.EVENT.title });
      return full({ ...t, file, title: file.EVENT.title });
    },
    // 인물 구성안 고치기(인물을 만들기 전)
    async plan(auth, d) {
      const t = await own(auth, d.topicId);
      if (t.build?.step !== "frame") fail("failed-precondition", "인물을 만들기 전에만 구성안을 고칠 수 있습니다.");
      if ((t.file.PERSONAS || []).length) fail("failed-precondition", "인물을 만들기 시작한 뒤에는 구성안을 고칠 수 없습니다. 인물마다 '다시 만들기'를 쓰세요.");
      let plan;
      try { plan = sanitizePlan(d.plan, t.plan, t.file.EVENT); } catch (e) { fail("invalid-argument", e.message); }
      await save(t.id, { plan });
      return full({ ...t, plan });
    },
    // 출처 원문 확인. 확인한 출처만 학생에게 보이는 인물·자료에 쓰인다.
    async verifySource(auth, d) {
      const t = await own(auth, d.topicId);
      const ids = (Array.isArray(d.sourceIds) ? d.sourceIds : [d.sourceId]).map(String).slice(0, 100);
      for (const sid of ids) if (!t.file.SOURCES?.[sid]) fail("not-found", "출처를 찾을 수 없습니다.");
      const v = d.verified !== false;
      const upd = {};
      for (const sid of ids) { upd[`bundle.SOURCES.${sid}.verified`] = v; upd[`bundle.SOURCES.${sid}.verifiedAt`] = v ? Date.now() : 0; }
      await save(t.id, upd);
      ids.forEach((sid) => { t.file.SOURCES[sid].verified = v; });
      const info = usableInfo(t.file);
      return { verified: v, sourceIds: ids, usable: info.usable, requiredOk: info.required, check: info.check };
    },
    async delete(auth, d) {
      const t = await own(auth, d.topicId);
      if (t.build?.busy && t.build.busyUntil > Date.now()) fail("failed-precondition", "지금 AI 가 이 주제를 만들고 있어요. 끝난 뒤 지우세요.");
      await db.recursiveDelete(ref(t.id));
      return { ok: true };
    },
    // 내 수업의 주제 사본을 지금 주제 내용으로 바꾼다(수업을 만든 뒤 출처를 더 확인했을 때)
    async syncSession(auth, d) {
      const code = String(d.code || "").trim().toUpperCase();
      const s = code ? await db.doc(`sessions/${code}`).get() : null;
      if (!s?.exists || s.data().teacherUid !== auth.uid) fail("permission-denied", "내가 만든 수업이 아닙니다.");
      if (!s.data().topicId) fail("failed-precondition", "기본 주제로 만든 수업입니다.");
      const t = await forClass(auth, s.data().topicId);
      await db.doc(`sessions/${code}/private/topic`).set({ topicId: t.id, title: t.title, bundle: t.bundle, copiedAt: FieldValue().serverTimestamp() });
      onSessionTopic(code);
      return { ok: true };
    },

    // ---------- AI ----------
    // 아이디어 → 사건 후보(주제를 만들기 전이라 저장하지 않는다). 하루 10번.
    async ideas(auth, d) {
      const input = { idea: clipIn(d.idea, 300), grade: clipIn(d.grade, 100), focus: clipIn(d.focus, 300), avoid: clipIn(d.avoid, 200) };
      if (input.idea.length < 2) fail("invalid-argument", "다루고 싶은 지역이나 주제를 적어 주세요.");
      await bump(auth.uid, "ideas", IDEAS_PER_DAY, `사건 후보 찾기는 하루 ${IDEAS_PER_DAY}번까지예요. 내일 다시 해 주세요.`);
      try { return { ...(await build.ideas(input, ai)), usage: await usage(auth.uid) }; }
      catch (e) {
        await unbump(auth.uid, "ideas");
        if (/찾지 못했어요|적어 주세요/.test(e.message)) fail("not-found", e.message);
        console.error("topics ideas 실패:", e.message);
        fail("unavailable", "사건 후보를 찾지 못했습니다. 잠시 후 다시 시도하세요.");
      }
    },
    // 고른 후보로 주제 만들기 시작(하루 한도에 센다). 교사가 직접 쓴 사건도 받는다.
    async start(auth, d) {
      const c = d.candidate || {};
      const candidate = {
        title: clipIn(c.title, 120), place: clipIn(c.place, 120), period: clipIn(c.period, 60), summary: clipIn(c.summary, 1200), conflict: clipIn(c.conflict, 400),
        stakeholders: (Array.isArray(c.stakeholders) ? c.stakeholders : String(c.stakeholders || "").split("/")).map((x) => clipIn(x, 60)).filter(Boolean).slice(0, 6),
        requiredWho: clipIn(c.requiredWho, 120), now: clipIn(c.now, 200),
        links: (Array.isArray(c.links) ? c.links : []).slice(0, 6).map((l) => ({ title: clipIn(l?.title, 200), url: build.normUrl(l?.url) })).filter((l) => l.url),
      };
      if (!candidate.title || candidate.summary.length < 20) fail("invalid-argument", "사건 이름과 요약(20자 이상)을 적어 주세요.");
      const snap = await db.collection("teacherTopics").where("ownerUid", "==", auth.uid).get();
      if (snap.docs.length >= MAX_TOPICS) fail("resource-exhausted", `주제는 ${MAX_TOPICS}개까지 둘 수 있어요. 쓰지 않는 주제를 지운 뒤 만들어 주세요.`);
      await bump(auth.uid, "topics", dailyLimit(), `새 주제는 하루 ${dailyLimit()}개까지 만들 수 있어요. 내일 다시 만들어 주세요.`);
      const id = newTopicId();
      const input = { idea: clipIn(d.idea, 300), grade: clipIn(d.grade, 100), focus: clipIn(d.focus, 300), avoid: clipIn(d.avoid, 200), candidate,
        now: clipIn(d.now, 200) || candidate.now, requiredWho: clipIn(d.requiredWho, 120) || candidate.requiredWho };
      await ref(id).set({ ownerUid: auth.uid, title: candidate.title, status: "building", input, build: { step: "start", calls: 0 }, plan: null, review: null,
        bundle: null, createdAt: FieldValue().serverTimestamp(), updatedAt: FieldValue().serverTimestamp() });
      return { topicId: id, usage: await usage(auth.uid) };
    },
    async research(auth, d) {
      return step(auth, d.topicId, "research", ["start", "research"], async (t, count) => {
        const r = await build.research({ input: t.input }, ai);
        count(r.calls);
        await researchRef(t.id).set({ SOURCES: r.SOURCES, facts: r.facts, names: r.names, errors: r.errors, at: Date.now() });
        await save(t.id, { "build.step": "research", bundle: toStored({ SOURCES: r.SOURCES, EVENT: null, PERSONAS: [], MATERIALS: [], POLICY_CASES: [], AFTERMATH: [], BRIEFS: {} }), plan: null, review: null });
        return { step: "research", sources: Object.keys(r.SOURCES).length, facts: r.facts.length, missed: r.errors.length };
      });
    },
    async frame(auth, d) {
      return step(auth, d.topicId, "frame", ["research", "frame"], async (t, count) => {
        const research = await loadResearch(t.id);
        const r = await compose.frame({ topicId: t.id, input: t.input, research }, ai);
        count(r.calls);
        const file = { SOURCES: research.SOURCES, EVENT: r.EVENT, PERSONAS: [], MATERIALS: [], POLICY_CASES: [], AFTERMATH: [], BRIEFS: {} };
        await save(t.id, { "build.step": "frame", bundle: toStored(file), plan: r.plan, title: r.EVENT.title, review: null });
        return { step: "frame", plan: r.plan, event: r.EVENT };
      });
    },
    // 인물을 PERSONA_BATCH 명씩 만든다. 다 만들 때까지 여러 번 부른다.
    async personas(auth, d) {
      return step(auth, d.topicId, "personas", ["frame", "personas"], async (t, count) => {
        const research = await loadResearch(t.id);
        const file = t.file;
        const done = new Set(file.PERSONAS.map((p) => p.id));
        const todo = t.plan.personas.filter((p) => !done.has(p.id)).slice(0, PERSONA_BATCH);
        const problems = { ...(t.review?.problems || {}) };
        const made = await build.pool(todo, PERSONA_BATCH, async (slot) => {
          const r = await compose.persona({ file, plan: t.plan, slotId: slot.id, research }, ai);
          count(r.calls);
          return r;
        });
        for (const r of made) { file.PERSONAS.push(r.persona); file.BRIEFS[r.persona.id] = r.brief; problems[r.persona.id] = r.problems; }
        file.PERSONAS.sort((a, b) => t.plan.personas.findIndex((p) => p.id === a.id) - t.plan.personas.findIndex((p) => p.id === b.id));
        const left = t.plan.personas.length - file.PERSONAS.length;
        await save(t.id, { "build.step": left ? "frame" : "personas", bundle: toStored(file), review: { ...(t.review || {}), problems } });
        return { step: left ? "frame" : "personas", done: file.PERSONAS.length, total: t.plan.personas.length, made: made.map((r) => r.persona.name) };
      });
    },
    async extras(auth, d) {
      return step(auth, d.topicId, "extras", ["personas", "extras"], async (t, count) => {
        const research = await loadResearch(t.id);
        const r = await compose.extras({ file: t.file, research }, ai);
        count(r.calls);
        const file = { ...t.file, MATERIALS: r.MATERIALS, POLICY_CASES: r.POLICY_CASES, AFTERMATH: r.AFTERMATH };
        await save(t.id, { "build.step": "extras", bundle: toStored(file) });
        return { step: "extras", materials: r.MATERIALS.length, cases: r.POLICY_CASES.length, aftermath: r.AFTERMATH.length };
      });
    },
    async review(auth, d) {
      return step(auth, d.topicId, "review", ["extras", "review"], async (t, count) => {
        const research = await loadResearch(t.id);
        const file = t.file;
        // 출처는 조사 결과 전체에서 다시 고른다(교사가 확인한 표시는 남긴다)
        file.SOURCES = Object.fromEntries(Object.entries(research.SOURCES).map(([id, s]) => [id, { ...s, verified: file.SOURCES?.[id]?.verified === true, ...(file.SOURCES?.[id]?.verifiedAt ? { verifiedAt: file.SOURCES[id].verifiedAt } : {}) }]));
        const r = await compose.review({ file, plan: t.plan, research }, ai);
        count(r.calls);
        const rev = { problems: t.review?.problems || {}, fixes: r.fixes, materialFixes: r.materialFixes, balance: r.balance, at: Date.now() };
        await save(t.id, { "build.step": "review", status: "review", bundle: toStored(file), review: rev });
        return { step: "review", fixes: r.fixes.length, materialFixes: r.materialFixes.length, errors: r.check.errors.length, warnings: r.check.warnings.length };
      });
    },
    // 인물 한 명 다시 만들기(교사 요청을 반영). 다시 만든 인물만 점검한다.
    async regenPersona(auth, d) {
      return step(auth, d.topicId, "regenPersona", ["review"], async (t, count) => {
        const research = await loadResearch(t.id);
        const file = t.file;
        const pid = String(d.personaId || "");
        const prev = file.PERSONAS.find((p) => p.id === pid);
        if (!prev) fail("not-found", "인물을 찾을 수 없습니다.");
        file.SOURCES = Object.fromEntries(Object.entries(research.SOURCES).map(([id, s]) => [id, { ...s, verified: file.SOURCES?.[id]?.verified === true }]));
        const r = await compose.persona({ file, plan: t.plan, slotId: pid, research, note: d.note, prev }, ai);
        count(r.calls);
        file.PERSONAS = file.PERSONAS.map((p) => (p.id === pid ? r.persona : p));
        file.BRIEFS[pid] = r.brief;
        const rv = await compose.review({ file, plan: t.plan, research, only: [pid] }, ai);
        count(rv.calls);
        const rev = { ...(t.review || {}), problems: { ...(t.review?.problems || {}), [pid]: r.problems }, fixes: [...(t.review?.fixes || []).filter((x) => x.persona !== pid), ...rv.fixes] };
        await save(t.id, { bundle: toStored(file), review: rev });
        return { step: "review", persona: r.persona.name, fixes: rv.fixes.length };
      });
    },
  };

  async function handle(req) {
    const auth = await requireTeacher(req);
    const d = req.data || {};
    const fn = actions[d.action];
    if (!fn) fail("invalid-argument", "알 수 없는 요청입니다.");
    if (AI_ACTIONS.includes(d.action) && !builderOpen()) fail("failed-precondition", "새 주제 만들기는 지금 잠시 닫혀 있어요. 이미 만든 주제는 그대로 쓸 수 있어요.");
    return fn(auth, d);
  }
  return { handle, forClass, own, actions };
}

const clipIn = (v, n) => String(v ?? "").replace(/\s+/g, " ").trim().slice(0, n);

// 교사가 고친 인물 구성안. 칸·길이를 정리하고, 축은 사건의 축 가운데서만, 인물 수와 ID 는 바꿀 수 없다.
function sanitizePlan(input, prev, ev) {
  const P = input || {};
  const personas = prev.personas.map((old) => {
    const x = (Array.isArray(P.personas) ? P.personas : []).find((p) => p?.id === old.id) || old;
    return {
      ...old, name: clipIn(x.name, 8) || old.name, axis: ev.axes.includes(x.axis) ? x.axis : old.axis, label: clipIn(x.label, 120) || old.label,
      role: clipIn(x.role, 300) || old.role, side: ["A", "B", "가운데"].includes(x.side) ? x.side : old.side, stance: clipIn(x.stance, 300) || old.stance,
      who: clipIn(x.who, 120) || old.who, brief: clipIn(x.brief, 60) || old.brief, belief: clipIn(x.belief, 300),
    };
  });
  const names = personas.map((p) => p.name);
  if (new Set(names).size !== names.length) throw new Error("인물 이름이 겹칩니다.");
  const links = (Array.isArray(P.links) ? P.links : prev.links).slice(0, 8).map((l) => ({ a: String(l?.a || ""), b: String(l?.b || ""), scene: clipIn(l?.scene, 200), a_mark: clipIn(l?.a_mark, 20), b_mark: clipIn(l?.b_mark, 20) }))
    .filter((l) => personas.some((p) => p.id === l.a) && personas.some((p) => p.id === l.b) && l.a !== l.b && l.a_mark && l.b_mark);
  return { sides: { A: clipIn(P.sides?.A, 100) || prev.sides.A, B: clipIn(P.sides?.B, 100) || prev.sides.B }, personas, links, balance: prev.balance };
}

module.exports = { makeTopicApi, sanitizePlan, STEPS, MAX_TOPICS, MAX_CALLS, IDEAS_PER_DAY, PERSONA_BATCH };
