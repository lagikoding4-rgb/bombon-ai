// netlify/functions/chat.js
//
// Serverless endpoint: POST /api/chat
// Body: { message, history, image?, fileText?, fileName?, userEmail? }
// Returns: { reply: string }
//
// Env vars (Netlify dashboard -> Environment variables):
//   GROQ_API_KEY              -> wajib
//   GROQ_CHAT_MODEL           -> optional
//   GROQ_VISION_MODEL         -> optional
//   SUPABASE_URL              -> buat fitur memory (opsional, kalau gak diisi fitur /inget dimatiin)
//   SUPABASE_SERVICE_ROLE_KEY -> service role key Supabase (JANGAN dipakai di frontend, cuma di sini)
//   OWNER_EMAIL               -> email akun Bombon (pemilik), buat pengenalan pemilik

const axios = require('axios');

const CHAT_MODEL = process.env.GROQ_CHAT_MODEL || 'llama-3.3-70b-versatile';
const VISION_MODEL = process.env.GROQ_VISION_MODEL || 'meta-llama/llama-4-scout-17b-16e-instruct';
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
  const apiKey = process.env.GROQ_API_KEY;
  const isOwner = !!(userEmail && OWNER_EMAIL && userEmail.toLowerCase() === OWNER_EMAIL);

  if (!apiKey) {
    return {
      statusCode: 500,
      body: JSON.stringify({ error: 'GROQ_API_KEY belum diatur di environment variables Netlify.' }),
    };
  }

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
      const content = [
        { type: 'text', text: message || 'Analisis gambar ini dan jelaskan isinya secara ringkas.' },
        { type: 'image_url', image_url: { url: `data:${image.mimeType};base64,${image.data}` } },
      ];

      const response = await axios.post(
        'https://api.groq.com/openai/v1/chat/completions',
        {
          model: VISION_MODEL,
          messages: [
            { role: 'system', content: 'Kamu adalah Bombon AI, dibuat oleh Bombon. Analisis gambar yang dikirim pengguna secara akurat dan ringkas, dalam Bahasa Indonesia, gaya santai gak kaku.' },
            { role: 'user', content },
          ],
          max_tokens: 700,
        },
        { headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` }, timeout: 45000 }
      );

      reply = response.data?.choices?.[0]?.message?.content?.trim();
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

      const messages = [
        { role: 'system', content: systemContent },
        ...history.slice(-8),
        { role: 'user', content: userMessage },
      ];

      const response = await axios.post(
        'https://api.groq.com/openai/v1/chat/completions',
        {
          model: CHAT_MODEL,
          messages,
          temperature: 0.8,
          max_tokens: 6000,
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
