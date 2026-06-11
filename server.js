// server.js
import express from 'express';
import cors from 'cors';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import 'dotenv/config';
import https from 'https';
import axios from 'axios';
import FormData from 'form-data';
import * as googleTTS from 'google-tts-api';
import { exec } from 'child_process';
import util from 'util';
import fs from 'fs';
import nodemailer from 'nodemailer';
import schedule from 'node-schedule';

const execPromise = util.promisify(exec);

// Helper: Digitizing images using Sarvam AI Document Digitization REST API
async function digitizeImage(base64Data, mimeType) {
    const sarvamKey = process.env.SARVAM_API_KEY;
    if (!sarvamKey) throw new Error('SARVAM_API_KEY not configured in .env');

    const id = Date.now() + Math.random().toString(36).substring(7);
    const matches = base64Data.match(/^data:([A-Za-z-+\/]+);base64,(.+)$/);
    let actualBase64 = base64Data;
    let ext = 'png';

    if (matches && matches.length === 3) {
        actualBase64 = matches[2];
        const mime = matches[1].toLowerCase();
        if (mime === 'image/jpeg' || mime === 'image/jpg') ext = 'jpg';
    }

    const imgBuffer = Buffer.from(actualBase64, 'base64');
    const imageFile = `temp_v_${id}.${ext}`;
    const zipFile = `temp_v_${id}.zip`;
    const outZip = `out_v_${id}.zip`;
    const outDir = `out_v_${id}_dir`;

    try {
        // Write image file to disk
        fs.writeFileSync(imageFile, imgBuffer);

        // Compress image to a zip file using the Windows bsdtar utility
        await execPromise(`tar -c -f "${zipFile}" --format=zip "${imageFile}"`);

        // 1. Create Digitization Job (output format: markdown for structured layout text)
        const createJobRes = await axios.post("https://api.sarvam.ai/doc-digitization/job/v1", {
            job_parameters: {
                language: "en-IN",
                output_format: "md"
            }
        }, {
            headers: {
                "api-subscription-key": sarvamKey,
                "Content-Type": "application/json"
            }
        });
        const jobId = createJobRes.data.job_id;

        // 2. Request Upload URL
        const uploadUrlsRes = await axios.post("https://api.sarvam.ai/doc-digitization/job/v1/upload-files", {
            job_id: jobId,
            files: [zipFile]
        }, {
            headers: {
                "api-subscription-key": sarvamKey,
                "Content-Type": "application/json"
            }
        });
        const uploadUrl = uploadUrlsRes.data.upload_urls[zipFile].file_url;

        // 3. Upload ZIP file to Azure Blob storage
        const zipBuffer = fs.readFileSync(zipFile);
        await axios.put(uploadUrl, zipBuffer, {
            headers: {
                "Content-Type": "application/octet-stream",
                "x-ms-blob-type": "BlockBlob"
            }
        });

        // 4. Start the job
        await axios.post(`https://api.sarvam.ai/doc-digitization/job/v1/${jobId}/start`, {}, {
            headers: { "api-subscription-key": sarvamKey }
        });

        // 5. Poll job status until complete
        let completed = false;
        let downloadUrl = "";
        for (let attempt = 0; attempt < 30; attempt++) {
            await new Promise(r => setTimeout(r, 1500));
            const statusRes = await axios.get(`https://api.sarvam.ai/doc-digitization/job/v1/${jobId}/status`, {
                headers: { "api-subscription-key": sarvamKey }
            });
            const state = statusRes.data?.job_state;
            if (state && state.toLowerCase() === 'completed') {
                // 6. Request Download URL
                const downloadUrlsRes = await axios.post(`https://api.sarvam.ai/doc-digitization/job/v1/${jobId}/download-files`, {}, {
                    headers: {
                        "api-subscription-key": sarvamKey,
                        "Content-Type": "application/json"
                    }
                });
                downloadUrl = downloadUrlsRes.data.download_urls?.["document.zip"]?.file_url || 
                              downloadUrlsRes.data.download_urls?.["document.zip"] || 
                              Object.values(downloadUrlsRes.data.download_urls || {})[0]?.file_url || 
                              Object.values(downloadUrlsRes.data.download_urls || {})[0];
                completed = true;
                break;
            }
            if (state && state.toLowerCase() === 'failed') {
                throw new Error('Sarvam digitization job failed');
            }
        }

        if (!completed || !downloadUrl) {
            throw new Error('Timeout or missing download URL');
        }

        // 7. Download output ZIP
        const downloadRes = await axios.get(downloadUrl, { responseType: 'arraybuffer' });
        fs.writeFileSync(outZip, Buffer.from(downloadRes.data));

        // 8. Extract output ZIP
        fs.mkdirSync(outDir);
        await execPromise(`tar -x -f "${outZip}" -C "${outDir}"`);

        // 9. Read extracted Markdown contents
        const files = fs.readdirSync(outDir);
        const mdFile = files.find(f => f.endsWith('.md'));
        let extractedText = "";
        if (mdFile) {
            extractedText = fs.readFileSync(join(outDir, mdFile), 'utf8');
        }
        return extractedText;

    } finally {
        // Safe cleanup of all temporary workspace files
        try { if (fs.existsSync(imageFile)) fs.unlinkSync(imageFile); } catch (_) {}
        try { if (fs.existsSync(zipFile)) fs.unlinkSync(zipFile); } catch (_) {}
        try { if (fs.existsSync(outZip)) fs.unlinkSync(outZip); } catch (_) {}
        try { if (fs.existsSync(outDir)) fs.rmSync(outDir, { recursive: true, force: true }); } catch (_) {}
    }
}

