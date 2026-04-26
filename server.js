const express = require("express");
const axios = require("axios");
const cron = require("node-cron");
const cors = require("cors");
const path = require("path");
const fs = require("fs");

const app = express();
app.use(cors());

// Phục vụ các file tĩnh từ thư mục "public"
app.use(express.static(path.join(__dirname, "public")));

// Render cung cấp biến PORT qua biến môi trường
const PORT = process.env.PORT || 3000;
const DATA_PATH = path.join(__dirname, "history", "data.json");

// Đảm bảo thư mục history tồn tại để không bị lỗi khi ghi file
const historyDir = path.join(__dirname, "history");
if (!fs.existsSync(historyDir)) {
  fs.mkdirSync(historyDir, { recursive: true });
}

let latestData = null;

// Hàm lưu lịch sử vào file JSON
function saveToHistory(entry) {
  let history = [];
  try {
    if (fs.existsSync(DATA_PATH)) {
      const fileContent = fs.readFileSync(DATA_PATH, "utf-8");
      history = JSON.parse(fileContent || "[]");
    }
    
    const lastEntry = history[history.length - 1];
    // Tránh lưu dữ liệu trùng lặp nếu giá không đổi
    if (!lastEntry || lastEntry.sjc !== entry.sjc || lastEntry.xau !== entry.xau) {
      history.push(entry);
      if (history.length > 200) history.shift();
      fs.writeFileSync(DATA_PATH, JSON.stringify(history, null, 2));
    }
  } catch (e) {
    console.error("❌ Lỗi ghi file history:", e);
  }
}

async function getUSDRate() {
  try {
    const res = await axios.get("https://webgia.com/ty-gia/vietcombank/", { timeout: 8000 });
    const clean = res.data.replace(/\s+/g, " ");
    const nums = clean.match(/[0-9]{2,3}\.[0-9]{3},[0-9]{2}/g);
    if (!nums) throw new Error("No USD rate found");
    const values = nums.map(n => parseFloat(n.replace(/\./g, "").replace(",", ".")));
    return Math.max(...values.filter(v => v > 20000 && v < 30000));
  } catch (e) {
    return 25500; // Giá USD dự phòng
  }
}

async function getWorldGoldPrice() {
  try {
    const res = await axios.get("https://api.gold-api.com/price/XAU");
    return res.data.price || 2350;
  } catch {
    return 2350;
  }
}

async function updateData() {
  console.log("⏳ Đang fetch dữ liệu mới...");
  try {
    const usd = await getUSDRate();
    const xau = await getWorldGoldPrice();
    const sjc = 85000000; // Thay thế bằng logic lấy giá SJC thật nếu có

    const worldVND = xau * usd * (37.5 / 31.1035);
    const diff = sjc - worldVND;
    const percent = (diff / worldVND) * 100;

    latestData = {
      time: new Date().toLocaleString("vi-VN", { timeZone: "Asia/Ho_Chi_Minh" }),
      usd, xau, sjc,
      worldVND: Math.round(worldVND),
      diff: Math.round(diff),
      percent: percent.toFixed(2) + "%"
    };

    saveToHistory(latestData);
    console.log("✅ Cập nhật hoàn tất lúc:", latestData.time);
  } catch (e) {
    console.error("❌ Lỗi trong quá trình update:", e.message);
  }
}

// Chạy cron job mỗi 2 phút
cron.schedule("*/2 * * * *", updateData);

// API endpoints
app.get("/api/gold", async (req, res) => {
  if (req.query.t) await updateData();
  res.json(latestData || { message: "Đang khởi tạo dữ liệu..." });
});

app.get("/api/history", (req, res) => {
  try {
    if (fs.existsSync(DATA_PATH)) {
      const data = fs.readFileSync(DATA_PATH, "utf-8");
      return res.json(JSON.parse(data));
    }
    res.json([]);
  } catch (e) {
    res.status(500).json({ error: "Không thể đọc lịch sử" });
  }
});

// Trả về file index.html cho mọi request không phải API (hỗ trợ SPA nếu cần)
app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.listen(PORT, () => {
  console.log(`🚀 Server đang chạy trên port ${PORT}`);
  updateData();
});
