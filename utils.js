const fs = require('fs');
const path = require('path');

// Helper to extract clean IPv4 from possible IPv6 mapped IPv4
function cleanIp(ip) {
  if (!ip) return '';
  const parts = ip.split(':');
  return parts[parts.length - 1];
}

// 本地时间戳 "YYYY-MM-DD HH:mm:ss.SSS"。
// 不要用 toISOString()：那是 UTC，在 UTC+8 下展示会慢 8 小时。
function localTimestamp(d = new Date()) {
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ` +
    `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
}

module.exports = {
  cleanIp,
  localTimestamp
};
