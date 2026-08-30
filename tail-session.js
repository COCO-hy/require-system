// 解码 dsh 会话日志（多帧 zstd JSONL：按帧魔数切分逐帧解码）
// 用法: node tail-session.js <file> [N] [--json]
//   默认人读模式打印最后 N 条事件；--json 输出机器可读 JSON（供透传服务调用）
"use strict";
const zlib = require("zlib");
const fs = require("fs");

const args = process.argv.slice(2);
const file = args[0];
const jsonMode = args.includes("--json");
const tailN = parseInt(args[1] || "8", 10);
const buf = fs.readFileSync(file);

// 找出所有 zstd 帧起始位置（magic: 28 B5 2F FD）
const positions = [];
for (let i = 0; i <= buf.length - 4; i++) {
  if (buf[i] === 0x28 && buf[i + 1] === 0xB5 && buf[i + 2] === 0x2F && buf[i + 3] === 0xFD) positions.push(i);
}

const parts = [];
for (let k = 0; k < positions.length; k++) {
  const end = k + 1 < positions.length ? positions[k + 1] : buf.length;
  try {
    parts.push(zlib.zstdDecompressSync(buf.subarray(positions[k], end)));
  } catch (_) { /* 半帧（正在写入）跳过 */ }
}
const text = Buffer.concat(parts).toString("utf8");
const lines = text.split("\n").filter(Boolean);

function pick(ev) {
  const type = ev.type || "?";
  if (/^(text-chunks|reasoning-chunks|tool-call-chunks)$/.test(type)) return null; // 打包行
  if (type === "assistant/chunk") return null; // 细粒度 delta，噪音太大
  const d = ev.data || {};
  let out = "";
  if (type === "assistant/message") {
    const blocks = (d.message && d.message.content) || [];
    const tb = blocks.find((b) => b.type === "text");
    out = tb ? tb.text : "(思考中)";
  } else if (type === "tool/call") {
    out = `▶ ${d.name || "?"} ${String(d.arguments || "").slice(0, 180)}`;
  } else if (type === "tool/result" || type === "tool/outcome") {
    out = `✔ ${JSON.stringify(d).slice(0, 140)}`;
  } else if (type === "user/message") {
    out = String(d.text || d.message || JSON.stringify(d)).slice(0, 200);
  } else if (type === "turn/end") {
    out = `结束: ${(d.reason && (d.reason.kind || d.reason)) || "?"}`;
  } else if (type === "session") {
    return null;
  } else {
    out = JSON.stringify(d).slice(0, 120);
  }
  return { t: ev.time || 0, type, text: String(out).replace(/\s+/g, " ").slice(0, 240) };
}

if (jsonMode) {
  const events = [];
  let maxTime = 0;
  for (const line of lines) {
    try {
      const o = JSON.parse(line);
      const ev = o.event || o;
      if (ev.time > maxTime) maxTime = ev.time;
      const p = pick(ev);
      if (p) events.push(p);
    } catch (_) {}
  }
  console.log(JSON.stringify({ frames: positions.length, total: lines.length, lastTime: maxTime, events: events.slice(-tailN) }));
  process.exit(0);
}

console.log(`帧数: ${positions.length}  总事件数: ${lines.length}`);
for (const line of lines.slice(-tailN)) {
  try {
    const o = JSON.parse(line);
    const ev = o.event || o;
    const t = ev.time ? new Date(ev.time).toLocaleTimeString("zh-CN", { hour12: false }) : "?";
    console.log(`[${t}] #${ev.seq} ${ev.type} ${JSON.stringify(ev.data || {}).slice(0, 300)}`);
  } catch (_) {
    console.log(line.slice(0, 200));
  }
}
