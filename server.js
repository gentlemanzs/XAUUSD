const express = require("express");
const cron = require("node-cron");
const cors = require("cors");
const mongoose = require("mongoose");
const cheerio = require("cheerio");
const compression = require("compression");

const app = express();
app.use(compression());
app.use(cors());
app.use(express.json());

const path = require("path");
app.use(express.static(path.join(__dirname, "public")));

const PORT = process.env.PORT || 3000;

/* ===== CONNECT MONGO ===== */
mongoose.connect(process.env.MONGO_URI, { serverSelectionTimeoutMS: 5000 })
  .then(() => console.log("✅ MongoDB connected"))
  .catch(err => { console.error("❌ MongoDB error:", err); process.exit(1); });

/* ===== SCHEMA ===== */
const HistorySchema = new mongoose.Schema({
  usd: Number, xau: Number, sjc: Number, worldVND: Number,
  diff: Number, percent: String, status: String
}, { timestamps: true });

HistorySchema.index({ createdAt: -1 });
const History = mongoose.model("History", HistorySchema);

// Biến RAM Cache tổng
let latestData = null;
let clients = []; 
let isUpdating = false; 

// Biến RAM Cache riêng cho USD (1 tiếng)
let cachedUsdRate = 1000;
let lastUsdFetchTime = 0;
const USD_CACHE_DURATION = 60 * 60 * 1000; // 1 tiếng tính bằng mili-giây

/* ===== FETCH HELPERS ===== */
async function fetchWithRetry(url, isJson = false) {
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36" },
      signal: AbortSignal.timeout(8000) 
    });
    if (!res.ok) throw new Error(`HTTP Error: ${res.status}`);
    return isJson ? await res.json() : await res.text();
  } catch (e) {
      console.warn(`⚠️ Cảnh báo: Lỗi khi lấy dữ liệu từ ${url} - ${e.message}`);
      return null; 
  }
}

/* ===== HÀM CÀO USD ĐỘC LẬP (CÓ CACHE 1 TIẾNG) ===== */
async function getUsdRate() {
  const now = Date.now();
  // Nếu chưa qua 1 tiếng và đã có dữ liệu trước đó -> Trả về dữ liệu cũ luôn, không cần cào mạng
  if (now - lastUsdFetchTime < USD_CACHE_DURATION && cachedUsdRate !== 1000) {
    return cachedUsdRate;
  }

  // Đã qua 1 tiếng -> Cào XML từ VCB
  const xml = await fetchWithRetry("https://portal.vietcombank.com.vn/Usercontrols/TVPortal.TyGia/pXML.aspx");
  if (xml) {
    // Bật chế độ xmlMode để cheerio đọc chính xác thẻ <Exrate>
    const $ = cheerio.load(xml, { xmlMode: true });
    // Lấy giá trị của thuộc tính Sell trong thẻ Exrate có CurrencyCode là USD
    const sellStr = $('Exrate[CurrencyCode="USD"]').attr('Sell');
    
    if (sellStr) {
      // Dữ liệu mẫu: "26,368.00" -> Xóa dấu phẩy và chuyển thành số nguyên/thập phân
      const parsedRate = parseFloat(sellStr.replace(/,/g, ""));
      if (!isNaN(parsedRate)) {
        cachedUsdRate = parsedRate;
        lastUsdFetchTime = now;
        console.log(`   💵 Đã cập nhật tỷ giá USD mới từ VCB XML: ${cachedUsdRate}`);
        return cachedUsdRate;
      }
    }
  }
  // Nếu lỗi mạng, trả về giá trị cache gần nhất
  return cachedUsdRate; 
}

