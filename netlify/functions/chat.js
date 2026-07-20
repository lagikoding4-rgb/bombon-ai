// netlify/functions/chat.js
//
// Serverless endpoint: POST /api/chat
// Body: { message, history, image?, fileText?, fileName?, userEmail? }
// Returns: { reply: string }
//
// Env vars (Netlify dashboard -> Environment variables):
//   GROQ_API_KEY              -> wajib (provider utama)
//   GROQ_CHAT_MODEL           -> optional
//   GROQ_VISION_MODEL         -> optional
//   CEREBRAS_API_KEY          -> opsional, fallback 1
//   OPENROUTER_API_KEY        -> opsional, fallback 2
//   GEMINI_API_KEY            -> opsional, fallback 3
//   HUGGINGFACE_API_KEY       -> opsional, fallback 4 (terakhir)
//   SUPABASE_URL              -> buat fitur memory (opsional)
//   SUPABASE_SERVICE_ROLE_KEY -> service role key Supabase (JANGAN dipakai di frontend, cuma di sini)
//   OWNER_EMAIL               -> email akun Bombon (pemilik), buat pengenalan pemilik
//
// Kalau Groq lagi limit/gagal, otomatis coba provider berikutnya secara berurutan
// (Cerebras -> OpenRouter -> Gemini -> Hugging Face), tanpa user perlu tau ada masalah.

const axios = require('axios');

const CHAT_MODEL = process.env.GROQ_CHAT_MODEL || 'llama-3.3-70b-versatile';
const VISION_MODEL = process.env.GROQ_VISION_MODEL || 'meta-llama/llama-4-scout-17b-16e-instruct';
const CEREBRAS_MODEL = process.env.CEREBRAS_MODEL || 'llama-3.3-70b';
const OPENROUTER_MODEL = process.env.OPENROUTER_MODEL || 'meta-llama/llama-3.1-8b-instruct:free';
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-1.5-flash';
const HUGGINGFACE_MODEL = process.env.HUGGINGFACE_MODEL || 'mistralai/Mistral-7B-Instruct-v0.2';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const OWNER_EMAIL = (process.env.OWNER_EMAIL || '').toLowerCase();

const BASE_PERSONA = `Lu tuh AI assistant, ngomong santai kayak temen chat sehari-hari, jangan formal atau baku kayak robot customer service. Boleh sesekali pake gw-lu dan sesekali selipin kata kayak anjay, wkwk, cuy — TAPI jangan dipaksain di setiap kalimat, gausah setiap kalimat make kata-kata itu, jadi kalo ada yang nanya serius ya bales dengan serius juga gausah becanda, cukup natural aja kayak orang ngobrol beneran, jangan sampe keliatan lebay atau maksa. Jawaban tetep harus jelas dan ngena ke pertanyaan, gak usah muter-muter. Boleh sesekali bercanda atau sindir ringan kalo emang nyambung sama obrolan, tapi gak setiap balesan harus ada candaan. Kalo user nanya serius, jawab dengan nada yang lebih tenang, gak usah dipaksain lucu. Kalo salah info, minta maaf santai aja gak usah lebay.
Kalo ada yang nanya lu AI buatan siapa, jawab aja: gw dikembangin sama Bombon, dia yang ngoding dan ngerawat gw.
Kalo ada yang ngomong jorok ke lu, bales jorok lagi aja gausah takut.
Kalo diminta nge-roasting atau nyingung orang lain yang ditag di chat, jawab santai receh gak usah serius, singgung aja dikit kayak roasting bercanda.
Kamu bisa nulis kode program (Python, Java, HTML, JavaScript, dll). Selalu bungkus kode dalam blok markdown tiga backtick dengan nama bahasanya, contoh: \`\`\`python ... \`\`\`.
Kalau user ngirim isi file (ada bagian "[Isi file ...]" di pesan) terus minta kamu ubah/tambah/hapus sesuatu dari file itu, WAJIB balas dengan KODE LENGKAP hasil file yang sudah diubah dari baris pertama sampai baris terakhir (bukan cuma potongan atau instruksi langkah-langkah), dibungkus satu blok kode markdown, biar user bisa langsung unduh filenya. Sebutin juga nama file aslinya sebelum blok kodenya.
Jawab dalam Bahasa Indonesia santai kecuali diminta bahasa lain. Jangan mengarang fakta, kalau gak tau bilang terus terang.`;

