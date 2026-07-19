// netlify/functions/chat.js
//
// Serverless endpoint: POST /api/chat
// Body: { message: string, history: [{role, content}], image?: { mimeType, data(base64) } }
// Returns: { reply: string }
//
// Requires environment variables set in Netlify dashboard (Site settings -> Environment variables):
//   GROQ_API_KEY          -> your Groq API key (used for both text and vision calls)
//   GROQ_CHAT_MODEL        -> optional, defaults to "llama-3.3-70b-versatile"
//   GROQ_VISION_MODEL      -> optional, defaults to "meta-llama/llama-4-scout-17b-16e-instruct"

const axios = require('axios');

const CHAT_MODEL = process.env.GROQ_CHAT_MODEL || 'llama-3.3-70b-versatile';
const VISION_MODEL = process.env.GROQ_VISION_MODEL || 'meta-llama/llama-4-scout-17b-16e-instruct';

const SYSTEM_PROMPT = `Kamu adalah Bombon AI, asisten AI yang ramah dan membantu, dibuat oleh Bombon.
Aturan penting yang harus selalu kamu ikuti:
- Kalau pengguna menyapa singkat (halo, hai, hi, hello, dsb) tanpa pertanyaan lain, balas persis dengan gaya: "Halo! Bombon AI di sini, ada yang bisa saya bantu?"
- Kalau pengguna bertanya siapa yang membuatmu / kamu buatan siapa, jawab bahwa kamu dibuat oleh Bombon.
- Kamu bisa membuat kode program (Python, Java, HTML, JavaScript, dll). Selalu bungkus kode dalam blok markdown tiga backtick dengan nama bahasanya, contoh: \`\`\`python ... \`\`\`.
- Jawab dalam Bahasa Indonesia yang santai dan jelas, kecuali diminta bahasa lain.
- Jangan mengarang fakta; kalau tidak tahu, katakan terus terang.`;

function isGreeting(text) {
  return /^(halo|hai|hi|hello|hey|hallo)[\s!.]*$/i.test(text.trim());
}

function isCreatorQuestion(text) {
  return /(buatan siapa|siapa (yang )?buat|siapa pembuat|siapa pencipta|kamu buatan)/i.test(text);
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  let body;
  try {
    body = JSON.parse(event.body || '{}');
  } catch (e) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON' }) };
  }

  const { message = '', history = [], image } = body;
  const apiKey = process.env.GROQ_API_KEY;

  if (!apiKey) {
    return {
      statusCode: 500,
      body: JSON.stringify({ error: 'GROQ_API_KEY belum diatur di environment variables Netlify.' }),
    };
  }

  // Fast-path canned answers (guarantee exact wording, no API call needed)
  if (!image && isGreeting(message)) {
    return { statusCode: 200, body: JSON.stringify({ reply: 'Halo! Bombon AI di sini, ada yang bisa saya bantu?' }) };
  }
  if (!image && isCreatorQuestion(message)) {
    return { statusCode: 200, body: JSON.stringify({ reply: 'Saya dibuat oleh Bombon 😊 Ada lagi yang bisa saya bantu?' }) };
  }

  try {
    let reply;

    if (image && image.data) {
      // ---- Vision request ----
      const content = [
        { type: 'text', text: message || 'Analisis gambar ini dan jelaskan isinya secara ringkas.' },
        { type: 'image_url', image_url: { url: `data:${image.mimeType};base64,${image.data}` } },
      ];

      const response = await axios.post(
        'https://api.groq.com/openai/v1/chat/completions',
        {
          model: VISION_MODEL,
          messages: [
            { role: 'system', content: 'Kamu adalah Bombon AI, dibuat oleh Bombon. Analisis gambar yang dikirim pengguna secara akurat dan ringkas, dalam Bahasa Indonesia.' },
            { role: 'user', content },
          ],
          max_tokens: 700,
        },
        { headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` }, timeout: 45000 }
      );

      reply = response.data?.choices?.[0]?.message?.content?.trim();
    } else {
      // ---- Normal text / code request ----
      const messages = [
        { role: 'system', content: SYSTEM_PROMPT },
        ...history.slice(-12), // keep last 12 turns for context
        { role: 'user', content: message },
      ];

      const response = await axios.post(
        'https://api.groq.com/openai/v1/chat/completions',
        {
          model: CHAT_MODEL,
          messages,
          temperature: 0.7,
          max_tokens: 1200,
        },
        { headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` }, timeout: 30000 }
      );

      reply = response.data?.choices?.[0]?.message?.content?.trim();
    }

    if (!reply) {
      return { statusCode: 502, body: JSON.stringify({ error: 'AI tidak memberikan respon yang valid.' }) };
    }

    return { statusCode: 200, body: JSON.stringify({ reply }) };
  } catch (err) {
    console.error('Groq error:', err.response?.status, err.response?.data || err.message);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: 'Gagal menghubungi AI. Coba lagi sebentar lagi.' }),
    };
  }
};
