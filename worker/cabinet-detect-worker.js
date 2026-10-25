// Cabinet Colour Visualizer: AI cabinet detection (Cloudflare Worker)
//
// The visualizer page POSTs {image: "data:image/jpeg;base64,...", aspect: "4:3"} here. This Worker
// adds the secret Gemini API key and asks Google's image-editing model to repaint ONLY the cabinets
// in flat magenta, and (at the same time) in an even grey final coat. It returns
// {image, grey, seconds}: the page treats every magenta pixel as cabinet, takes light and shadow from
// the grey coat, and paints the real Sherwin-Williams colour there itself.
// The key never reaches the browser.
//
// Setup (Cloudflare dashboard): Workers & Pages -> cabinet-detect -> Edit code -> paste this file -> Deploy.
// The key is a Secret named GEMINI_API_KEY (Settings -> Variables and Secrets).

const MODEL = "gemini-3.1-flash-image"; // "Nano Banana 2": matched or beat Pro on test kitchens at a fraction of the cost
const ALLOWED_ORIGINS = [
  "https://tristanhulscher.github.io",
  "http://localhost:8766",
  "http://localhost:8767",
];
const ASPECTS = ["1:1", "2:3", "3:2", "3:4", "4:3", "4:5", "5:4", "9:16", "16:9", "21:9"];
const MAX_IMAGE_CHARS = 4_000_000;      // ~3 MB JPEG; the page sends ~2048px photos (~600 KB)
const FIND_LIMIT = 10;                  // photo uploads per visitor per hour
const PAINT_LIMIT = 8;                  // colour renders per visitor per day (the page allows 5; a little slack for retries)
const HOUR = 60 * 60 * 1000, DAY = 24 * HOUR;

const PROMPT = `Edit this photo for a cabinet-painting preview.
Repaint ONLY the cabinetry in a flat, solid, fully saturated magenta (#FF00FF): every cabinet door,
drawer front, cabinet box, end panel, face frame, filler, toe kick, crown moulding on cabinets, and
the sides and back of any island or peninsula cabinetry. Cover the whole cabinet surface, edge to edge.

Do NOT change anything else, not even slightly: keep walls, ceiling, countertops, backsplash, tile,
appliances, range hood, sink, faucet, windows, floor, lights, handles and knobs, glass panes in doors,
and every object exactly as they are. Keep the same framing, size and perspective; do not crop,
zoom, straighten or re-light the photo. Grey borders around the photo must stay grey.`;

// Second render: the cabinets in an even mid-grey final coat. The page takes the light and shadow from
// it and tints it to the exact Sherwin-Williams colour, so the paint looks like a real photo
const GREY_PROMPT = `Edit this photo for a cabinet-painting preview.
Repaint ONLY the cabinetry as if a professional painter just finished the final coat in an even,
solid, medium neutral grey (#808080) satin paint: every cabinet door, drawer front, cabinet box,
end panel, face frame, filler, toe kick, crown moulding on cabinets, and the sides of any island or
peninsula cabinetry. Fully hide the old finish and wood grain. Keep the real lighting, shadows,
panel profiles and edges of the cabinets so it looks like a real photo.

Do NOT change anything else, not even slightly: keep walls, ceiling, countertops, backsplash, tile,
appliances, range hood, sink, faucet, windows, floor, lights, handles and knobs, glass panes in doors,
and every object exactly as they are. Keep the same framing, size and perspective; do not crop,
zoom, straighten or re-light the photo. Grey borders around the photo must stay grey.`;

// Third kind of render, one per colour the customer picks: the cabinets painted in that actual
// Sherwin-Williams colour. The page keeps only the cabinets from it and corrects it to the exact chip
const paintPrompt = c => `Edit this photo to show what this kitchen would look like after a professional cabinet painter
finished the job. Repaint ONLY the cabinetry in Sherwin-Williams ${c.num} ${c.name} (hex #${c.hex}), smooth satin
finish, final coat: every cabinet door, drawer front, cabinet box, end panel, face frame, filler, toe
kick, crown moulding on cabinets, and island or peninsula cabinetry. Fully hide the old finish and wood
grain. Keep crisp, realistic detail on door profiles and edges, with the room's natural light and
shadows so it looks like a real photograph. Use a smooth low-sheen finish: no mirror-like
reflections, no window reflections, no light streaks or glare on the doors.
Keep every door's design exactly: glass-front doors stay glass, showing the same items inside;
open shelves stay open with the same items; never turn glass or open cabinets into solid doors.

Do NOT change anything else: keep walls, ceiling, countertops, backsplash, appliances, range hood, sink,
faucet, windows, floor, lights, handles and knobs, and every object exactly as they are. Keep the same
framing, size and perspective. Grey borders around the photo must stay grey.`;

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

