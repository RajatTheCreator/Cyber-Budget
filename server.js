// ============================================================
// server.js — Montra Backend Server
// Express + MongoDB (via Mongoose) REST API
// Handles: Auth, Transactions, Budgets, Goals, Transfers, AI Chat
// ============================================================

// ── Core dependencies ────────────────────────────────────────
const express = require("express");        // Web framework
const cors = require("cors");           // Allow cross-origin requests from HTML frontend
const bcrypt = require("bcryptjs");       // Password hashing (replaces the insecure btoa used in frontend)
const jwt = require("jsonwebtoken");   // JSON Web Tokens for session auth
const mongoose = require("mongoose");       // MongoDB ODM (used for Schema definitions)
const Anthropic = require("@anthropic-ai/sdk"); // Claude AI SDK for the chat feature
require("dotenv").config();                   // Load .env variables (MONGO_URI, JWT_SECRET, ANTHROPIC_API_KEY, PORT)

// ── Internal modules ─────────────────────────────────────────
const connectDB = require("./db");           // Our MongoDB connector

// ── Initialize Express app ───────────────────────────────────
const app = express();
const PORT = process.env.PORT || 3000;        // Port from .env or default 3000

// ── Connect to MongoDB before anything else ──────────────────
connectDB();

// ============================================================
// MIDDLEWARE
// ============================================================

// Parse incoming JSON request bodies (req.body)
app.use(express.json());

// Allow the HTML frontend (served from a different origin/port) to call this API
app.use(cors({
  origin: "*",          // In production, replace * with your actual frontend URL
  methods: ["GET", "POST", "PUT", "DELETE"],
  allowedHeaders: ["Content-Type", "Authorization"],
}));

// Serve the frontend HTML file statically so opening localhost:3000 shows the app
// The HTML file must be in the same folder as server.js, named index.html
const path = require("path");
app.use(express.static(path.join(__dirname)));  // Serve index.html from the same directory

// ============================================================
// MONGOOSE SCHEMAS & MODELS
// Each Schema defines the shape of a MongoDB document (like a table in SQL)
// ============================================================

// ── User Schema ──────────────────────────────────────────────
// Stores registered user accounts
const userSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },           // Full name
    email: { type: String, required: true, unique: true, lowercase: true, trim: true }, // Login key
    password: { type: String, required: true },                       // bcrypt hashed password
    income: { type: Number, default: 0 },                           // Monthly income entered at registration
  },
  { timestamps: true } // Adds createdAt and updatedAt automatically
);
const User = mongoose.model("User", userSchema);

// ── Transaction Schema ───────────────────────────────────────
// Stores every income / expense / transfer entry
const transactionSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true }, // Owner reference
    type: { type: String, enum: ["income", "expense", "transfer"], required: true },
    title: { type: String, required: true, trim: true },
    amount: { type: Number, required: true, min: 0 },
    cat: { type: String, required: true },                         // Category slug e.g. "food", "salary"
    date: { type: String, required: true },                         // ISO date string "YYYY-MM-DD"
    note: { type: String, default: "" },
  },
  { timestamps: true }
);
const Transaction = mongoose.model("Transaction", transactionSchema);

// ── Budget Schema ────────────────────────────────────────────
// One document per user, holds a map of category → limit (INR)
const budgetSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, unique: true },
    categories: { type: Map, of: Number, default: {} },  // e.g. { food: 5000, transport: 2000 }
  },
  { timestamps: true }
);
const Budget = mongoose.model("Budget", budgetSchema);

// ── Goal Schema ──────────────────────────────────────────────
// Each savings goal is its own document
const goalSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    name: { type: String, required: true, trim: true },
    target: { type: Number, required: true, min: 1 },                   // Goal amount in INR
    saved: { type: Number, default: 0 },                               // Current saved amount
    date: { type: String },                                           // Target completion date "YYYY-MM-DD"
  },
  { timestamps: true }
);
const Goal = mongoose.model("Goal", goalSchema);

// ── Transfer Schema ──────────────────────────────────────────
// Tracks internal account-to-account transfers (separate from Transaction)
const transferSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    from: { type: String, required: true },   // Account slug e.g. "savings"
    to: { type: String, required: true },
    amount: { type: Number, required: true, min: 1 },
    note: { type: String, default: "" },
    date: { type: String, required: true },   // "YYYY-MM-DD"
  },
  { timestamps: true }
);
const Transfer = mongoose.model("Transfer", transferSchema);