// Helper: Clean messages array to format compatible with text-only models
function cleanMessagesForTextModels(messages) {
    return messages.map(m => {
        if (Array.isArray(m.content)) {
            let text = "";
            m.content.forEach(part => {
                if (part.type === 'text') {
                    text += part.text + " ";
                } else if (part.type === 'image_url') {
                    text += "[Image Uploaded] ";
                }
            });
            return { role: m.role, content: text.trim() };
        }
        return m;
    });
}

// Configure Email Transporter
const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
        user: process.env.EMAIL_USER,
        pass: process.env.EMAIL_PASS
    }
});

// Define __dirname for ES modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json({ limit: '20mb' }));       // audio base64 can be several MB
app.use(express.urlencoded({ extended: true, limit: '20mb' }));

// Serve frontend static files from the same directory
app.use(express.static(__dirname));

// Places API Proxy Route: SerpApi (Primary Google Maps) -> Foursquare (Secondary) -> OSM (Fallback)
app.get('/api/places', async (req, res) => {
    const { lat, lon, query } = req.query;
    if (!lat || !lon) return res.status(400).json({ error: 'Missing coordinates' });

    let placesContext = "";

    // Primary: SerpApi (Google Maps live scraping)
    const serpKey = process.env.SERPAPI_API_KEY;
    if (serpKey) {
        try {
            const serpParams = new URLSearchParams({
                engine: 'google_maps',
                q: query || 'hospital clinic doctor',
                ll: `@${lat},${lon},14z`,
                type: 'search',
                api_key: serpKey
            });
            const serpRes = await fetch(`https://serpapi.com/search.json?${serpParams.toString()}`);
            if (serpRes.ok) {
                const serpJson = await serpRes.json();
                if (serpJson.local_results && serpJson.local_results.length > 0) {
                    placesContext = "REAL-WORLD NEARBY CLINICS FOUND (From Live Google Maps via SerpApi):\n";
                    const topResults = serpJson.local_results.slice(0, 4);
                    topResults.forEach(place => {
                        placesContext += `- **${place.title}**`;
                        if (place.rating) placesContext += ` (⭐ ${place.rating}/5 from ${place.reviews} reviews)`;
                        if (place.phone) placesContext += ` (📞 Phone: ${place.phone})`;
                        if (place.website) placesContext += ` (🌐 Website: ${place.website})`;
                        placesContext += "\n";
                    });
                    return res.json({ context: placesContext });
                }
            }
        } catch (err) {
            console.error("SerpApi failed", err);
        }
    }

    // Secondary: Foursquare API
    const fsqKey = process.env.FOURSQUARE_API_KEY;
    if (fsqKey) {
        try {
            const searchParams = new URLSearchParams({
                ll: `${lat},${lon}`,
                query: query || 'hospital clinic doctor',
                categories: '13000',
                limit: '4',
                fields: 'name,rating,tel,website,location'
            });
            const fsqRes = await fetch(`https://api.foursquare.com/v3/places/search?${searchParams.toString()}`, {
                headers: {
                    "Accept": "application/json",
                    "Authorization": fsqKey
                }
            });
            if (fsqRes.ok) {
                const fsqJson = await fsqRes.json();
                if (fsqJson.results && fsqJson.results.length > 0) {
                    placesContext = "REAL-WORLD NEARBY CLINICS FOUND (From Foursquare Live Data):\n";
                    fsqJson.results.forEach(place => {
                        placesContext += `- **${place.name}**`;
                        if (place.rating) placesContext += ` (Rating: ${place.rating}/10)`;
                        if (place.tel) placesContext += ` (📞 ${place.tel})`;
                        if (place.website) placesContext += ` (🌐 ${place.website})`;
                        placesContext += "\n";
                    });
                    return res.json({ context: placesContext });
                }
            }
        } catch (err) {
            console.error("Foursquare failed", err);
        }
    }

    // Fallback: OpenStreetMap (Overpass API)
    try {
        const overpassQuery = `[out:json][timeout:5];(node["amenity"="hospital"](around:5000,${lat},${lon});node["amenity"="clinic"](around:5000,${lat},${lon});node["amenity"="doctors"](around:5000,${lat},${lon}););out tags 4;`;
        const overpassUrl = `https://overpass-api.de/api/interpreter?data=${encodeURIComponent(overpassQuery)}`;
        const mapRes = await fetch(overpassUrl);
        if (mapRes.ok) {
            const mapJson = await mapRes.json();
            if (mapJson.elements && mapJson.elements.length > 0) {
                placesContext = "REAL-WORLD NEARBY CLINICS FOUND (From OpenStreetMap Fallback):\n";
                mapJson.elements.forEach((el) => {
                    const tags = el.tags || {};
                    if (tags.name) {
                        placesContext += `- **${tags.name}**`;
                        if (tags.phone || tags['contact:phone']) placesContext += ` (📞 ${tags.phone || tags['contact:phone']})`;
                        if (tags.website || tags['contact:website']) placesContext += ` (🌐 ${tags.website || tags['contact:website']})`;
                        placesContext += "\n";
                    }
                });
                return res.json({ context: placesContext });
            }
        }
    } catch (e) {
        console.warn("OSM live fetch failed", e);
    }

    return res.json({ context: null });
});

// Digitize Image: Pre-process image via Sarvam AI Document Digitization
app.post('/api/digitize', async (req, res) => {
    try {
        const { imageBase64, mimeType } = req.body;
        if (!imageBase64) return res.status(400).json({ error: 'imageBase64 required' });

        console.log('[Digitize API] Starting image digitization...');
        const text = await digitizeImage(imageBase64, mimeType || 'image/png');
        console.log('[Digitize API] Image digitized successfully.');
        return res.json({ text });
    } catch (err) {
        console.error('[Digitize API] Digitization failed:', err.message);
        return res.status(500).json({ error: 'Digitization failed', detail: err.message });
    }
});

