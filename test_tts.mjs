import * as googleTTS from 'google-tts-api';
async function test() {
    try {
        console.log(Object.keys(googleTTS));
        const res = await googleTTS.getAllAudioBase64("Hello, this is a very long text to test the splitting capabilities of the Google TTS API. It should return multiple chunks if configured correctly. ".repeat(10), { lang: 'en', host: 'https://translate.google.com'});
        console.log("Chunks count: " + res.length);
        console.log("Keys on chunk: ", Object.keys(res[0]));
    } catch(err) {
        console.error("Error", err);
    }
}
test();
