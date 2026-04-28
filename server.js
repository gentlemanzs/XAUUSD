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
  status: String
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
    if (!html) return 1000;
    const $ = cheerio.load(html);
    
    // Tìm hàng chứa chữ USD, sau đó lấy giá trị ở cột tỷ giá Bán (thường là cột cuối hoặc áp chót)
    const sellPriceText = $('td:contains("USD")').parent().find('td').last().text().trim(); 
    const rate = parseFloat(sellPriceText.replace(/\./g, "").replace(",", "."));
    
    return isNaN(rate) ? 1000 : rate;
  } catch {
    return 1000;
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
    const last = await History.findOne().sort({ createdAt: -1 });
    
    // Chỉ lưu nếu giá SJC hoặc XAU có sự thay đổi so với lần lưu trước
    if (!last || last.sjc !== entry.sjc || last.xau !== entry.xau) {
      await History.create(entry);
      console.log("💾 Đã lưu biến động mới vào database.");

      // Tự động xóa bản ghi cũ nếu vượt quá 200 (Giữ dung lượng thấp cho Atlas)
      const count = await History.countDocuments();
      if (count > 200) {
        await History.findOneAndDelete({}, { sort: { createdAt: 1 } });
      }
    }
  } catch (e) {
    console.log("❌ Lỗi lưu DB:", e);
  }
}

/* ===== UPDATE ===== */
/* ===== UPDATE ===== */
async function updateData() {
  try {
    // 1. Cào dữ liệu từ các nguồn
    let [usd, xau, sjc] = await Promise.all([
      getUSDRate(),
      getWorldGoldPrice(),
      getSJCPrice()
    ]);

    // Lấy bản ghi mới nhất từ database để làm phương án dự phòng (fallback)
    const lastRecord = await History.findOne().sort({ createdAt: -1 });

    // 2. Kiểm tra và xử lý Fallback
    // Nếu cào lỗi (giá bằng 0 hoặc dùng giá mặc định), ta lấy lại giá trị cũ từ DB
    let isFallback = false;

    if (sjc <= 0 && lastRecord) {
      sjc = lastRecord.sjc;
      isFallback = true;
    }
    
    if (xau <= 0 && lastRecord) {
      xau = lastRecord.xau;
      isFallback = true;
    }

    // Riêng USD, nếu hàm trả về 1000 (giá mặc định khi lỗi) thì thử lấy lại giá cũ
    if (usd === 1000 && lastRecord) {
      usd = lastRecord.usd;
    }

    // Nếu không có cả dữ liệu mới lẫn dữ liệu cũ (DB trống), dừng xử lý
    if (sjc <= 0 || xau <= 0) {
      console.log("⚠️ Không có dữ liệu để cập nhật.");
      return;
    }

    // 3. Tính toán các chỉ số chênh lệch
    const worldVND = xau * usd * (37.5 / 31.1035);
    const diff = sjc - worldVND;
    const percent = (diff / worldVND) * 100;

    // 4. Cập nhật vào biến Global latestData
    latestData = {
      // Đảm bảo giờ hiển thị là giờ Việt Nam dù Deploy trên Railway (server quốc tế)
      time: new Date().toLocaleString("vi-VN", { timeZone: "Asia/Ho_Chi_Minh" }),
      date: getToday(),
      usd: usd,
      xau: xau,
      sjc: sjc,
      worldVND: Math.round(worldVND),
      diff: Math.round(diff),
      percent: percent.toFixed(2) + "%",
      status: isFallback ? "Delayed" : "Live" // Gắn nhãn để UI nhận biết
    };

    // 5. Lưu vào lịch sử
    // Chỉ gọi hàm lưu nếu không phải là dữ liệu Fallback (để tránh làm rác biểu đồ)
    if (!isFallback) {
      await saveHistory(latestData);
    } else {
      console.log("🟡 Đang hiển thị dữ liệu tạm thời (Fallback), không lưu vào History.");
    }

  } catch (e) {
    console.log("❌ Lỗi nghiêm trọng trong quá trình Update:", e);
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