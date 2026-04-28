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
async function fetchWithRetry(url, retries = 3) {
  for (let i = 0; i < retries; i++) {
    try {
      const res = await axios.get(url, { 
        timeout: 10000,
        headers: { "User-Agent": "Mozilla/5.0..." /* Giữ nguyên Header của bạn */ }
      });
      return res.data;
    } catch (e) {
      console.log(`⚠️ Thử lại lần ${i + 1} cho ${url}...`);
      if (i === retries - 1) return null; // Hết số lần thử thì bỏ cuộc
    }
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
/* ===== SJC CÓ BACKUP ===== */
async function getSJCPrice() {
  // ---------------------------------------------------------
  // LỚP 1: CÀO TỪ TRANG CHỦ F0 (sjc.com.vn)
  // ---------------------------------------------------------
  try {
    console.log("⏳ Đang lấy giá SJC từ nguồn chính (sjc.com.vn)...");
    const htmlF0 = await fetchWithRetry("https://sjc.com.vn/gia-vang-online");
    
    if (htmlF0) {
      const $ = cheerio.load(htmlF0);
      // SJC thường ghi loại vàng phổ biến là "1L, 10L, 1KG"
      const nameCell = $('td:contains("1L, 10L")').first(); 
      
      if (nameCell.length > 0) {
        // Nhảy sang 2 cột để lấy giá Bán Ra
        const sellPriceText = nameCell.next().next().text().trim();
        let price = parseInt(sellPriceText.replace(/\D/g, ""), 10);
        
        if (!isNaN(price) && price > 0) {
          // Giá SJC niêm yết theo ngàn đồng (vd 88.500), cần nhân 1000
          if (price < 10000000) price = price * 1000;
          console.log("✅ Lấy thành công SJC (Nguồn chính):", price);
          return price; // Thành công thì dừng hàm, trả kết quả luôn
        }
      }
    }
    console.log("⚠️ Nguồn chính không có dữ liệu hoặc thay đổi cấu trúc, tự động chuyển qua Backup...");
  } catch (error) {
    console.error("❌ Lỗi cào nguồn chính SJC, kích hoạt Backup:", error.message);
  }

  // ---------------------------------------------------------
  // LỚP 2: CÀO TỪ NGUỒN BACKUP (webgia.com) - Chỉ chạy khi Lớp 1 lỗi
  // ---------------------------------------------------------
  try {
    console.log("⏳ Đang lấy giá SJC từ nguồn dự phòng (webgia.com)...");
    const htmlBackup = await fetchWithRetry("https://webgia.com/gia-vang/sjc/");
    
    if (htmlBackup) {
      const $ = cheerio.load(htmlBackup);
      const nameCell = $('td:contains("Vàng SJC 1L")').first();
      const sellPriceText = nameCell.next().next().text().trim();
      
      if (sellPriceText) {
        // Webgia có dấu chấm phân cách hàng ngàn
        const pricePerChi = parseInt(sellPriceText.replace(/\./g, ""), 10);
        if (!isNaN(pricePerChi) && pricePerChi > 0) {
          // Webgia niêm yết theo chỉ, cần nhân 10 để ra lượng
          const price = pricePerChi * 10;
          console.log("✅ Lấy thành công SJC (Nguồn Webgia):", price);
          return price;
        }
      }
    }
    console.log("⚠️ Nguồn dự phòng cũng thất bại.");
  } catch (error) {
    console.error("❌ Lỗi cào nguồn dự phòng Webgia:", error.message);
  }

  // ---------------------------------------------------------
  // LỚP 3: THẤT BẠI HOÀN TOÀN
  // ---------------------------------------------------------
  console.log("🚨 TẤT CẢ CÁC NGUỒN ĐỀU SẬP. TRẢ VỀ 0.");
  return 0;
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
    const [usd, xau, sjc] = await Promise.all([
  getUSDRate(),
  getWorldGoldPrice(),
  getSJCPrice()
]);

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