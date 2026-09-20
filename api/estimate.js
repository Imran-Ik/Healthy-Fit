// Serverless function (Vercel-style: /api/estimate.js -> POST /api/estimate)
//
// Text-only nutrition lookup, used for two things in the app:
//  1. Re-estimating a single dish after the user corrects its quantity
//     (e.g. "Rice, 150g" instead of the photo's guessed "1 cup").
//  2. Adding a dish the photo missed, from a plain description like
//     "1 large boiled egg".
//
// Same key, same model family as api/analyze.js — see that file's
// comments for the free-tier/model-name notes, they apply here too.
const MODEL = 'gemini-3.6-flash';
const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`;

const RESPONSE_SCHEMA = {
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

  const { name, quantity, description } = req.body || {};
  // Either pass {description: "1 large boiled egg"} for a brand new dish,
  // or {name, quantity} to re-estimate an existing one with a corrected amount.
  const query = description || [name, quantity].filter(Boolean).join(', ');
  if (!query || !query.trim()) { res.status(400).json({ error: 'No food description provided' }); return; }

  const prompt = `You are a nutrition estimation assistant for a calorie-tracking app.
Estimate the calories and macronutrients (including dietary fiber) for exactly this food and quantity: "${query}"
If no quantity/serving size is given, assume one typical single serving and state that assumption in portionEstimate.
Return your best realistic numeric estimate even if the description is informal or approximate.`;

  try {
    const geminiRes = await fetch(`${GEMINI_URL}?key=${encodeURIComponent(apiKey)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
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
      res.status(502).json({ error: 'AI estimate service error (' + geminiRes.status + ')' });
      return;
    }

    const data = await geminiRes.json();
    const candidate = (data.candidates || [])[0];
    const part = candidate && candidate.content && candidate.content.parts && candidate.content.parts[0];
    const text = part && part.text;

    if (!text) {
      const reason = candidate && candidate.finishReason;
      res.status(502).json({ error: reason === 'SAFETY' ? 'That description was blocked by content safety filters' : 'AI returned no estimate' });
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

    res.status(200).json(parsed);
  } catch (err) {
    console.error('estimate.js error:', err);
    res.status(500).json({ error: 'Unexpected server error estimating that dish' });
  }
};
