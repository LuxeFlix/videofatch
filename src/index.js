const MAX_HTML_BYTES = 2_500_000;
const REQUEST_TIMEOUT_MS = 12_000;

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function isPrivateHost(hostname) {
  const host = hostname.toLowerCase();
  return host === "localhost" || host === "::1" || host.endsWith(".localhost") ||
    host === "0.0.0.0" || /^127\./.test(host) || /^10\./.test(host) ||
    /^192\.168\./.test(host) || /^169\.254\./.test(host) ||
    /^172\.(1[6-9]|2\d|3[0-1])\./.test(host);
}

function decodeHtml(value) {
  return value.replace(/&amp;/g, "&").replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'").replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">").replace(/\s+/g, " ").trim();
}

function resolveUrl(raw, base) {
  try {
    const value = new URL(decodeHtml(raw), base);
    return value.protocol === "http:" || value.protocol === "https:" ? value.href : null;
  } catch {
    return null;
  }
}

async function scanVideos(request) {
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Please provide a valid JSON request." }, 400);
  }

  if (!body || typeof body.url !== "string" || body.url.length < 8 || body.url.length > 2048) {
    return json({ error: "Please provide a valid webpage URL." }, 400);
  }

  let pageUrl;
  try {
    pageUrl = new URL(body.url);
    if (!["http:", "https:"].includes(pageUrl.protocol) || isPrivateHost(pageUrl.hostname)) {
      throw new Error("unsupported host");
    }
  } catch {
    return json({ error: "Only public http(s) pages can be scanned." }, 400);
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(pageUrl, {
      signal: controller.signal,
      headers: {
        "User-Agent": "VideoLinkGenerator/1.0 (+authorized-content-scanner)",
        Accept: "text/html,application/xhtml+xml",
      },
    });
    if (!response.ok) return json({ error: `The page returned HTTP ${response.status}.` }, 502);
    const contentType = response.headers.get("content-type") || "";
    if (!contentType.includes("text/html") && !contentType.includes("application/xhtml")) {
      return json({ error: "The URL did not return an HTML page." }, 502);
    }

    const reader = response.body?.getReader();
    if (!reader) return json({ error: "The page response was empty." }, 502);
    const chunks = [];
    let total = 0;
    while (total < MAX_HTML_BYTES) {
      const { done, value } = await reader.read();
      if (done || !value) break;
      const remaining = MAX_HTML_BYTES - total;
      const chunk = value.byteLength > remaining ? value.slice(0, remaining) : value;
      chunks.push(chunk);
      total += chunk.byteLength;
    }
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.length;
    }
    const html = new TextDecoder().decode(bytes);
    const pageTitle = decodeHtml(html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || pageUrl.hostname);
    const found = new Map();
    const add = (raw, label, kind) => {
      const url = raw ? resolveUrl(raw, pageUrl.href) : null;
      if (!url || found.has(url)) return;
      found.set(url, { url, title: label || `Video ${found.size + 1}`, kind });
    };

    for (const match of html.matchAll(/<(?:video|source)\b[^>]*?(?:src|data-src)\s*=\s*["']([^"']+)["'][^>]*>/gi)) {
      add(match[1], `Video ${found.size + 1}`, "video");
    }
    for (const match of html.matchAll(/(?:href|data-video-url|data-src)\s*=\s*["']([^"']+\.(?:mp4|webm|mov|m4v)(?:\?[^"']*)?)["']/gi)) {
      add(match[1], `Video ${found.size + 1}`, "source");
    }
    for (const match of html.matchAll(/https?:\/\/[^"'\s<>]+?\.(?:mp4|webm|mov|m4v)(?:\?[^"'\s<>]*)?/gi)) {
      add(match[0], `Video ${found.size + 1}`, "source");
    }

    return json({
      sourceUrl: pageUrl.href,
      pageTitle: pageTitle.slice(0, 200),
      videos: [...found.values()].slice(0, 100).map((video, index) => ({ ...video, index: index + 1 })),
      scannedAt: new Date().toISOString(),
    });
  } catch {
    return json({ error: "The page could not be fetched. Try another public URL." }, 502);
  } finally {
    clearTimeout(timeout);
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/api/healthz") return json({ status: "ok" });
    if (url.pathname === "/api/videos/scan") {
      if (request.method === "OPTIONS") {
        return new Response(null, { headers: { "access-control-allow-methods": "POST, OPTIONS", "access-control-allow-headers": "content-type" } });
      }
      if (request.method !== "POST") return json({ error: "Method not allowed." }, 405);
      return scanVideos(request);
    }
    return env.ASSETS.fetch(request);
  },
};