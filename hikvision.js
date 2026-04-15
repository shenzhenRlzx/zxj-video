const http = require('http');
const https = require('https');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

function formatHikTime(date) {
  const d = new Date(date.getTime());
  const iso = d.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  return iso.replace('Z', '') + 'Z';
}

function ensureDir(dir) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function parseAuthHeader(header) {
  const raw = Array.isArray(header) ? header.join(',') : String(header || '');
  const idx = raw.toLowerCase().indexOf('digest');
  if (idx === -1) return null;
  const rest = raw.slice(idx + 6);
  const pairs = rest.match(/([a-zA-Z0-9_-]+)=(".*?"|[^,\s]+)/g) || [];
  const params = {};
  for (const p of pairs) {
    const eq = p.indexOf('=');
    const k = p.slice(0, eq).trim();
    let v = p.slice(eq + 1).trim();
    if (v.startsWith('"') && v.endsWith('"')) v = v.slice(1, -1);
    params[k] = v;
  }
  return params.nonce ? params : null;
}

function md5(text) {
  return crypto.createHash('md5').update(String(text), 'utf8').digest('hex');
}

function buildDigestAuth({ username, password, method, uri, challenge }) {
  const realm = challenge.realm || '';
  const nonce = challenge.nonce || '';
  const qopRaw = String(challenge.qop || '');
  const qop = qopRaw
    .split(',')
    .map((s) => s.trim())
    .find((s) => s === 'auth') || '';
  const algorithm = String(challenge.algorithm || 'MD5').toUpperCase();
  const opaque = challenge.opaque;

  const ha1 = algorithm === 'MD5' ? md5(`${username}:${realm}:${password}`) : md5(`${username}:${realm}:${password}`);
  const ha2 = md5(`${method}:${uri}`);
  const nc = '00000001';
  const cnonce = crypto.randomBytes(8).toString('hex');
  const response = qop ? md5(`${ha1}:${nonce}:${nc}:${cnonce}:${qop}:${ha2}`) : md5(`${ha1}:${nonce}:${ha2}`);

  const parts = [
    `username="${username}"`,
    `realm="${realm}"`,
    `nonce="${nonce}"`,
    `uri="${uri}"`,
    `response="${response}"`
  ];
  if (algorithm) parts.push(`algorithm=${algorithm}`);
  if (opaque) parts.push(`opaque="${opaque}"`);
  if (qop) parts.push(`qop=${qop}`, `nc=${nc}`, `cnonce="${cnonce}"`);
  return `Digest ${parts.join(', ')}`;
}

function requestOnce({ ip, port, method, urlPath, headers, body, timeoutMs, secure }) {
  return new Promise((resolve, reject) => {
    const protocol = secure ? https : http;
    const req = protocol.request(
      {
        hostname: ip,
        port,
        path: urlPath,
        method,
        headers,
        timeout: timeoutMs
      },
      (res) => resolve(res)
    );
    req.on('error', (err) => reject(err));
    if (body) req.write(body);
    req.end();
  });
}

function requestXml({ ip, httpPort, port, username, password, path: urlPath, secure = false }) {
  return new Promise(async (resolve, reject) => {
    try {
      const hikPort = Number(httpPort) || Number(port) || 80;
      const timeoutMs = 15000;
      const baseHeaders = {};

      const res1 = await requestOnce({
        ip,
        port: hikPort,
        method: 'GET',
        urlPath,
        headers: baseHeaders,
        body: null,
        timeoutMs,
        secure
      });

      if (res1.statusCode === 401) {
        const challenge = parseAuthHeader(res1.headers['www-authenticate']);
        res1.resume();
        if (!challenge) {
          reject(new Error('hikvision request failed: 401 unauthorized'));
          return;
        }
        const auth = buildDigestAuth({
          username: String(username || ''),
          password: String(password || ''),
          method: 'GET',
          uri: urlPath,
          challenge
        });
        const res2 = await requestOnce({
          ip,
          port: hikPort,
          method: 'GET',
          urlPath,
          headers: { Authorization: auth },
          body: null,
          timeoutMs,
          secure
        });
        const chunks = [];
        res2.on('data', (c) => chunks.push(c));
        res2.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          if (res2.statusCode !== 200) {
            reject(new Error(`hikvision request failed: ${res2.statusCode} ${text}`));
            return;
          }
          resolve(text);
        });
        return;
      }

      const chunks = [];
      res1.on('data', (c) => chunks.push(c));
      res1.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        if (res1.statusCode !== 200) {
          reject(new Error(`hikvision request failed: ${res1.statusCode} ${text}`));
          return;
        }
        resolve(text);
      });
    } catch (e) {
      reject(e);
    }
  });
}

function fetchChannels({ ip, httpPort, username, password, secure = false }) {
  if (!ip || !username) return Promise.reject(new Error('invalid hikvision config'));
  const urlPath = '/ISAPI/Streaming/channels';
  return requestXml({ ip, httpPort, username, password, path: urlPath, secure }).then((xml) => {
    const list = [];
    const re = /<StreamingChannel>([\s\S]*?)<\/StreamingChannel>/g;
    let m;
    while ((m = re.exec(xml))) {
      const block = m[1];
      const idMatch = block.match(/<id>(.*?)<\/id>/);
      const nameMatch = block.match(/<channelName>(.*?)<\/channelName>/);
      const id = idMatch ? String(idMatch[1]).trim() : '';
      const name = nameMatch ? String(nameMatch[1]).trim() : '';
      if (!id) continue;
      list.push({ id, name });
    }
    return list;
  });
}

