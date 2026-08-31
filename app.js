/* 析文 DocSift — 主逻辑
   结构：
   - fileRead: 文件读取（PDF/TXT/MD/DOCX）→ 纯文本
   - analyze:  分析管线（类型判断 → 本地规则引擎 / LLM 引擎）
   - render:   报告渲染 + 原文高亮回链
*/
'use strict';

/* ================= 状态 ================= */
const state = {
  docText: '',
  docName: '',
  engine: 'local',            // 'local' | 'llm'
  llm: { base: '', key: '', model: '' },
  sentences: [],              // 分句结果，供回链
};

const $ = (id) => document.getElementById(id);

/* ================= 工具 ================= */
function toast(msg) {
  const t = $('toast');
  t.textContent = msg;
  t.hidden = false;
  t.classList.add('show');
  clearTimeout(toast._timer);
  toast._timer = setTimeout(() => { t.hidden = true; t.classList.remove('show'); }, 2800);
}

/* ================= 文件读取 ================= */
async function readDoc(file) {
  const name = file.name.toLowerCase();
  if (name.endsWith('.pdf')) return readPdf(file);
  if (name.endsWith('.docx')) return readDocx(file);
  if (name.endsWith('.txt') || name.endsWith('.md') || name.endsWith('.markdown')) {
    return (await file.text()).slice(0, 200000);
  }
  throw new Error('暂不支持该格式，请上传 PDF / TXT / MD / DOCX');
}

async function readPdf(file) {
  const buf = await file.arrayBuffer();
  const pdf = await pdfjsLib.getDocument({ data: buf }).promise;
  let text = '';
  for (let i = 1; i <= Math.min(pdf.numPages, 60); i++) {
    const page = await pdf.getPage(i);
    const content = await page.getTextContent();
    text += content.items.map((it) => it.str).join(' ') + '\n';
  }
  if (!text.trim()) throw new Error('这份 PDF 没有可提取的文字层（可能是扫描件）');
  return text;
}