// ══════════════════════════════════════════════════════════════════════
// Voice STT: Transcribe audio → text via Groq Whisper
// Groq supports: flac, mp3, mp4, mpeg, mpga, m4a, ogg, opus, wav, webm
// ══════════════════════════════════════════════════════════════════════
app.post('/api/transcribe', async (req, res) => {
    try {
        const { audioBase64, mimeType = 'audio/webm', lang } = req.body;
        if (!audioBase64) return res.status(400).json({ error: 'audioBase64 required' });

        const GROQ_KEY = process.env.GROQ_API_KEY || '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';
        const buffer   = Buffer.from(audioBase64, 'base64');

        // Strip codec suffix (e.g. 'audio/webm;codecs=opus' -> 'audio/webm')
        const baseType = mimeType.split(';')[0].trim();
        const extMap   = { 'audio/webm': 'webm', 'audio/ogg': 'ogg', 'audio/mp4': 'mp4',
                           'audio/mpeg': 'mp3', 'audio/wav': 'wav', 'audio/opus': 'opus' };
        const ext      = extMap[baseType] || 'webm';

        const formData = new FormData();
        formData.append('file', buffer, { filename: `audio.${ext}`, contentType: baseType });
        formData.append('model', 'whisper-large-v3');
        formData.append('response_format', 'json');

        // Guide Whisper with language code if explicitly selected by user (non-English)
        if (lang && lang.toLowerCase() !== 'en') {
            formData.append('language', lang.toLowerCase());
        }

        // Prevent Hindi audio from transcribing to Urdu Nastaliq script by providing a script-biasing prompt
        formData.append('prompt', 'Hello SwasthyaSaathi, health assistant. नमस्ते स्वास्थयसाथी, मुझे बुखार है। ନମସ୍କାର ସ୍ୱାସ୍ଥ୍ୟସାଥୀ।');

        console.log(`[STT] Sending ${(buffer.length / 1024).toFixed(1)} KB as audio.${ext} to Groq...`);

        const response = await axios.post(
            'https://api.groq.com/openai/v1/audio/transcriptions',
            formData,
            { headers: { 'Authorization': `Bearer ${GROQ_KEY}`, ...formData.getHeaders() },
              maxBodyLength: Infinity, maxContentLength: Infinity }
        );
        const text = response.data.text?.trim() || '';
        console.log(`[STT] ✅ Transcribed: "${text}"`);
        return res.json({ text });
    } catch (err) {
        const errDetail = err?.response?.data || err.message;
        console.error('[STT] ❌ Groq error:', JSON.stringify(errDetail));
        return res.status(500).json({ error: 'Transcription failed', detail: errDetail });
    }
});


