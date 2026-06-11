const http = require('http');

const data = JSON.stringify({
    text: "Hello, this is a test.",
    lang: "en"
});

const options = {
    hostname: 'localhost',
    port: 3000,
    path: '/api/tts',
    method: 'POST',
    headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(data)
    }
};

const req = http.request(options, (res) => {
    console.log(`STATUS: ${res.statusCode}`);
    let body = '';
    res.on('data', (chunk) => { body += chunk; });
    res.on('end', () => {
        if (res.statusCode === 200) {
            const parsed = JSON.parse(body);
            console.log(`Audio Base64 Length: ${parsed.audioBase64 ? parsed.audioBase64.length : 'undefined'}`);
        } else {
            console.log(`Error Response: ${body}`);
        }
    });
});

req.on('error', (e) => {
    console.error(`problem with request: ${e.message}`);
});

req.write(data);
req.end();
