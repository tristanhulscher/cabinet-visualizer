# Cabinet Colour Visualizer

Customers upload a photo of their kitchen and AI finds and paints their cabinets automatically, in any Sherwin-Williams colour. Then they can ask for a quote in that colour with one tap.

- **20 popular cabinet colours** are shown first. On phones they sit right under the photo, so customers can try a colour with one tap.
- **All 1,526 Sherwin-Williams colours** can be found by name or number (for example "Naval" or "6244").
- **No tapping.** Google's Gemini AI finds the cabinets (10–55 seconds per photo) and only those get painted: countertops, backsplash, walls, floors and appliances stay as they are, glass panes are cut out and handles keep their metal look. An **Adjust** button opens tap, brush and erase tools for the rare photo the AI gets wrong.
- **Final-coat look.** A solid, even colour that matches the chip. The room's lighting and the door profiles show through; the old wood grain doesn't.
- **Before / After** slider, **Download my photo** (labelled with the colour name and your brand), and **Get a free quote in this colour**.
- **Photos and cost.** A downscaled copy of each photo goes to Google's Gemini AI to find the cabinets; nothing is stored by us unless the customer sends a quote. The footer says this. Each photo costs a few cents or less in prepaid Gemini credit.

## Files

| File | What it is |
|---|---|
| `index.html` | The tool. Settings are at the top of the script, under "Settings: edit these" |
| `colors.js` | The Sherwin-Williams colour list and the 20 popular colours |
| `worker/cabinet-detect-worker.js` | The AI service. A copy runs on Cloudflare (see below); this file is the source |

Both files must be hosted together, in the same folder.

## 1. Where it lives

**Live link: https://tristanhulscher.github.io/cabinet-visualizer/**

It's hosted free on GitHub Pages from this repo. Any change pushed to `main` goes live within about a minute, and the link stays the same. If you later move the tool to your own website, only the `src` in the embed code changes.

## 2. Put it on the landing page

Paste this into a "Custom HTML" / "Code" / "Embed" block. That works in HighLevel funnels, WordPress, Wix and Squarespace:

```html
<iframe id="cabinet-visualizer" src="https://tristanhulscher.github.io/cabinet-visualizer/"
        style="width:100%;height:1100px;border:0" allow="camera" title="Cabinet colour visualizer"></iframe>
<script>
  // Grows the frame to fit the tool, so there's no inner scrollbar
  addEventListener("message", e => {
    if (e.data && e.data.type === "cabinet-visualizer:height")
      document.getElementById("cabinet-visualizer").style.height = e.data.height + "px";
  });
</script>
```

## 3. Choose where quote requests go

Open `index.html` and edit the `CONFIG` block near the top of the script:

```js
brand: "Envision Painting",     // footer + label on downloaded photos
accent: "#1f4e5f",              // button colour
quoteWebhook: "",               // HighLevel / Zapier inbound webhook URL
quoteUrl: "",                   // OR your existing quote page
```

- **HighLevel (recommended):** create a workflow with the **Inbound Webhook** trigger, paste its URL into `quoteWebhook`, then map the fields to a contact. The fields are `name`, `phone`, `email`, `city`, `notes`, `color` (like "SW 6244 Naval"), `color_hex`, `source`, `page`, and `photo` (the preview image, if the customer left that box ticked).
- **Existing quote page:** put its link in `quoteUrl`. The button sends customers there with `?color=SW 6244 Naval` added to the link.
- **Neither set:** the form still says "Thanks", but the lead **isn't sent anywhere**. Set one before going live.

**Shortcut:** `brand`, `accent`, `defaultColor` and `quoteUrl` can also be set in the embed link instead of the file, for example `index.html?brand=Acme%20Painting&accent=%23224466`.

## AI cabinet detection

- **How it works:** customers upload up to 3 photos (angles). For each photo the Worker asks Google's image model (`gemini-3.1-flash-image`) for two pictures: one with the cabinets in magenta (where they are) and one in an even grey coat (their light and shadow). For each colour the customer settles on, it also asks for the kitchen painted in that real Sherwin-Williams colour at 2K; the page keeps only the cabinets from it, corrects them to the exact chip, and keeps the original knobs and pulls. The first colour is requested at the same time as the cabinet search, so the first photo-real result shows in about 20 seconds.
- **Where it runs:** a Cloudflare Worker named `cabinet-detect` on Tristan's Cloudflare account (tristanhulscher@gmail.com, not the Paint Bid Ninja account), at `https://cabinet-detect.tristanhulscher.workers.dev/`. `detectUrl` in `index.html` points at it.
- **The key:** the Gemini API key is stored only as a Cloudflare secret named `GEMINI_API_KEY` (Worker → Settings → Variables and Secrets). It is never in this repo or the page.
- **Billing:** the key belongs to the "My First Project" project in Google AI Studio, on prepaid credit with a monthly spend cap (ai.studio/spend). About 5¢ per photo to find the cabinets and 7¢ per colour per photo. When the credit or cap runs out, customers see "Our visualizer is busy right now".
- **Cost limits:** 5 photo-real colours per customer per day (each shown on all their angles; colours past that show an instant preview). The Worker also allows 10 photos per hour and 18 colour renders per day per visitor, and only answers this site (plus localhost for testing).
- **Bot check:** Cloudflare Turnstile widget "Cabinet visualizer" (Turnstile in the Cloudflare dashboard; hostnames tristanhulscher.github.io and localhost). Its public site key is `turnstileSiteKey` in `index.html`. It only blocks bots once its **secret key** is added to the Worker as a secret named `TURNSTILE_SECRET` (Worker → Settings → Variables and Secrets → Add → type Secret). Without it the Worker lets every request through. Almost all visitors never see it; a suspicious one is asked to tick "Verify you are human" at the bottom of the page.
- **Changing it:** edit `worker/cabinet-detect-worker.js`, then paste it into the Worker's **Edit code** screen on Cloudflare and click **Deploy**.
- **Testing changes:** `cabinet-ai-test/regress.html` (open `http://localhost:8767/regress` with the test server running) runs the page on 12 saved kitchens without any AI cost and flags anything that changed from the saved baseline. Run it before every change goes live; `?save=baseline` records a new baseline once the results look right.

## Changing the popular colours

In `colors.js`, the first line after the comment lists the 20 popular colours by Sherwin-Williams number:

```js
window.SW_POPULAR=[["Popular cabinet colours",["7005","7006","7008", ...]]];
```

Replace, add or reorder the numbers, keeping the quotes. They show in that order. The current picks, in order:
- **Whites:** Pure White, Extra White, Alabaster, Snowbound, Greek Villa, Dover White, Shoji White
- **Greige:** Agreeable Gray, Repose Gray, Accessible Beige, Mindful Gray
- **Greens:** Sea Salt, Evergreen Fog, Pewter Green
- **Darks:** Naval, Iron Ore, Urbane Bronze, Tricorn Black, Peppercorn, Cyberspace

That list is a general starting point, not based on sales data. Swap in your best sellers. After changing `colors.js`, bump the number in `colors.js?v=3` in `index.html` so browsers fetch the new list.

## Good to know

- **Best photos:** taken straight on, in good light, with the cabinets filling most of the photo.
- **Colours are approximate.** Screens vary, and the footer tells customers to check a real paint chip.
- **Trademark wording.** The footer notes that Sherwin-Williams names and numbers are their trademarks. Keep that line.
- **Lead tracking.** If the page has Google Analytics, a `generate_lead` event fires when a quote is sent. The host page also receives a `cabinet-visualizer:lead` message, if you want to hook up other tracking.
