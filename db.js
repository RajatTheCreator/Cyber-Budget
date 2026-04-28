// ============================================================
// db.js — MongoDB Connection Manager for Montra
// Handles connecting to MongoDB using Mongoose.
// Import this file wherever DB access is needed (e.g. server.js)
// ============================================================

const mongoose = require("mongoose"); // Mongoose ODM for MongoDB

// ── Load environment variables from .env file ───────────────
require("dotenv").config();

// ── MongoDB connection URI from .env (falls back to local) ──
const MONGO_URI = process.env.MONGO_URI || "mongodb://127.0.0.1:27017/montra";

// ── connectDB: call this once at app startup ─────────────────
const connectDB = async () => {
  try {
    const conn = await mongoose.connect(MONGO_URI, {
      // These options suppress deprecation warnings in Mongoose 6+
      useNewUrlParser: true,
      useUnifiedTopology: true,
    });

    console.log(`✅ MongoDB Connected: ${conn.connection.host}`);
    console.log(`📦 Database Name   : ${conn.connection.name}`);
  } catch (error) {
    // Print the error clearly and exit — app cannot run without DB
    console.error("❌ MongoDB connection failed:", error.message);
    process.exit(1); // Exit with failure code
  }
};

// ── Handle connection events after initial connect ───────────

// Fires if the connection is lost after a successful connect
mongoose.connection.on("disconnected", () => {
  console.warn("⚠️  MongoDB disconnected. Attempting to reconnect...");
});

// Fires when reconnection succeeds
mongoose.connection.on("reconnected", () => {
  console.log("🔄 MongoDB reconnected successfully.");
});

// Fires on any connection error
mongoose.connection.on("error", (err) => {
  console.error("❌ MongoDB runtime error:", err.message);
});

// ── Export the connect function for use in server.js ─────────
module.exports = connectDB;