// ══════════════════════════════════════════════════════════════════════
// Voice TTS: text → base64 MP3
// Strategy: edge-tts (local/server) → google-tts-api (Vercel fallback)
// ══════════════════════════════════════════════════════════════════════
app.post('/api/tts', async (req, res) => {
    try {
        const { text, lang = 'en' } = req.body;
        if (!text) return res.status(400).json({ error: 'text required' });

        const safeText = text.replace(/[*_`#~>|]/g, '').slice(0, 3000);

        const voiceMap = {
            'en': 'en-IN-NeerjaNeural', 'hi': 'hi-IN-SwaraNeural',
            'ta': 'ta-IN-PallaviNeural', 'te': 'te-IN-ShrutiNeural',
            'bn': 'bn-IN-TanishaaNeural', 'gu': 'gu-IN-DhwaniNeural',
            'mr': 'mr-IN-AarohiNeural', 'ml': 'ml-IN-SobhanaNeural',
            'kn': 'kn-IN-SapnaNeural', 'or': 'or-IN-AnanyaNeural',
            'ur': 'ur-IN-YasminNeural'
        };
        const voice = voiceMap[lang.toLowerCase()] || 'en-IN-NeerjaNeural';

        // ── Attempt 0: Sarvam AI TTS (Outstanding quality for Indian languages) ──
        const sarvamKey = process.env.SARVAM_API_KEY;
        if (sarvamKey) {
            try {
                const langMap = {
                    'en': 'en-IN', 'hi': 'hi-IN', 'ta': 'ta-IN', 'te': 'te-IN',
                    'bn': 'bn-IN', 'gu': 'gu-IN', 'mr': 'mr-IN', 'ml': 'ml-IN',
                    'kn': 'kn-IN', 'or': 'or-IN'
                };
                const targetLang = langMap[lang.toLowerCase()];
                if (targetLang) {
                    console.log(`[TTS] Requesting Sarvam AI TTS for language: ${targetLang}...`);
                    const sarvamRes = await fetch("https://api.sarvam.ai/text-to-speech/stream", {
                        method: "POST",
                        headers: {
                            "api-subscription-key": sarvamKey,
                            "Content-Type": "application/json"
                        },
                        body: JSON.stringify({
                            text: safeText,
                            target_language_code: targetLang,
                            speaker: "shubh",
                            model: "bulbul:v3",
                            pace: 1.1,
                            speech_sample_rate: 22050,
                            output_audio_codec: "mp3",
                            enable_preprocessing: true
                        })
                    });

                    if (sarvamRes.ok) {
                        const audioBuffer = await sarvamRes.arrayBuffer();
                        const base64Audio = Buffer.from(audioBuffer).toString('base64');
                        console.log('[TTS] Sarvam AI TTS succeeded');
                        return res.json({ audioBase64: base64Audio });
                    } else {
                        console.warn(`[TTS] Sarvam AI failed with status ${sarvamRes.status}:`, await sarvamRes.text());
                    }
                }
            } catch (sarvamErr) {
                console.warn('[TTS] Sarvam AI TTS failed, falling back to edge-tts:', sarvamErr.message);
            }
        }

        // ── Attempt 1: edge-tts (needs Python, works locally & on servers) ──
        try {
            const id = Date.now() + Math.random().toString(36).substring(7);
            const textFile = `temp_${id}.txt`;
            const audioFile = `out_${id}.mp3`;
            fs.writeFileSync(textFile, safeText, 'utf8');
            await execPromise(`edge-tts -f "${textFile}" --voice ${voice} --write-media "${audioFile}"`);
            const base64Audio = fs.readFileSync(audioFile, { encoding: 'base64' });
            if (fs.existsSync(textFile)) fs.unlinkSync(textFile);
            if (fs.existsSync(audioFile)) fs.unlinkSync(audioFile);
            console.log('[TTS] edge-tts succeeded');
            return res.json({ audioBase64: base64Audio });
        } catch (edgeErr) {
            console.warn('[TTS] edge-tts failed, falling back to Google TTS:', edgeErr.message);
        }

        // ── Attempt 2: google-tts-api (pure JS, always works on Vercel) ──
        const langCodeMap = { 'en': 'en', 'hi': 'hi', 'ta': 'ta', 'te': 'te', 'bn': 'bn', 'gu': 'gu', 'mr': 'mr', 'ml': 'ml', 'kn': 'kn', 'or': 'or', 'ur': 'ur' };
        const gttsLang = langCodeMap[lang.toLowerCase()] || 'en';

        const urls = googleTTS.getAllAudioUrls(safeText, { lang: gttsLang, slow: false, splitPunct: ',.?!' });
        const chunks = await Promise.all(urls.map(({ url }) =>
            axios.get(url, { responseType: 'arraybuffer' }).then(r => Buffer.from(r.data))
        ));
        const merged = Buffer.concat(chunks);
        const base64Audio = merged.toString('base64');
        console.log('[TTS] google-tts fallback succeeded');
        return res.json({ audioBase64: base64Audio });

    } catch (err) {
        console.error('[TTS] All TTS methods failed:', err.message);
        return res.status(500).json({ error: 'TTS failed' });
    }
});

// ══════════════════════════════════════════════════════════════════════
// Email Reminders endpoint
// ══════════════════════════════════════════════════════════════════════
app.post('/api/reminder', async (req, res) => {
    try {
        const { email, name, date, time, type } = req.body;
        
        if (!email || !name || !date || !time) {
            return res.status(400).json({ error: 'Missing required fields' });
        }

        const targetDateTime = new Date(`${date}T${time}`);
        const now = new Date();

        if (targetDateTime <= now) {
            return res.status(400).json({ error: 'Reminder time must be in the future' });
        }

        // ── Helper: try each AI model in cascade (mirrors /api/chat priority) ──
        // ── Helper: try each AI model in cascade (mirrors /api/chat priority) ──
        async function getAIMedicalDetails(itemName, itemType) {
            const systemPrompt = `You are a helpful medical assistant for SwasthyaSaathi AI.
The user has set a reminder for a medicine or vaccine. Write a SHORT, friendly medical note (3-5 sentences) that includes:
1. **What is it**: A clear explanation of what this medicine/vaccine is.
2. **When to take it**: In which condition(s) or for which symptoms we should take it.
3. **Precautions**: Important precautions, safety notes, or side-effects to watch out for.

Use **bold** for section headings (e.g., **What is it**, **When to take it**, **Precautions**) and keep it warm, simple, and easy to understand.`;
            const userPrompt = `Medicine/Vaccine: ${itemName}\nType: ${itemType}`;
            const messages = [
                { role: 'system', content: systemPrompt },
                { role: 'user', content: userPrompt }
            ];

            // 1. Groq Llama 3.3 (Primary - lightning fast and highly reliable)
            try {
                const GROQ_KEY = process.env.GROQ_API_KEY || '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';
                const r = await axios.post('https://api.groq.com/openai/v1/chat/completions', {
                    model: 'llama-3.3-70b-versatile',
                    messages: messages,
                    stream: false
                }, { headers: { 'Authorization': `Bearer ${GROQ_KEY}`, 'Content-Type': 'application/json' } });
                const text = r.data.choices?.[0]?.message?.content?.trim();
                if (text) { console.log('[Reminder AI] Groq Llama 3.3 responded'); return text; }
            } catch (e) { console.warn('[Reminder AI] Groq Llama 3.3 failed:', e.message); }

            // 2. Groq Llama 3.1 (Secondary)
            try {
                const GROQ_KEY = process.env.GROQ_API_KEY || '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';
                const r = await axios.post('https://api.groq.com/openai/v1/chat/completions', {
                    model: 'llama-3.1-8b-instant',
                    messages: messages,
                    stream: false
                }, { headers: { 'Authorization': `Bearer ${GROQ_KEY}`, 'Content-Type': 'application/json' } });
                const text = r.data.choices?.[0]?.message?.content?.trim();
                if (text) { console.log('[Reminder AI] Groq Llama 3.1 responded'); return text; }
            } catch (e) { console.warn('[Reminder AI] Groq Llama 3.1 failed:', e.message); }

            // 3. Gemini (Tertiary)
            try {
                const GEMINI_KEY = process.env.GEMINI_API_KEY;
                const geminiBody = {
                    contents: [{ role: 'user', parts: [{ text: userPrompt }] }],
                    systemInstruction: { parts: [{ text: systemPrompt }] }
                };
                const r = await axios.post(
                    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${GEMINI_KEY}`,
                    geminiBody, { headers: { 'Content-Type': 'application/json' } }
                );
                const text = r.data.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
                if (text) { console.log('[Reminder AI] Gemini responded'); return text; }
            } catch (e) { console.warn('[Reminder AI] Gemini failed:', e.message); }

            // 4. OpenRouter Free Models (Gemma 4 / Llama 4 as last resort)
            for (const model of ['google/gemma-4-31b-it:free', 'google/gemma-4-26b-a4b-it:free', 'meta-llama/llama-4-maverick:free']) {
                try {
                    const r = await axios.post('https://openrouter.ai/api/v1/chat/completions', {
                        model: model, stream: false, messages
                    }, { headers: { 'Authorization': `Bearer ${process.env.OPENROUTER_API_KEY || process.env.OPENROUTER_API_KEY_2}` } });
                    const text = r.data.choices?.[0]?.message?.content?.trim();
                    if (text) { console.log(`[Reminder AI] OpenRouter ${model} responded`); return text; }
                } catch (e) { console.warn(`[Reminder AI] OpenRouter ${model} failed:`, e.message); }
            }

            return ''; // All failed — send email without AI notes
        }

        // Fetch AI details for the item
        let aiDetails = '';
        try {
            aiDetails = await getAIMedicalDetails(name, type);
            if (aiDetails) console.log(`[Reminder AI] Got details for "${name}"`);
        } catch (e) {
            console.warn('[Reminder AI] Failed to fetch details:', e.message);
        }

        // Format markdown bold/italic for HTML email
        const formattedAiDetails = aiDetails
            .replace(/\*\*(.*?)\*\*/g, '<b>$1</b>')
            .replace(/\*(.*?)\*/g, '<i>$1</i>')
            .replace(/\n/g, '<br>');

        const aiDetailsHtml = aiDetails ? `
        <div style="background: #eef2ff; border: 1px solid #c7d2fe; padding: 15px; border-radius: 10px; margin-top: 15px;">
            <h4 style="margin-top: 0; color: #3730a3;">ℹ️ About ${name}</h4>
            <p style="margin-bottom: 0; color: #4338ca; font-size: 14px; line-height: 1.6;">${formattedAiDetails}</p>
        </div>` : '';

        // 1. Send immediate confirmation email
        const mailOptions = {
            from: process.env.EMAIL_USER,
            to: email,
            subject: `Reminder Set: ${name}`,
            text: `Hello!\n\nYou have successfully set a ${type.toLowerCase()} reminder for:\n\nItem: ${name}\nDate: ${date}\nTime: ${time}\n\nWe will send you another email 15 minutes before this scheduled time.\n\n${aiDetails ? `Notes on ${name}:\n${aiDetails}\n\n` : ''}Stay healthy!\n- SwasthyaSaathi AI`,
            html: `
                <div style="font-family: Arial, sans-serif; color: #333; max-width: 600px;">
                    <h2>Hello!</h2>
                    <p>You have successfully set a ${type.toLowerCase()} reminder for:</p>
                    <div style="background: #f0fdf4; border: 1px solid #bbf7d0; padding: 15px; border-radius: 10px;">
                        <ul style="list-style: none; padding: 0; margin: 0; font-size: 16px;">
                            <li style="margin-bottom: 5px;"><strong>Item:</strong> ${name}</li>
                            <li style="margin-bottom: 5px;"><strong>Date:</strong> ${date}</li>
                            <li><strong>Time:</strong> ${time}</li>
                        </ul>
                    </div>
                    <p>We will send you another email 15 minutes before this scheduled time.</p>
                    ${aiDetailsHtml}
                    <p>Stay healthy!<br><strong>- SwasthyaSaathi AI</strong></p>
                </div>
            `
        };

        await transporter.sendMail(mailOptions);

        // 2. Schedule the 15-minute advanced alert email
        // Note: node-schedule only works on persistent servers (not Vercel serverless)
        const alertTime = new Date(targetDateTime.getTime() - 15 * 60000);
        const isVercel = process.env.VERCEL === '1';
        
        if (!isVercel && alertTime > now) {
            schedule.scheduleJob(alertTime, async () => {
                const alertMailOptions = {
                    from: process.env.EMAIL_USER,
                    to: email,
                    subject: `Urgent Reminder: ${name} in 15 Minutes!`,
                    text: `Hello!\n\nThis is your 15-minute alert for your ${type.toLowerCase()}: ${name}.\n\nPlease prepare for it.\n\n${aiDetails ? `Notes on ${name}:\n${aiDetails}\n\n` : ''}- SwasthyaSaathi AI`,
                    html: `
                        <div style="font-family: Arial, sans-serif; color: #333; max-width: 600px;">
                            <h2>Hello!</h2>
                            <div style="background: #fef2f2; border: 1px solid #fecaca; padding: 15px; border-radius: 10px;">
                                <p style="color: #b91c1c; font-weight: bold; margin: 0; font-size: 18px;">This is your 15-minute alert for your ${type.toLowerCase()}: ${name}.</p>
                            </div>
                            <p style="font-size: 16px;">Please prepare for it.</p>
                            ${aiDetailsHtml}
                            <p>Stay healthy!<br><strong>- SwasthyaSaathi AI</strong></p>
                        </div>
                    `
                };
                try {
                    await transporter.sendMail(alertMailOptions);
                    console.log(`[Reminder] Sent 15-min alert for ${name} to ${email}`);
                } catch (e) {
                    console.error('[Reminder] Failed to send 15-min alert', e);
                }
            });
            console.log(`[Reminder] Scheduled 15-min alert for ${name} at ${alertTime}`);
        } else if (isVercel) {
            console.log('[Reminder] Running on Vercel serverless — 15-min alert cannot be scheduled (stateless). Confirmation email sent.');
        } else {
            console.log(`[Reminder] Target time is less than 15 mins away. Skipping 15-min alert.`);
        }

        return res.json({ success: true, message: 'Reminder set and immediate email sent!' });
        
    } catch (err) {
        console.error('[Reminder] Error:', err);
        return res.status(500).json({ error: 'Internal Server Error' });
    }
});

