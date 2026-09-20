// check_keys.mjs — SwasthyaSaathi API Key Diagnostic
// Run: node check_keys.mjs
import 'dotenv/config';

const results = [];

function log(name, ok, detail = '') {
    const icon = ok ? '✅' : '❌';
    const msg = `${icon} ${name}${detail ? ' — ' + detail : ''}`;
    console.log(msg);
    results.push({ name, ok, detail });
}

async function testGroq() {
    const key = process.env.GROQ_API_KEY;
    if (!key) { log('Groq', false, 'GROQ_API_KEY not set'); return; }
    try {
        const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ model: 'llama-3.1-8b-instant', messages: [{ role: 'user', content: 'hi' }], max_tokens: 5 })
        });
        if (r.ok) { log('Groq (GROQ_API_KEY)', true, `HTTP ${r.status}`); }
        else { const t = await r.text(); log('Groq (GROQ_API_KEY)', false, `HTTP ${r.status}: ${t.slice(0, 120)}`); }
    } catch (e) { log('Groq (GROQ_API_KEY)', false, e.message); }
}

async function testGemini() {
    const key = process.env.GEMINI_API_KEY;
    if (!key) { log('Gemini', false, 'GEMINI_API_KEY not set'); return; }
    try {
        const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${key}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: 'hi' }] }] })
        });
        if (r.ok) { log('Gemini (GEMINI_API_KEY)', true, `HTTP ${r.status}`); }
        else { const t = await r.text(); log('Gemini (GEMINI_API_KEY)', false, `HTTP ${r.status}: ${t.slice(0, 120)}`); }
    } catch (e) { log('Gemini (GEMINI_API_KEY)', false, e.message); }
}

async function testOpenRouter(envVar) {
    const key = process.env[envVar];
    if (!key) { log(`OpenRouter (${envVar})`, false, `${envVar} not set`); return; }
    try {
        const r = await fetch('https://openrouter.ai/api/v1/chat/completions', {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ model: 'google/gemma-4-31b-it:free', messages: [{ role: 'user', content: 'hi' }], max_tokens: 5 })
        });
        if (r.ok) { log(`OpenRouter (${envVar})`, true, `HTTP ${r.status}`); }
        else { const t = await r.text(); log(`OpenRouter (${envVar})`, false, `HTTP ${r.status}: ${t.slice(0, 150)}`); }
    } catch (e) { log(`OpenRouter (${envVar})`, false, e.message); }
}

async function testSarvam() {
    const key = process.env.SARVAM_API_KEY;
    if (!key) { log('Sarvam AI', false, 'SARVAM_API_KEY not set'); return; }
    try {
        // Test TTS endpoint with a tiny request
        const r = await fetch('https://api.sarvam.ai/text-to-speech/stream', {
            method: 'POST',
            headers: { 'api-subscription-key': key, 'Content-Type': 'application/json' },
            body: JSON.stringify({ text: 'Hi', target_language_code: 'en-IN', speaker: 'shubh', model: 'bulbul:v3' })
        });
        if (r.ok) { log('Sarvam AI (SARVAM_API_KEY)', true, `HTTP ${r.status}`); }
        else { const t = await r.text(); log('Sarvam AI (SARVAM_API_KEY)', false, `HTTP ${r.status}: ${t.slice(0, 120)}`); }
    } catch (e) { log('Sarvam AI (SARVAM_API_KEY)', false, e.message); }
}

async function testAgentRouter() {
    const key = process.env.AGENTROUTER_API_KEY;
    const base = process.env.AGENTROUTER_BASE_URL;
    if (!key || !base) { log('AgentRouter', false, `${!key ? 'AGENTROUTER_API_KEY' : 'AGENTROUTER_BASE_URL'} not set`); return; }
    try {
        const r = await fetch(`${base}/chat/completions`, {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ model: 'deepseek-v3.2', messages: [{ role: 'user', content: 'hi' }], max_tokens: 5 })
        });
        if (r.ok) { log('AgentRouter (AGENTROUTER_API_KEY)', true, `HTTP ${r.status}`); }
        else { const t = await r.text(); log('AgentRouter (AGENTROUTER_API_KEY)', false, `HTTP ${r.status}: ${t.slice(0, 120)}`); }
    } catch (e) { log('AgentRouter (AGENTROUTER_API_KEY)', false, e.message); }
}

async function testSerpApi() {
    const key = process.env.SERPAPI_API_KEY;
    if (!key) { log('SerpApi', false, 'SERPAPI_API_KEY not set'); return; }
    try {
        const r = await fetch(`https://serpapi.com/account.json?api_key=${key}`);
        if (r.ok) { const j = await r.json(); log('SerpApi (SERPAPI_API_KEY)', true, `Account: ${j.email || 'ok'}, Credits: ${j.searches_left ?? 'n/a'}`); }
        else { const t = await r.text(); log('SerpApi (SERPAPI_API_KEY)', false, `HTTP ${r.status}: ${t.slice(0, 120)}`); }
    } catch (e) { log('SerpApi (SERPAPI_API_KEY)', false, e.message); }
}

async function testFoursquare() {
    const key = process.env.FOURSQUARE_API_KEY;
    if (!key) { log('Foursquare', false, 'FOURSQUARE_API_KEY not set'); return; }
    try {
        const r = await fetch('https://api.foursquare.com/v3/places/search?ll=28.6,77.2&limit=1', {
            headers: { 'Authorization': key, 'Accept': 'application/json' }
        });
        if (r.ok) { log('Foursquare (FOURSQUARE_API_KEY)', true, `HTTP ${r.status}`); }
        else { const t = await r.text(); log('Foursquare (FOURSQUARE_API_KEY)', false, `HTTP ${r.status}: ${t.slice(0, 120)}`); }
    } catch (e) { log('Foursquare (FOURSQUARE_API_KEY)', false, e.message); }
}

function checkEnvVars() {
    const vars = ['MONGODB_URI', 'MONGODB_URI_LOCAL', 'EMAIL_USER', 'EMAIL_PASS', 'JWT_SECRET', 'GOOGLE_CLIENT_ID', 'TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN'];
    for (const v of vars) {
        if (process.env[v]) { log(`${v}`, true, 'set'); }
        else { log(`${v}`, false, 'NOT SET'); }
    }
}

async function main() {
    console.log('\n🔍 SwasthyaSaathi — API Key Diagnostic\n' + '─'.repeat(50));
    await testGroq();
    await testGemini();
    await testOpenRouter('OPENROUTER_API_KEY');
    await testOpenRouter('OPENROUTER_API_KEY_2');
    await testSarvam();
    await testAgentRouter();
    await testSerpApi();
    await testFoursquare();
    checkEnvVars();

    const passed = results.filter(r => r.ok).length;
    const failed = results.filter(r => !r.ok);
    console.log('\n' + '─'.repeat(50));
    console.log(`📊 Summary: ${passed}/${results.length} OK`);
    if (failed.length) {
        console.log('\n🚨 FAILING / NOT SET:');
        failed.forEach(f => console.log(`   ❌ ${f.name}: ${f.detail}`));
    }
}

main().catch(console.error);
