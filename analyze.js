// Serverless function (Vercel-style: /api/analyze.js -> POST /api/analyze)
//
// This is the ONLY place your Gemini API key lives. Never put the key
// directly in app.js or any file the browser downloads — anyone could open
// devtools, copy it, and run up your usage. This function runs on Vercel's
// servers, reads the key from an environment variable, and is the only
// thing that talks to generativelanguage.googleapis.com.
//
// Set GEMINI_API_KEY in your Vercel project's Environment Variables
// (Project Settings -> Environment Variables). See README.md for the
// full walkthrough, including how to get a free key from Google AI Studio.

// Gemini's free tier (via an AI Studio key) currently covers the "flash"
// and "flash-lite" model family. Model names get renamed/retired over
// time — if this stops working, check the current free list at
// https://ai.google.dev/gemini-api/docs/models and swap the string below.
const MODEL = 'gemini-2.5-flash';
const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`;

const ANALYSIS_PROMPT = `You are a nutrition estimation assistant analyzing a food photo for a calorie-tracking app.
Identify the food or meal shown, estimate a realistic single-serving portion, and estimate its total calories and macronutrients for what's visible.`;

// Gemini can be told to return JSON that matches this exact shape, which
// avoids the "strip markdown fences and hope it parses" dance you'd
// otherwise need.
const RESPONSE_SCHEMA = {
  type: 'OBJECT',
  properties: {
    foodName: { type: 'STRING' },
    portionEstimate: { type: 'STRING' },
    calories: { type: 'NUMBER' },
    protein_g: { type: 'NUMBER' },
    carbs_g: { type: 'NUMBER' },
    fat_g: { type: 'NUMBER' },
    confidence: { type: 'STRING', enum: ['low', 'medium', 'high'] }
  },
  required: ['foodName', 'calories', 'protein_g', 'carbs_g', 'fat_g', 'confidence']
};

module.exports = async (req, res) => {
  // Basic CORS so this also works if you ever host the front end on a
  // different origin than the function. Tighten this to your real domain
  // once you're live.
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return;
  }
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    res.status(500).json({ error: 'Server is missing GEMINI_API_KEY. Set it in your hosting provider\'s environment variables.' });
    return;
  }

  const { imageBase64, mediaType } = req.body || {};
  if (!imageBase64) {
    res.status(400).json({ error: 'No image provided' });
    return;
  }

  try {
    const geminiRes = await fetch(GEMINI_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': apiKey
      },
      body: JSON.stringify({
        contents: [
          {
            parts: [
              { inline_data: { mime_type: mediaType || 'image/jpeg', data: imageBase64 } },
              { text: ANALYSIS_PROMPT }
            ]
          }
        ],
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
      // Common cause: the safety filters blocked the image/response.
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

    res.status(200).json(parsed);
  } catch (err) {
    console.error('analyze.js error:', err);
    res.status(500).json({ error: 'Unexpected server error analyzing the photo' });
  }
};
