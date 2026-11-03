# 평가척도표 Word 파일 생성: functions/rubric.js 의 척도표를 그대로 옮긴다.
#   node -e "..." 로 만든 JSON 을 읽는다(아래 main 참고). 실행: python3 tools/build-rubric-docx.py
import json, subprocess, os
from docx import Document
from docx.shared import Pt, Mm, RGBColor
from docx.enum.text import WD_ALIGN_PARAGRAPH
from docx.oxml.ns import qn
from docx.oxml import OxmlElement

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "rubric-out", "AI-EPS_수행평가_평가척도표.docx")
JS = r'''
const R=require("./rubric.js"), S=require("./seteuk.js"), A=require("./assess.js");
const keys=[...new Set(R.CRITERIA.flatMap(c=>(c.deep||[]).map(d=>d.key)))];
const deepAll=Object.fromEntries(keys.map(k=>[k,true]));
process.stdout.write(JSON.stringify({high:R.rubricFor("high",deepAll,{contrib:true}),mid:R.rubricFor("middle",{},{contrib:true}),
 deep:R.CRITERIA.filter(c=>c.deep).map(c=>({id:c.id,name:c.name,deep:c.deep})),comp:S.COMPETENCY,parts:S.PART_GUIDE,T:A.THRESHOLDS,noteMin:A.NOTE_MIN,ver:R.RUBRIC_VERSION}));
'''
D = json.loads(subprocess.check_output(["node", "-e", JS], cwd=os.path.join(ROOT, "functions")))
H, M = D["high"], D["mid"]

doc = Document()
sec = doc.sections[0]
sec.page_width, sec.page_height = Mm(297), Mm(210)
sec.orientation = 1
for side in ("left_margin", "right_margin"): setattr(sec, side, Mm(15))
sec.top_margin = sec.bottom_margin = Mm(14)
st = doc.styles["Normal"]
st.font.name = "Malgun Gothic"; st.font.size = Pt(9.5)
st.element.rPr.rFonts.set(qn("w:eastAsia"), "맑은 고딕")
for s in ("Title", "Heading 1", "Heading 2", "List Bullet"):
    f = doc.styles[s].font; f.name = "Malgun Gothic"
    rpr = doc.styles[s].element.get_or_add_rPr(); rf = rpr.find(qn("w:rFonts"))
    if rf is None: rf = OxmlElement("w:rFonts"); rpr.append(rf)
    rf.set(qn("w:eastAsia"), "맑은 고딕")
    if s != "List Bullet": f.color.rgb = RGBColor(0x1F, 0x2A, 0x44)

def shade(cell, hexc):
    tcPr = cell._tc.get_or_add_tcPr(); sh = OxmlElement("w:shd")
    sh.set(qn("w:val"), "clear"); sh.set(qn("w:color"), "auto"); sh.set(qn("w:fill"), hexc); tcPr.append(sh)

def table(head, rows, widths=None):
    t = doc.add_table(rows=1, cols=len(head)); t.style = "Table Grid"
    for i, h in enumerate(head):
        c = t.rows[0].cells[i]; c.text = ""; r = c.paragraphs[0].add_run(h); r.bold = True; shade(c, "E8EDF5")
    for row in rows:
        cells = t.add_row().cells
        for i, v in enumerate(row):
            cells[i].text = ""
            lines = str(v).split("\n")
            for j, ln in enumerate(lines):
                p = cells[i].paragraphs[0] if j == 0 else cells[i].add_paragraph()
                r = p.add_run(ln)
                if i == 0 and j == 0: r.bold = True
                if ln.startswith("[") and ln.endswith("점]"): r.font.color.rgb = RGBColor(0x55, 0x55, 0x55)
    if widths:
        for row in t.rows:
            for i, w in enumerate(widths): row.cells[i].width = Mm(w)
    for row in t.rows:
        for c in row.cells:
            for p in c.paragraphs:
                for r in p.runs: r.font.size = Pt(8.5)
    doc.add_paragraph()
    return t