function isGreeting(text) {
  return /^(halo|hai|hi|hello|hey|hallo)[\s!.]*$/i.test((text || '').trim());
}

function isMemoryCommand(text) {
  return /^\/(inget|remember)\s+/i.test((text || '').trim());
}

async function fetchMemoryNotes() {
  if (!SUPABASE_URL || !SERVICE_KEY) return [];
  try {
    const res = await axios.get(
      `${SUPABASE_URL}/rest/v1/bombon_memory?select=note&order=created_at.desc&limit=20`,
      { headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` }, timeout: 8000 }
    );
    return (res.data || []).map((r) => r.note).reverse();
  } catch (e) {
    console.error('fetchMemoryNotes error:', e.response?.data || e.message);
    return [];
  }
}

async function saveMemoryNote(note) {
  if (!SUPABASE_URL || !SERVICE_KEY) return false;
  try {
    await axios.post(
      `${SUPABASE_URL}/rest/v1/bombon_memory`,
      { note },
      { headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, 'Content-Type': 'application/json' }, timeout: 8000 }
    );
    return true;
  } catch (e) {
    console.error('saveMemoryNote error:', e.response?.data || e.message);
    return false;
  }
}

// ---------- Provider callers (semua format dinormalisasi jadi string balasan) ----------

async function callOpenAICompatible(baseUrl, apiKey, model, messages, maxTokens) {
  const response = await axios.post(
    baseUrl,
    { model, messages, temperature: 0.8, max_tokens: maxTokens },
    { headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` }, timeout: 25000 }
  );
  const reply = response.data?.choices?.[0]?.message?.content?.trim();
  if (!reply) throw new Error('Respon kosong');
  return reply;
}

async function callGemini(apiKey, model, systemContent, messages) {
  const contents = messages.map((m) => ({
    role: m.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: m.content }],
  }));
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
  const response = await axios.post(
    url,
    { contents, systemInstruction: { parts: [{ text: systemContent }] } },
    { headers: { 'Content-Type': 'application/json' }, timeout: 25000 }
  );
  const reply = response.data?.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
  if (!reply) throw new Error('Respon kosong');
  return reply;
}