// ============================================================
// AUTH MIDDLEWARE
// Protects all routes that need a logged-in user.
// Reads the JWT from the Authorization header: "Bearer <token>"
// ============================================================
const authMiddleware = (req, res, next) => {
  const authHeader = req.headers["authorization"]; // Get the Authorization header

  // Header must exist and start with "Bearer "
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return res.status(401).json({ error: "No token provided. Please log in." });
  }

  const token = authHeader.split(" ")[1]; // Extract token after "Bearer "

  try {
    // Verify the token using our secret key; throws if expired or tampered
    const decoded = jwt.verify(token, process.env.JWT_SECRET || "montra_secret_key");
    req.userId = decoded.userId; // Attach the user's MongoDB _id to request
    next();                       // Pass control to the actual route handler
  } catch (err) {
    return res.status(401).json({ error: "Invalid or expired token. Please log in again." });
  }
};

// ============================================================
// HELPER UTILITIES
// ============================================================

// Send a consistent error response with a message and optional dev detail
const sendError = (res, status, message, detail = null) => {
  const payload = { error: message };
  if (detail && process.env.NODE_ENV === "development") payload.detail = detail;
  return res.status(status).json(payload);
};

// ============================================================
// ROUTES — AUTHENTICATION
// POST /api/auth/register  →  Create new account
// POST /api/auth/login     →  Log in, get JWT
// ============================================================

// ── Register ─────────────────────────────────────────────────
app.post("/api/auth/register", async (req, res) => {
  try {
    const { name, email, password, income } = req.body;

    // Basic validation — all three fields are mandatory
    if (!name || !email || !password) {
      return sendError(res, 400, "Name, email and password are required.");
    }
    if (password.length < 6) {
      return sendError(res, 400, "Password must be at least 6 characters.");
    }

    // Check if the email is already taken
    const existing = await User.findOne({ email: email.toLowerCase() });
    if (existing) {
      return sendError(res, 409, "An account with this email already exists.");
    }

    // Hash the password with bcrypt (12 rounds = good security/speed balance)
    const hashedPassword = await bcrypt.hash(password, 12);

    // Save the new user to MongoDB
    const user = await User.create({
      name,
      email: email.toLowerCase(),
      password: hashedPassword,
      income: parseFloat(income) || 0,
    });

    // If the user entered an income, seed an initial salary transaction
    if (income && parseFloat(income) > 0) {
      await Transaction.create({
        userId: user._id,
        type: "income",
        title: "Monthly Salary",
        amount: parseFloat(income),
        cat: "salary",
        date: new Date().toISOString().slice(0, 10),
        note: "Initial income setup",
      });
    }

    // Sign a JWT valid for 7 days
    const token = jwt.sign(
      { userId: user._id },
      process.env.JWT_SECRET || "montra_secret_key",
      { expiresIn: "7d" }
    );

    // Return the token and basic profile (never return the password)
    res.status(201).json({
      token,
      user: { id: user._id, name: user.name, email: user.email, income: user.income },
    });
  } catch (err) {
    sendError(res, 500, "Registration failed.", err.message);
  }
});

// ── Login ────────────────────────────────────────────────────
app.post("/api/auth/login", async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return sendError(res, 400, "Email and password are required.");
    }

    // Find the user by email
    const user = await User.findOne({ email: email.toLowerCase() });
    if (!user) {
      return sendError(res, 401, "No account found with this email.");
    }

    // Compare submitted password with stored bcrypt hash
    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) {
      return sendError(res, 401, "Incorrect password.");
    }

    // Issue a fresh JWT
    const token = jwt.sign(
      { userId: user._id },
      process.env.JWT_SECRET || "montra_secret_key",
      { expiresIn: "7d" }
    );

    res.json({
      token,
      user: { id: user._id, name: user.name, email: user.email, income: user.income },
    });
  } catch (err) {
    sendError(res, 500, "Login failed.", err.message);
  }
});