// ══════════════════════════════════════════════════════════════════════
// Chat Endpoint — Smart AI Routing
// ══════════════════════════════════════════════════════════════════════
//
// TEXT priority:       1. Kimi-k2.6       2. AgentRouter DeepSeek
//                      3. Qwen            4. Gemini direct   5. Llama
//
// IMAGE / VOICE:       Gemini first (only multimodal model in chain)
//                      → falls through to text chain if Gemini fails
//
app.post('/api/chat', async (req, res) => {
    try {
        let { messages } = req.body;

        if (!messages || !Array.isArray(messages)) {
            return res.status(400).json({ error: 'Valid messages array is required' });
        }

        // If there are images and we have a Sarvam API key, pre-process them using Sarvam AI Vision
        const hasImages = messages.some(m =>
            Array.isArray(m.content) && m.content.some(part => part.type === 'image_url')
        );

        if (hasImages && process.env.SARVAM_API_KEY) {
            console.log('[Sarvam Vision] Pre-processing images...');
            for (let i = 0; i < messages.length; i++) {
                const msg = messages[i];
                if (Array.isArray(msg.content)) {
                    for (let j = 0; j < msg.content.length; j++) {
                        const part = msg.content[j];
                        if (part.type === 'image_url' && part.image_url?.url?.startsWith('data:')) {
                            try {
                                const base64 = part.image_url.url;
                                // Digitize image using Sarvam AI
                                const digitizedText = await digitizeImage(base64, 'image/png');
                                console.log('[Sarvam Vision] Digitized image text successfully.');
                                // Replace image_url part with digitized text description
                                msg.content[j] = {
                                    type: 'text',
                                    text: `[🩺 IMAGE ANALYSIS (Prescription/Report/Condition digitized via SwasthyaSaathi):\n${digitizedText}\n]`
                                };
                            } catch (digitizeErr) {
                                console.error('[Sarvam Vision] Digitization failed:', digitizeErr.message);
                            }
                        }
                    }
                }
            }
        }

        // SSE headers
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');
        res.setHeader('X-Accel-Buffering', 'no');

        // ── Detect image / voice request ──────────────────────────────────────
        // Any message part with image_url or audio inlineData
        const isMultimodal = messages.some(m =>
            Array.isArray(m.content) && m.content.some(part =>
                part.type === 'image_url' ||
                (part.inlineData && part.inlineData.mimeType?.startsWith('audio'))
            )
        );
        console.log(`[Router] ${isMultimodal ? '🖼️  MULTIMODAL (image/voice)' : '💬 TEXT'} request received`);

        // ── HELPER: stream Groq (OpenAI-compatible, Lightning Fast) ───────────
        async function streamGroq(modelName) {
            const GROQ_KEY = process.env.GROQ_API_KEY || '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';
            const cleanedMessages = cleanMessagesForTextModels(messages);
            const resp = await fetch('https://api.groq.com/openai/v1/chat/completions', {
                method: 'POST',
                headers: { 'Authorization': `Bearer ${GROQ_KEY}`, 'Content-Type': 'application/json' },
                body: JSON.stringify({ model: modelName, messages: cleanedMessages, stream: true })
            });
            if (!resp.ok) {
                throw new Error(`Groq ${modelName} → HTTP ${resp.status}: ${await resp.text()}`);
            }

            const reader  = resp.body.getReader();
            const decoder = new TextDecoder();
            let buf = '';
            while (true) {
                const { value, done } = await reader.read();
                if (done) break;
                buf += decoder.decode(value, { stream: true });
                const lines = buf.split('\n');
                buf = lines.pop();
                for (const line of lines) {
                    if (line.startsWith('data: ') && line !== 'data: [DONE]') {
                        try {
                            const parsed = JSON.parse(line.slice(6));
                            const content = parsed.choices?.[0]?.delta?.content;
                            if (content) res.write(`data: ${JSON.stringify({ content })}\n\n`);
                        } catch (_) {}
                    }
                }
            }
            res.write('data: [DONE]\n\n');
            res.end();
        }

        // ── HELPER: stream AgentRouter (OpenAI-compatible) ────────────────────
        async function streamAgentRouter(modelName) {
            const AR_KEY  = process.env.AGENTROUTER_API_KEY;
            const AR_BASE = process.env.AGENTROUTER_BASE_URL;
            if (!AR_KEY || !AR_BASE) throw new Error('AgentRouter not configured');

            const cleanedMessages = cleanMessagesForTextModels(messages);
            const resp = await fetch(`${AR_BASE}/chat/completions`, {
                method: 'POST',
                headers: { 'Authorization': `Bearer ${AR_KEY}`, 'Content-Type': 'application/json' },
                body: JSON.stringify({ model: modelName, messages: cleanedMessages, stream: true })
            });
            if (!resp.ok) {
                throw new Error(`AgentRouter ${modelName} → HTTP ${resp.status}: ${await resp.text()}`);
            }

            const reader  = resp.body.getReader();
            const decoder = new TextDecoder();
            let buf = '';
            while (true) {
                const { value, done } = await reader.read();
                if (done) break;
                buf += decoder.decode(value, { stream: true });
                const lines = buf.split('\n');
                buf = lines.pop();
                for (const line of lines) {
                    if (line.startsWith('data: ') && line !== 'data: [DONE]') {
                        try {
                            const parsed = JSON.parse(line.slice(6));
                            const content = parsed.choices?.[0]?.delta?.content;
                            if (content) res.write(`data: ${JSON.stringify({ content })}\n\n`);
                        } catch (_) {}
                    }
                }
            }
            res.write('data: [DONE]\n\n');
            res.end();
        }

        // ── HELPER: connect to OpenRouter (returns open stream handle) ────────
        function connectOpenRouter(modelName, apiKey) {
            return new Promise((resolve, reject) => {
                const cleanedMessages = cleanMessagesForTextModels(messages);
                const postData = JSON.stringify({ model: modelName, messages: cleanedMessages, stream: true });
                const req2 = https.request({
                    hostname: 'openrouter.ai',
                    path: '/api/v1/chat/completions',
                    method: 'POST',
                    headers: {
                        'Authorization': `Bearer ${apiKey}`,
                        'Content-Type': 'application/json',
                        'Content-Length': Buffer.byteLength(postData)
                    }
                }, (orRes) => {
                    if (orRes.statusCode === 200) {
                        resolve(orRes);
                    } else {
                        let body = '';
                        orRes.on('data', c => body += c);
                        orRes.on('end', () => reject(new Error(`${modelName} → HTTP ${orRes.statusCode}: ${body}`)));
                    }
                });
                req2.on('error', reject);
                req2.write(postData);
                req2.end();
            });
        }

        // ── HELPER: pipe an open OpenRouter stream to the client ──────────────
        function pipeOpenRouter(orRes) {
            return new Promise((resolve) => {
                let buf = '';
                orRes.on('data', (chunk) => {
                    buf += chunk.toString('utf-8');
                    const lines = buf.split('\n');
                    buf = lines.pop();
                    for (const line of lines) {
                        if (line.startsWith('data: ') && line !== 'data: [DONE]') {
                            try {
                                const parsed = JSON.parse(line.slice(6));
                                const content = parsed.choices?.[0]?.delta?.content;
                                if (content) res.write(`data: ${JSON.stringify({ content })}\n\n`);
                            } catch (_) {}
                        }
                    }
                });
                orRes.on('end',   () => { res.write('data: [DONE]\n\n'); res.end(); resolve(); });
                orRes.on('error', () => { res.end(); resolve(); });
            });
        }

        // ── HELPER: stream Gemini (text + vision + audio) ─────────────────────
        async function streamGemini() {
            const GEMINI_KEY = process.env.GEMINI_API_KEY;
            if (!GEMINI_KEY) throw new Error('Gemini API key not set');

            const geminiContents = messages
                .filter(m => m.role !== 'system')
                .map(m => {
                    const role = m.role === 'assistant' ? 'model' : 'user';
                    if (Array.isArray(m.content)) {
                        const parts = m.content.map(part => {
                            if (part.type === 'text')      return { text: part.text };
                            if (part.type === 'image_url') {
                                // Support data URIs (base64) or plain URLs
                                const url = part.image_url?.url || '';
                                if (url.startsWith('data:')) {
                                    const [header, data] = url.split(',');
                                    const mimeType = header.split(':')[1].split(';')[0];
                                    return { inlineData: { mimeType, data } };
                                }
                                return { text: `[Image: ${url}]` };
                            }
                            if (part.inlineData) return { inlineData: part.inlineData };
                            return { text: JSON.stringify(part) };
                        });
                        return { role, parts };
                    }
                    return { role, parts: [{ text: m.content }] };
                });

            const systemMsg  = messages.find(m => m.role === 'system');
            const geminiBody = {
                contents: geminiContents,
                systemInstruction: systemMsg ? { parts: [{ text: systemMsg.content }] } : undefined
            };

            const geminiRes = await fetch(
                `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:streamGenerateContent?alt=sse&key=${GEMINI_KEY}`,
                { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(geminiBody) }
            );
            if (!geminiRes.ok) throw new Error(`Gemini → HTTP ${geminiRes.status}`);

            const reader  = geminiRes.body.getReader();
            const decoder = new TextDecoder();
            let buf = '';
            while (true) {
                const { value, done } = await reader.read();
                if (done) break;
                buf += decoder.decode(value, { stream: true });
                const lines = buf.split('\n');
                buf = lines.pop();
                for (const line of lines) {
                    if (line.startsWith('data: ')) {
                        try {
                            const parsed = JSON.parse(line.slice(6));
                            const text = parsed.candidates?.[0]?.content?.parts?.[0]?.text;
                            if (text) res.write(`data: ${JSON.stringify({ content: text })}\n\n`);
                        } catch (_) {}
                    }
                }
            }
            res.write('data: [DONE]\n\n');
            res.end();
        }

        // ════════════════════════════════════════════════════════════════════
        // ROUTING
        // ════════════════════════════════════════════════════════════════════

        // ── PATH A: IMAGE / VOICE — Gemini first ─────────────────────────────
        if (isMultimodal) {
            try {
                console.log('[Gemini] Handling multimodal (image/voice)...');
                await streamGemini();
                console.log('✅ [Gemini] Multimodal response complete.');
                return;
            } catch (err) {
                console.warn(`❌ [Gemini] Multimodal failed: ${err.message} — falling to text chain`);
            }
        }

        // ── PATH B: TEXT — priority chain ─────────────────────────────────────

        // 1. Groq (Llama 3.3 - Lightning Fast Primary)
        for (const model of ['llama-3.3-70b-versatile', 'llama-3.1-8b-instant']) {
            try {
                console.log(`[1/6] Groq ${model} (Lightning Fast)...`);
                await streamGroq(model);
                console.log(`✅ [1/6] Groq ${model} responded!`);
                return;
            } catch (err) { console.warn(`❌ [1/6] Groq ${model}: ${err.message}`); }
        }

        // 2. OpenRouter Reliable Free Models (Gemma 4 31B & 26B)
        for (const model of ['google/gemma-4-31b-it:free', 'google/gemma-4-26b-a4b-it:free']) {
            try {
                console.log(`[2/6] OpenRouter ${model}...`);
                const orRes = await connectOpenRouter(model, process.env.OPENROUTER_API_KEY || process.env.OPENROUTER_API_KEY_2);
                console.log(`✅ [2/6] OpenRouter ${model} responded!`);
                await pipeOpenRouter(orRes);
                return;
            } catch (err) { console.warn(`❌ [2/6] OpenRouter ${model}: ${err.message}`); }
        }

        // 3. Gemini direct (text fallback)
        try {
            console.log('[3/6] Gemini direct (text fallback)...');
            await streamGemini();
            console.log('✅ [3/6] Gemini text fallback responded!');
            return;
        } catch (err) { console.warn(`❌ [3/6] Gemini: ${err.message}`); }

        // 4. OpenRouter Venice Fallbacks (Llama & Qwen - Venice is sometimes rate-limited)
        for (const model of ['meta-llama/llama-3.3-70b-instruct:free', 'qwen/qwen3-next-80b-a3b-instruct:free', 'meta-llama/llama-3.2-3b-instruct:free']) {
            try {
                console.log(`[4/6] OpenRouter Venice ${model}...`);
                const orRes = await connectOpenRouter(model, process.env.OPENROUTER_API_KEY || process.env.OPENROUTER_API_KEY_2);
                console.log(`✅ [4/6] OpenRouter Venice ${model} responded!`);
                await pipeOpenRouter(orRes);
                return;
            } catch (err) { console.warn(`❌ [4/6] OpenRouter Venice ${model}: ${err.message}`); }
        }

        // 5. AgentRouter — DeepSeek (r1-0528 → v3.2 → v3.1)
        for (const model of ['deepseek-r1-0528', 'deepseek-v3.2', 'deepseek-v3.1']) {
            try {
                console.log(`[5/6] AgentRouter / ${model}...`);
                await streamAgentRouter(model);
                console.log(`✅ [5/6] AgentRouter/${model} responded!`);
                return;
            } catch (err) { console.warn(`❌ [5/6] AgentRouter/${model}: ${err.message}`); }
        }

        // All models exhausted
        res.write(`data: ${JSON.stringify({ error: 'All AI models are currently busy. Please try again in a moment.' })}\n\n`);
        res.write('data: [DONE]\n\n');
        res.end();

    } catch (error) {
        console.error('Chat endpoint error:', error);
        if (!res.headersSent) {
            res.status(500).json({ error: 'Internal Server Error' });
        } else {
            res.end();
        }
    }
});

