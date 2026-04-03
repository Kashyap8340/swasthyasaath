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

// ══════════════════════════════════════════════════════════════════════
// Voice STT: Transcribe audio → text via Groq Whisper
// Groq supports: flac, mp3, mp4, mpeg, mpga, m4a, ogg, opus, wav, webm
// ══════════════════════════════════════════════════════════════════════
app.post('/api/transcribe', async (req, res) => {
    try {
        const { audioBase64, mimeType = 'audio/webm' } = req.body;
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
            'kn': 'kn-IN-SapnaNeural'
        };
        const voice = voiceMap[lang.toLowerCase()] || 'en-IN-NeerjaNeural';

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
        const langCodeMap = { 'en': 'en', 'hi': 'hi', 'ta': 'ta', 'te': 'te', 'bn': 'bn', 'gu': 'gu', 'mr': 'mr', 'ml': 'ml', 'kn': 'kn' };
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
        async function getAIMedicalDetails(itemName, itemType) {
            const systemPrompt = `You are a helpful medical assistant for SwasthyaSaathi AI.
The user has set a reminder for a medicine or vaccine. Write a SHORT, friendly medical note (3-5 sentences) that includes:
1. What this medicine/vaccine is commonly used for
2. Key dosage or usage tip
3. One important safety note or side-effect to watch for

Use **bold** for section headings and keep it warm and easy to understand.`;
            const userPrompt = `Medicine/Vaccine: ${itemName}\nType: ${itemType}`;
            const messages = [
                { role: 'system', content: systemPrompt },
                { role: 'user', content: userPrompt }
            ];

            // 1. Step-3.5-flash (primary, same as chat)
            try {
                const r = await axios.post('https://openrouter.ai/api/v1/chat/completions', {
                    model: 'stepfun/step-3.5-flash:free', stream: false, messages
                }, { headers: { 'Authorization': `Bearer ${process.env.OPENROUTER_API_KEY}` } });
                const text = r.data.choices?.[0]?.message?.content?.trim();
                if (text) { console.log('[Reminder AI] step-3.5-flash responded'); return text; }
            } catch (e) { console.warn('[Reminder AI] step-3.5-flash failed:', e.message); }

            // 2. Qwen (secondary, same as chat)
            try {
                const r = await axios.post('https://openrouter.ai/api/v1/chat/completions', {
                    model: 'qwen/qwen3.6-plus-preview:free', stream: false, messages
                }, { headers: { 'Authorization': `Bearer ${process.env.OPENROUTER_API_KEY_2}` } });
                const text = r.data.choices?.[0]?.message?.content?.trim();
                if (text) { console.log('[Reminder AI] Qwen responded'); return text; }
            } catch (e) { console.warn('[Reminder AI] Qwen failed:', e.message); }

            // 3. Gemini (tertiary, same as chat)
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

            // 4. Llama (last resort, same as chat)
            try {
                const r = await axios.post('https://openrouter.ai/api/v1/chat/completions', {
                    model: 'meta-llama/llama-4-maverick:free', stream: false, messages
                }, { headers: { 'Authorization': `Bearer ${process.env.OPENROUTER_API_KEY}` } });
                const text = r.data.choices?.[0]?.message?.content?.trim();
                if (text) { console.log('[Reminder AI] Llama responded'); return text; }
            } catch (e) { console.warn('[Reminder AI] Llama failed:', e.message); }

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
// TEXT priority:       1. Step-3.5-flash  2. AgentRouter DeepSeek
//                      3. Qwen            4. Gemini direct   5. Llama
//
// IMAGE / VOICE:       Gemini first (only multimodal model in chain)
//                      → falls through to text chain if Gemini fails
//
app.post('/api/chat', async (req, res) => {
    try {
        const { messages } = req.body;

        if (!messages || !Array.isArray(messages)) {
            return res.status(400).json({ error: 'Valid messages array is required' });
        }

        // SSE headers
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');
        res.setHeader('X-Accel-Buffering', 'no');

        // ── Detect image / voice request ──────────────────────────────────────
        // voiceMode flag OR any message part with image_url / audio inlineData
        const isMultimodal = req.body.voiceMode === true || messages.some(m =>
            Array.isArray(m.content) && m.content.some(part =>
                part.type === 'image_url' ||
                (part.inlineData && part.inlineData.mimeType?.startsWith('audio'))
            )
        );
        console.log(`[Router] ${isMultimodal ? '🖼️  MULTIMODAL (image/voice)' : '💬 TEXT'} request received`);

        // ── HELPER: stream Groq (OpenAI-compatible, Lightning Fast) ───────────
        async function streamGroq(modelName) {
            const GROQ_KEY = process.env.GROQ_API_KEY || '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';
            const resp = await fetch('https://api.groq.com/openai/v1/chat/completions', {
                method: 'POST',
                headers: { 'Authorization': `Bearer ${GROQ_KEY}`, 'Content-Type': 'application/json' },
                body: JSON.stringify({ model: modelName, messages, stream: true })
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

            const resp = await fetch(`${AR_BASE}/chat/completions`, {
                method: 'POST',
                headers: { 'Authorization': `Bearer ${AR_KEY}`, 'Content-Type': 'application/json' },
                body: JSON.stringify({ model: modelName, messages, stream: true })
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
                const postData = JSON.stringify({ model: modelName, messages, stream: true });
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
        for (const model of ['llama-3.3-70b-versatile', 'llama3-8b-8192']) {
            try {
                console.log(`[1/6] Groq ${model} (Lightning Fast)...`);
                await streamGroq(model);
                console.log(`✅ [1/6] Groq ${model} responded!`);
                return;
            } catch (err) { console.warn(`❌ [1/6] Groq ${model}: ${err.message}`); }
        }

        // 2. Step-3.5-flash  (best standard text replies)
        try {
            console.log('[2/6] stepfun/step-3.5-flash:free  (OpenRouter)...');
            const orRes = await connectOpenRouter('stepfun/step-3.5-flash:free', process.env.OPENROUTER_API_KEY);
            console.log('✅ [2/6] step-3.5-flash responded!');
            await pipeOpenRouter(orRes);
            return;
        } catch (err) { console.warn(`❌ [2/6] step-3.5-flash: ${err.message}`); }

        // 3. AgentRouter — DeepSeek  (r1-0528 → v3.2 → v3.1)
        for (const model of ['deepseek-r1-0528', 'deepseek-v3.2', 'deepseek-v3.1']) {
            try {
                console.log(`[3/6] AgentRouter / ${model}...`);
                await streamAgentRouter(model);
                console.log(`✅ [3/6] AgentRouter/${model} responded!`);
                return;
            } catch (err) { console.warn(`❌ [3/6] AgentRouter/${model}: ${err.message}`); }
        }

        // 4. Qwen
        try {
            console.log('[4/6] qwen/qwen3.6-plus-preview:free  (OpenRouter)...');
            const orRes = await connectOpenRouter('qwen/qwen3.6-plus-preview:free', process.env.OPENROUTER_API_KEY_2);
            console.log('✅ [4/6] Qwen responded!');
            await pipeOpenRouter(orRes);
            return;
        } catch (err) { console.warn(`❌ [4/6] Qwen: ${err.message}`); }

        // 5. Gemini direct  (text fallback — always agrees to plain text)
        try {
            console.log('[5/6] Gemini direct (text fallback)...');
            await streamGemini();
            console.log('✅ [5/6] Gemini text fallback responded!');
            return;
        } catch (err) { console.warn(`❌ [5/6] Gemini: ${err.message}`); }

        // 6. Llama  (last resort)
        try {
            console.log('[6/6] meta-llama/llama-4-maverick:free  (last resort)...');
            const orRes = await connectOpenRouter('meta-llama/llama-4-maverick:free', process.env.OPENROUTER_API_KEY);
            console.log('✅ [6/6] Llama responded!');
            await pipeOpenRouter(orRes);
            return;
        } catch (err) { console.warn(`❌ [6/6] Llama: ${err.message}`); }

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
            model: "stepfun/step-3.5-flash:free",
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
