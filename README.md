# Cabinet Colour Visualizer

Customers upload a photo of their kitchen, tap their cabinets, and see them in any Sherwin-Williams colour. Then they can ask for a quote in that colour with one tap.

- **20 popular cabinet colours** are shown first. On phones they sit right under the photo, so customers can try a colour with one tap.
- **All 1,526 Sherwin-Williams colours** can be found by name or number (for example "Naval" or "6244").
- **Tap to select.** Tapping a cabinet door selects the whole door. The **Brush** and **Erase** tools fix anything the tap missed or caught by mistake. **Undo** is available.
- **Realistic result.** The room's light and shadows stay, handles and countertops don't change, and most of the wood grain is hidden like real paint would.
- **Before / After** slider, **Download my photo** (labelled with the colour name and your brand), and **Get a free quote in this colour**.
- **Private and free to run.** Everything happens in the customer's browser. Photos are never uploaded unless the customer sends a quote request. There are no AI fees or API keys.

## Files

| File | What it is |
|---|---|
| `index.html` | The tool. Settings are at the top of the script, under "Settings: edit these" |
| `colors.js` | The Sherwin-Williams colour list and the top 10 |

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

- **Best photos:** taken straight on, in good light. Cabinets that are a different colour from the walls select in one tap. If a tap spills onto the wall, press **Undo**, lower **Spread**, and tap again.
- **Colours are approximate.** Screens vary, and the footer tells customers to check a real paint chip.
- **Trademark wording.** The footer notes that Sherwin-Williams names and numbers are their trademarks. Keep that line.
- **Lead tracking.** If the page has Google Analytics, a `generate_lead` event fires when a quote is sent. The host page also receives a `cabinet-visualizer:lead` message, if you want to hook up other tracking.
