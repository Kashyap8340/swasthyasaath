// test_agent.js — runs 3 test queries against the local /api/chat endpoint
import http from 'http';

const tests = [
  {
    name: "Test 1: Basic health query",
    messages: [
      { role: "system", content: "You are a helpful health assistant." },
      { role: "user",   content: "What are the symptoms of dengue fever? Give a short 3-point answer." }
    ]
  },
  {
    name: "Test 2: Medication advice",
    messages: [
      { role: "system", content: "You are a helpful health assistant." },
      { role: "user",   content: "Is paracetamol safe for children? One sentence please." }
    ]
  },
  {
    name: "Test 3: Multi-turn conversation",
    messages: [
      { role: "system",    content: "You are a helpful health assistant." },
      { role: "user",      content: "I have a headache." },
      { role: "assistant", content: "I'm sorry to hear that. How long have you had it?" },
      { role: "user",      content: "Since this morning. What could it be? Short answer." }
    ]
  }
];

async function runTest(test) {
  return new Promise((resolve) => {
    console.log(`\n${'='.repeat(60)}`);
    console.log(`▶ ${test.name}`);
    console.log('='.repeat(60));

    const body = JSON.stringify({ messages: test.messages });
    let fullResponse = "";
    let tokenCount = 0;
    const startTime = Date.now();

    const req = http.request({
      hostname: 'localhost',
      port: 3000,
      path: '/api/chat',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body)
      }
    }, (res) => {
      console.log(`HTTP Status: ${res.statusCode}`);
      let buffer = "";

      res.on('data', (chunk) => {
        buffer += chunk.toString('utf-8');
        const lines = buffer.split('\n');
        buffer = lines.pop();

        for (const line of lines) {
          if (line.startsWith('data: ') && line !== 'data: [DONE]') {
            try {
              const parsed = JSON.parse(line.slice(6));
              if (parsed.content) {
                process.stdout.write(parsed.content);
                fullResponse += parsed.content;
                tokenCount++;
              }
              if (parsed.error) {
                console.log(`\n❌ ERROR: ${parsed.error}`);
              }
            } catch(e) {}
          }
        }
      });

      res.on('end', () => {
        const elapsed = ((Date.now() - startTime) / 1000).toFixed(2);
        console.log(`\n\n✅ RESULT: ${fullResponse.trim() ? 'SUCCESS' : 'EMPTY/FAILED'}`);
        console.log(`⏱  Time: ${elapsed}s | Chunks received: ${tokenCount}`);
        resolve({ success: !!fullResponse.trim(), time: elapsed, name: test.name });
      });
    });

    req.on('error', (e) => {
      console.log(`\n❌ Request failed: ${e.message}`);
      resolve({ success: false, name: test.name, error: e.message });
    });

    req.setTimeout(30000, () => {
      console.log('\n⌛ TIMEOUT after 30s');
      req.destroy();
      resolve({ success: false, name: test.name, error: 'timeout' });
    });

    req.write(body);
    req.end();
  });
}

async function main() {
  console.log('\n🧪 AgentRouter Test Suite — SwasthyaSaathi');
  console.log('🔗 Endpoint: http://localhost:3000/api/chat\n');

  const results = [];
  for (const test of tests) {
    const result = await runTest(test);
    results.push(result);
    await new Promise(r => setTimeout(r, 1000)); // small gap between tests
  }

  console.log('\n' + '='.repeat(60));
  console.log('📊 SUMMARY');
  console.log('='.repeat(60));
  for (const r of results) {
    const icon = r.success ? '✅' : '❌';
    console.log(`${icon} ${r.name} ${r.time ? `(${r.time}s)` : ''} ${r.error ? `— ${r.error}` : ''}`);
  }
  const passed = results.filter(r => r.success).length;
  console.log(`\nPassed: ${passed}/${results.length}`);
}

main();