// Best effort: counts live per Worker instance, so this is a backstop, not an exact meter
function rateLimited(key, limit, windowMs) {
  const now = Date.now();
  const list = (hits.get(key) || []).filter(t => now - t < windowMs);
  if (list.length >= limit) { hits.set(key, list); return true; }
  list.push(now);
  hits.set(key, list);
  return false;
}

async function callModel(env, jpegB64, aspect, prompt, size) {
  const generationConfig = { responseModalities: ["IMAGE"] };
  if (aspect || size) generationConfig.imageConfig = { ...(aspect && { aspectRatio: aspect }), ...(size && { imageSize: size }) };
  return fetch(`https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-goog-api-key": env.GEMINI_API_KEY },
    body: JSON.stringify({
      contents: [{ parts: [{ inline_data: { mime_type: "image/jpeg", data: jpegB64 } }, { text: prompt }] }],
      generationConfig,
    }),
  });
}

async function render(env, jpeg, aspect, prompt, size) {
  let res = await callModel(env, jpeg, aspect, prompt, size);
  if (res.status === 400 && (aspect || size)) res = await callModel(env, jpeg, null, prompt); // in case imageConfig isn't accepted
  if (!res.ok) {
    console.log("Gemini error", res.status, (await res.text()).slice(0, 300));
    return { error: `Detection service error (${res.status})` };
  }
  const data = await res.json();
  const img = (data.candidates?.[0]?.content?.parts || []).find(p => (p.inlineData || p.inline_data)?.data);
  if (!img) {
    console.log("No image in answer", JSON.stringify(data).slice(0, 300));
    return { error: "The detection service returned no image" };
  }
  const inline = img.inlineData || img.inline_data;
  return { image: `data:${inline.mimeType || inline.mime_type || "image/png"};base64,${inline.data}` };
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get("Origin") || "";
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors(origin) });
    if (request.method !== "POST") return reply({ error: "POST a photo to use this endpoint" }, 405, origin);
    if (!ALLOWED_ORIGINS.includes(origin)) return reply({ error: "Not allowed from this site" }, 403, origin);
    if (!env.GEMINI_API_KEY) return reply({ error: "GEMINI_API_KEY secret is not set" }, 500, origin);

    const ip = request.headers.get("CF-Connecting-IP") || "unknown";

    let body;
    try { body = await request.json(); } catch { body = {}; }
    const image = body.image;
    if (typeof image !== "string" || !image.startsWith("data:image/jpeg;base64,") || image.length > MAX_IMAGE_CHARS) {
      return reply({ error: "Send a JPEG photo as a data URL" }, 400, origin);
    }
    const aspect = ASPECTS.includes(body.aspect) ? body.aspect : null;
    const jpeg = image.slice(image.indexOf(",") + 1);

    const t0 = Date.now();
    if (rateLimited((body.mode === "paint" ? "p:" : "f:") + ip, body.mode === "paint" ? PAINT_LIMIT : FIND_LIMIT, body.mode === "paint" ? DAY : HOUR)) {
      return reply({ error: "You've reached today's limit, please try again later" }, 429, origin);
    }
    if (body.mode === "paint") {
      const c = body.color || {};
      if (!/^\d{4}$/.test(c.num || "") || !/^[0-9A-Fa-f]{6}$/.test(c.hex || "") || typeof c.name !== "string" || c.name.length > 60) {
        return reply({ error: "Send a Sherwin-Williams colour" }, 400, origin);
      }
      const painted = await render(env, jpeg, aspect, paintPrompt({ num: c.num, name: c.name.replace(/[^\w\s'-]/g, ""), hex: c.hex }), "2K"); // 2K: sharp enough for a full-screen phone view
      if (painted.error) return reply({ error: painted.error }, 502, origin);
      return reply({ image: painted.image, model: MODEL, seconds: Math.round((Date.now() - t0) / 100) / 10 }, 200, origin);
    }
    // Both renders at once: magenta says where the cabinets are, grey says how the paint should look
    const [found, coat] = await Promise.all([render(env, jpeg, aspect, PROMPT), render(env, jpeg, aspect, GREY_PROMPT)]);
    if (found.error) return reply({ error: found.error }, 502, origin);
    return reply({
      image: found.image,
      grey: coat.image || null, // the page falls back to its own shading if this one failed
      model: MODEL,
      seconds: Math.round((Date.now() - t0) / 100) / 10,
    }, 200, origin);
  },
};
