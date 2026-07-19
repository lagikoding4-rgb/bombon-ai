# Panduan Setup Bombon AI (Netlify + Supabase + Groq)

Struktur proyek:
```
bombon-ai-web/
  netlify.toml              -> konfigurasi Netlify
  package.json               -> dependency function (axios)
  netlify/functions/chat.js  -> "otak" AI-nya (manggil Groq)
  public/index.html          -> tampilan aplikasi
  public/config.js           -> isi kunci Supabase kamu di sini
  public/assets/logo.jpg     -> logo Bombon AI
```

## 1. Bikin akun & API key Groq (buat otak AI-nya)
1. Daftar di https://console.groq.com
2. Buat API Key baru, salin.
3. Nanti dimasukkan ke Netlify sebagai environment variable `GROQ_API_KEY` (langkah 4).

> Groq gratis dengan batas pemakaian (rate limit), cukup buat mulai/testing.

## 2. Bikin project Supabase (buat login Google + nanti riwayat chat)
1. Daftar di https://supabase.com, bikin **New Project**.
2. Di dashboard project → **Authentication → Providers → Google** → aktifkan.
3. Supabase akan kasih kamu sebuah **Redirect URL** (bentuknya `https://xxxx.supabase.co/auth/v1/callback`) — salin URL ini, dipakai di langkah 3.
4. Balik ke **Project Settings → API**, salin:
   - `Project URL`
   - `anon public key`
5. Tempel dua nilai itu ke file `public/config.js`:
   ```js
   window.BOMBON_CONFIG = {
     SUPABASE_URL: "https://xxxx.supabase.co",
     SUPABASE_ANON_KEY: "isi-anon-key-kamu",
   };
   ```

## 3. Bikin OAuth Client di Google Cloud Console
1. Buka https://console.cloud.google.com → bikin project baru (atau pakai yang sudah ada).
2. Menu **APIs & Services → OAuth consent screen** → isi info dasar (nama app: Bombon AI, dst), simpan.
3. Menu **APIs & Services → Credentials → Create Credentials → OAuth Client ID**.
   - Application type: **Web application**
   - **Authorized redirect URIs**: tempel URL callback dari Supabase (langkah 2.3)
4. Setelah dibuat, salin **Client ID** dan **Client Secret**.
5. Balik ke dashboard Supabase → **Authentication → Providers → Google** → tempel Client ID & Client Secret itu → simpan.

## 4. Deploy ke Netlify
1. Push folder ini ke repo GitHub kamu.
2. Buka https://app.netlify.com → **Add new site → Import an existing project** → hubungkan ke repo GitHub itu.
3. Build settings biasanya otomatis kebaca dari `netlify.toml`, biarkan default.
4. Sebelum deploy, buka **Site settings → Environment variables**, tambahkan:
   - `GROQ_API_KEY` = API key dari langkah 1
   - (opsional) `GROQ_CHAT_MODEL`, `GROQ_VISION_MODEL` kalau mau ganti model
5. Klik **Deploy site**.
6. Setelah dapat URL Netlify-nya (misal `https://bombon-ai.netlify.app`), balik ke Google Cloud Console → tambahkan URL itu juga ke **Authorized JavaScript origins**.

## 5. Tes
- Buka URL Netlify kamu di browser.
- Splash animasi jalan → muncul tombol "Lanjutkan dengan Google" → beneran diarahkan ke halaman login Google → setelah pilih akun, balik ke app dengan nama & foto profil asli kamu.
- Coba ketik "halo", tanya "kamu buatan siapa", atau minta "buatkan script python fizzbuzz" / "contoh kode html".
- Coba lampirkan gambar (ikon 📎) lalu kirim — AI akan menganalisis gambar itu beneran lewat Groq vision.

## Belum termasuk (langkah lanjutan kalau mau)
- **Riwayat chat tersimpan permanen per user** — sekarang riwayat cuma ada selama tab dibuka (hilang kalau refresh). Untuk simpan permanen, tambahkan tabel di Supabase (misal tabel `messages` dengan kolom `user_id`, `role`, `content`, `created_at`) dan panggil dari frontend pakai `supabaseClient.from('messages')`.
- **Rate limiting / batas pemakaian per user** biar API key kamu tidak disalahgunakan orang lain.
- **Custom domain** — bisa ditambahkan lewat Netlify → Domain settings.
