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
const VISION_MODEL = process.env.GROQ_VISION_MODEL || 'qwen/qwen3.6-27b';
const VISION_MODEL_CANDIDATES = [
  VISION_MODEL,
  'meta-llama/llama-4-scout-17b-16e-instruct',
  'meta-llama/llama-4-maverick-17b-128e-instruct',
  'llama-3.2-90b-vision-preview',
];
const CEREBRAS_MODEL = process.env.CEREBRAS_MODEL || 'llama-3.3-70b';
const OPENROUTER_MODEL = process.env.OPENROUTER_MODEL || 'meta-llama/llama-3.1-8b-instruct:free';
const OPENROUTER_ONLINE_MODEL = process.env.OPENROUTER_ONLINE_MODEL || 'meta-llama/llama-3.1-8b-instruct';
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

async function callGeminiVision(apiKey, model, systemContent, message, image) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
  const response = await axios.post(
    url,
    {
      contents: [
        {
          role: 'user',
          parts: [
            { text: message || 'Analisis gambar ini dan jelaskan isinya secara ringkas.' },
            { inline_data: { mime_type: image.mimeType, data: image.data } },
          ],
        },
      ],
      systemInstruction: { parts: [{ text: systemContent }] },
    },
    { headers: { 'Content-Type': 'application/json' }, timeout: 25000 }
  );
  const reply = response.data?.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
  if (!reply) throw new Error('Respon kosong');
  return reply;
}

async function searchWebSerpApi(query) {
  const apiKey = process.env.SERPAPI_KEY;
  if (!apiKey) throw new Error('SERPAPI_KEY belum diatur.');
  const url = `https://serpapi.com/search.json?engine=google&q=${encodeURIComponent(query)}&api_key=${apiKey}`;
  const response = await axios.get(url, { timeout: 15000 });
  const data = response.data || {};
  const snippets = [];
  if (data.answer_box) {
    const ab = data.answer_box;
    const text = ab.answer || ab.snippet || ab.result || null;
    if (text) snippets.push(text);
  }
  if (data.knowledge_graph) {
    const kg = data.knowledge_graph;
    const parts = [];
    if (kg.title) parts.push(kg.title);
    if (kg.description) parts.push(kg.description);
    if (kg.type) parts.push(`Jabatan/Tipe: ${kg.type}`);
    if (parts.length) snippets.push(parts.join(' | '));
  }
  const organic = data.organic_results || [];
  for (const item of organic.slice(0, 5)) {
    if (item.snippet) snippets.push(`${item.title ? item.title + ': ' : ''}${item.snippet}`);
  }
  return snippets.join('\n');
}

async function callOpenRouterOnline(systemContent, userContent) {
  const model = `${OPENROUTER_ONLINE_MODEL}:online`;
  return callOpenAICompatible(
    'https://openrouter.ai/api/v1/chat/completions',
    process.env.OPENROUTER_API_KEY,
    model,
    [
      { role: 'system', content: systemContent },
      { role: 'user', content: userContent },
    ],
    900
  );
}

async function synthesizeVisionAnswerOnline(userQuestion, identification) {
  const systemPrompt = `Kamu asisten yang menjawab pertanyaan tentang gambar dengan AKURAT dan berdasarkan FAKTA TERKINI dari internet.
ATURAN:
- Fokus jawaban HARUS ke gambar yang baru dikirim, JANGAN mengaitkan atau mencampur dengan topik obrolan sebelumnya.
- Cari & pakai info terbaru dari web buat mastiin jawabanmu akurat (misal status/jabatan terkini suatu tokoh).
- Kalau gak nemu info relevan, jujur aja bilang gak nemu, jangan mengarang.
- Jawab singkat, jelas, langsung ke pertanyaan, gaya santai kayak chat biasa (gw-lu).`;
  const userPrompt = `Hasil identifikasi visual gambar yang baru dikirim user: "${identification}"\n\nPertanyaan user: "${userQuestion}"\n\nCari info terbaru soal ini di internet kalau perlu, terus jawab pertanyaan user.`;
  return callOpenRouterOnline(systemPrompt, userPrompt);
}

