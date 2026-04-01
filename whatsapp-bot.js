import pkg from 'whatsapp-web.js';
const { Client, LocalAuth, MessageMedia } = pkg;
import qrcode from 'qrcode';
import https from 'https';
import { exec } from 'child_process';
import * as googleTTS from 'google-tts-api';
import axios from 'axios';
import FormData from 'form-data';
import fs from 'fs';
import 'dotenv/config';

process.env.GROQ_API_KEY = "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";

// In-Memory global chat history for the bot
let chatHistory = [];
const MAX_HISTORY = 20;

// 1. Initialize WhatsApp Client
// We use LocalAuth so you only need to scan the QR code once.
const client = new Client({
    authStrategy: new LocalAuth(),
    puppeteer: {
        args: ['--no-sandbox', '--disable-setuid-sandbox'],
    }
});

// 2. Generate and Save QR Code
client.on('qr', (qr) => {
    console.log('Generating QR code image... please wait.');
    qrcode.toFile('qr.png', qr, {
        scale: 8,
        color: { dark: '#000000', light: '#FFFFFF' }
    }, (err) => {
        if (err) console.error('Error generating QR code:', err);
        else {
            console.log('========================================================');
            console.log('✅ QR Code image saved successfully!');
            console.log('👉 Opening the image automatically for scanning...');
            console.log('========================================================');
            // Auto open the image in Windows default viewer
            exec('start qr.png');
        }
    });
});

// 3. Client Ready
client.on('ready', () => {
    console.log('✅ Client is ready! Your 8340442589 number is now officially the SwasthyaSaathi AI bot!');
    console.log('Try sending a message to yourself (or having a friend text you) to see the AI reply.');
});

// 4. Listen for Messages
client.on('message', async (message) => {
    try {
        // TESTING MODE: ONLY respond to this specific phone number!
        // `message.from` usually looks like "919473473722@c.us". We check if it includes the base number.
        const allowedTestingNumber = '9473473722';
        if (!message.from.includes(allowedTestingNumber)) {
            console.log(`[Ignored] Message from ${message.from} (not the testing number).`);
            return;
        }

        // Restart Conversation Context manually
        if (message.body && message.body.trim().toLowerCase() === '/restart') {
            chatHistory = [];
            await message.reply("🔄 Conversation memory cleared! Let's start fresh. ✨");
            return;
        }

        // Prevent responding to groups unless specifically tagged or you want to (uncomment if you want groups)
        // const chat = await message.getChat();
        // if (chat.isGroup) return; 

        if (message.hasMedia) {
            const media = await message.downloadMedia();
            if (media.mimetype.includes('audio') || media.mimetype.includes('ogg')) {
                console.log(`[Received Voice] Transcribing...`);
                
                const chat = await message.getChat();
                chat.sendStateRecording();
                
                let step = "Transcribing STT";
                try {
                    const transcribedText = await transcribeAudio(media.data);
                    console.log(`[Transcribed] User said: ${transcribedText}`);
                    
                    step = "Generating AI Response";
                    const aiResponse = await getAIResponse(chatHistory, transcribedText, true);
                    console.log(`[AI Response] ${aiResponse}`);
                    
                    step = "Parsing Language & Clean Text";
                    let responseLang = 'en';
                    let cleanAiResponse = aiResponse;
                    const match = aiResponse.match(/^\[([a-zA-Z-]+)\]/);
                    if (match) {
                        responseLang = match[1].toLowerCase();
                        cleanAiResponse = aiResponse.replace(/^\[[a-zA-Z-]+\]\s*/, '').trim();
                    }

                    step = "Generating TTS Audio";
                    // Generate full audio response without the 199 character limit
                    const replyAudioBase64 = await generateAudioResponse(cleanAiResponse, responseLang);

                    step = "Sending WhatsApp Media";
                    const replyMedia = new MessageMedia('audio/mp3', replyAudioBase64, 'reply.mp3');
                    await message.reply(replyMedia, undefined, { sendAudioAsVoice: true });
                } catch (e) {
                    console.error("Audio processing failed at step:", step, e);
                    fs.writeFileSync('error.log', `Error at ${step}:\n${e.stack || e.toString()}`);
                    await message.reply(`Sorry! I broke at this step: ${step} 🎧❌`);
                }
                return;
            }
        }

        // We only respond to text messages for now
        if (message.body && typeof message.body === 'string') {
            console.log(`[Received] ${message.from}: ${message.body}`);

            // Show "typing..." indicator
            const chat = await message.getChat();
            chat.sendStateTyping();

            // Send to OpenRouter
            const aiResponse = await getAIResponse(chatHistory, message.body, false);

            // Reply to the user
            await message.reply(aiResponse);
            console.log(`[Sent] SwasthyaSaathi AI: ${aiResponse}`);
        }
    } catch (error) {
        console.error('Error processing message:', error);
        message.reply("Sorry, the AI is taking a quick break!");
    }
});