// WhatsApp Endpoint Configured for Twilio
app.post('/api/whatsapp', async (req, res) => {
    try {
        const incomingMsg = req.body.Body;
        if (!incomingMsg) {
            return res.status(400).send('No message body');
        }

        const postData = JSON.stringify({
            model: "google/gemma-4-31b-it:free",
            messages: [{ role: "user", content: incomingMsg }],
            stream: false
        });

        const options = {
            hostname: 'openrouter.ai',
            path: '/api/v1/chat/completions',
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${process.env.OPENROUTER_API_KEY}`,
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(postData)
            }
        };

        let responseText = "AI Assistant is currently unavailable.";

        const orReq = https.request(options, (orRes) => {
            let data = '';
            orRes.on('data', chunk => data += chunk);
            orRes.on('end', () => {
                if (orRes.statusCode === 200) {
                    try {
                        const parsed = JSON.parse(data);
                        responseText = parsed.choices[0]?.message?.content || responseText;
                    } catch (e) {
                        console.error("Error parsing OpenRouter response", e);
                    }
                } else {
                    console.error("OpenRouter API error:", data);
                }

                res.setHeader('Content-Type', 'text/xml');
                res.send(`<?xml version="1.0" encoding="UTF-8"?><Response><Message>${responseText}</Message></Response>`);
            });
        });

        orReq.on('error', (error) => {
            console.error('Error proxying to OpenRouter:', error);
            res.setHeader('Content-Type', 'text/xml');
            res.send(`<?xml version="1.0" encoding="UTF-8"?><Response><Message>Error connecting to AI service.</Message></Response>`);
        });

        orReq.write(postData);
        orReq.end();

    } catch (error) {
        console.error('WhatsApp Endpoint Error:', error);
        res.setHeader('Content-Type', 'text/xml');
        res.send(`<?xml version="1.0" encoding="UTF-8"?><Response><Message>Internal Server Error.</Message></Response>`);
    }
});

// Export app for Vercel
export default app;

if (process.env.NODE_ENV !== 'production') {
    if (process.argv[1] === __filename || process.argv[1] === fileURLToPath(import.meta.url)) {
        app.listen(PORT, () => {
            console.log(`Server is running successfully on http://localhost:${PORT}`);
        });
    }
}