// ── Get current user profile (auth required) ─────────────────
app.get("/api/auth/me", authMiddleware, async (req, res) => {
  try {
    // req.userId was set by authMiddleware; fetch user but exclude password field
    const user = await User.findById(req.userId).select("-password");
    if (!user) return sendError(res, 404, "User not found.");
    res.json(user);
  } catch (err) {
    sendError(res, 500, "Could not fetch profile.", err.message);
  }
});

// ============================================================
// ROUTES — TRANSACTIONS
// GET    /api/transactions       →  All transactions for logged-in user
// POST   /api/transactions       →  Create new transaction
// DELETE /api/transactions/:id   →  Delete a transaction by MongoDB _id
// ============================================================

// ── Get all transactions ──────────────────────────────────────
app.get("/api/transactions", authMiddleware, async (req, res) => {
  try {
    // Fetch only the current user's transactions, newest first
    const txns = await Transaction.find({ userId: req.userId }).sort({ date: -1, createdAt: -1 });
    res.json(txns);
  } catch (err) {
    sendError(res, 500, "Failed to fetch transactions.", err.message);
  }
});

// ── Create transaction ────────────────────────────────────────
app.post("/api/transactions", authMiddleware, async (req, res) => {
  try {
    const { type, title, amount, cat, date, note } = req.body;

    // Validate required fields
    if (!type || !title || !amount || !cat || !date) {
      return sendError(res, 400, "type, title, amount, cat and date are all required.");
    }
    if (!["income", "expense", "transfer"].includes(type)) {
      return sendError(res, 400, "type must be one of: income, expense, transfer.");
    }
    if (parseFloat(amount) <= 0) {
      return sendError(res, 400, "amount must be greater than 0.");
    }

    const txn = await Transaction.create({
      userId: req.userId,
      type,
      title: title.trim(),
      amount: parseFloat(amount),
      cat,
      date,
      note: note || "",
    });

    res.status(201).json(txn);
  } catch (err) {
    sendError(res, 500, "Failed to create transaction.", err.message);
  }
});

// ── Delete transaction ────────────────────────────────────────
app.delete("/api/transactions/:id", authMiddleware, async (req, res) => {
  try {
    // Find and delete — also verifies ownership via userId
    const txn = await Transaction.findOneAndDelete({ _id: req.params.id, userId: req.userId });
    if (!txn) return sendError(res, 404, "Transaction not found or not yours.");
    res.json({ message: "Transaction deleted.", id: req.params.id });
  } catch (err) {
    sendError(res, 500, "Failed to delete transaction.", err.message);
  }
});

// ============================================================
// ROUTES — BUDGETS
// GET  /api/budgets       →  Get budget map for user
// POST /api/budgets       →  Set or update a category budget
// DELETE /api/budgets/:cat → Remove one category budget
// ============================================================

// ── Get budgets ───────────────────────────────────────────────
app.get("/api/budgets", authMiddleware, async (req, res) => {
  try {
    const budget = await Budget.findOne({ userId: req.userId });
    // Return the categories map or an empty object if none set yet
    res.json(budget ? Object.fromEntries(budget.categories) : {});
  } catch (err) {
    sendError(res, 500, "Failed to fetch budgets.", err.message);
  }
});

// ── Set / update a category budget ───────────────────────────
app.post("/api/budgets", authMiddleware, async (req, res) => {
  try {
    const { cat, amount } = req.body;

    if (!cat || !amount || parseFloat(amount) <= 0) {
      return sendError(res, 400, "cat (category) and a positive amount are required.");
    }

    // findOneAndUpdate with upsert: creates the doc if it doesn't exist yet
    const budget = await Budget.findOneAndUpdate(
      { userId: req.userId },
      { $set: { [`categories.${cat}`]: parseFloat(amount) } }, // Set just this one category key
      { new: true, upsert: true }
    );

    res.json(Object.fromEntries(budget.categories));
  } catch (err) {
    sendError(res, 500, "Failed to set budget.", err.message);
  }
});

// ── Delete one category budget ────────────────────────────────
app.delete("/api/budgets/:cat", authMiddleware, async (req, res) => {
  try {
    const { cat } = req.params;

    const budget = await Budget.findOneAndUpdate(
      { userId: req.userId },
      { $unset: { [`categories.${cat}`]: "" } }, // Remove only this key from the map
      { new: true }
    );

    res.json(budget ? Object.fromEntries(budget.categories) : {});
  } catch (err) {
    sendError(res, 500, "Failed to delete budget.", err.message);
  }
});

