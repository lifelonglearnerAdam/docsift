/* 析文 DocSift — 本地 LLM 转发代理
   用途：号池等按 User-Agent 指纹校验的服务商，浏览器无法自定义 UA（forbidden header），
   本代理在转发时补上 claude-cli 指纹，并加 CORS 头让本地页面可跨域调用。
   仅监听 127.0.0.1，仅转发 /v1/chat/completions。
*/
import http from 'node:http';

const PORT = 8422;
const UPSTREAM = 'https://ps.air-outer.com';

http.createServer(async (req, res) => {
  const cors = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
  };
  if (req.method === 'OPTIONS') { res.writeHead(204, cors); res.end(); return; }
  if (req.url !== '/v1/chat/completions') { res.writeHead(404, cors); res.end('not found'); return; }

  const chunks = [];
  for await (const c of req) chunks.push(c);
  const body = Buffer.concat(chunks);

  try {
    const r = await fetch(UPSTREAM + '/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': req.headers['authorization'] || '',
        // 浏览器禁止自定义 User-Agent，这里补上客户端指纹
        'User-Agent': 'claude-cli/2.0.14 (external, cli)',
        'x-app': 'cli',
      },
      body,
    });
    const text = await r.text();
    res.writeHead(r.status, { 'Content-Type': 'application/json', ...cors });
    res.end(text);
  } catch (e) {
    res.writeHead(502, { 'Content-Type': 'application/json', ...cors });
    res.end(JSON.stringify({ error: { message: 'proxy upstream error: ' + e.message } }));
  }
}).listen(PORT, '127.0.0.1', () => console.log(`LLM proxy on http://127.0.0.1:${PORT}`));
