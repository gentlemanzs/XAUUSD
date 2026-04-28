const express = require("express");
const axios = require("axios");
const cron = require("node-cron");
const cors = require("cors");
const path = require("path");
const mongoose = require("mongoose");
const cheerio = require("cheerio");

const app = express();
app.use(cors());

const PORT = process.env.PORT || 3000;
app.use(express.static("public"));

/* ===== CONNECT MONGO ===== */
mongoose.connect(process.env.MONGO_URI, {
  serverSelectionTimeoutMS: 5000
})
.then(() => console.log("✅ MongoDB connected"))
.catch(err => {
  console.error("❌ MongoDB error:", err);
  process.exit(1);
});

/* ===== SCHEMA ===== */
const HistorySchema = new mongoose.Schema({
  time: String,
  date: String, // yyyy-mm-dd
  usd: Number,
  xau: Number,
  sjc: Number,
  worldVND: Number,
  diff: Number,
  percent: String
}, { timestamps: true });

const History = mongoose.model("History", HistorySchema);

let latestData = null;

/* ===== HELPER ===== */
function getToday() {
  return new Date().toISOString().slice(0, 10);
}

/* ===== FETCH ===== */
/* ===== FETCH ===== */
async function fetchWithRetry(url) {
  try {
    const res = await axios.get(url, { 
      timeout: 10000, // Tăng thời gian chờ lên 10s
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8",
        "Accept-Language": "vi-VN,vi;q=0.9,en-US;q=0.8,en;q=0.7",
        "Cache-Control": "no-cache"
      }
    });
    return res.data;
  } catch (e) {
    console.log(`❌ Fetch error for ${url}:`, e.message);
    return null;
  }
}

/* ===== USD ===== */
async function getUSDRate() {
  try {
    const html = await fetchWithRetry("https://webgia.com/ty-gia/vietcombank/");
    const clean = html.replace(/\s+/g, " ");
    const nums = clean.match(/[0-9]{2,3}\.[0-9]{3},[0-9]{2}/g);
    const values = nums.map(n =>
      parseFloat(n.replace(/\./g, "").replace(",", "."))
    );
    return Math.max(...values.filter(v => v > 20000 && v < 30000));
  } catch {
    return 26000;
  }
}

/* ===== XAU ===== */
async function getWorldGoldPrice() {
  try {
    const data = await fetchWithRetry("https://api.gold-api.com/price/XAU");
    return data?.price || 2350;
  } catch {
    return 2350;
  }
}

/* ===== SJC ===== */
/* ===== SJC ===== */
/* ===== SJC ===== */
/* ===== SJC ===== */
/* ===== SJC ===== */
async function getSJCPrice() {
  try {
    const html = await fetchWithRetry("https://webgia.com/gia-vang/sjc/");
    if (!html) {
      console.log("⚠️ Không tải được web, trả về 0.");
      return 0; // Fallback là 0
    }

    const $ = cheerio.load(html);
    
    // Tìm ô chứa "Vàng SJC 1L"
    const nameCell = $('td:contains("Vàng SJC 1L")').first();
    const sellPriceText = nameCell.next().next().text().trim();
    
    console.log("👉 Text giá cào được từ webgia:", sellPriceText);

    if (sellPriceText) {
      const pricePerChi = parseInt(sellPriceText.replace(/\./g, ""), 10);
      if (!isNaN(pricePerChi)) {
        console.log("✅ Giá 1 chỉ quy ra số:", pricePerChi);
        return pricePerChi * 10;
      }
    }

    console.log("⚠️ Lấy được web nhưng không tìm thấy giá trị, trả về 0.");
    return 0; // Fallback là 0
  } catch (error) {
    console.error("❌ Lỗi lấy giá SJC 1L:", error.message);
    return 0; // Fallback là 0
  }
}

/* ===== SAVE LOGIC ===== */
async function saveHistory(entry) {
  try {
    const today = getToday();

    // record đầu ngày
    const firstToday = await History.findOne({ date: today }).sort({ createdAt: 1 });

    // record cuối cùng
    const last = await History.findOne().sort({ createdAt: -1 });

    // ✔ lưu nếu:
    // 1. chưa có record hôm nay (giá đầu ngày)
    // 2. SJC thay đổi
    if (!firstToday || !last || last.sjc !== entry.sjc) {
      await History.create(entry);
      console.log("💾 Saved:", entry.sjc);

      // giữ max 200 record
      const count = await History.countDocuments();
      if (count > 200) {
        const oldest = await History.findOne().sort({ createdAt: 1 });
        if (oldest) await History.deleteOne({ _id: oldest._id });
      }
    } else {
      console.log("⏭ Skip (no change)");
    }

  } catch (e) {
    console.log("❌ Save error:", e);
  }
}

/* ===== UPDATE ===== */
async function updateData() {
  try {
    const usd = await getUSDRate();
    const xau = await getWorldGoldPrice();
    const sjc = await getSJCPrice();

    const worldVND = xau * usd * (37.5 / 31.1035);
    const diff = sjc - worldVND;
    const percent = (diff / worldVND) * 100;

    latestData = {
      time: new Date().toLocaleString("vi-VN"),
      date: getToday(),
      usd,
      xau,
      sjc,
      worldVND: Math.round(worldVND),
      diff: Math.round(diff),
      percent: percent.toFixed(2) + "%"
    };

    await saveHistory(latestData);

  } catch (e) {
    console.log("❌ UPDATE ERROR:", e);
  }
}

/* ===== CRON ===== */
cron.schedule("*/2 * * * *", updateData);

/* ===== API ===== */
app.get("/api/gold", (req, res) => {
  res.json(latestData || {});
});

app.get("/api/history", async (req, res) => {
  const data = await History.find().sort({ createdAt: -1 });
  res.json(data);
});

app.delete("/api/history", async (req, res) => {
  await History.deleteMany({});
  res.json({ ok: true });
});

/* ===== START ===== */
app.listen(PORT, () => {
  console.log("🚀 Server running on", PORT);
  updateData();
});