def bullets(xs):
    for x in xs: doc.add_paragraph(x, style="List Bullet")

def area(c): return "모둠" if c["scope"] == "group" else ("학생별·모둠 영역" if c["area"] == "group" else "개인")

doc.add_paragraph("AI-EPS 수업 수행평가 평가척도표", style="Title")
gmax = H["total"] - H["indivMax"]
share = sum(c["max"] for c in H["criteria"] if c["scope"] == "group")
contrib = next(c for c in H["criteria"] if c["id"] == "c63")
doc.add_paragraph(f"AI-EPS 1~7단계에서 학생이 직접 쓴 칸을 근거로 100점 만점(개인 {H['indivMax']}점 + 모둠 {gmax}점)으로 채점하는 척도표입니다. 항목과 단계 이름은 학생 화면의 장면 이름과 같습니다. 중학교와 고등학교는 서술 수준과 등급 수가 다릅니다. 앱의 평가 탭(교사 화면)이 이 표와 같은 기준으로 채점·세특·공개를 돕습니다. (척도표 버전 {D['ver']})")

doc.add_paragraph("1. 설계 원칙", style="Heading 1")
bullets([
    "평가 대상은 학생이 쓴 판단·근거·이유입니다. AI 질문 횟수, 글자 수, 맞춤법, AI를 썼는지는 점수에 넣지 않습니다(3~5단계 AI는 선택 도구).",
    "근거 칸이 비어 제출하지 않은 경우는 어느 수준에도 넣지 않고 미제출 0점입니다.",
    f"개인 영역 {H['indivMax']}점은 모둠 산출물 가운데 그 학생이 직접 입력한 항목(원인 추측·확인 질문·해결책·반응 예측)만 근거로 삼습니다. 모둠 산출물 {share}점은 모둠원 모두에게 같고, 모둠 기여도 {contrib['max']}점은 학생마다 다릅니다.",
    "심화 활동을 켠 수업은 해당 기준의 '매우 잘함' 조건에 심화 조건이 붙습니다(5장).",
    f"AI는 채점을 돕는 평정자입니다. 가장 높은·낮은 수준, AI 의견과 두 수준 이상 다른 판정에는 평가 근거를 {D['noteMin']}자 이상 씁니다. 최종 판단은 교사입니다.",
])

doc.add_paragraph("2. 평가 요소와 배점", style="Heading 1")
rows, last = [], None
for c in H["criteria"]:
    rows.append([c["elName"] if c["el"] != last else "", c["stage"], c["name"], str(c["max"]), area(c)]); last = c["el"]
rows.append(["합계", "", "", str(H["total"]), f"개인 {H['indivMax']} · 모둠 {gmax}"])
table(["평가 요소", "단계(학생 화면)", "세부 기준", "배점", "구분"], rows, [42, 62, 95, 18, 40])
pct = " · ".join(f"{l} {p}%" for l, p in zip(H["labels"], [100, 80, 60, 40]))
doc.add_paragraph(f"등급별 점수 — 고등학교: {pct} (10점 기준 10/8/6/4, 5점 기준 5/4/3/2). 중학교: {'·'.join(M['labels'])} (10점 기준 10/7/4, 5점 기준 5/4/2). 미제출 0점.")

def rubric(R, title):
    doc.add_paragraph(title, style="Heading 1")
    by = {}
    for c in R["criteria"]: by.setdefault((c["el"], c["elName"]), []).append(c)
    w = [55] + [(267 - 55) / len(R["labels"])] * len(R["labels"])
    for (el, nm), cs in by.items():
        doc.add_paragraph(nm, style="Heading 2")
        table(["세부 기준"] + R["labels"], [[f"{c['name']}\n({area(c)} {c['max']}점 · {c['stage']})"] + [f"{l['desc']}\n[{l['pts']}점]" for l in c["levels"]] for c in cs], w)

