const express = require("express");
const path = require("path");
const app = express();
app.use(express.json({ limit: "8mb" }));
app.use(express.static(path.join(__dirname, "public")));

const KEY = process.env.GEMINI_API_KEY;
const MODEL = process.env.MODEL || "gemini-3.5-flash";
const PROMPT = `You are an expert entomologist. Identify the insect/arthropod in the attached photo.
Return ONLY JSON (no markdown) with this exact shape:
{"is_arthropod":bool,"image_quality":"good|fair|poor","quality_note":"string",
"common_name":"string","scientific_name":"string","confidence":0-1,
"alternatives":[{"name":"string","confidence":0-1}] (up to 2 other plausible species, include look-alikes),
"characteristics":"2 sentences","habitat":"1-2 sentences","behaviour":"1-2 sentences",
"harm":"1-2 sentences on danger to humans (sting, bite, venom, disease, allergen, or harmless)",
"hazard":0-3 (0 harmless,1 minor irritant,2 medically significant e.g. painful sting/allergen/disease vector,3 potentially dangerous e.g. black widow, recluse, scorpion, hornet),
"hazard_reason":"short string",
"first_aid":["3-5 short practical steps if bitten/stung"],
"prevention":["2-3 short tips"]}
If no insect or arthropod is visible, set is_arthropod false and confidence 0. Be honest about uncertainty.`;

// Simple per-IP rate limit: 15 requests per 10 minutes
const hits = new Map();
function limited(ip) {
  const now = Date.now(), win = 10 * 60 * 1000;
  const arr = (hits.get(ip) || []).filter(t => now - t < win);
  arr.push(now); hits.set(ip, arr);
  return arr.length > 15;
}

app.post("/api/identify", async (req, res) => {
  if (!KEY) return res.status(500).json({ error: "Server is not configured." });
  if (limited(req.ip)) return res.status(429).json({ error: "Too many requests. Try again later." });
  const { image, bitten, region } = req.body || {};
  if (!image || typeof image !== "string") return res.status(400).json({ error: "No image provided." });
  const ctx = bitten ? `\nContext: person was bitten/stung. Region: ${String(region || "unknown").slice(0, 80)}.` : "";
  try {
    const body = JSON.stringify({
      contents: [{ parts: [
        { inline_data: { mime_type: "image/jpeg", data: image } },
        { text: PROMPT + ctx }
      ]}],
      generationConfig: { responseMimeType: "application/json" }
    });
    // Try the main model, then fallbacks, retrying when Google is busy (503/429)
    const models = [...new Set([MODEL, "gemini-3.6-flash", "gemini-2.5-flash"])];
    let data = null, last = 0;
    outer: for (const m of models) {
      for (let attempt = 0; attempt < 2; attempt++) {
        const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${m}:generateContent`, {
          method: "POST",
          headers: { "content-type": "application/json", "x-goog-api-key": KEY },
          body
        });
        const d = await r.json();
        if (r.ok) { data = d; break outer; }
        last = r.status;
        console.error("Gemini error:", m, r.status, JSON.stringify(d).slice(0, 300));
        if (r.status !== 503 && r.status !== 429 && r.status !== 404) break outer;
        if (r.status === 404) break;
        await new Promise(ok => setTimeout(ok, 1500));
      }
    }
    if (!data) return res.status(502).json({ error: last === 503 ? "The AI service is busy. Please try again in a minute." : "Analysis service error (" + last + ")." });
    const text = data.candidates[0].content.parts.map(p => p.text || "").join("").replace(/```json|```/g, "").trim();
    res.json(JSON.parse(text));
  } catch (e) {
    console.error("Server error:", e);
    res.status(500).json({ error: "Could not analyse the image. Please try again." });
  }
});

app.listen(process.env.PORT || 3000, () => console.log("Running"));