async function readDocx(file) {
  // DOCX = zip，word/document.xml 里是正文；用最小解包避免引依赖
  const buf = new Uint8Array(await file.arrayBuffer());
  const zip = await unzipMini(buf);
  const xmlBytes = zip['word/document.xml'];
  if (!xmlBytes) throw new Error('DOCX 结构异常：找不到 document.xml');
  const xml = new TextDecoder('utf-8').decode(xmlBytes);
  // 段落 → 换行；去标签
  return xml
    .replace(/<w:p\b[^>]*>/g, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .slice(0, 200000);
}

/* 极简 ZIP 读取：local file header 顺序扫描，仅需 stored/deflate 的 docx 主流情况 */
async function unzipMini(buf) {
  const files = {};
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const text = (off, len) => new TextDecoder('latin1').decode(buf.subarray(off, off + len));
  let p = 0;
  while (p + 30 <= buf.length) {
    if (view.getUint32(p, true) !== 0x04034b50) { p++; continue; } // PK\x03\x04
    const method = view.getUint16(p + 8, true);
    const csize = view.getUint32(p + 18, true);
    const nameLen = view.getUint16(p + 26, true);
    const extraLen = view.getUint16(p + 28, true);
    const name = text(p + 30, nameLen);
    const dataOff = p + 30 + nameLen + extraLen;
    if (name === 'word/document.xml' && csize > 0) {
      const raw = buf.subarray(dataOff, dataOff + csize);
      files[name] = method === 0 ? raw : await inflateMini(raw);
      break;
    }
    p = dataOff + csize;
  }
  return files;
}

/* 解压 deflate（原生 DecompressionStream，Chrome/Edge/Safari 均支持） */
async function inflateMini(deflated) {
  const ds = new DecompressionStream('deflate');
  const stream = new Blob([deflated]).stream().pipeThrough(ds);
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/* ================= 分句与回链 ================= */
function splitSentences(text) {
  // 中文分句：。！？；以及换行；英文句号后带空格
  const parts = text.split(/(?<=[。！？；\n])\s*|(?<=\.)\s+(?=[A-Z])/).filter(Boolean);
  return parts;
}

function renderDocText(text) {
  const el = $('docText');
  el.textContent = text;
}

function highlightSentence(idx) {
  const el = $('docText');
  el.querySelectorAll('mark').forEach((m) => m.remove());
  const s = state.sentences[idx];
  if (!s) return;
  // 在纯文本节点里查找该句
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  let node;
  while ((node = walker.nextNode())) {
    const i = node.textContent.indexOf(s);
    if (i >= 0) {
      const after = node.splitText(i);
      after.splitText(s.length);
      const mark = document.createElement('mark');
      mark.textContent = s;
      after.parentNode.replaceChild(mark, after);
      mark.scrollIntoView({ block: 'center', behavior: 'smooth' });
      return;
    }
  }
}

/* ================= 文档类型判断 ================= */
function detectKind(text) {
  const t = text.slice(0, 4000);
  const rules = [
    ['contract', /(甲方|乙方|合同|协议|违约|双方同意|签署|保密)/, 0],
    ['meeting', /(会议|参会人|讨论|决议|待办|行动项|纪要|主持人)/, 0],
    ['resume', /(个人简历|教育经历|工作经历|求职意向|技能清单|自我评价|项目经验)/, 0],
    ['finance', /(营业收入|净利润|资产负债|毛利率|同比|营业收入|财报|现金流量)/, 0],
  ];
  const score = {};
  for (const [kind, re] of rules) {
    const m = t.match(new RegExp(re.source, 'g'));
    score[kind] = m ? m.length : 0;
  }
  const best = Object.entries(score).sort((a, b) => b[1] - a[1])[0];
  if (best[1] === 0) return { kind: 'general', label: '通用文档', conf: 0 };
  const labels = { contract: '合同', meeting: '会议记录', resume: '简历', finance: '财报' };
  return { kind: best[0], label: labels[best[0]], conf: best[1] };
}

/* ================= 本地规则引擎 ================= */
/* 非玩具：真实的分句、模式匹配、数字抽取；每条 finding 记录句索引实现回链 */
function analyzeLocal(text, kind) {
  const out = [];
  const push = (sec, sentenceIdx, text, tag) => out.push({ sec, sentenceIdx, text, tag });

  const money = /(人民币|美元|￥|\$)\s*([0-9][0-9,，]*(?:\.[0-9]+)?)\s*(万|亿|千)?\s*(元|块|RMB)?/g;
  const dates = /(\d{4}\s*[年.-]\s*\d{1,2}\s*[月.-]\s*\d{1,2}\s*日?)|(\d{1,2}\s*月\s*\d{1,2}\s*日)/g;
  const riskWords = /(违约|赔偿|终止|解除|罚款|滞纳金|诉讼|仲裁|不可抗力|知识产权纠纷|保密义务|竞业限制)/g;
  const dutyWords = /(甲方应当|乙方应当|甲方须|乙方须|甲方负责|乙方负责|甲方有权|乙方有权)/g;

  let m;
  state.sentences.forEach((s, idx) => {
    const t = s;
    if (!t || t.trim().length < 4) return;

    let mm;
    money.lastIndex = 0;
    while ((mm = money.exec(t))) {
      push('金额条款', idx, `金额：${mm[0].trim()}（出处：第 ${idx + 1} 句）`, 'num');
      break; // 每句报一次即可
    }
    riskWords.lastIndex = 0;
    while ((mm = riskWords.exec(t))) {
      push('风险提示', idx, `涉及「${mm[1]}」：${t.slice(0, 60)}${t.length > 60 ? '…' : ''}`, 'risk');
      break;
    }
    dutyWords.lastIndex = 0;
    while ((mm = dutyWords.exec(t))) {
      push('义务与权利', idx, `${mm[1]}：${t.slice(mm[1].length, mm[1].length + 50)}…`, 'duty');
      break;
    }
    dates.lastIndex = 0;
    while ((mm = dates.exec(t))) {
      push('关键日期', idx, `日期：${mm[0]}`, 'num');
      break;
    }
  });

  // 类型专属补充
  if (kind === 'meeting') {
    const todo = /(待办|行动项|跟进|负责|截止)/g;
    state.sentences.forEach((s, idx) => {
      if (todo.test(s)) push('待办与行动项', idx, s.slice(0, 80), 'ok');
      todo.lastIndex = 0;
    });
  }
  if (kind === 'finance') {
    const idxs = /(营业收入|净利润|毛利率|资产负债率|经营现金流)/g;
    state.sentences.forEach((s, idx) => {
      if (idxs.test(s)) push('核心指标', idx, s.slice(0, 80), 'num');
      idxs.lastIndex = 0;
    });
  }
  if (kind === 'resume') {
    const skill = /(熟练|精通|掌握|熟悉|精通|熟悉使用)/g;
    state.sentences.forEach((s, idx) => {
      if (skill.test(s)) push('技能与经历', idx, s.slice(0, 80), 'ok');
      skill.lastIndex = 0;
    });
  }

  return {
    engine: 'local',
    summary: `识别为${kind === 'general' ? '通用' : detectKind(text).label}文档，共 ${state.sentences.length} 句。本地引擎通过模式匹配抽取了 ${out.length} 条结构化线索。接入大模型引擎可获得语义级分析。`,
    findings: out.slice(0, 60),
  };
}

/* ================= LLM 引擎 ================= */
async function analyzeLLM(text, kind) {
  const { base, key, model } = state.llm;
  const url = base.replace(/\/+$/, '') + '/chat/completions';
  const sys = `你是文档分析引擎。对用户给出的文档生成结构化中文报告。
输出 JSON：{"summary": "一句话总评", "findings": [{"sec": "分类名", "text": "结论", "quote": "原文中的支撑句"}]}
分类按文档类型选择（合同：金额条款/义务与权利/风险提示/关键日期；会议：决议/待办与行动项/责任人；简历：技能匹配/经历亮点/存疑处；财报：核心指标/同比变化/异常值）。
quote 必须逐字取自原文，不得改写。只输出 JSON。`;

  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + key },
    body: JSON.stringify({
      model: model || 'deepseek-chat',
      temperature: 0.2,
      max_tokens: 4000,
      messages: [
        { role: 'system', content: sys },
        { role: 'user', content: `文档类型判定：${kind}\n\n文档内容：\n${text.slice(0, 12000)}` },
      ],
    }),
  });
  if (!resp.ok) throw new Error(`API 返回 ${resp.status}：${(await resp.text()).slice(0, 200)}`);
  const data = await resp.json();
  const raw = data.choices[0].message.content.replace(/```json|```/g, '').trim();
  const parsed = JSON.parse(raw);

  // quote → 句索引回链
  const findings = (parsed.findings || []).map((f) => {
    let idx = -1;
    const qi = state.sentences.findIndex((s) => s.includes(f.quote) || f.quote.includes(s.trim()));
    if (qi >= 0) idx = qi;
    return { sec: f.sec, text: f.text, sentenceIdx: idx };
  });
  return { engine: 'llm', summary: parsed.summary, findings };
}

