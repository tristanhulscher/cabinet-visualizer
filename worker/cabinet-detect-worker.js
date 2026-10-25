// Cabinet Colour Visualizer: AI cabinet detection (Cloudflare Worker)
//
// The visualizer page POSTs {image: "data:image/jpeg;base64,...", aspect: "4:3"} here. This Worker
// adds the secret Gemini API key and asks Google's image-editing model to repaint ONLY the cabinets
// in flat magenta. It returns {image: "data:image/png;base64,...", seconds}; the page treats every
// magenta pixel as cabinet and paints the real Sherwin-Williams colour there itself.
// The key never reaches the browser.
//
// Setup (Cloudflare dashboard): Workers & Pages -> cabinet-detect -> Edit code -> paste this file -> Deploy.
// The key is a Secret named GEMINI_API_KEY (Settings -> Variables and Secrets).

const MODEL = "gemini-3-pro-image"; // "Nano Banana Pro": kept glass panes intact where Nano Banana 2 painted over them
const ALLOWED_ORIGINS = [
  "https://tristanhulscher.github.io",
  "http://localhost:8766",
  "http://localhost:8767",
];
const ASPECTS = ["1:1", "2:3", "3:2", "3:4", "4:3", "4:5", "5:4", "9:16", "16:9", "21:9"];
const MAX_IMAGE_CHARS = 3_000_000;      // ~2.2 MB JPEG; the page sends ~1280px photos (~250 KB)
const PER_IP_LIMIT = 15;                // detections per IP per window (best effort, per Worker instance)
const WINDOW_MS = 60 * 60 * 1000;

const PROMPT = `Edit this photo for a cabinet-painting preview.
Repaint ONLY the cabinetry in a flat, solid, fully saturated magenta (#FF00FF): every cabinet door,
drawer front, cabinet box, end panel, face frame, filler, toe kick, crown moulding on cabinets, and
the sides and back of any island or peninsula cabinetry. Cover the whole cabinet surface, edge to edge.

Do NOT change anything else, not even slightly: keep walls, ceiling, countertops, backsplash, tile,
appliances, range hood, sink, faucet, windows, floor, lights, handles and knobs, glass panes in doors,
and every object exactly as they are. Keep the same framing, size and perspective; do not crop,
zoom, straighten or re-light the photo. Grey borders around the photo must stay grey.`;

const hits = new Map(); // ip -> [timestamps]

function cors(origin) {
  const ok = ALLOWED_ORIGINS.includes(origin);
  return {
    "Access-Control-Allow-Origin": ok ? origin : ALLOWED_ORIGINS[0],
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Vary": "Origin",
  };
}

function reply(body, status, origin) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...cors(origin) },
  });
}

function rateLimited(ip) {
  const now = Date.now();
  const list = (hits.get(ip) || []).filter(t => now - t < WINDOW_MS);
  if (list.length >= PER_IP_LIMIT) { hits.set(ip, list); return true; }
  list.push(now);
  hits.set(ip, list);
  return false;
}

async function callModel(env, jpegB64, aspect) {
  const generationConfig = { responseModalities: ["IMAGE"] };
  if (aspect) generationConfig.imageConfig = { aspectRatio: aspect };
  return fetch(`https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-goog-api-key": env.GEMINI_API_KEY },
    body: JSON.stringify({
      contents: [{ parts: [{ inline_data: { mime_type: "image/jpeg", data: jpegB64 } }, { text: PROMPT }] }],
      generationConfig,
    }),
  });
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get("Origin") || "";
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors(origin) });
    if (request.method !== "POST") return reply({ error: "POST a photo to use this endpoint" }, 405, origin);
    if (!ALLOWED_ORIGINS.includes(origin)) return reply({ error: "Not allowed from this site" }, 403, origin);
    if (!env.GEMINI_API_KEY) return reply({ error: "GEMINI_API_KEY secret is not set" }, 500, origin);

    const ip = request.headers.get("CF-Connecting-IP") || "unknown";
    if (rateLimited(ip)) return reply({ error: "Too many photos, please try again later" }, 429, origin);

    let body;
    try { body = await request.json(); } catch { body = {}; }
    const image = body.image;
    if (typeof image !== "string" || !image.startsWith("data:image/jpeg;base64,") || image.length > MAX_IMAGE_CHARS) {
      return reply({ error: "Send a JPEG photo as a data URL" }, 400, origin);
    }
    const aspect = ASPECTS.includes(body.aspect) ? body.aspect : null;
    const jpeg = image.slice(image.indexOf(",") + 1);

    const t0 = Date.now();
    let res = await callModel(env, jpeg, aspect);
    if (res.status === 400 && aspect) res = await callModel(env, jpeg, null); // in case aspectRatio isn't accepted
    if (!res.ok) {
      const detail = (await res.text()).slice(0, 300);
      console.log("Gemini error", res.status, detail);
      return reply({ error: `Detection service error (${res.status})` }, 502, origin);
    }
    const data = await res.json();
    const parts = data.candidates?.[0]?.content?.parts || [];
    const img = parts.find(p => (p.inlineData || p.inline_data)?.data);
    if (!img) {
      console.log("No image in answer", JSON.stringify(data).slice(0, 300));
      return reply({ error: "The detection service returned no image" }, 502, origin);
    }
    const inline = img.inlineData || img.inline_data;
    return reply({
      image: `data:${inline.mimeType || inline.mime_type || "image/png"};base64,${inline.data}`,
      model: MODEL,
      seconds: Math.round((Date.now() - t0) / 100) / 10,
    }, 200, origin);
  },
};
