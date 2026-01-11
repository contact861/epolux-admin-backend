require("dotenv").config();
const express = require("express");
const cors = require("cors");
const stripe = require("stripe")(process.env.STRIPE_SECRET_KEY);
const shippo = require("shippo")(process.env.SHIPPO_API_KEY);
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const https = require("https");
const cloudinary = require("cloudinary").v2;

const app = express();
app.use(cors());
app.use(express.json());

// Cloudinary configuration
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET
});

// ✅ Initialize Shippo here 
// const shippoClient = shippo(process.env.SHIPPO_API_KEY);

// Products data file (use /tmp on Vercel, fallback to data dir locally)
const isVercel = process.env.VERCEL === "1";
const dataDir = isVercel ? "/tmp" : path.join(__dirname, "data");
const productsFile = path.join(dataDir, "products.json");

// Only try to create directory/files if not on Vercel (Vercel file system is read-only except /tmp)
if (!isVercel) {
  try {
    if (!fs.existsSync(dataDir)) {
      fs.mkdirSync(dataDir, { recursive: true });
    }
    if (!fs.existsSync(productsFile)) {
      fs.writeFileSync(productsFile, JSON.stringify([], null, 2));
    }
  } catch (err) {
    console.warn("Could not initialize data directory:", err.message);
  }
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

// Helper functions for products.json (in-memory for Vercel, file-based locally)
let productsData = [];

function getProducts() {
  if (isVercel) {
    return productsData;
  }
  try {
    if (fs.existsSync(productsFile)) {
      const data = fs.readFileSync(productsFile, "utf8");
      return JSON.parse(data);
    }
    return [];
  } catch (err) {
    console.error("Error reading products:", err);
    return [];
  }
}

function saveProducts(products) {
  if (isVercel) {
    productsData = products;
    return true;
  }
  try {
    fs.writeFileSync(productsFile, JSON.stringify(products, null, 2));
    return true;
  } catch (err) {
    console.error("Error saving products:", err);
    return false;
  }
}

// Helper functions for static products visibility (in-memory for Vercel)
let staticProductsData = { hidden: [] };

function getStaticProducts() {
  return staticProductsData;
}

function saveStaticProducts(data) {
  staticProductsData = data;
  return true;
}

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
app.get("/api/products", (req, res) => {
  try {
    const products = getProducts();
    res.json(products);
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch products" });
  }
});

// Get single product
app.get("/api/products/:id", (req, res) => {
  try {
    const products = getProducts();
    const product = products.find(p => p.id === parseInt(req.params.id));
    if (!product) {
      return res.status(404).json({ error: "Product not found" });
    }
    res.json(product);
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch product" });
  }
});

// Create product
app.post("/api/products", authenticate, upload.array("images", 20), async (req, res) => {
  try {
    const { specs, translations } = req.body;

    if (!req.files || req.files.length === 0) {
      return res.status(400).json({ error: "At least one image is required" });
    }

    const products = getProducts();
    const newId = products.length > 0 ? Math.max(...products.map(p => p.id)) + 1 : 1;

    const imageUrls = [];
    for (const file of req.files) {
      const url = await uploadToCloudinary(file.buffer);
      imageUrls.push(url);
    }

    const product = {
      id: newId,
      images: imageUrls,
      specs: JSON.parse(specs || "[]"),
      translations: JSON.parse(translations || "{}"),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };

    products.push(product);
    saveProducts(products);

    res.json({ product, message: "Product created successfully" });
  } catch (err) {
    console.error("Error creating product:", err);
    res.status(500).json({ error: "Failed to create product" });
  }
});

// Update product
app.put("/api/products/:id", authenticate, upload.array("images", 20), async (req, res) => {
  try {
    const products = getProducts();
    const index = products.findIndex(p => p.id === parseInt(req.params.id));

    if (index === -1) {
      return res.status(404).json({ error: "Product not found" });
    }

    const { specs, translations, existingImages } = req.body;
    let imageUrls = existingImages ? JSON.parse(existingImages) : [];

    const oldImages = products[index].images || [];

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

    products[index] = {
      ...products[index],
      images: imageUrls,
      specs: JSON.parse(specs || "[]"),
      translations: JSON.parse(translations || "{}"),
      updatedAt: new Date().toISOString()
    };

    saveProducts(products);
    res.json({ product: products[index], message: "Product updated successfully" });
  } catch (err) {
    console.error("Error updating product:", err);
    res.status(500).json({ error: "Failed to update product" });
  }
});

// Get static products visibility status (public)
app.get("/api/static-products", (req, res) => {
  try {
    const data = getStaticProducts();
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch static products status" });
  }
});

// Update static product visibility (admin only)
app.post("/api/static-products/toggle", authenticate, (req, res) => {
  try {
    const { productId } = req.body;
    if (!productId || !productId.startsWith("static-")) {
      return res.status(400).json({ error: "Invalid product ID" });
    }
    
    const data = getStaticProducts();
    const index = data.hidden.indexOf(productId);
    
    if (index === -1) {
      // Hide the product
      data.hidden.push(productId);
    } else {
      // Show the product
      data.hidden.splice(index, 1);
    }
    
    saveStaticProducts(data);
    res.json({ hidden: data.hidden, message: "Static product visibility updated" });
  } catch (err) {
    console.error("Error updating static product:", err);
    res.status(500).json({ error: "Failed to update static product" });
  }
});

// Delete product
app.delete("/api/products/:id", authenticate, async (req, res) => {
  try {
    const products = getProducts();
    const index = products.findIndex(p => p.id === parseInt(req.params.id));

    if (index === -1) {
      return res.status(404).json({ error: "Product not found" });
    }

    const product = products[index];

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

    products.splice(index, 1);
    saveProducts(products);

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
// Shippo: Get shipping rates
app.post("/shipping/rates", async (req, res) => {
  try {
    const { toAddress, weight } = req.body;

    const shipment = await shippo.shipment.create({
      ...
    });

    res.json(shipment.rates);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to fetch shipping rates" });
  }
});


// Shippo: Create shipping label
app.post("/shipping/label", async (req, res) => {
  try {
    const { rateId } = req.body;

    const transaction = await shippo.transaction.create({
      rate: rateId,
      label_file_type: "PDF",
      async: false
    });

    res.json({
      labelUrl: transaction.label_url,
      trackingNumber: transaction.tracking_number,
      trackingUrl: transaction.tracking_url_provider
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to create label" });
  }
});

// IMPORTANT: Export app for Vercel
module.exports = app;






