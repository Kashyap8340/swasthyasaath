const http = require('http');

const data = JSON.stringify({
    messages: [
        { role: "system", content: "You are SwasthyaSaathi AI, a compassionate doctor in a real-time voice call. Rules:\n1. Speak naturally and conversationally.\n2. NO Markdown, emojis, or bullet points.\n3. KEEP IT VERY SHORT (30-60 words max).\n4. Reply in the EXACT SAME LANGUAGE the user spoke, prefixed with the 2-letter lang code (e.g., [hi] or [en])." },
        { role: "user", content: "Hindi" }
    ],
    voiceMode: true
});

const options = {
    hostname: 'localhost',
    port: 3000,
    path: '/api/chat',
    method: 'POST',
    headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(data)
    }
};

const req = http.request(options, (res) => {
    console.log(`STATUS: ${res.statusCode}`);
    console.log(`HEADERS: ${JSON.stringify(res.headers)}`);
    res.setEncoding('utf8');
    res.on('data', (chunk) => {
        console.log(`BODY: ${chunk}`);
    });
    res.on('end', () => {
        console.log('No more data in response.');
    });
});

req.on('error', (e) => {
    console.error(`problem with request: ${e.message}`);
});

req.write(data);
req.end();
