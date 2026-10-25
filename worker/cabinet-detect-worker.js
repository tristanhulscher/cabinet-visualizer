// Cabinet Colour Visualizer: AI cabinet detection (Cloudflare Worker)
//
// The visualizer page POSTs {image: "data:image/jpeg;base64,...", aspect: "4:3"} here. This Worker
// adds the secret Gemini API key and asks Google's image-editing model to repaint ONLY the cabinets
// in flat magenta, and (at the same time) in an even grey final coat. It returns
// {image, grey, seconds}: the page treats every magenta pixel as cabinet, takes light and shadow from
// the grey coat, and paints the real Sherwin-Williams colour there itself.
// {mode: "paint", color} asks for the cabinets in that real colour instead, and {mode: "parts"} (two-tone
// only) for the uppers, lowers and island in three marker colours, which the page uses to tell them apart.
// The key never reaches the browser.
//
// Bot check (Cloudflare Turnstile): when the TURNSTILE_SECRET secret is set, the page must first send
// {mode: "hello", turnstile: <token>}; it gets back a signed session that every other request carries.
// Without that secret nothing is checked, so the page keeps working while it's being set up.
//
// Setup (Cloudflare dashboard): Workers & Pages -> cabinet-detect -> Edit code -> paste this file -> Deploy.
// The key is a Secret named GEMINI_API_KEY (Settings -> Variables and Secrets); the Turnstile widget's
// secret key goes in a Secret named TURNSTILE_SECRET.

const MODEL = "gemini-3.1-flash-image"; // "Nano Banana 2": matched or beat Pro on test kitchens at a fraction of the cost
const ALLOWED_ORIGINS = [
  "https://tristanhulscher.github.io",
  "http://localhost:8766",
  "http://localhost:8767",
];
const ASPECTS = ["1:1", "2:3", "3:2", "3:4", "4:3", "4:5", "5:4", "9:16", "16:9", "21:9"];
const MAX_IMAGE_CHARS = 4_000_000;      // ~3 MB JPEG; the page sends ~2048px photos (~600 KB)
const FIND_LIMIT = 10;                  // photo uploads per visitor per hour
const PAINT_LIMIT = 18;                 // colour renders per visitor per day (page allows 5 colours x up to 3 angles, plus retries)
const PARTS_LIMIT = 10;                 // two-tone part finds per visitor per hour (one per photo, plus retries)
const HELLO_LIMIT = 30;                 // bot checks per visitor per hour
const SESSION_MS = 3 * 60 * 60 * 1000;  // a passed bot check is good for 3 hours
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

// Two-tone only (asked for once the customer turns it on): each cabinet in a marker colour for its part of
// the kitchen. The page only uses it to split the cabinets it already found into uppers, lowers and island
const PARTS_PROMPT = `Edit this photo for a two-tone cabinet-painting preview.
Repaint ONLY the cabinetry, each cabinet in one flat, solid, fully saturated marker colour by where it is:
- pure blue (#0000FF): upper cabinets. Wall cabinets above the countertop, cabinets above the fridge or
  range hood, and tall floor-to-ceiling cabinets (pantry, fridge or oven towers), with their crown moulding.
- pure green (#00FF00): lower cabinets along the walls, under the countertop. Their doors, drawer fronts,
  cabinet boxes, end panels, fillers and toe kicks.
- pure magenta (#FF00FF): island and peninsula cabinets. Every door, drawer front, panel and side of a
  freestanding island, or of a peninsula that sticks out into the room.
Cover each cabinet surface edge to edge.

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

// Sessions are "<expiry>.<id>.<signature>", signed with the Turnstile secret, so no storage is needed
const enc = new TextEncoder();
const b64url = buf => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
async function sign(env, text) {
  const key = await crypto.subtle.importKey("raw", enc.encode("session:" + env.TURNSTILE_SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return b64url(await crypto.subtle.sign("HMAC", key, enc.encode(text)));
}
async function newSession(env) {
  const body = `${Date.now() + SESSION_MS}.${crypto.randomUUID().slice(0, 8)}`;
  return `${body}.${await sign(env, body)}`;
}
async function sessionId(env, session) {
  const [exp, id, sig] = String(session || "").split(".");
  if (!exp || !id || !sig || +exp < Date.now()) return null;
  return sig === await sign(env, `${exp}.${id}`) ? id : null;
}
async function turnstileOK(env, token, ip) {
  if (typeof token !== "string" || !token || token.length > 4096) return false;
  const form = new FormData();
  form.append("secret", env.TURNSTILE_SECRET); form.append("response", token); form.append("remoteip", ip);
  const res = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", { method: "POST", body: form });
  const data = await res.json().catch(() => ({}));
  if (!data.success) console.log("Turnstile failed", JSON.stringify(data["error-codes"] || []));
  return !!data.success;
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

    // Bot check: swap a Turnstile token for a session (no AI involved, so no cost)
    if (body.mode === "hello") {
      if (!env.TURNSTILE_SECRET) return reply({ session: "open" }, 200, origin);
      if (rateLimited("h:" + ip, HELLO_LIMIT, HOUR)) return reply({ error: "Too many tries, please wait a bit" }, 429, origin);
      if (!(await turnstileOK(env, body.turnstile, ip))) return reply({ error: "Bot check failed", needCheck: true }, 403, origin);
      return reply({ session: await newSession(env) }, 200, origin);
    }
    let sid = "";
    if (env.TURNSTILE_SECRET) {
      sid = await sessionId(env, body.session);
      if (!sid) return reply({ error: "Please refresh the page", needCheck: true }, 401, origin);
    }

    const image = body.image;
    if (typeof image !== "string" || !image.startsWith("data:image/jpeg;base64,") || image.length > MAX_IMAGE_CHARS) {
      return reply({ error: "Send a JPEG photo as a data URL" }, 400, origin);
    }
    const aspect = ASPECTS.includes(body.aspect) ? body.aspect : null;
    const jpeg = image.slice(image.indexOf(",") + 1);

    const t0 = Date.now();
    // Limits per visitor (IP) and, with the bot check on, per session too
    const mode = body.mode === "paint" || body.mode === "parts" ? body.mode : "find";
    const [kind, limit, span] = { find: ["f:", FIND_LIMIT, HOUR], parts: ["g:", PARTS_LIMIT, HOUR], paint: ["p:", PAINT_LIMIT, DAY] }[mode];
    if (rateLimited(kind + ip, limit, span) || (sid && rateLimited(kind + "s:" + sid, limit, span))) {
      return reply({ error: "You've reached today's limit, please try again later" }, 429, origin);
    }
    if (mode === "parts") {
      const marked = await render(env, jpeg, aspect, PARTS_PROMPT);
      if (marked.error) return reply({ error: marked.error }, 502, origin);
      return reply({ image: marked.image, model: MODEL, seconds: Math.round((Date.now() - t0) / 100) / 10 }, 200, origin);
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