/* ================= 渲染 ================= */
function renderReport(result) {
  const body = $('reportBody');
  const kind = detectKind(state.docText);
  const secOrder = [];
  const secMap = {};
  for (const f of result.findings) {
    if (!secMap[f.sec]) { secMap[f.sec] = []; secOrder.push(f.sec); }
    secMap[f.sec].push(f);
  }

  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  let html = `
    <div class="report-head">
      <span class="report-kind">${kind.label} · ${result.engine === 'llm' ? '大模型引擎' : '本地引擎'}</span>
      <div class="report-title">析文报告</div>
      <div class="report-line">${esc(state.docName)} · ${state.sentences.length} 句 · ${result.findings.length} 条发现</div>
    </div>`;

  for (const sec of secOrder) {
    html += `<section class="report-sec"><div class="sec-head"><span class="sec-num">${String(secOrder.indexOf(sec) + 1).padStart(2, '0')}</span><span class="sec-title">${esc(sec)}</span></div>`;
    for (const f of secMap[sec]) {
      const cls = f.tag === 'risk' ? ' risk' : f.tag === 'ok' ? ' ok' : '';
      const src = f.sentenceIdx >= 0 ? `原文 · 第 ${f.sentenceIdx + 1} 句` : '无出处标记';
      html += `<button class="finding${cls}" type="button" data-idx="${f.sentenceIdx}">
        <span class="finding-text">${esc(f.text)}</span>
        <span class="finding-src">${src}</span></button>`;
    }
    html += `</section>`;
  }

  if (secOrder.length === 0) {
    html += `<section class="report-sec"><p class="finding-text">没有匹配到结构化线索。试试接入大模型引擎，或上传更典型的文档。</p></section>`;
  }

  html += `<section class="report-sec"><div class="sec-head"><span class="sec-title">总评</span></div><p style="font-size:13.5px;color:var(--ink-700)">${esc(result.summary)}</p></section>`;

  body.innerHTML = html;
  body.querySelectorAll('.finding').forEach((btn) => {
    btn.addEventListener('click', () => {
      const idx = Number(btn.dataset.idx);
      if (idx >= 0) highlightSentence(idx);
    });
  });
}

