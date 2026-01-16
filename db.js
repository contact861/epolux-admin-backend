require("dotenv").config();
const express = require("express");
const cors = require("cors");
const stripe = require("stripe")(process.env.STRIPE_SECRET_KEY);
const multer = require("multer");
const path = require("path");
const https = require("https");
const cloudinary = require("cloudinary").v2;
const {
  connectDB,
  getProducts,
  getProductById,
  createProduct,
  updateProduct,
  deleteProduct,
  getStaticProducts,
  saveStaticProducts
} = require("./db");

const app = express();
app.use(cors());
app.use(express.json());

// Cloudinary configuration
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET
});

// Initialize MongoDB connection on startup (only if MONGODB_URI is set)
if (process.env.MONGODB_URI) {
  connectDB().catch(err => {
    console.error("⚠️ Failed to connect to MongoDB on startup:", err.message);
    console.error("⚠️ Server will continue, but MongoDB operations will fail until connection is established");
    // Don't exit - allow server to start even if MongoDB fails (connection will be retried on first use)
  });
} else {
  console.warn("⚠️ MONGODB_URI not set - MongoDB features will not work");
  console.warn("⚠️ Please set MONGODB_URI in Vercel Settings → Environment Variables");
}

// Multer in-memory storage (for Cloudinary)
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowedTypes = /jpeg|jpg|png|webp/;
    const extname = allowedTypes.test(path.extname(file.originalname).toLowerCase());
    const mimetype = allowedTypes.test(file.mimetype);
    if (mimetype && extname) {
      return cb(null, true);
    } else {
      cb(new Error("Only image files are allowed (jpeg, jpg, png, webp)"));
    }
  }
});

// Simple authentication middleware
const authenticate = (req, res, next) => {
  const authHeader = req.headers.authorization;
  const token = authHeader && authHeader.split(" ")[1];

  if (!token) {
    return res.status(401).json({ error: "Authentication required" });
  }

  const adminToken = process.env.ADMIN_TOKEN || "epolux-admin-2024";
  if (token !== adminToken) {
    return res.status(403).json({ error: "Invalid token" });
  }

  next();
};

// Upload to Cloudinary
function uploadToCloudinary(fileBuffer) {
  return new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      { folder: "epolux/products" },
      (error, result) => {
        if (error) return reject(error);
        resolve(result.secure_url);
      }
    );
    stream.end(fileBuffer);
  });
}

// Extract Cloudinary public_id
function getCloudinaryPublicId(url) {
  try {
    const parts = url.split("/");
    const fileWithExt = parts.pop();
    const fileName = fileWithExt.split(".")[0];

    const uploadIndex = parts.indexOf("upload");
    let folderPath = "";
    if (uploadIndex !== -1 && uploadIndex < parts.length - 1) {
      folderPath = parts.slice(uploadIndex + 1).join("/");
    }

    return folderPath ? `${folderPath}/${fileName}` : fileName;
  } catch (err) {
    console.error("Error parsing Cloudinary public_id:", url, err);
    return null;
  }
}

// Test route
app.get("/", (req, res) => {
  res.send("Backend is running");
});

// Admin authentication
app.post("/api/admin/login", (req, res) => {
  const { password } = req.body;
  const adminPassword = process.env.ADMIN_PASSWORD || "epolux2024";

  if (password === adminPassword) {
    const token = process.env.ADMIN_TOKEN || "epolux-admin-2024";
    res.json({ token, message: "Login successful" });
  } else {
    res.status(401).json({ error: "Invalid password" });
  }
});

// Translation endpoint (using free MyMemory API)
app.post("/api/translate", (req, res) => {
  try {
    const { text, targetLang } = req.body;
    
    if (!text || !targetLang) {
      return res.status(400).json({ error: "Text and target language required" });
    }

    // Language codes mapping
    const langCodes = {
      "sl": "sl",  // Slovenian
      "de": "de",  // German
      "it": "it",  // Italian
      "sr": "sr"   // Serbian
    };

    const targetCode = langCodes[targetLang] || targetLang;
    
    // Use MyMemory Translation API (free, no API key needed)
    const url = `https://api.mymemory.translated.net/get?q=${encodeURIComponent(text)}&langpair=en|${targetCode}`;
    
    https.get(url, (apiRes) => {
      let data = "";
      
      apiRes.on("data", (chunk) => {
        data += chunk;
      });
      
      apiRes.on("end", () => {
        try {
          const parsedData = JSON.parse(data);
          
          if (parsedData.responseStatus === 200 && parsedData.responseData && parsedData.responseData.translatedText) {
            res.json({ translatedText: parsedData.responseData.translatedText });
          } else {
            res.status(500).json({ error: "Translation failed" });
          }
        } catch (parseErr) {
          console.error("Error parsing translation response:", parseErr);
          res.status(500).json({ error: "Translation service error" });
        }
      });
    }).on("error", (err) => {
      console.error("Translation API error:", err);
      res.status(500).json({ error: "Translation service error" });
    });
  } catch (err) {
    console.error("Translation error:", err);
    res.status(500).json({ error: "Translation service error" });
  }
});

