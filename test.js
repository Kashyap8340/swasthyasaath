import { OpenRouter } from "@openrouter/sdk";
import 'dotenv/config';

const openrouter = new OpenRouter({
  apiKey: process.env.OPENROUTER_API_KEY
});

async function main() {
  try {
    // Stream the response to get reasoning tokens in usage
    const stream = await openrouter.chat.send({
      chatGenerationParams: {
        model: "nvidia/nemotron-3-ultra-550b-a55b:free",
        messages: [
          {
            role: "user",
            content: "How many r's are in the word 'strawberry'?"
          }
        ],
        stream: true
      }
    });

    let response = "";
    for await (const chunk of stream) {
      const content = chunk.choices[0]?.delta?.content;
      if (content) {
        response += content;
        process.stdout.write(content);
      }

      // Usage information comes in the final chunk
      if (chunk.usage) {
        console.log("\nReasoning tokens:", chunk.usage.reasoningTokens || chunk.usage.reasoning_tokens || "N/A");
      }
    }
  } catch (e) {
    console.error("Openrouter Error:", e);
  }
}

main();