/* ================= 主流程 ================= */
async function processFile(file) {
  try {
    $('dropZone').hidden = true;
    $('docView').hidden = false;
    $('reportEmpty').hidden = true;
    $('reportBody').hidden = true;
    $('reportLoading').hidden = false;
    $('loadingStep').textContent = '读取文档';

    const text = await readDoc(file);
    state.docText = text;
    state.docName = file.name;
    state.sentences = splitSentences(text);
    $('docName').textContent = file.name;
    $('docStat').textContent = `${text.length} 字 · ${state.sentences.length} 句`;
    renderDocText(text);

    $('loadingStep').textContent = state.engine === 'llm' ? '调用大模型' : '规则匹配';
    await new Promise((r) => setTimeout(r, 450)); // 让扫描动画至少跑一拍

    const kind = detectKind(text);
    let result;
    if (state.engine === 'llm') {
      result = await analyzeLLM(text, kind.kind);
    } else {
      result = analyzeLocal(text, kind.kind);
    }

    $('reportLoading').hidden = true;
    $('reportBody').hidden = false;
    renderReport(result);
  } catch (err) {
    $('reportLoading').hidden = true;
    $('reportEmpty').hidden = false;
    $('dropZone').hidden = false;
    $('docView').hidden = true;
    toast(err.message || '解析失败');
  }
}

/* 恢复上次的引擎选择 */
(() => {
  const eng = localStorage.getItem('docsift-engine');
  if (eng === 'llm') {
    const saved = JSON.parse(localStorage.getItem('docsift-llm') || 'null');
    if (saved && saved.base && saved.key) {
      state.engine = 'llm';
      state.llm = saved;
      document.querySelector('input[name=engine][value=llm]').checked = true;
      const toggle = document.querySelector('.engine-toggle');
      toggle.classList.add('is-llm');
      document.getElementById('engineLabel').textContent = '大模型引擎';
    }
  }
})();

/* ================= 事件绑定 ================= */
const dz = $('dropZone');
const fi = $('fileInput');

dz.addEventListener('click', () => fi.click());
dz.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') fi.click(); });
dz.addEventListener('dragover', (e) => { e.preventDefault(); dz.classList.add('dragging'); });
dz.addEventListener('dragleave', () => dz.classList.remove('dragging'));
dz.addEventListener('drop', (e) => {
  e.preventDefault();
  dz.classList.remove('dragging');
  const f = e.dataTransfer.files[0];
  if (f) processFile(f);
});
fi.addEventListener('change', () => { if (fi.files[0]) processFile(fi.files[0]); fi.value = ''; });

