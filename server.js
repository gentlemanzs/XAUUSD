const express = require("express");
const axios = require("axios");
const cron = require("node-cron");
const cors = require("cors");
const path = require("path");
const fs = require("fs");

const app = express();
app.use(cors());

// Serve các file tĩnh từ thư mục public
app.use(express.static("public"));

const PORT = process.env.PORT || 3000;
const DATA_PATH = path.join(__dirname, "history/data.json");

// Đảm bảo thư mục history tồn tại
if (!fs.existsSync(path.join(__dirname, "history"))) {
  fs.mkdirSync(path.join(__dirname, "history"));
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
    // Chỉ lưu nếu giá trị SJC hoặc XAU thay đổi để tránh trùng lặp dữ liệu rác
    if (!lastEntry || lastEntry.sjc !== entry.sjc || lastEntry.xau !== entry.xau) {
      history.push(entry);
      if (history.length > 200) history.shift(); // Giữ tối đa 200 bản ghi
      fs.writeFileSync(DATA_PATH, JSON.stringify(history, null, 2));
    }
  } catch (e) {
    console.log("❌ Lỗi ghi file history:", e);
  }
}

async function getUSDRate() {
  try {
    const html = await axios.get("https://webgia.com/ty-gia/vietcombank/", { timeout: 5000 });
    const clean = html.data.replace(/\s+/g, " ");
    const nums = clean.match(/[0-9]{2,3}\.[0-9]{3},[0-9]{2}/g);
    if (!nums) throw "No USD rate found";
    const values = nums.map(n => parseFloat(n.replace(/\./g, "").replace(",", ".")));
    return Math.max(...values.filter(v => v > 20000 && v < 30000));
  } catch (e) {
    return 26000; // Fallback
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
  console.log("⏳ Đang cập nhật dữ liệu...");
  try {
    const usd = await getUSDRate();
    const xau = await getWorldGoldPrice();
    const sjc = 168800000; // Giá giả định hoặc logic lấy giá thực

    const worldVND = xau * usd * (37.5 / 31.1035);
    const diff = sjc - worldVND;
    const percent = (diff / worldVND) * 100;

    latestData = {
      time: new Date().toLocaleString("vi-VN"),
      usd, xau, sjc,
      worldVND: Math.round(worldVND),
      diff: Math.round(diff),
      percent: percent.toFixed(2) + "%"
    };

    saveToHistory(latestData);
    console.log("✅ Cập nhật thành công");
  } catch (e) {
    console.log("❌ Lỗi cập nhật:", e);
  }
}

// Cập nhật tự động mỗi 2 phút
cron.schedule("*/2 * * * *", updateData);

app.get("/api/gold", async (req, res) => {
  if (req.query.t) await updateData(); // Update ngay nếu có yêu cầu từ nút bấm
  res.json(latestData || { message: "Đang tải..." });
});

app.get("/api/history", (req, res) => {
  if (fs.existsSync(DATA_PATH)) {
    res.json(JSON.parse(fs.readFileSync(DATA_PATH, "utf-8")));
  } else {
    res.json([]);
  }
});

app.listen(PORT, () => {
  console.log(`🚀 Server đang chạy tại: http://localhost:${PORT}`);
  updateData();
});
