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

// TỐI ƯU: Đưa file tĩnh vào thư mục public (Bạn cần tạo thư mục 'public' và cho index.html, style.css, main.js vào đây)
// Nếu bạn vẫn để tất cả file ở thư mục gốc, hãy đổi thành app.use(express.static(__dirname));
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

// Biến RAM Cache để không phải gọi Database liên tục
let latestData = null;
let clients = []; 
let isUpdating = false; 

/* ===== FETCH HELPERS (Native Fetch Node 18+) ===== */
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

/* ===== UPDATE LOGIC (CÀO DỮ LIỆU) ===== */
async function updateData(triggerSource = "Tự động") {
  if (isUpdating) return; // Khóa chống cào đè
  isUpdating = true;
  try {
    console.log(`\n▶ [${triggerSource}] Bắt đầu cào dữ liệu lúc ${new Date().toLocaleTimeString('vi-VN')}`);
    
    // Chạy song song 3 tác vụ cào để tăng tốc
    const [htmlVCB, dataXAU, htmlSJC] = await Promise.all([
      fetchWithRetry("https://webgia.com/ty-gia/vietcombank/"),
      fetchWithRetry("https://api.gold-api.com/price/XAU", true),
      fetchWithRetry("https://webgia.com/gia-vang/sjc/")
    ]);

    // Lấy dữ liệu cũ (từ RAM hoặc DB) để làm Fallback (Dự phòng)
    let lastRecord = latestData; 
    if (!lastRecord) {
      lastRecord = await History.findOne().sort({ createdAt: -1 }).lean();
    }
    
    // Biến mặc định
    let usd = 1000, xau = 2350, sjc = 0;

    // --- Xử lý USD ---
    if (htmlVCB) {
      const $ = cheerio.load(htmlVCB);
      // Cải thiện logic tìm kiếm ổn định hơn
      const rate = $('td:contains("USD")').parent().find('td').last().text().trim();
      usd = parseFloat(rate.replace(/\./g, "").replace(",", ".")) || 1000;
    }
    
    // --- Xử lý XAU ---
    xau = dataXAU?.price || 2350;

    // --- Xử lý SJC ---
    if (htmlSJC) {
      const $ = cheerio.load(htmlSJC);
      const priceText = $('td:contains("Vàng SJC 1L")').first().next().next().text().trim();
      sjc = (parseInt(priceText.replace(/\./g, ""), 10) * 10) || 0;
    }

    // --- FALLBACK (KHI WEB LỖI HOẶC CHẶN BOT) ---
    if (sjc <= 0 && lastRecord) sjc = lastRecord.sjc;
    if (usd === 1000 && lastRecord) usd = lastRecord.usd;

    // Lỗi hoàn toàn cả mạng lẫn database thì hủy phiên làm việc
    if (sjc <= 0 || xau <= 0) {
        console.log("❌ Lỗi nghiêm trọng: Không thể lấy dữ liệu và không có bản sao lưu.");
        return; 
    }

    // --- TÍNH TOÁN ---
    const worldVND = xau * usd * (37.5 / 31.1035);
    const diff = sjc - worldVND;

    // --- LƯU VÀO RAM CACHE ---
    latestData = {
      updatedAt: new Date(), 
      usd, 
      xau, 
      sjc,
      worldVND: Math.round(worldVND), 
      diff: Math.round(diff),
      percent: ((diff / worldVND) * 100).toFixed(2) + "%",
      status: sjc > 0 ? "Live" : "Delayed"
    };

    // --- LƯU DATABASE ---
    // Chỉ ghi vào DB nếu giá SJC thay đổi thực sự so với lần trước
    if (sjc > 0 && (!lastRecord || lastRecord.sjc !== sjc)) {
      const dbEntry = { ...latestData };
      delete dbEntry.updatedAt; // Xóa key thừa
      await History.create(dbEntry);
      console.log(`   💾 DB: Đã lưu bản ghi SJC mới là ${sjc}`);
      
      // Tự động dọn dẹp Database (Giữ lại 200 bản ghi mới nhất)
      const count = await History.countDocuments();
      if (count > 200) await History.findOneAndDelete({}, { sort: { createdAt: 1 } });
    } else {
      console.log(`   ⏩ DB: Giá SJC không đổi (${sjc}), không lưu rác.`);
    }

    // --- ĐẨY DỮ LIỆU SSE CHO CLIENT ---
    clients.forEach(c => c.write(`data: ${JSON.stringify(latestData)}\n\n`));
    console.log(`   ✅ Đã đẩy Realtime xuống ${clients.length} client(s).`);

  } catch (e) {
    console.log("❌ Lỗi hệ thống trong UpdateData:", e);
  } finally {
    // Mở khóa phiên bản cào
    isUpdating = false;
  }
}

/* ===== API & SSE ===== */

// Mở kết nối luồng (SSE)
app.get("/api/stream", (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  
  clients.push(res);
  
  // Nếu đã có dữ liệu trong RAM, gửi ngay cho client mới kết nối
  if (latestData) {
      res.write(`data: ${JSON.stringify(latestData)}\n\n`);
  }

  // Xóa client khi mất kết nối (đóng tab)
  req.on("close", () => clients = clients.filter(c => c !== res));
});

// YÊU CẦU MỚI: API chỉ trả về dữ liệu tĩnh đang có, TUYỆT ĐỐI KHÔNG KÍCH HOẠT CÀO (Bỏ force update)
app.get("/api/gold", async (req, res) => {
    // Xóa bỏ hoàn toàn logic kiểm tra req.query.force
    // Chỉ cần trả về dữ liệu cuối cùng nằm trong RAM
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
// YÊU CẦU MỚI: Đổi lịch trình cào từ mỗi phút (*/1 * * * *) thành MỖI 5 PHÚT (*/5 * * * *)
cron.schedule("*/5 * * * *", () => updateData("Cronjob 5 phút"));

/* ===== START ===== */
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
  // Lần khởi động server đầu tiên bắt buộc phải cào 1 lần để mồi dữ liệu
  updateData("Khởi động Server");
});