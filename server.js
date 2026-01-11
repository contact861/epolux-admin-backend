require("dotenv").config();
const express = require("express");
const cors = require("cors");
const stripe = require("stripe")(process.env.STRIPE_SECRET_KEY);
const multer = require("multer");
const path = require("path");
const fs = require("fs");

const app = express();
app.use(cors());
app.use(express.json());

// Serve uploaded images
app.use("/uploads", express.static(path.join(__dirname, "uploads")));

// Ensure uploads directory exists
const uploadsDir = path.join(__dirname, "uploads", "products");
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}

// Products data file
const productsFile = path.join(__dirname, "data", "products.json");
const dataDir = path.join(__dirname, "data");
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}
if (!fs.existsSync(productsFile)) {
  fs.writeFileSync(productsFile, JSON.stringify([], null, 2));
}

// Configure multer for file uploads
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, uploadsDir);
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + "-" + Math.round(Math.random() * 1e9);
    cb(null, uniqueSuffix + path.extname(file.originalname));
  }
});

const upload = multer({
  storage: storage,
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB limit
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
  const token = authHeader && authHeader.split(" ")[1]; // Bearer TOKEN
  
  if (!token) {
    return res.status(401).json({ error: "Authentication required" });
  }
  
  // Simple token check (in production, use JWT or session)
  const adminToken = process.env.ADMIN_TOKEN || "epolux-admin-2024";
  if (token !== adminToken) {
    return res.status(403).json({ error: "Invalid token" });
  }
  
  next();
};

// Helper functions
function getProducts() {
  try {
    const data = fs.readFileSync(productsFile, "utf8");
    return JSON.parse(data);
  } catch (err) {
    console.error("Error reading products:", err);
    return [];
  }
}

function saveProducts(products) {
  try {
    fs.writeFileSync(productsFile, JSON.stringify(products, null, 2));
    return true;
  } catch (err) {
    console.error("Error saving products:", err);
    return false;
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

// Get all products (public)
app.get("/api/products", (req, res) => {
  try {
    const products = getProducts();
    res.json(products);
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch products" });
  }
});

// Get single product (public)
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

// Create product (admin only)
app.post("/api/products", authenticate, upload.array("images", 20), (req, res) => {
  try {
    const { specs, translations } = req.body;
    
    if (!req.files || req.files.length === 0) {
      return res.status(400).json({ error: "At least one image is required" });
    }
    
    const products = getProducts();
    const newId = products.length > 0 ? Math.max(...products.map(p => p.id)) + 1 : 1;
    
    // Convert uploaded files to paths
    const imagePaths = req.files.map(file => `/uploads/products/${file.filename}`);
    
    const product = {
      id: newId,
      images: imagePaths,
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

// Update product (admin only)
app.put("/api/products/:id", authenticate, upload.array("images", 20), (req, res) => {
  try {
    const products = getProducts();
    const index = products.findIndex(p => p.id === parseInt(req.params.id));
    
    if (index === -1) {
      return res.status(404).json({ error: "Product not found" });
    }
    
    const { specs, translations, existingImages } = req.body;
    let imagePaths = [];
    
    // Keep existing images if provided
    if (existingImages) {
      imagePaths = JSON.parse(existingImages);
    }
    
    // Add new uploaded images
    if (req.files && req.files.length > 0) {
      const newImages = req.files.map(file => `/uploads/products/${file.filename}`);
      imagePaths = [...imagePaths, ...newImages];
    }
    
    if (imagePaths.length === 0) {
      return res.status(400).json({ error: "At least one image is required" });
    }
    
    // Delete old images that are no longer used
    const oldImages = products[index].images;
    const imagesToDelete = oldImages.filter(img => !imagePaths.includes(img));
    imagesToDelete.forEach(imgPath => {
      const fullPath = path.join(__dirname, imgPath);
      if (fs.existsSync(fullPath)) {
        fs.unlinkSync(fullPath);
      }
    });
    
    products[index] = {
      ...products[index],
      images: imagePaths,
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

// Delete product (admin only)
app.delete("/api/products/:id", authenticate, (req, res) => {
  try {
    const products = getProducts();
    const index = products.findIndex(p => p.id === parseInt(req.params.id));
    
    if (index === -1) {
      return res.status(404).json({ error: "Product not found" });
    }
    
    // Delete associated image files
    products[index].images.forEach(imgPath => {
      const fullPath = path.join(__dirname, imgPath);
      if (fs.existsSync(fullPath)) {
        fs.unlinkSync(fullPath);
      }
    });
    
    products.splice(index, 1);
    saveProducts(products);
    
    res.json({ message: "Product deleted successfully" });
  } catch (err) {
    console.error("Error deleting product:", err);
    res.status(500).json({ error: "Failed to delete product" });
  }
});

// Create checkout session
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
      success_url: process.env.SUCCESS_URL || "http://localhost:5500/success.html",
      cancel_url: process.env.CANCEL_URL || "http://localhost:5500/cancel.html"
    });

    res.json({ url: session.url });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to create session" });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`Products API: http://localhost:${PORT}/api/products`);
  console.log(`Admin API: http://localhost:${PORT}/api/admin/login`);
});