// Get all products
app.get("/api/products", async (req, res) => {
  try {
    const products = await getProducts();
    res.json(products);
  } catch (err) {
    console.error("Error fetching products:", err);
    res.status(500).json({ error: "Failed to fetch products" });
  }
});

// Get single product
app.get("/api/products/:id", async (req, res) => {
  try {
    const product = await getProductById(req.params.id);
    if (!product) {
      return res.status(404).json({ error: "Product not found" });
    }
    res.json(product);
  } catch (err) {
    console.error("Error fetching product:", err);
    res.status(500).json({ error: "Failed to fetch product" });
  }
});

// Create product
app.post("/api/products", authenticate, upload.array("images", 20), async (req, res) => {
  try {
    console.log("📦 Creating product...");
    const { specs, translations } = req.body;

    if (!req.files || req.files.length === 0) {
      console.error("❌ No images provided");
      return res.status(400).json({ error: "At least one image is required" });
    }

    console.log(`📸 Uploading ${req.files.length} image(s) to Cloudinary...`);
    const imageUrls = [];
    for (const file of req.files) {
      try {
        const url = await uploadToCloudinary(file.buffer);
        imageUrls.push(url);
        console.log("✅ Image uploaded:", url);
      } catch (cloudErr) {
        console.error("❌ Cloudinary upload error:", cloudErr);
        return res.status(500).json({ error: `Failed to upload image: ${cloudErr.message}` });
      }
    }

    let parsedSpecs, parsedTranslations;
    try {
      parsedSpecs = JSON.parse(specs || "[]");
      parsedTranslations = JSON.parse(translations || "{}");
    } catch (parseErr) {
      console.error("❌ JSON parse error:", parseErr);
      return res.status(400).json({ error: `Invalid JSON data: ${parseErr.message}` });
    }

    // Extract publish flags from request body
    const publishFlags = {
      published: req.body.published === "true" || req.body.published === true,
      isPublished: req.body.isPublished === "true" || req.body.isPublished === true,
      active: req.body.active === "true" || req.body.active === true,
      isActive: req.body.isActive === "true" || req.body.isActive === true,
      visible: req.body.visible === "true" || req.body.visible === true,
      isVisible: req.body.isVisible === "true" || req.body.isVisible === true,
      status: req.body.status || "published"
    };

    const productData = {
      images: imageUrls,
      specs: parsedSpecs,
      translations: parsedTranslations,
      ...publishFlags
    };

    // Check MongoDB connection before creating product
    if (!process.env.MONGODB_URI) {
      console.error("❌ MONGODB_URI not set");
      return res.status(500).json({ 
        error: "Database not configured", 
        details: "MONGODB_URI environment variable is not set. Please configure it in Vercel Settings → Environment Variables." 
      });
    }

    console.log("💾 Saving product to MongoDB...");
    let product;
    try {
      product = await createProduct(productData);
    } catch (dbErr) {
      console.error("❌ Database error:", dbErr.message);
      if (dbErr.message.includes("MONGODB_URI")) {
        return res.status(500).json({ 
          error: "Database configuration error", 
          details: dbErr.message 
        });
      } else if (dbErr.message.includes("authentication")) {
        return res.status(500).json({ 
          error: "Database authentication failed", 
          details: "Check your MongoDB username and password in the connection string." 
        });
      } else if (dbErr.message.includes("IP") || dbErr.message.includes("whitelist")) {
        return res.status(500).json({ 
          error: "Database network error", 
          details: "Your IP is not whitelisted. Add 0.0.0.0/0 in MongoDB Atlas → Network Access." 
        });
      } else {
        return res.status(500).json({ 
          error: "Database connection failed", 
          details: dbErr.message 
        });
      }
    }
    
    if (!product) {
      console.error("❌ createProduct returned null");
      return res.status(500).json({ 
        error: "Failed to save product", 
        details: "Product creation returned null. Check MongoDB connection and logs." 
      });
    }
    
    console.log("✅ Product created successfully:", product.id);

    res.json({ product, message: "Product created successfully" });
  } catch (err) {
    console.error("❌ Error creating product:", err);
    console.error("❌ Error stack:", err.stack);
    res.status(500).json({ 
      error: "Failed to create product",
      details: err.message || String(err)
    });
  }
});