async function synthesizeVisionAnswer(userQuestion, identification, searchResults) {
  const systemPrompt = `Kamu asisten yang menjawab pertanyaan tentang gambar dengan AKURAT dan berdasarkan FAKTA TERKINI.
Kamu akan diberi: (1) hasil identifikasi visual dari gambar, (2) hasil pencarian web terbaru terkait.
ATURAN:
- Jawab HANYA berdasarkan data yang diberikan, jangan mengarang atau menebak.
- Fokus jawaban HARUS ke gambar yang baru dikirim, JANGAN mengaitkan atau mencampur dengan topik obrolan sebelumnya.
- Kalau data pencarian menyebutkan status/jabatan/fakta terkini yang berbeda dari asumsi umum, PRIORITASKAN data pencarian.
- Kalau data pencarian tidak cukup atau tidak relevan, katakan dengan jujur bahwa informasi tidak ditemukan, jangan mengarang.
- Jawab singkat, jelas, langsung ke pertanyaan user, gaya santai kayak chat biasa (gw-lu).`;
  const userPrompt = `Pertanyaan user: "${userQuestion}"\n\nHasil identifikasi visual gambar:\n${identification}\n\nHasil pencarian web terbaru:\n${searchResults || '(tidak ada hasil relevan)'}\n\nJawab pertanyaan user berdasarkan data di atas.`;
  return getChatReply(systemPrompt, [{ role: 'user', content: userPrompt }]);
}

async function generateImagePollinations(prompt) {
  const model = process.env.POLLINATIONS_MODEL || 'flux';
  const width = process.env.POLLINATIONS_WIDTH || 1024;
  const height = process.env.POLLINATIONS_HEIGHT || 1024;
  const seed = Math.floor(Math.random() * 1000000);
  const url = `https://image.pollinations.ai/prompt/${encodeURIComponent(prompt)}?model=${model}&width=${width}&height=${height}&seed=${seed}&nologo=true`;
  const response = await axios.get(url, { responseType: 'arraybuffer', timeout: 60000 });
  const base64 = Buffer.from(response.data).toString('base64');
  return { mimeType: 'image/jpeg', data: base64 };
}

async function searchImageSerpApi(query) {
  const apiKey = process.env.SERPAPI_KEY;
  if (!apiKey) throw new Error('SERPAPI_KEY belum diatur.');
  const url = `https://serpapi.com/search.json?engine=google_images&q=${encodeURIComponent(query)}&api_key=${apiKey}`;
  const response = await axios.get(url, { timeout: 15000 });
  const items = response.data?.images_results || [];
  return items.slice(0, 5).map((item) => item.original).filter(Boolean);
}

function isImageGenCommand(text) {
  const t = (text || '').trim();
  if (/^\/(gambar|image)\s+/i.test(t)) return true;
  const hasCreateVerb = /\b(buatkan|buatin|bikinkan|bikin|gambarkan|gambarin|generate|create|lukiskan)\b/i.test(t);
  const hasImageWord = /\b(gambar|image|foto|lukisan|ilustrasi|wallpaper)\b/i.test(t);
  return hasCreateVerb && hasImageWord;
}

function extractImageGenPrompt(text) {
  const t = text.trim();
  const slash = t.match(/^\/(gambar|image)\s+(.+)/i);
  if (slash) return slash[2].trim();
  return t
    .replace(/\b(tolong|coba|dong|ya)\b/gi, '')
    .replace(/\b(buatkan|buatin|bikinkan|bikin|gambarkan|gambarin|generate|create|lukiskan)\b/gi, '')
    .replace(/\b(gambar|image|foto|lukisan|ilustrasi|wallpaper)\b/gi, '')
    .replace(/\s+/g, ' ')
    .trim() || t;
}

function isImageSearchCommand(text) {
  const t = (text || '').trim();
  if (/^\/(cari|carigambar)\s+/i.test(t)) return true;
  const hasSearchVerb = /\b(cari|carikan|cariin|search|kirim|kirimkan|kirimin|kasih|kasihkan|tunjukin|tunjukkan|liatin|lihatkan|share)\b/i.test(t);
  const hasImageWord = /\b(gambar|image|foto|picture|pic)\b/i.test(t);
  return hasSearchVerb && hasImageWord;
}

