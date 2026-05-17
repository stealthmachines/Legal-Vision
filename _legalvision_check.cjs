const http = require("http");
const img = "C:/Users/Owner/Documents/Josef's Law Collection/11 Am Jur 1d Const Law/iCloud Photos/Rotated/crops/IMG_2117_R.jpg";
function sseCall(port, name, args) {
  return new Promise((resolve, reject) => {
    let posted = false, sseBuf = ""; const msgId = 1;
    const req = http.get(`http://127.0.0.1:${port}/sse`, (res) => {
      res.on("data", chunk => {
        sseBuf += chunk.toString();
        const lines = sseBuf.split("\n"); sseBuf = lines.pop();
        for (const line of lines) {
          if (!posted && line.startsWith("data:")) {
            const d = line.slice(5).trim();
            if (d.startsWith("/")) {
              posted = true;
              const body = JSON.stringify({ jsonrpc:"2.0", id:msgId, method:"tools/call", params:{ name, arguments:args } });
              const postReq = http.request(`http://127.0.0.1:${port}${d}`, { method:"POST", headers:{ "Content-Type":"application/json", "Content-Length": Buffer.byteLength(body)} });
              postReq.on("error", reject); postReq.end(body);
            }
          }
          if (posted && line.startsWith("data:")) {
            const d = line.slice(5).trim();
            try { const j = JSON.parse(d); if (j.id===msgId){ req.destroy(); resolve(j);} } catch {}
          }
        }
      });
      res.on("error", reject);
    });
    req.on("error", reject);
    setTimeout(()=>{req.destroy(); reject(new Error("timeout"));}, 240000);
  });
}
(async()=>{
  for (const port of [3333,3334]) {
    try {
      const r = await sseCall(port,"legal_vision",{
        image_path:img,
        document_type:"legal",
        depth:"detailed",
        model:"qwen3.5-9b@q6_k_xl:2",
        max_tokens:700,
        vision_timeout_ms:300000
      });
      const o = JSON.parse(r?.result?.content?.[0]?.text || "{}");
      console.log(`PORT ${port} success=${!!o.success} mode=${o.mode||"n/a"} err=${o.error||"none"} hasVerbatim=${typeof o.verbatim_transcription==="string"} uncertain=${Array.isArray(o.uncertain_spans)?o.uncertain_spans.length:"n/a"} first=${o.first_visible_line||""}`);
    } catch (e) {
      console.log(`PORT ${port} ERROR ${e.message}`);
    }
  }
})();
