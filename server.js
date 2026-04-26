const express = require("express");
const axios = require("axios");
const cron = require("node-cron");
const cors = require("cors");
const path = require("path");
const fs = require("fs"); // Thêm fs để quản lý file

const app = express();
app.use(cors());

/* 🔥 PORT FIX */
const PORT = process.env.PORT || 3000;

/* 🔥 SERVE FRONTEND */
app.use(express.static("public"));

/* 🔥 PATH CONFIG */
const DATA_DIR = path.join(__dirname, "data");
const DATA_FILE = path.join(DATA_DIR, "history.json");

// Đảm bảo thư mục data tồn tại
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

let latestData = null;

/* ===== CONFIG ===== */
const CONFIG = {
  TIMEOUT: 5000,
  RETRY: 2
};

/* ===== HELPER FETCH ===== */
async function fetchWithRetry(url) {
  for (let i = 0; i < CONFIG.RETRY; i++) {
    try {
      const res = await axios.get(url, {
        timeout: CONFIG.TIMEOUT,
        headers: { "User-Agent": "Mozilla/5.0" }
      });
      return res.data;
    } catch (e) {
      console.log(`⚠️ Retry ${i + 1} fail: ${url}`);
    }
  }
  return null;
}

/* ===== USD ===== */
async function getUSDRate() {
  try {
    console.log("🔎 Fetch USD từ webgia...");

    const html = await fetchWithRetry("https://webgia.com/ty-gia/vietcombank/");
    if (!html) throw "Fetch fail";

    const clean = html.replace(/\s+/g, " ");

    const nums = clean.match(/[0-9]{2,3}\.[0-9]{3},[0-9]{2}/g);

    if (!nums || nums.length === 0) throw "Không tìm thấy số";

    const values = nums.map(n =>
      parseFloat(n.replace(/\./g, "").replace(",", "."))
    );

    const usdValues = values.filter(v => v > 20000 && v < 30000);

    if (usdValues.length === 0) throw "Không có giá hợp lệ";

    return Math.max(...usdValues);

  } catch (e) {
    console.log("❌ USD fallback");
    return 26000;
  }
}

/* ===== XAU ===== */
async function getWorldGoldPrice() {
  try {
    const data = await fetchWithRetry("https://api.gold-api.com/price/XAU");

    if (data && data.price) return data.price;

    throw "API lỗi";
  } catch {
    return 2350;
  }
}

/* ===== SJC ===== */
async function getSJCPrice() {
  return 168800000;
}

/* ===== SAVE HISTORY ===== */
function saveHistory(entry) {
  try {
    let history = [];
    if (fs.existsSync(DATA_FILE)) {
      const fileData = fs.readFileSync(DATA_FILE, "utf-8");
      history = JSON.parse(fileData || "[]");
    }

    // Kiểm tra bản ghi cuối cùng để tránh lưu trùng dữ liệu liên tục
    const lastEntry = history[history.length - 1];
    if (!lastEntry || lastEntry.sjc !== entry.sjc || lastEntry.xau !== entry.xau) {
      history.push(entry);
      
      // Giữ lại tối đa 200 bản ghi để tránh file quá nặng
      if (history.length > 200) history.shift();

      fs.writeFileSync(DATA_FILE, JSON.stringify(history, null, 2));
      console.log("💾 Đã lưu vào data/history.json");
    }
  } catch (e) {
    console.log("❌ Lỗi lưu file history:", e);
  }
}

/* ===== UPDATE ===== */
async function updateData() {
  console.log("\n⏳ Updating...");

  try {
    const usd = await getUSDRate();
    const xau = await getWorldGoldPrice();
    const sjc = await getSJCPrice();

    const worldVND = xau * usd * (37.5 / 31.1035);
    const diff = sjc - worldVND;
    const percent = (diff / worldVND) * 100;

    latestData = {
      time: new Date().toLocaleString("vi-VN"), // Chuyển sang string để lưu json đẹp hơn
      usd,
      xau,
      sjc,
      worldVND: Math.round(worldVND),
      diff: Math.round(diff),
      percent: percent.toFixed(2) + "%"
    };

    saveHistory(latestData); // Thực hiện lưu vào file
    console.log("✅ DONE");

  } catch (e) {
    console.log("❌ UPDATE ERROR:", e);
  }
}

/* ===== CRON ===== */
cron.schedule("*/2 * * * *", updateData);

/* ===== API ===== */
app.get("/api/gold", (req, res) => {
  if (!latestData) {
    return res.json({ message: "No data yet, please wait..." });
  }
  res.json(latestData);
});

// Thêm API để frontend có thể lấy lịch sử từ file
app.get("/api/history", (req, res) => {
  if (fs.existsSync(DATA_FILE)) {
    const data = fs.readFileSync(DATA_FILE, "utf-8");
    res.json(JSON.parse(data || "[]"));
  } else {
    res.json([]);
  }
});

/* ===== ROOT (serve index.html) ===== */
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public/index.html"));
});

/* ===== START ===== */
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
  updateData();
});