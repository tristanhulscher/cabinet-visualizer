// Cabinet Colour Visualizer: AI cabinet detection (Cloudflare Worker)
//
// The visualizer page POSTs {image: "data:image/jpeg;base64,..."} here. This Worker adds the
// secret Gemini API key, asks Gemini where the cabinets are, and returns
// {items: [{box_2d, mask, label}], seconds}. The key never reaches the browser.
//
// Setup (Cloudflare dashboard): Workers & Pages -> Create -> Worker -> paste this file -> Deploy.
// Then Settings -> Variables and Secrets -> add a Secret named GEMINI_API_KEY.

const MODEL = "gemini-4-argon"; // gemini-3.8-flash only returns boxes, not outlines
const ALLOWED_ORIGINS = [
  "https://tristanhulscher.github.io",
  "http://localhost:8766",
  "http://localhost:8767",
];
const MAX_IMAGE_CHARS = 3_000_000;      // ~2.2 MB JPEG; the page sends ~1024px photos (~200 KB)
const PER_IP_LIMIT = 15;                // detections per IP per window (best effort, per Worker instance)
const WINDOW_MS = 60 * 60 * 1000;

const PROMPT = `You are segmenting a kitchen or bathroom photo for a cabinet-painting preview.
A customer will see ONLY the cabinetry recoloured, so precision matters more than coverage.

Return as FEW entries as possible: one "cabinet" entry per continuous run of cabinetry
(for example: the upper run, the lower run, the island, a tall pantry). Trace each run's
outer edge tightly. A run includes its doors, drawer fronts, boxes, end panels, face frames,
fillers, toe kicks and attached crown moulding.

Also return one "glass" entry per glass pane in a cabinet door (these are cut out).
Also return one "hardware" entry per handle, knob or pull: a tight "box_2d" and an EMPTY
"mask" [] (no outline needed).

NEVER include in a cabinet outline, even when the same colour as the cabinets:
walls, ceiling, room trim, window and door casings, room doors, countertops and their edges,
backsplash and tile, open shelves, appliances of any kind (fridge, dishwasher, oven,
microwave, hood), sinks, faucets, lights, windows, floor, furniture, or objects in front.
Where the backsplash, an appliance or a window sits between cabinets, the outline must go
around it, not across it.

Output JSON with "box_2d", "mask" (polygon of [x, y] points, 0-1000) and "label".`;

// Without a schema that requires "mask", the model answers with boxes only
const SCHEMA = {
  type: "object",
  properties: {
    boxes: {
      type: "array",
      items: {
        type: "object",
        properties: {
          box_2d: { type: "array", items: { type: "integer" } },
          mask: { type: "array", items: { type: "array", items: { type: "integer" } } },
          label: { type: "string", enum: ["cabinet", "glass", "hardware"] },
        },
        required: ["box_2d", "mask", "label"],
      },
    },
  },
  required: ["boxes"],
};

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

// The answer text sits in the last "model_output" step
function outputText(interaction) {
  const steps = interaction.steps || [];
  for (let i = steps.length - 1; i >= 0; i--) {
    const s = steps[i];
    if (s.type === "model_output" && Array.isArray(s.content)) {
      return s.content.filter(c => c.type === "text").map(c => c.text).join("");
    }
  }
  return "";
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

    let image;
    try { image = (await request.json()).image; } catch { image = null; }
    if (typeof image !== "string" || !image.startsWith("data:image/jpeg;base64,") || image.length > MAX_IMAGE_CHARS) {
      return reply({ error: "Send a JPEG photo as a data URL" }, 400, origin);
    }

    const t0 = Date.now();
    const res = await fetch("https://generativelanguage.googleapis.com/v1beta/interactions", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": env.GEMINI_API_KEY },
      body: JSON.stringify({
        model: MODEL,
        input: [
          { type: "text", text: PROMPT },
          { type: "image", data: image.slice(image.indexOf(",") + 1), mime_type: "image/jpeg" },
        ],
        response_format: { type: "text", mime_type: "application/json", schema: SCHEMA },
        generation_config: { thinking_level: "low" },
      }),
    });
    if (!res.ok) {
      const detail = (await res.text()).slice(0, 300);
      console.log("Gemini error", res.status, detail);
      return reply({ error: `Detection service error (${res.status})` }, 502, origin);
    }
    let items = [];
    try {
      const parsed = JSON.parse(outputText(await res.json()).replace(/^\s*```(?:json)?|```\s*$/g, ""));
      items = Array.isArray(parsed) ? parsed : parsed.boxes || [];
    } catch (e) {
      console.log("Could not read Gemini answer", String(e));
      return reply({ error: "Could not read the detection result" }, 502, origin);
    }
    return reply({ items, model: MODEL, seconds: Math.round((Date.now() - t0) / 100) / 10 }, 200, origin);
  },
};
