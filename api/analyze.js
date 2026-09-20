// Serverless function (Vercel-style: /api/analyze.js -> POST /api/analyze)
//
// This is the ONLY place your Gemini API key lives. Never put the key
// directly in app.js or any file the browser downloads.
//
// Set GEMINI_API_KEY in your Vercel project's Environment Variables.

// Model names get renamed/retired over time — if this 404s again, check
// https://ai.google.dev/gemini-api/docs/models for the current free list.
const MODEL = 'gemini-3.6-flash';
const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`;

const ANALYSIS_PROMPT = `You are a nutrition estimation assistant analyzing a food photo for a calorie-tracking app.

The photo may show a single dish, or a full plate/thali/combo meal made up of several separate dishes (for example: rice, dal, a vegetable sabzi, roti, curd, pickle, a dessert). Identify EACH distinct dish separately rather than giving one combined total for the whole plate — list every dish you can visually distinguish, each with its own realistic portion size and its own nutrition estimate. Include dietary fiber for every dish, not just carbs/protein/fat.`;

// Gemini returns JSON matching this schema exactly, so the app doesn't
// have to guess how to parse free-text.
const RESPONSE_SCHEMA = {
  type: 'OBJECT',
  properties: {
    items: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          name: { type: 'STRING' },
          portionEstimate: { type: 'STRING' },
          calories: { type: 'NUMBER' },
          protein_g: { type: 'NUMBER' },
          carbs_g: { type: 'NUMBER' },
          fat_g: { type: 'NUMBER' },
          fiber_g: { type: 'NUMBER' },
          confidence: { type: 'STRING', enum: ['low', 'medium', 'high'] }
        },
        required: ['name', 'calories', 'protein_g', 'carbs_g', 'fat_g', 'fiber_g', 'confidence']
      }
    }
  },
  required: ['items']
};

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') { res.status(200).end(); return; }
  if (req.method !== 'POST') { res.status(405).json({ error: 'Method not allowed' }); return; }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    res.status(500).json({ error: 'Server is missing GEMINI_API_KEY. Set it in your hosting provider\'s environment variables.' });
    return;
  }

  const { imageBase64, mediaType } = req.body || {};
  if (!imageBase64) { res.status(400).json({ error: 'No image provided' }); return; }

  try {
    const geminiRes = await fetch(`${GEMINI_URL}?key=${encodeURIComponent(apiKey)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{
          parts: [
            { inline_data: { mime_type: mediaType || 'image/jpeg', data: imageBase64 } },
            { text: ANALYSIS_PROMPT }
          ]
        }],
        generationConfig: {
          responseMimeType: 'application/json',
          responseSchema: RESPONSE_SCHEMA,
          temperature: 0.2
        }
      })
    });

    if (!geminiRes.ok) {
      const errText = await geminiRes.text();
      console.error('Gemini API error:', geminiRes.status, errText);
      res.status(502).json({ error: 'AI analysis service error (' + geminiRes.status + ')' });
      return;
    }

    const data = await geminiRes.json();
    const candidate = (data.candidates || [])[0];
    const part = candidate && candidate.content && candidate.content.parts && candidate.content.parts[0];
    const text = part && part.text;

    if (!text) {
      const reason = candidate && candidate.finishReason;
      console.error('Gemini returned no text. finishReason:', reason, JSON.stringify(data));
      res.status(502).json({ error: reason === 'SAFETY' ? 'The photo was blocked by content safety filters' : 'AI returned no analysis' });
      return;
    }

    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch (e) {
      const match = text.match(/\{[\s\S]*\}/);
      if (match) parsed = JSON.parse(match[0]);
      else throw e;
    }

    // Always hand back { items: [...] } to the front end, even if the
    // model (or an older cached prompt) ever returns a single flat object.
    if (!Array.isArray(parsed.items)) {
      parsed = { items: [parsed] };
    }

    res.status(200).json(parsed);
  } catch (err) {
    console.error('analyze.js error:', err);
    res.status(500).json({ error: 'Unexpected server error analyzing the photo' });
  }
};