// Update product
app.put("/api/products/:id", authenticate, upload.array("images", 20), async (req, res) => {
  try {
    const existingProduct = await getProductById(req.params.id);

    if (!existingProduct) {
      return res.status(404).json({ error: "Product not found" });
    }

    const { specs, translations, existingImages } = req.body;
    let imageUrls = existingImages ? JSON.parse(existingImages) : [];

    const oldImages = existingProduct.images || [];

    if (req.files && req.files.length > 0) {
      for (const file of req.files) {
        const url = await uploadToCloudinary(file.buffer);
        imageUrls.push(url);
      }
    }

    if (imageUrls.length === 0) {
      return res.status(400).json({ error: "At least one image is required" });
    }

    const imagesToDelete = oldImages.filter(img => !imageUrls.includes(img));
    for (const url of imagesToDelete) {
      const publicId = getCloudinaryPublicId(url);
      if (publicId) {
        try {
          await cloudinary.uploader.destroy(publicId);
        } catch (err) {
          console.error("Error deleting Cloudinary image:", publicId, err);
        }
      }
    }

    const updates = {
      images: imageUrls,
      specs: JSON.parse(specs || "[]"),
      translations: JSON.parse(translations || "{}")
    };

    const updatedProduct = await updateProduct(req.params.id, updates);

    if (!updatedProduct) {
      return res.status(404).json({ error: "Product not found" });
    }

    res.json({ product: updatedProduct, message: "Product updated successfully" });
  } catch (err) {
    console.error("Error updating product:", err);
    res.status(500).json({ error: "Failed to update product" });
  }
});

// Get static products visibility status (public)
app.get("/api/static-products", async (req, res) => {
  try {
    const data = await getStaticProducts();
    res.json(data);
  } catch (err) {
    console.error("Error fetching static products:", err);
    res.status(500).json({ error: "Failed to fetch static products status" });
  }
});

// Update static product visibility (admin only)
app.post("/api/static-products/toggle", authenticate, async (req, res) => {
  try {
    const { productId } = req.body;
    if (!productId) {
      return res.status(400).json({ error: "Product ID is required" });
    }
    
    const data = await getStaticProducts();
    const hidden = data.hidden || [];
    const index = hidden.indexOf(String(productId));
    
    if (index === -1) {
      // Hide the product
      hidden.push(String(productId));
    } else {
      // Show the product
      hidden.splice(index, 1);
    }
    
    await saveStaticProducts({ hidden });
    res.json({ hidden, message: "Product visibility updated" });
  } catch (err) {
    console.error("Error updating static product:", err);
    res.status(500).json({ error: "Failed to update static product" });
  }
});

// Delete product
app.delete("/api/products/:id", authenticate, async (req, res) => {
  try {
    const product = await getProductById(req.params.id);

    if (!product) {
      return res.status(404).json({ error: "Product not found" });
    }

    if (product.images && product.images.length > 0) {
      for (const url of product.images) {
        const publicId = getCloudinaryPublicId(url);
        if (publicId) {
          try {
            await cloudinary.uploader.destroy(publicId);
          } catch (err) {
            console.error("Error deleting Cloudinary image:", publicId, err);
          }
        }
      }
    }

    const deleted = await deleteProduct(req.params.id);

    if (!deleted) {
      return res.status(404).json({ error: "Product not found" });
    }

    res.json({ message: "Product deleted successfully" });
  } catch (err) {
    console.error("Error deleting product:", err);
    res.status(500).json({ error: "Failed to delete product" });
  }
});

// Stripe checkout
app.post("/create-checkout-session", async (req, res) => {
  const cart = req.body.cart;

  try {
    const line_items = cart.map(item => ({
      price_data: {
        currency: "eur",
        product_data: { name: item.name },
        unit_amount: Math.round(item.price * 100)
      },
      quantity: 1
    }));

    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      line_items,
      shipping_address_collection: {
        allowed_countries: ["SI", "HR", "AT", "DE", "IT"]
      },
      success_url: process.env.SUCCESS_URL,
      cancel_url: process.env.CANCEL_URL
    });

    res.json({ url: session.url });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to create session" });
  }
});

// IMPORTANT: Export app for Vercel
module.exports = app;

// For local development, start the server
if (require.main === module) {
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
    console.log(`Products API: http://localhost:${PORT}/api/products`);
    console.log(`Admin API: http://localhost:${PORT}/api/admin/login`);
  });
}
