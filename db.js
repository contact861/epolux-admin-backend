// MongoDB Database Connection and Helper Functions
require("dotenv").config();
const { MongoClient } = require("mongodb");

const MONGODB_URI = process.env.MONGODB_URI || "";
const DB_NAME = process.env.MONGODB_DB_NAME || "epolux";
const PRODUCTS_COLLECTION = "products";
const STATIC_PRODUCTS_COLLECTION = "staticProducts";

let client = null;
let db = null;

// Connect to MongoDB with retry logic
async function connectDB(retries = 2) {
  if (db) {
    return db; // Already connected
  }

  if (!MONGODB_URI) {
    console.warn("⚠️ MONGODB_URI not set - MongoDB features disabled");
    throw new Error("MONGODB_URI environment variable is not set. Please configure it in Vercel Settings → Environment Variables.");
  }

  for (let attempt = 1; attempt <= retries + 1; attempt++) {
    try {
      console.log(`🔄 Attempting to connect to MongoDB (attempt ${attempt}/${retries + 1})...`);
      console.log("📍 Database name:", DB_NAME);
      console.log("🔗 Connection string present:", !!MONGODB_URI);
      console.log("🔗 Connection string starts with:", MONGODB_URI.substring(0, 20) + "...");
      
      client = new MongoClient(MONGODB_URI, {
        serverSelectionTimeoutMS: 10000,
        connectTimeoutMS: 15000
      });
      
      await client.connect();
      db = client.db(DB_NAME);
      
      // Test the connection
      await db.admin().ping();
      
      console.log("✅ Connected to MongoDB successfully");
      console.log("📊 Database:", DB_NAME);
      return db;
    } catch (err) {
      console.error(`❌ MongoDB connection error (attempt ${attempt}):`, err.message);
      if (err.message.includes("authentication")) {
        console.error("❌ Authentication failed - check username and password in connection string");
      } else if (err.message.includes("IP")) {
        console.error("❌ IP not whitelisted - add 0.0.0.0/0 in MongoDB Atlas Network Access");
      } else if (err.message.includes("timeout")) {
        console.error("❌ Connection timeout - check network connectivity");
      }
      
      if (attempt <= retries) {
        const delay = attempt * 1000; // Exponential backoff
        console.log(`⏳ Retrying in ${delay}ms...`);
        await new Promise(resolve => setTimeout(resolve, delay));
      } else {
        console.error("❌ All connection attempts failed");
        throw new Error(`Failed to connect to MongoDB after ${retries + 1} attempts: ${err.message}`);
      }
    }
  }
}

// Get database instance (connects if needed)
async function getDB() {
  if (!db) {
    await connectDB(); // This will throw if connection fails
  }
  return db;
}

// Products Collection Operations
async function getProducts() {
  try {
    const database = await getDB();
    if (!database) {
      console.error("Database connection not available");
      return [];
    }
    const collection = database.collection(PRODUCTS_COLLECTION);
    const products = await collection.find({}).toArray();
    return products.map(p => ({
      ...p,
      id: p.id || (p._id ? p._id.toString() : String(Math.random())),
      _id: undefined
    }));
  } catch (err) {
    console.error("Error getting products:", err.message || err);
    return [];
  }
}

async function getProductById(id) {
  try {
    const database = await getDB();
    const collection = database.collection(PRODUCTS_COLLECTION);
    const { ObjectId } = require("mongodb");
    
    let product = null;
    try {
      product = await collection.findOne({ _id: new ObjectId(id) });
    } catch (e) {
      product = await collection.findOne({ id: parseInt(id) });
    }
    
    if (product) {
      return {
        ...product,
        id: product._id ? product._id.toString() : product.id,
        _id: undefined
      };
    }
    return null;
  } catch (err) {
    console.error("Error getting product by ID:", err);
    return null;
  }
}

async function createProduct(product) {
  try {
    const database = await getDB();
    const collection = database.collection(PRODUCTS_COLLECTION);
    
    const existingProducts = await collection.find({}).toArray();
    const maxId = existingProducts.length > 0 
      ? Math.max(...existingProducts.map(p => p.id || 0))
      : 0;
    
    const newProduct = {
      id: maxId + 1,
      ...product,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
    
    const result = await collection.insertOne(newProduct);
    return {
      ...newProduct,
      id: newProduct.id.toString(),
      _id: result.insertedId.toString()
    };
  } catch (err) {
    console.error("Error creating product:", err);
    throw err;
  }
}

async function updateProduct(id, updates) {
  try {
    const database = await getDB();
    const collection = database.collection(PRODUCTS_COLLECTION);
    const { ObjectId } = require("mongodb");
    
    const updateData = {
      ...updates,
      updatedAt: new Date().toISOString()
    };
    
    let result = null;
    try {
      result = await collection.findOneAndUpdate(
        { _id: new ObjectId(id) },
        { $set: updateData },
        { returnDocument: "after" }
      );
    } catch (e) {
      result = await collection.findOneAndUpdate(
        { id: parseInt(id) },
        { $set: updateData },
        { returnDocument: "after" }
      );
    }
    
    if (result && result.value) {
      return {
        ...result.value,
        id: result.value._id ? result.value._id.toString() : result.value.id,
        _id: undefined
      };
    }
    return null;
  } catch (err) {
    console.error("Error updating product:", err);
    throw err;
  }
}

async function deleteProduct(id) {
  try {
    const database = await getDB();
    const collection = database.collection(PRODUCTS_COLLECTION);
    const { ObjectId } = require("mongodb");
    
    let result = null;
    try {
      result = await collection.findOneAndDelete({ _id: new ObjectId(id) });
    } catch (e) {
      result = await collection.findOneAndDelete({ id: parseInt(id) });
    }
    
    return result && result.value ? true : false;
  } catch (err) {
    console.error("Error deleting product:", err);
    throw err;
  }
}

// Static Products Collection Operations
async function getStaticProducts() {
  try {
    const database = await getDB();
    const collection = database.collection(STATIC_PRODUCTS_COLLECTION);
    const data = await collection.findOne({ _id: "config" });
    return data || { hidden: [] };
  } catch (err) {
    console.error("Error getting static products:", err);
    return { hidden: [] };
  }
}

async function saveStaticProducts(data) {
  try {
    const database = await getDB();
    const collection = database.collection(STATIC_PRODUCTS_COLLECTION);
    await collection.updateOne(
      { _id: "config" },
      { $set: { ...data, _id: "config" } },
      { upsert: true }
    );
    return true;
  } catch (err) {
    console.error("Error saving static products:", err);
    return false;
  }
}

// Close database connection
async function closeDB() {
  if (client) {
    await client.close();
    db = null;
    client = null;
    console.log("MongoDB connection closed");
  }
}

module.exports = {
  connectDB,
  getDB,
  getProducts,
  getProductById,
  createProduct,
  updateProduct,
  deleteProduct,
  getStaticProducts,
  saveStaticProducts,
  closeDB
};
