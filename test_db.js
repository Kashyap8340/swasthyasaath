import 'dotenv/config';
import mongoose from 'mongoose';

console.log("MONGODB_URI_LOCAL:", process.env.MONGODB_URI_LOCAL ? "Exists (length " + process.env.MONGODB_URI_LOCAL.length + ")" : "Undefined");
console.log("MONGODB_URI:", process.env.MONGODB_URI ? "Exists (length " + process.env.MONGODB_URI.length + ")" : "Undefined");

const uri = process.env.MONGODB_URI_LOCAL || process.env.MONGODB_URI;

mongoose.connect(uri, { family: 4 })
    .then(() => {
        console.log('✅ Connected successfully to', uri.substring(0, 30) + "...");
        process.exit(0);
    })
    .catch(err => {
        console.error('❌ Error:', err.message);
        process.exit(1);
    });
