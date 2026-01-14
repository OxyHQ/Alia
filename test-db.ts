
import mongoose from 'mongoose';
import * as dotenv from 'dotenv';
dotenv.config();

const uri = process.env.MONGODB_URI;

console.log('Testing MongoDB connection...');
console.log(`URI length: ${uri?.length}`);

if (!uri) {
  console.error('MONGODB_URI is not defined');
  process.exit(1);
}

// Set a shorter timeout for testing
const options = {
  serverSelectionTimeoutMS: 5000,
  socketTimeoutMS: 5000,
};

mongoose.connect(uri, options)
  .then(() => {
    console.log('Successfully connected to MongoDB!');
    return mongoose.connection.close();
  })
  .then(() => {
    console.log('Connection closed.');
    process.exit(0);
  })
  .catch((err) => {
    console.error('Connection failed:', err);
    process.exit(1);
  });