function normalizeLiveChannelId(channelId, streamType) {
  const raw = String(channelId || '').trim();
  if (!raw) return null;
  if (!/^\d+$/.test(raw)) return raw;
  if (raw.length >= 3) return Number(raw);
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return null;
  const st = Number(streamType) || 2;
  if (n >= 33) return (n - 32) * 100 + st;
  return n * 100 + st;
}

function normalizePlaybackTrackId(channelId) {
  const raw = String(channelId || '').trim();
  if (!raw) return null;
  if (!/^\d+$/.test(raw)) return raw;
  if (raw.length >= 3) return Number(raw);
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return null;
  const ipChannel = n >= 33 ? n - 32 : n;
  return ipChannel * 100 + 1;
}

function buildRtspUrl({ ip, username, password, channelId, rtspPort, streamType }) {
  const safeIp = String(ip || '').trim();
  const safeUser = encodeURIComponent(String(username || '').trim());
  const safePass = encodeURIComponent(String(password || ''));
  const safeChannel = normalizeLiveChannelId(channelId, streamType);
  const safeRtspPort = Number(rtspPort) || 554;
  if (!safeIp || !safeChannel) return '';
  if (!safeUser) {
    return `rtsp://${safeIp}:${safeRtspPort}/Streaming/channels/${safeChannel}`;
  }
  return `rtsp://${safeUser}:${safePass}@${safeIp}:${safeRtspPort}/Streaming/channels/${safeChannel}`;
}

function downloadClip({ ip, httpPort, port, username, password, channelId, rtspPort, start, end, saveDir, fileName, secure = false }) {
  return new Promise((resolve, reject) => {
    if (!ip || !channelId || !username) {
      reject(new Error('invalid hikvision config'));
      return;
    }

    const protocol = secure ? https : http;
    const hikPort = Number(httpPort) || Number(port) || 80;
    const safeRtspPort = Number(rtspPort) || 554;
    const startStr = formatHikTime(start);
    const endStr = formatHikTime(end);

    const trackId = normalizePlaybackTrackId(channelId);
    if (!trackId) {
      reject(new Error('invalid channelId'));
      return;
    }
    const userPart = encodeURIComponent(String(username || '').trim());
    const passPart = encodeURIComponent(String(password || ''));
    const cred = userPart ? `${userPart}:${passPart}@` : '';
    const playbackUri = `rtsp://${cred}${ip}:${safeRtspPort}/Streaming/tracks/${trackId}?starttime=${startStr}&endtime=${endStr}`;
    const body = `<downloadRequest><playbackURI>${playbackUri}</playbackURI></downloadRequest>`;
    const bodyBuf = Buffer.from(body, 'utf8');

    ensureDir(saveDir);
    const safeName = fileName || `clip-${Date.now()}.mp4`;
    const target = path.join(saveDir, safeName);

    const urlPath = '/ISAPI/ContentMgmt/download';
    const timeoutMs = 30000;

    const handleDownloadResponse = (res) => {
      if (res.statusCode !== 200) {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          reject(new Error(`hikvision download failed: ${res.statusCode} ${text}`));
        });
        return;
      }

      const out = fs.createWriteStream(target);
      res.pipe(out);
      out.on('finish', () => {
        out.close(() => resolve(target));
      });
      out.on('error', (err) => {
        reject(err);
      });
    };

    const req1 = protocol.request(
      {
        hostname: ip,
        port: hikPort,
        path: urlPath,
        method: 'POST',
        headers: {
          'Content-Type': 'application/xml',
          'Content-Length': bodyBuf.length
        },
        timeout: timeoutMs
      },
      (res1) => {
        if (res1.statusCode === 401) {
          const challenge = parseAuthHeader(res1.headers['www-authenticate']);
          res1.resume();
          if (!challenge) {
            reject(new Error('hikvision download failed: 401 unauthorized'));
            return;
          }
          const auth = buildDigestAuth({
            username: String(username || ''),
            password: String(password || ''),
            method: 'POST',
            uri: urlPath,
            challenge
          });
          const req2 = protocol.request(
            {
              hostname: ip,
              port: hikPort,
              path: urlPath,
              method: 'POST',
              headers: {
                Authorization: auth,
                'Content-Type': 'application/xml',
                'Content-Length': bodyBuf.length
              },
              timeout: timeoutMs
            },
            handleDownloadResponse
          );
          req2.on('error', (err) => reject(err));
          req2.write(bodyBuf);
          req2.end();
          return;
        }
        handleDownloadResponse(res1);
      }
    );

    req1.on('error', (err) => reject(err));
    req1.write(bodyBuf);
    req1.end();
  });
}

module.exports = {
  downloadClip,
  fetchChannels,
  buildRtspUrl
};