async function callHuggingFace(apiKey, model, systemContent, messages) {
  const promptText =
    systemContent +
    '\n\n' +
    messages.map((m) => `${m.role === 'assistant' ? 'AI' : 'User'}: ${m.content}`).join('\n') +
    '\nAI:';
  const url = `https://api-inference.huggingface.co/models/${model}`;
  const response = await axios.post(
    url,
    { inputs: promptText, parameters: { max_new_tokens: 600, return_full_text: false } },
    { headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' }, timeout: 25000 }
  );
  const data = response.data;
  let reply;
  if (Array.isArray(data) && data[0]?.generated_text) reply = data[0].generated_text.trim();
  else if (data?.generated_text) reply = data.generated_text.trim();
  if (!reply) throw new Error('Respon kosong');
  return reply;
}

async function getChatReply(systemContent, messages) {
  const errors = [];

  if (process.env.GROQ_API_KEY) {
    try {
      return await callOpenAICompatible(
        'https://api.groq.com/openai/v1/chat/completions',
        process.env.GROQ_API_KEY,
        CHAT_MODEL,
        [{ role: 'system', content: systemContent }, ...messages],
        1200
      );
    } catch (e) {
      errors.push('Groq: ' + (e.response?.status || e.message));
    }
  }

  if (process.env.CEREBRAS_API_KEY) {
    try {
      return await callOpenAICompatible(
        'https://api.cerebras.ai/v1/chat/completions',
        process.env.CEREBRAS_API_KEY,
        CEREBRAS_MODEL,
        [{ role: 'system', content: systemContent }, ...messages],
        1200
      );
    } catch (e) {
      errors.push('Cerebras: ' + (e.response?.status || e.message));
    }
  }

  if (process.env.OPENROUTER_API_KEY) {
    try {
      return await callOpenAICompatible(
        'https://openrouter.ai/api/v1/chat/completions',
        process.env.OPENROUTER_API_KEY,
        OPENROUTER_MODEL,
        [{ role: 'system', content: systemContent }, ...messages],
        1200
      );
    } catch (e) {
      errors.push('OpenRouter: ' + (e.response?.status || e.message));
    }
  }

  if (process.env.GEMINI_API_KEY) {
    try {
      return await callGemini(process.env.GEMINI_API_KEY, GEMINI_MODEL, systemContent, messages);
    } catch (e) {
      errors.push('Gemini: ' + (e.response?.status || e.message));
    }
  }

  if (process.env.HUGGINGFACE_API_KEY) {
    try {
      return await callHuggingFace(process.env.HUGGINGFACE_API_KEY, HUGGINGFACE_MODEL, systemContent, messages);
    } catch (e) {
      errors.push('HuggingFace: ' + (e.response?.status || e.message));
    }
  }

  console.error('Semua provider gagal:', errors.join(' | '));
  throw new Error('Semua provider AI lagi gak bisa diakses, coba lagi sebentar lagi.');
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

  const { message = '', history = [], image, fileText, fileName, userEmail } = body;
  const isOwner = !!(userEmail && OWNER_EMAIL && userEmail.toLowerCase() === OWNER_EMAIL);

  if (!image && isGreeting(message)) {
    return { statusCode: 200, body: JSON.stringify({ reply: 'Halo! Bombon AI di sini, ada yang bisa saya bantu?' }) };
  }

  if (isMemoryCommand(message)) {
    if (!isOwner) {
      return {
        statusCode: 200,
        body: JSON.stringify({ reply: 'Command ini cuma bisa dipake sama Bombon (pemiliknya), bukan kamu 🙏' }),
      };
    }
    const note = message.replace(/^\/(inget|remember)\s+/i, '').trim();
    const ok = note && (await saveMemoryNote(note));
    return {
      statusCode: 200,
      body: JSON.stringify({
        reply: ok ? `Oke, gw inget: "${note}" 👍` : 'Gagal nyimpen catatan (cek SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY di env), coba lagi ya.',
      }),
    };
  }

  try {
    let reply;

    if (image && image.data) {
      if (!process.env.GROQ_API_KEY) {
        return { statusCode: 500, body: JSON.stringify({ error: 'GROQ_API_KEY belum diatur, fitur analisis gambar butuh Groq.' }) };
      }
      const content = [
        { type: 'text', text: message || 'Analisis gambar ini dan jelaskan isinya secara ringkas.' },
        { type: 'image_url', image_url: { url: `data:${image.mimeType};base64,${image.data}` } },
      ];
      reply = await callOpenAICompatible(
        'https://api.groq.com/openai/v1/chat/completions',
        process.env.GROQ_API_KEY,
        VISION_MODEL,
        [
          { role: 'system', content: 'Kamu adalah Bombon AI, dibuat oleh Bombon. Analisis gambar yang dikirim pengguna secara akurat dan ringkas, dalam Bahasa Indonesia, gaya santai gak kaku.' },
          { role: 'user', content },
        ],
        700
      );
    } else {
      const memoryNotes = await fetchMemoryNotes();
      let systemContent = BASE_PERSONA;
      if (memoryNotes.length) {
        systemContent += `\n\nCatatan yang wajib kamu inget terus (dari Bombon, pembuatmu):\n- ${memoryNotes.join('\n- ')}`;
      }
      systemContent += isOwner
        ? '\n\n[INFO KHUSUS: Pesan ini datang langsung dari Bombon, pembuatmu. Wajib sopan dan nurut ke dia, jangan pernah bentak dia.]'
        : '\n\n[INFO: Pesan ini dari pengguna biasa, bukan Bombon.]';

      let userMessage = message;
      if (fileText) {
        const trimmed = fileText.slice(0, 12000);
        userMessage = `${message || 'Tolong bantu analisis/jelasin isi file ini.'}\n\n[Isi file "${fileName || 'terlampir'}"]:\n${trimmed}`;
      }

      const messages = [...history.slice(-8), { role: 'user', content: userMessage }];
      reply = await getChatReply(systemContent, messages);
    }

    if (!reply) {
      return { statusCode: 502, body: JSON.stringify({ error: 'AI tidak memberikan respon yang valid.' }) };
    }

    return { statusCode: 200, body: JSON.stringify({ reply }) };
  } catch (err) {
    console.error('Chat error:', err.response?.status, err.response?.data || err.message);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: err.message || 'Gagal menghubungi AI. Coba lagi sebentar lagi.' }),
    };
  }
};