// ============================================================
// ROUTES — GOALS
// GET    /api/goals       →  List all goals for user
// POST   /api/goals       →  Create a new goal
// PUT    /api/goals/:id   →  Update saved amount (or any field)
// DELETE /api/goals/:id   →  Delete a goal
// ============================================================

// ── Get all goals ─────────────────────────────────────────────
app.get("/api/goals", authMiddleware, async (req, res) => {
  try {
    const goals = await Goal.find({ userId: req.userId }).sort({ createdAt: -1 });
    res.json(goals);
  } catch (err) {
    sendError(res, 500, "Failed to fetch goals.", err.message);
  }
});

// ── Create goal ───────────────────────────────────────────────
app.post("/api/goals", authMiddleware, async (req, res) => {
  try {
    const { name, target, saved, date } = req.body;

    if (!name || !target || parseFloat(target) <= 0) {
      return sendError(res, 400, "name and a positive target amount are required.");
    }

    const goal = await Goal.create({
      userId: req.userId,
      name: name.trim(),
      target: parseFloat(target),
      saved: parseFloat(saved) || 0,
      date: date || "",
    });

    res.status(201).json(goal);
  } catch (err) {
    sendError(res, 500, "Failed to create goal.", err.message);
  }
});

// ── Update goal (e.g. update saved amount) ────────────────────
app.put("/api/goals/:id", authMiddleware, async (req, res) => {
  try {
    const updates = req.body; // Accept any subset of fields to update

    // Prevent changing the userId via this endpoint
    delete updates.userId;

    const goal = await Goal.findOneAndUpdate(
      { _id: req.params.id, userId: req.userId }, // Ownership check
      { $set: updates },
      { new: true } // Return the updated document
    );

    if (!goal) return sendError(res, 404, "Goal not found or not yours.");
    res.json(goal);
  } catch (err) {
    sendError(res, 500, "Failed to update goal.", err.message);
  }
});

// ── Delete goal ───────────────────────────────────────────────
app.delete("/api/goals/:id", authMiddleware, async (req, res) => {
  try {
    const goal = await Goal.findOneAndDelete({ _id: req.params.id, userId: req.userId });
    if (!goal) return sendError(res, 404, "Goal not found or not yours.");
    res.json({ message: "Goal deleted.", id: req.params.id });
  } catch (err) {
    sendError(res, 500, "Failed to delete goal.", err.message);
  }
});

// ============================================================
// ROUTES — TRANSFERS
// GET  /api/transfers  →  List transfer history for user
// POST /api/transfers  →  Record a new transfer
// ============================================================

// ── Get transfer history ──────────────────────────────────────
app.get("/api/transfers", authMiddleware, async (req, res) => {
  try {
    const transfers = await Transfer.find({ userId: req.userId }).sort({ createdAt: -1 });
    res.json(transfers);
  } catch (err) {
    sendError(res, 500, "Failed to fetch transfers.", err.message);
  }
});

// ── Create transfer ───────────────────────────────────────────
app.post("/api/transfers", authMiddleware, async (req, res) => {
  try {
    const { from, to, amount, note } = req.body;

    if (!from || !to || !amount || parseFloat(amount) <= 0) {
      return sendError(res, 400, "from, to and a positive amount are required.");
    }
    if (from === to) {
      return sendError(res, 400, "From and To accounts must be different.");
    }

    const today = new Date().toISOString().slice(0, 10);

    // Save the transfer record
    const transfer = await Transfer.create({
      userId: req.userId,
      from,
      to,
      amount: parseFloat(amount),
      note: note || "",
      date: today,
    });

    // Also insert a corresponding transaction so it shows in transaction history
    await Transaction.create({
      userId: req.userId,
      type: "transfer",
      title: `Transfer: ${from} → ${to}`,
      amount: parseFloat(amount),
      cat: "other",
      date: today,
      note: note || "",
    });

    res.status(201).json(transfer);
  } catch (err) {
    sendError(res, 500, "Failed to record transfer.", err.message);
  }
});

