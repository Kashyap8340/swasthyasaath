import gTTS from 'gtts';
import fs from 'fs';

async function test() {
    try {
        const textToSpeech = new gTTS("Hello, this is a very long text to test the splitting capabilities of the Google TTS API. It should handle chunks internally without creating malformed MP3s! ".repeat(10), 'en');
        textToSpeech.save('test_gtts.mp3', function (err, result) {
            if(err) { throw new Error(err); }
            console.log("Success! File saved.");
            const base64 = fs.readFileSync('test_gtts.mp3', { encoding: 'base64' });
            console.log("Base64 length: " + base64.length);
        });
    } catch(err) {
        console.error("Error", err);
    }
}
test();