$('docClear').addEventListener('click', () => {
  state.docText = ''; state.docName = ''; state.sentences = [];
  $('docView').hidden = true;
  $('dropZone').hidden = false;
  $('reportBody').hidden = true;
  $('reportEmpty').hidden = false;
});

/* 引擎面板 */
const ep = $('enginePanel');
$('engineToggle').addEventListener('click', () => {
  ep.hidden = false;
  const saved = JSON.parse(localStorage.getItem('docsift-llm') || 'null');
  if (saved) {
    $('llmBase').value = saved.base || '';
    $('llmKey').value = saved.key || '';
    $('llmModel').value = saved.model || '';
  }
  const cur = state.engine;
  document.querySelector(`input[name=engine][value=${cur}]`).checked = true;
  $('llmFields').hidden = cur !== 'llm';
});
document.querySelectorAll('input[name=engine]').forEach((r) => {
  r.addEventListener('change', () => { $('llmFields').hidden = r.value !== 'llm'; });
});
$('engineCancel').addEventListener('click', () => { ep.hidden = true; });
$('engineSave').addEventListener('click', () => {
  const val = document.querySelector('input[name=engine]:checked').value;
  state.engine = val;
  if (val === 'llm') {
    state.llm = { base: $('llmBase').value.trim(), key: $('llmKey').value.trim(), model: $('llmModel').value.trim() };
    if (!state.llm.base || !state.llm.key) { toast('大模型引擎需要 API 地址和密钥'); return; }
    localStorage.setItem('docsift-llm', JSON.stringify(state.llm));
    $('engineToggle').classList.add('is-llm');
    $('engineLabel').textContent = '大模型引擎';
  } else {
    $('engineToggle').classList.remove('is-llm');
    $('engineLabel').textContent = '本地引擎';
  }
  ep.hidden = true;
  localStorage.setItem('docsift-engine', val);
  toast(`已切换到${val === 'llm' ? '大模型' : '本地'}引擎，重新上传文档生效`);
});

/* 示例合同 */
const SAMPLE = `软件开发服务合同
甲方：星辰科技有限公司
乙方：云图软件开发工作室
双方就甲方委托乙方开发客户管理系统事宜，经友好协商达成如下协议：

第一条 项目内容
甲方委托乙方开发一套客户管理系统，包含客户档案、销售漏斗、数据看板三个模块。乙方应当按照附件一《需求规格说明书》完成开发。

第二条 合同金额与支付
本合同总金额为人民币 180,000 元。合同签署后 5 个工作日内，甲方支付首期款 50%，即 90,000 元；系统验收通过后支付剩余 50% 尾款。

第三条 开发周期
乙方应当在 2026 年 9 月 15 日前完成全部开发工作并提交甲方验收。如遇甲方需求变更，工期相应顺延。

第四条 双方义务
甲方应当及时提供开发所需的业务资料与测试人员。乙方应当按里程碑每两周向甲方汇报进度，并保证源代码质量。
乙方有权在收到首期款后开始开发工作。甲方有权对交付成果提出两轮修改意见。

第五条 知识产权
本项目交付成果的知识产权归甲方所有。乙方保证交付物不含侵犯第三方知识产权的内容，如引发知识产权纠纷，由乙方承担全部责任。

第六条 保密义务
乙方对在合作期间接触到的甲方商业秘密负有保密义务，保密期限至合同终止后 3 年。

第七条 违约责任
如乙方延期交付超过 15 个工作日，每延期一日按合同总额的 0.5‰ 支付违约金。如甲方逾期付款，每逾期一日按应付款项的 0.5‰ 支付滞纳金。

第八条 争议解决
因本合同引起的争议，双方应当友好协商解决；协商不成的，提交上海仲裁委员会仲裁。

第九条 合同生效
本合同一式两份，双方各执一份，自双方签署之日起生效。合同期限至 2026 年 12 月 31 日项目维保期结束为止。`;

$('pasteSample').addEventListener('click', (e) => {
  e.preventDefault();
  const blob = new File([SAMPLE], '示例-软件开发服务合同.txt', { type: 'text/plain' });
  processFile(blob);
});