// ============================================================
// ROUTE — AI CHAT  (POST /chat)
// Receives a user message and replies using Claude claude-sonnet-4-20250514
// Reads conversation history from the request body for multi-turn context
// ============================================================
app.post("/chat", async (req, res) => {
  try {
    const { message, history = [] } = req.body;  // history = array of {role,content} objects

    if (!message || !message.trim()) {
      return sendError(res, 400, "message is required.");
    }

    // Initialise the Anthropic SDK client (picks up ANTHROPIC_API_KEY from .env)
    const client = new Anthropic();

    // Build the messages array: previous history + new user message
    const messages = [
      ...history,                            // Previous turns (role: user/assistant)
      { role: "user", content: message },    // The latest user input
    ];

    // Call Claude claude-sonnet-4-20250514 with a finance-focused system prompt
    const response = await client.messages.create({
      model: "claude-sonnet-4-20250514",  // Latest Sonnet model
      max_tokens: 1024,                         // Cap response length
      system: `You are SmartBudget AI, a helpful personal finance assistant built into the Montra app.
You help users with budgeting strategies, understanding their spending, savings tips, and financial planning.
Be concise, friendly, and practical. Use INR (Indian Rupee) as the currency. 
Never provide legal or investment advice — direct users to professionals for that.`,
      messages,
    });

    // Extract the text from the first content block
    const reply = response.content
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .join("\n");

    // Return the reply plus the updated history for the frontend to store
    res.json({
      reply,
      history: [
        ...messages,
        { role: "assistant", content: reply }, // Append assistant turn for next request
      ],
    });
  } catch (err) {
    console.error("AI Chat error:", err.message);
    sendError(res, 500, "AI service error. Check your ANTHROPIC_API_KEY.", err.message);
  }
});

// ============================================================
// ANALYTICS — summary endpoint (optional convenience)
// GET /api/analytics  →  Returns aggregated totals per month
// ============================================================
app.get("/api/analytics", authMiddleware, async (req, res) => {
  try {
    // Aggregate income and expense totals grouped by YYYY-MM
    const pipeline = [
      { $match: { userId: new mongoose.Types.ObjectId(req.userId) } },  // Only current user
      {
        $group: {
          _id: {
            month: { $substr: ["$date", 0, 7] },  // Extract "YYYY-MM" from date string
            type: "$type",
          },
          total: { $sum: "$amount" },
        },
      },
      { $sort: { "_id.month": 1 } },  // Chronological order
    ];

    const results = await Transaction.aggregate(pipeline);
    res.json(results);
  } catch (err) {
    sendError(res, 500, "Failed to compute analytics.", err.message);
  }
});

// ============================================================
// HEALTH CHECK — GET /api/health
// Quick ping to confirm the server and DB are both alive
// ============================================================
app.get("/api/health", (req, res) => {
  const dbState = ["disconnected", "connected", "connecting", "disconnecting"];
  res.json({
    status: "ok",
    server: "Montra API running",
    database: dbState[mongoose.connection.readyState] || "unknown",
    time: new Date().toISOString(),
  });
});

// ============================================================
// CATCH-ALL — serve index.html for any unknown route
// Allows the app to work when opened directly in browser
// ============================================================
app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

// ============================================================
// GLOBAL ERROR HANDLER
// Catches any unhandled errors thrown inside route handlers
// ============================================================
app.use((err, req, res, next) => {
  console.error("Unhandled error:", err.stack);
  res.status(500).json({ error: "Internal server error.", detail: err.message });
});

// ============================================================
// START SERVER
// ============================================================
app.listen(PORT, () => {
  console.log("=".repeat(52));
  console.log(`🚀 Montra server running at http://localhost:${PORT}`);
  console.log(`📡 API base URL       : http://localhost:${PORT}/api`);
  console.log(`💬 AI chat endpoint   : http://localhost:${PORT}/chat`);
  console.log(`🩺 Health check       : http://localhost:${PORT}/api/health`);
  console.log("=".repeat(52));
});

// ── Graceful shutdown on Ctrl+C ──────────────────────────────
process.on("SIGINT", async () => {
  console.log("\n🛑 Shutting down Montra server...");
  await mongoose.connection.close();     // Close DB connection cleanly
  console.log("✅ MongoDB connection closed.");
  process.exit(0);
});