function extractImageSearchQuery(text) {
  const t = text.trim();
  const slash = t.match(/^\/(cari|carigambar)\s+(.+)/i);
  if (slash) return slash[2].trim();
  return t
    .replace(/\b(tolong|coba|dong|ya)\b/gi, '')
    .replace(/\b(cari|carikan|cariin|search|kirim|kirimkan|kirimin|kasih|kasihkan|tunjukin|tunjukkan|liatin|lihatkan|share)\b/gi, '')
    .replace(/\b(gambar|image|foto|picture|pic)\b/gi, '')
    .replace(/\s+/g, ' ')
    .trim() || t;
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

  if (!image && isImageGenCommand(message)) {
    const prompt = extractImageGenPrompt(message);
    try {
      const img = await generateImagePollinations(prompt);
      return {
        statusCode: 200,
        body: JSON.stringify({ reply: `Nih gambar "${prompt}" buat kamu 🎨`, image: img }),
      };
    } catch (e) {
      console.error('Image gen error:', e.response?.status, e.message);
      return { statusCode: 200, body: JSON.stringify({ reply: 'Gagal bikin gambar, coba lagi ya.' }) };
    }
  }

  if (!image && isImageSearchCommand(message)) {
    const query = extractImageSearchQuery(message);
    if (!process.env.SERPAPI_KEY) {
      return { statusCode: 200, body: JSON.stringify({ reply: 'Fitur cari gambar belum aktif (SERPAPI_KEY belum diatur).' }) };
    }
    try {
      const urls = await searchImageSerpApi(query);
      if (!urls.length) {
        return { statusCode: 200, body: JSON.stringify({ reply: `Gak nemu hasil buat "${query}".` }) };
      }
      for (const imgUrl of urls) {
        try {
          const imgResp = await axios.get(imgUrl, { responseType: 'arraybuffer', timeout: 10000 });
          const mimeType = imgResp.headers['content-type'] || 'image/jpeg';
          const base64 = Buffer.from(imgResp.data).toString('base64');
          return {
            statusCode: 200,
            body: JSON.stringify({
              reply: `Nih hasil pencarian "${query}" 📸`,
              image: { mimeType, data: base64 },
            }),
          };
        } catch (e) {
          continue; // coba url berikutnya kalau gagal fetch
        }
      }
      const linksMd = urls.map((u, i) => `${i + 1}. ${u}`).join('\n');
      return { statusCode: 200, body: JSON.stringify({ reply: `Gak bisa nampilin gambarnya langsung, ini link-nya:\n${linksMd}` }) };
    } catch (e) {
      console.error('Image search error:', e.response?.status, e.message);
      return { statusCode: 200, body: JSON.stringify({ reply: 'Gagal nyari gambar, coba lagi ya.' }) };
    }
  }

  try {
    let reply;

    if (image && image.data) {
      if (!process.env.GROQ_API_KEY && !process.env.GEMINI_API_KEY) {
        return { statusCode: 500, body: JSON.stringify({ error: 'Belum ada provider yang bisa analisis gambar (GROQ_API_KEY atau GEMINI_API_KEY).' }) };
      }
      const content = [
        { type: 'text', text: 'PENTING: Abaikan topik atau percakapan sebelumnya sama sekali. Fokus HANYA pada gambar yang baru saja dikirim di pesan ini. Identifikasi secara singkat dan spesifik apa/siapa yang ada di gambar ini. Kalau ini tokoh publik, sejarah, tokoh terkenal, sebutkan nama lengkapnya dan konteksnya. Kalau ini objek/benda biasa, jelaskan singkat. Jangan menambahkan opini atau info status terkini, cukup identifikasi visualnya saja berdasarkan apa yang benar-benar terlihat di gambar.' },
        { type: 'image_url', image_url: { url: `data:${image.mimeType};base64,${image.data}` } },
      ];
      const visionMessages = [{ role: 'user', content }];
      const visionErrors = [];
      let identification;
      if (process.env.GROQ_API_KEY) {
        for (const model of VISION_MODEL_CANDIDATES) {
          try {
            identification = await callOpenAICompatible(
              'https://api.groq.com/openai/v1/chat/completions',
              process.env.GROQ_API_KEY,
              model,
              visionMessages,
              500
            );
            break;
          } catch (e) {
            visionErrors.push(`${model}: ${e.response?.status || e.message}`);
          }
        }
      }
      if (!identification && process.env.GEMINI_API_KEY) {
        try {
          identification = await callGeminiVision(
            process.env.GEMINI_API_KEY,
            GEMINI_MODEL,
            'Identifikasi gambar ini secara singkat dan spesifik.',
            message,
            image
          );
        } catch (e) {
          visionErrors.push(`Gemini: ${e.response?.status || e.message}`);
        }
      }
      if (!identification) {
        console.error('Semua model vision gagal:', visionErrors.join(' | '));
        throw new Error('Semua model penganalisis gambar lagi gak bisa diakses, coba lagi sebentar lagi.');
      }

      const userQuestion = message || 'Analisis isi gambar ini, jelaskan ringkasannya.';
      if (process.env.SERPAPI_KEY) {
        let searchResults = '';
        try {
          searchResults = await searchWebSerpApi(`${identification} ${userQuestion}`);
        } catch (e) {
          console.error('Web search fact-check gagal:', e.message);
        }
        try {
          reply = await synthesizeVisionAnswer(userQuestion, identification, searchResults);
        } catch (e) {
          reply = identification;
        }
      } else if (process.env.OPENROUTER_API_KEY) {
        try {
          reply = await synthesizeVisionAnswerOnline(userQuestion, identification);
        } catch (e) {
          console.error('OpenRouter online fact-check gagal:', e.message);
          reply = identification;
        }
      } else {
        reply = identification;
      }
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