rubric(H, f"3. 고등학교 평가척도표 ({len(H['labels'])}수준)")
rubric(M, f"4. 중학교 평가척도표 ({len(M['labels'])}수준)")

doc.add_paragraph("5. 심화 활동을 켠 수업에서 덧붙는 조건 (고등학교는 기본으로 모두 켬)", style="Heading 1")
table(["기준", "'매우 잘함' 조건에 붙는 심화 조건"], [[f"{c['name']} ({c['id']})", "\n".join(f"[{d['key']}] {d['text']}" for d in c["deep"])] for c in D["deep"]], [80, 187])

doc.add_paragraph("6. 세특 작성 방식 (평가척도표와 역량 중심)", style="Heading 1")
bullets([
    "세특의 근거는 평가척도표입니다. 항목마다 매긴 수준과 그 수준의 기술, 교사의 평가 근거, 그 항목에서 드러나는 교과 역량을 묶어 초안을 만듭니다.",
    "글의 수준은 확정·채점된 척도표 점수(배점 대비 90% 이상·75% 이상·55% 이상·그 아래)로 정합니다. 매긴 항목이 절반이 안 되면 활동 기록으로 수준을 판정합니다.",
    "수준이 높은 항목의 역량을 중심으로, 교사가 관찰한 사고 과정과 역량을 교사의 언어로 재구성해 씁니다. 수준이 낮거나 미제출인 항목은 쓰지 않거나 성장의 방향으로만 짧게 다룹니다.",
    "학생의 글을 따옴표로 인용하거나 활동 순서대로 요약·나열하지 않습니다('~을 작성함', '~라고 씀' 금지). 학생 글과 12자 이상 같은 곳은 화면에 표시되어 교사가 고칩니다.",
    "관찰 자료에 없는 동기·과정·결과를 만들지 않으며, 근거가 적으면 짧게 씁니다. 점수·등급과 평가 수준의 이름은 본문에 쓰지 않습니다.",
    "구조는 기승전결입니다. " + " / ".join(f"{k}: {v}" for k, v in D["parts"].items()),
    "초안의 문장마다 근거가 된 평가 항목이 표시되며, 교사가 읽고 고쳐 저장해야 확정됩니다. 점수를 확정한 뒤에 세특을 만들면 수준이 척도표와 맞게 정해집니다.",
])
table(["기준", "세부 기준", "세특에서 드러내는 역량"], [[c["id"], c["name"], D["comp"].get(c["id"], "")] for c in H["criteria"]], [20, 110, 137])

T = D["T"]
doc.add_paragraph("7. 채점의 타당도·신뢰도를 지키는 방법 (앱에 들어 있음)", style="Heading 1")
bullets([
    "근거 고정: 기준마다 보는 칸이 정해져 있고, 채점 화면에 학생이 쓴 글이 그대로 보입니다.",
    f"근거가 없으면 미제출만 고를 수 있고, 가장 높은·낮은 수준은 평가 근거를 {D['noteMin']}자 이상 씁니다.",
    "AI는 같은 근거를 세 번 독립 채점하고, 결과가 갈리거나 인용한 문장을 학생 글에서 찾지 못한 항목은 교사에게 보냅니다. 익명 채점(학생 코드, 섞은 순서)을 지원합니다.",
    "일치도: 교사–AI 일치율·한 수준 이내·가중 카파·후함/엄격함, AI 3회 채점 일치율. 재채점 표본으로 교사의 일관성을 점검합니다.",
    f"경고 기준(조정 가능): 일치율 {T['exact']}%, 한 수준 이내 {T['adjacent']}%, 가중 카파 {T['kappa']}, 편향 {T['bias']}수준, AI 3회 일치 {T['selfConsistency']}%, 재채점 일치 {T['recheckExact']}%. 비교가 {T['minPairs']}칸 미만이면 해석이 이릅니다.",
])
doc.save(OUT)
print("written", OUT)
