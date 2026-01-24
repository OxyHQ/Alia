/**
 * Script to generate RSA key pair for ActivityPub HTTP Signatures
 * Run with: npm run generate-keys
 */

import crypto from 'crypto';
import mongoose from 'mongoose';
import dotenv from 'dotenv';

dotenv.config();

// ActivityPub Key Model
const ActivityPubKeySchema = new mongoose.Schema({
  actor: { type: String, required: true, unique: true },
  publicKey: { type: String, required: true },
  privateKey: { type: String, required: true },
  createdAt: { type: Date, default: Date.now },
});

const ActivityPubKey = mongoose.model('ActivityPubKey', ActivityPubKeySchema);

async function generateKeys() {
  try {
    // Connect to MongoDB
    const mongoUri = process.env.MONGODB_URI || 'mongodb://localhost:27017/alia-api';
    await mongoose.connect(mongoUri);
    console.log('✅ Connected to MongoDB');

    // Check if keys already exist
    const existing = await ActivityPubKey.findOne({ actor: 'alia' });
    if (existing) {
      console.log('⚠️  Keys already exist for actor "alia"');
      console.log('Public Key:');
      console.log(existing.publicKey);

      const overwrite = process.argv.includes('--force');
      if (!overwrite) {
        console.log('\nUse --force to regenerate keys');
        process.exit(0);
      }
      console.log('🔄 Regenerating keys...');
      await ActivityPubKey.deleteOne({ actor: 'alia' });
    }

    // Generate RSA key pair (2048 bits is standard for ActivityPub)
    console.log('🔑 Generating RSA-2048 key pair...');
    const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', {
      modulusLength: 2048,
      publicKeyEncoding: {
        type: 'spki',
        format: 'pem',
      },
      privateKeyEncoding: {
        type: 'pkcs8',
        format: 'pem',
      },
    });

    // Save to database
    await ActivityPubKey.create({
      actor: 'alia',
      publicKey,
      privateKey,
    });

    console.log('✅ Keys generated and saved to database');
    console.log('\nPublic Key:');
    console.log(publicKey);
    console.log('\n⚠️  Private key is stored securely in the database');
    console.log('   DO NOT expose the private key publicly!');

    process.exit(0);
  } catch (error) {
    console.error('❌ Error generating keys:', error);
    process.exit(1);
  }
}

generateKeys();