/* ===== UPDATE LOGIC (CÀO DỮ LIỆU CHÍNH) ===== */
async function updateData(triggerSource = "Tự động") {
  if (isUpdating) return; 
  isUpdating = true;
  try {
    console.log(`\n▶ [${triggerSource}] Bắt đầu cào dữ liệu lúc ${new Date().toLocaleTimeString('vi-VN')}`);
    
    // Gọi song song 3 hàm lấy dữ liệu
    const [usdRate, dataXAU, htmlSJC] = await Promise.all([
      getUsdRate(), // Hàm này sẽ cực kỳ nhanh nếu đang trong thời gian 1 tiếng cache
      fetchWithRetry("https://api.gold-api.com/price/XAU", true),
      fetchWithRetry("https://webgia.com/gia-vang/sjc/")
    ]);

    let lastRecord = latestData; 
    if (!lastRecord) {
      lastRecord = await History.findOne().sort({ createdAt: -1 }).lean();
    }
    
    let usd = usdRate; // Sử dụng tỷ giá đã lấy được
    let xau = 2350, sjc = 0;
    
    // --- Xử lý XAU ---
    xau = dataXAU?.price || 2350;

    // --- Xử lý SJC ---
    if (htmlSJC) {
      const $ = cheerio.load(htmlSJC);
      const priceText = $('td:contains("Vàng SJC 1L")').first().next().next().text().trim();
      sjc = (parseInt(priceText.replace(/\./g, ""), 10) * 10) || 0;
    }

    // --- FALLBACK ---
    if (sjc <= 0 && lastRecord) sjc = lastRecord.sjc;
    if (usd === 1000 && lastRecord) usd = lastRecord.usd;

    if (sjc <= 0 || xau <= 0) {
        console.log("❌ LỖI NGHIÊM TRỌNG: Không thể cào dữ liệu từ cả 3 nguồn và cũng không có bản lưu dự phòng!");
        console.log(`   👉 Chi tiết lỗi cào: SJC=${sjc}, XAU=${xau}, USD=${usd}`);
        return; 
    }

    // --- TÍNH TOÁN ---
    const worldVND = xau * usd * (37.5 / 31.1035);
    const diff = sjc - worldVND;

    // --- MỚI: Tìm giá đóng cửa ngày hôm trước để tính Change ---
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    yesterday.setHours(23, 59, 59, 999);

    // Tìm bản ghi cuối cùng của ngày hôm qua hoặc cũ hơn
    const lastDayRecord = await History.findOne({
      createdAt: { $lte: yesterday }
    }).sort({ createdAt: -1 }).lean();

    // Nếu không có giá hôm qua (mới chạy app), dùng chính giá hiện tại làm mốc
    const referenceSJC = lastDayRecord ? lastDayRecord.sjc : sjc;
    const sjcChange = sjc - referenceSJC;

    // --- LƯU VÀO RAM CACHE ---
    latestData = {
      updatedAt: new Date(), 
      usd, 
      xau, 
      sjc,
      sjcChange: sjcChange, // Gửi con số chênh lệch chuẩn từ Server
      worldVND: Math.round(worldVND), 
      diff: Math.round(diff),
      percent: ((diff / worldVND) * 100).toFixed(2) + "%",
      status: sjc > 0 ? "Live" : "Delayed"
    };

    // --- IN BẢNG LOG KẾT QUẢ CÀO (DÀNH CHO DEPLOY) ---
    console.log("----------------------------------------");
    console.log("📊 KẾT QUẢ CÀO DỮ LIỆU:");
    console.log(`   💵 USD: ${latestData.usd.toLocaleString('vi-VN')} VNĐ`);
    console.log(`   🌍 XAU: ${latestData.xau.toLocaleString('en-US')} USD/oz`);
    console.log(`   🧈 SJC: ${latestData.sjc.toLocaleString('vi-VN')} VNĐ`);
    console.log(`   ⚖️ GAP: ${latestData.diff.toLocaleString('vi-VN')} VNĐ (${latestData.percent})`);
    console.log("----------------------------------------");

    // --- LƯU DATABASE ---
    if (sjc > 0 && (!lastRecord || lastRecord.sjc !== sjc)) {
      const dbEntry = { ...latestData };
      delete dbEntry.updatedAt; 
      await History.create(dbEntry);
      console.log(`   💾 DB: Đã lưu bản ghi SJC mới là ${sjc.toLocaleString('vi-VN')}`);
      
      const count = await History.countDocuments();
      if (count > 200) await History.findOneAndDelete({}, { sort: { createdAt: 1 } });
    } else {
      console.log(`   ⏩ DB: Giá SJC không đổi (${sjc.toLocaleString('vi-VN')}), không lưu rác.`);
    }

    // --- ĐẨY DỮ LIỆU SSE CHO CLIENT ---
    clients.forEach(c => c.write(`data: ${JSON.stringify(latestData)}\n\n`));
    console.log(`   ✅ Đã đẩy Realtime xuống ${clients.length} client(s) đang kết nối.`);

  } catch (e) {
    console.log("❌ LỖI HỆ THỐNG (TRY-CATCH) TRONG UPDATE-DATA:", e.message);
  } finally {
    isUpdating = false;
  }
}

/* ===== API & SSE ===== */

app.get("/api/stream", (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  
  clients.push(res);
  
  if (latestData) {
      res.write(`data: ${JSON.stringify(latestData)}\n\n`);
  }

  req.on("close", () => clients = clients.filter(c => c !== res));
});

app.get("/api/gold", async (req, res) => {
    res.json(latestData || {});
});

app.get("/api/history", async (req, res) => {
  const data = await History.find().sort({ createdAt: -1 }).limit(100).lean();
  res.json(data);
});

app.post("/api/history/bulk-delete", async (req, res) => {
  try {
    const { ids } = req.body;
    await History.deleteMany({ _id: { $in: ids } });
    res.json({ ok: true });
  } catch (error) { res.status(500).json({ error: "Lỗi xóa" }); }
});

/* ===== CRONJOB (QUẢN LÝ LỊCH TRÌNH) ===== */
cron.schedule("*/5 * * * *", () => updateData("Cronjob 5 phút"));

/* ===== START ===== */
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
  updateData("Khởi động Server");
});