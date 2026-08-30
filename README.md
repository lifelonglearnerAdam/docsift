# 析文 DocSift

> 上传文档，30 秒生成结构化报告 —— 每条结论都回链原文，可核对，不编造。

**在线体验**：[https://lifelonglearneradam.github.io/docsift/](https://lifelonglearneradam.github.io/docsift/)

## 它解决什么问题

合同、会议记录、简历、财报这类长文档，人工通读费时，直接丢给 ChatGPT 又无法核对结论出处。析文的答案是：**结论 + 原文定位**——报告里的每一条发现都能点击跳回原文高亮处，看得见依据才敢用结论。

## 功能

- **文档解析**：PDF（文字层）/ TXT / Markdown / DOCX，全部在浏览器本地完成，不上传服务器
- **类型识别**：自动判断合同 / 会议记录 / 简历 / 财报 / 通用，按类型选择分析框架
- **双引擎**
  - 本地规则引擎：离线可用，分句 + 模式匹配抽取金额、日期、义务、风险词等结构化线索
  - 大模型引擎：填写任意兼容 OpenAI 格式的 API（DeepSeek / 智谱 / 本地 Ollama 均可），语义级分析，密钥只存本机 localStorage
- **回链高亮**：点击报告中的发现，原文滚动到对应句子并高亮

## 使用

无需构建，静态文件即开即用：

```bash
# 本地打开
python3 -m http.server 8080
# 或直接部署到 GitHub Pages / 任意静态托管
```

接入大模型引擎：右上角「本地引擎」按钮 → 选择大模型 → 填入 API 地址、密钥、模型名。

## 技术说明

- 零依赖前端：原生 JS + 一个 CDN（pdf.js）
- DOCX 解析为自带的极简 ZIP 解包（local file header 顺序扫描 + 原生 `DecompressionStream`），无第三方库
- 本地引擎的回链基于分句索引，LLM 引擎通过 quote 与分句匹配定位

## License

MIT
