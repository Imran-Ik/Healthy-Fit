// Serverless function (Vercel-style: /api/estimate.js -> POST /api/estimate)
//
// Batch text-based nutrition lookup: takes the WHOLE current dish list
// (after the user has edited quantities and/or added missed dishes) and
// re-estimates all of them in a single AI call, instead of one call per
// dish. Cheaper, faster, and avoids the list re-rendering mid-edit.
//
// Same key/model notes as api/analyze.js.
const MODEL = 'gemini-3.6-flash';
const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`;

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

  const freeText = req.body && req.body.freeText;
  const items = (req.body && req.body.items) || [];

  let listText, introLine;
  if (freeText && freeText.trim()) {
    // A single raw description of a whole meal, e.g.
    // "Boiled egg 1, Rice 250g, chicken 50g" — split by the AI itself
    // into separate dishes rather than requiring the user to pre-structure it.
    listText = freeText.trim();
    introLine = `The user typed this description of everything they ate, which may list several separate dishes separated by commas, "and", or line breaks, each possibly with its own quantity: "${listText}"
Split this into individual dishes and estimate calories and macronutrients (including dietary fiber) for EACH one separately, using whatever quantity was given for that dish (assume one typical serving for any dish with no quantity stated).`;
  } else {
    if (!Array.isArray(items) || items.length === 0) {
      res.status(400).json({ error: 'No dishes provided' });
      return;
    }
    listText = items.map((it, i) => {
      const qty = it.quantity || it.portionEstimate;
      return (i + 1) + '. ' + (it.name || 'unnamed dish') + (qty ? ' — ' + qty : ' (no quantity given, assume one typical serving)');
    }).join('\n');
    introLine = `Below is a list of dishes with their quantities. Estimate calories and macronutrients (including dietary fiber) for EACH dish individually, using exactly the quantity given for that dish.

${listText}`;
  }

  const prompt = `You are a nutrition estimation assistant for a calorie-tracking app.
${introLine}

Return exactly one item in the "items" array per dish listed above, in the same order, even if a quantity looks unusual — use your best realistic estimate rather than refusing.`;

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
      res.status(502).json({ error: 'AI recalculation service error (' + geminiRes.status + ')' });
      return;
    }

    const data = await geminiRes.json();
    const candidate = (data.candidates || [])[0];
    const part = candidate && candidate.content && candidate.content.parts && candidate.content.parts[0];
    const text = part && part.text;

    if (!text) {
      const reason = candidate && candidate.finishReason;
      res.status(502).json({ error: reason === 'SAFETY' ? 'That list was blocked by content safety filters' : 'AI returned no estimate' });
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

    if (!Array.isArray(parsed.items)) parsed = { items: [parsed] };
    res.status(200).json(parsed);
  } catch (err) {
    console.error('estimate.js error:', err);
    res.status(500).json({ error: 'Unexpected server error recalculating those dishes' });
  }
};