// Helper function to talk to OpenRouter completely exactly like Vercel backend
function getAIResponse(historyRef, userMessage, isVoice = false) {
    return new Promise((resolve, reject) => {
        let systemPrompt = "You are SwasthyaSaathi AI, a friendly, warm, and natural health assistant. Always use emojis. Talk like a friendly human on WhatsApp. IMPORTANT: You MUST reply in the EXACT SAME LANGUAGE the user messages you in (e.g. Hindi, English, Tamil, etc).";
        
        if (isVoice) {
            systemPrompt += " Since the user sent a voice message, YOUR text will be converted to speech. Keep your responses conversational and natural. ALSO: You MUST start your response with the 2-letter Google Translate language code in brackets. Example: '[hi] नमस्ते!' or '[ta] வணக்கம்!' or '[te] నమస్కారం!' or '[en] Hello!'";
        }

        // Push current message to memory
        historyRef.push({ role: "user", content: userMessage });
        if (historyRef.length > MAX_HISTORY) historyRef.splice(0, historyRef.length - MAX_HISTORY);

        const postData = JSON.stringify({
            model: "stepfun/step-3.5-flash:free",
            messages: [
                { role: "system", content: systemPrompt },
                ...historyRef
            ],
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

        const orReq = https.request(options, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                if (res.statusCode === 200) {
                    try {
                        const parsed = JSON.parse(data);
                        const answer = parsed.choices[0]?.message?.content || "AI Assistant is currently unavailable.";
                        
                        // Push AI answer back to memory
                        if (answer && answer !== "AI Assistant is currently unavailable.") {
                            // Strip localized bracket prefix before saving it so the AI doesn't get confused reading it next turn
                            let cleanForMemory = answer.replace(/^\[[a-zA-Z-]+\]\s*/, '').trim();
                            historyRef.push({ role: "assistant", content: cleanForMemory });
                        }

                        resolve(answer);
                    } catch (e) {
                        reject(e);
                    }
                } else {
                    reject(new Error(`API Error: ${data}`));
                }
            });
        });

        orReq.on('error', reject);
        orReq.write(postData);
        orReq.end();
    });
}

// Helper for TTS (Unlimited length via Edge-TTS Python wrapper)
async function generateAudioResponse(text, lang = 'en') {
    const safeText = text.replace(/[*_`#~>|]/g, '');
    const id = Date.now() + Math.random().toString(36).substring(7);
    const textFile = `temp_wa_${id}.txt`;
    const audioFile = `out_wa_${id}.mp3`;

    const voiceMap = {
        'en': 'en-IN-NeerjaNeural', 'hi': 'hi-IN-SwaraNeural',
        'ta': 'ta-IN-PallaviNeural', 'te': 'te-IN-ShrutiNeural',
        'bn': 'bn-IN-TanishaaNeural', 'gu': 'gu-IN-DhwaniNeural',
        'mr': 'mr-IN-AarohiNeural', 'ml': 'ml-IN-SobhanaNeural',
        'kn': 'kn-IN-SapnaNeural'
    };
    const voice = voiceMap[lang.toLowerCase()] || 'en-IN-NeerjaNeural';

    try {
        fs.writeFileSync(textFile, safeText, 'utf8');
        await new Promise((resolve, reject) => {
            exec(`edge-tts -f ${textFile} --voice ${voice} --write-media ${audioFile}`, (error) => {
                if (error) reject(error);
                else resolve();
            });
        });
        const base64Audio = fs.readFileSync(audioFile, { encoding: 'base64' });
        return base64Audio;
    } finally {
        if (fs.existsSync(textFile)) fs.unlinkSync(textFile);
        if (fs.existsSync(audioFile)) fs.unlinkSync(audioFile);
    }
}

// Helper for Groq STT (Whisper)
async function transcribeAudio(base64Data, retries = 1) {
    const buffer = Buffer.from(base64Data, 'base64');
    const formData = new FormData();
    formData.append('file', buffer, 'audio.ogg');
    formData.append('model', 'whisper-large-v3');

    try {
        const response = await axios.post('https://api.groq.com/openai/v1/audio/transcriptions', formData, {
            headers: {
                'Authorization': `Bearer ${process.env.GROQ_API_KEY}`,
                ...formData.getHeaders()
            }
        });

        return response.data.text;
    } catch (error) {
        if (retries > 0 && error.code === 'ECONNRESET') {
            console.log('🤖 [Retry] Groq API dropped connection (Cold Start). Retrying STT...');
            // Wait 1 second before retry
            await new Promise(resolve => setTimeout(resolve, 1000));
            return transcribeAudio(base64Data, retries - 1);
        }
        throw error;
    }
}

// 5. Start the bot
client.initialize();
