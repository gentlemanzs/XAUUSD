const express = require("express");
const path = require("path"); 
const cron = require("node-cron");
const cors = require("cors");
const mongoose = require("mongoose");
const cheerio = require("cheerio");
const compression = require("compression");
// TỐI ƯU BẢO MẬT: Nạp thư viện chống DDoS / Dội bom API
const rateLimit = require('express-rate-limit');
const app = express();

// FIX LỖI DEPLOY: Cho phép Express tin tưởng Proxy của Railway để Rate Limit lấy đúng IP thật của người dùng
app.set('trust proxy', 1);

// TỐI ƯU: Cấu hình nén dữ liệu chuẩn mực
app.use(compression({
  level: 6,
  threshold: 1024
}));

// TỐI ƯU BẢO MẬT: Cài đặt khiên chặn rate limit (Tối đa 100 request / 15 phút / 1 IP)
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, 
  max: 100, 
  message: { error: "Bạn đã gọi API quá nhiều lần. Vui lòng đợi 15 phút." },
  standardHeaders: true, 
  legacyHeaders: false, 
  skip: (req) => req.headers.accept === 'text/event-stream' // TỐI ƯU: Đảm bảo không bao giờ block nhầm luồng SSE
});

app.use(cors());
// Giới hạn JSON body 10kb chống payload rác làm tràn RAM
app.use(express.json({ limit: "10kb" })); 

// TỐI ƯU: Thêm Cache Header cho file tĩnh giúp giảm tải băng thông
app.use(express.static(path.join(__dirname, "public"), {
  maxAge: "1d",
  etag: true
}));

// Áp dụng lớp khiên Rate Limit cho toàn bộ Endpoint bắt đầu bằng /api/ (Ngoại trừ SSE /stream)
app.use('/api/history', apiLimiter);
app.use('/api/gold', apiLimiter);

const PORT = process.env.PORT || 3000;

// TỐI ƯU CHUẨN XÁC: Nạp dữ liệu từ DB lên RAM trước khi khởi động
async function preloadCache() {
  try {
    // TỐI ƯU TẬN CÙNG: Nạp sẵn 1000 dòng lịch sử lên RAM. Sau bước này API /history KHÔNG BAO GIỜ chọc DB nữa!
    const historyData = await History.find()
      .select("createdAt xau sjc diff percent _id")
      .sort({ createdAt: -1 })
      .limit(1000)
      .lean();
    if (historyData.length > 0) cachedHistory = historyData;

    // SỬA LỖI BUG F5 TRẮNG TRANG: Nạp FULL các trường dữ liệu để Frontend không bị từ chối
    const last = await History.findOne()
      .sort({ createdAt: -1 }) // Bỏ .select() để lấy toàn bộ dữ liệu dòng cuối
      .lean();

    if (last) {
      cachedLastSavedXau = last.xau;
      
      // Phải tìm đúng dòng có SJC KHÁC VỚI SJC HIỆN TẠI để nạp Gap cũ
      const diffRecord = await History.findOne({ sjc: { $ne: last.sjc } })
        .select('sjc diff')
        .sort({ createdAt: -1 })
        .lean();
      
      lastDifferentSjc = diffRecord ? { sjc: diffRecord.sjc, diff: diffRecord.diff } : { sjc: last.sjc, diff: last.diff };
      
      // KHÔI PHỤC FULL OBJECT: Đảm bảo có thuộc tính updatedAt để Frontend chấp nhận
      latestData = { 
        updatedAt: last.createdAt,
        usd: last.usd, 
        xau: last.xau, 
        xauChange: 0, // Fallback tạm khi chưa tính được chênh lệch
        sjc: last.sjc, 
        sjcChange: 0, // Fallback tạm
        oldGap: lastDifferentSjc.diff,
        gapChange: lastDifferentSjc.diff - last.diff,
        worldVND: last.worldVND,
        diff: last.diff,
        percent: last.percent,
        status: "Live (Preloaded)" 
      };
      
      console.log(`📦 Khởi động: Đã nạp (Preload) toàn bộ ${historyData.length} dòng History (tinh gọn) lên RAM!`);
    }
  } catch (e) {
    console.log("⚠️ Khởi động: Lỗi preload cache:", e.message);
  }
}

/* ===== CONNECT MONGO ===== */
mongoose.connect(process.env.MONGO_URI, { 
  serverSelectionTimeoutMS: 5000,
  maxPoolSize: 10, 
  minPoolSize: 2
})
  .then(async () => { 
    console.log("✅ MongoDB connected");
    await preloadCache(); 
    app.listen(PORT, () => {
      console.log(`🚀 Server running on port ${PORT}`);
      updateData("Khởi động Server");
    });
  })
  .catch(err => { 
    console.error("❌ MongoDB error:", err); 
    process.exit(1); 
  });

mongoose.connection.on('error', (err) => {
  console.error("🔥 Lỗi Mất Kết Nối MongoDB Đột Ngột:", err);
});
mongoose.connection.on('disconnected', () => {
  console.warn("⚠️ MongoDB đã ngắt kết nối. Đang thử lại...");
});

/* ===== SCHEMA ===== */
const HistorySchema = new mongoose.Schema({
  usd: Number, xau: Number, sjc: Number, worldVND: Number,
  diff: Number, percent: String, status: String
}, { timestamps: true });

HistorySchema.index({ createdAt: -1, sjc: 1 });
HistorySchema.index({ createdAt: -1 });
const History = mongoose.model("History", HistorySchema);

// Biến RAM Cache tổng
let latestData = null;
let clients = new Set(); 
let isUpdating = false; 

let lastDifferentSjc = null; 
let cachedLastSavedXau = null; 

let cachedYesterdaySjc = null;
let cachedYesterdayDate = null;
let cachedHistory = [];

// 🔥 HEARTBEAT giữ kết nối SSE không bị chết
setInterval(() => {
  for (const c of clients) {
    try {
      c.write(":\n\n"); 
      if (typeof c.flush === "function") c.flush();
    } catch (e) {
      clients.delete(c); 
    }
  }
}, 20000); 

let cachedUsdRate = null; 
let lastUsdFetchTime = 0;
const USD_CACHE_DURATION = 60 * 60 * 1000; 

/* ===== FETCH HELPERS ===== */
async function fetchWithRetry(url, isJson = false, retries = 3) {
  for (let i = 0; i < retries; i++) {
    try {
      const res = await fetch(url, {
        headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36" },
        signal: AbortSignal.timeout(5000) 
      });
      if (!res.ok) throw new Error(`HTTP Error: ${res.status}`);
      return isJson ? await res.json() : await res.text();
    } catch (e) {
      if (i === retries - 1) {
        console.warn(`⚠️ Cảnh báo: Lỗi khi lấy dữ liệu từ ${url} - ${e.message}`);
        return null; 
      }
      await new Promise(r => setTimeout(r, 300 * (i + 1)));
    }
  }
}

/* ===== HÀM CÀO USD ===== */
async function getUsdRate() {
  const now = Date.now();
  if (now - lastUsdFetchTime < USD_CACHE_DURATION && cachedUsdRate !== null) {
    return cachedUsdRate;
  }
  const xml = await fetchWithRetry("https://portal.vietcombank.com.vn/Usercontrols/TVPortal.TyGia/pXML.aspx");
  if (xml) {
    const $ = cheerio.load(xml, { xmlMode: true });
    const sellStr = $('Exrate[CurrencyCode="USD"]').attr('Sell');
    if (sellStr) {
      const parsedRate = parseFloat(sellStr.replace(/,/g, ""));
      if (!isNaN(parsedRate)) {
        cachedUsdRate = parsedRate;
        lastUsdFetchTime = now;
        console.log(`   💵 Đã cập nhật tỷ giá USD mới từ VCB: ${cachedUsdRate}`);
        return cachedUsdRate;
      }
    }
  }
  return cachedUsdRate; 
}

/* ===== HÀM LẤY GIÁ SJC ===== */
async function getSjcPrice() {
  try {
    const dojiXml = await fetchWithRetry("https://giavang.doji.vn/api/giavang/?api_key=258fbd2a72ce8481089d88c678e9fe4f", false);
    if (dojiXml) {
      const $ = cheerio.load(dojiXml, { xmlMode: true });
      const sellStr = $('Row[Key="dojihanoile"]').attr('Sell');
      if (sellStr) {
        let price = parseFloat(sellStr.replace(/,/g, ""));
        if (price > 0 && price < 1000000) price *= 1000; 
        console.log(`   🌟 Đã lấy giá SJC từ DOJI: ${price.toLocaleString('vi-VN')}`);
        return price;
      }
    }
  } catch (err) {
    console.warn("   ⚠️ DOJI gặp sự cố, chuyển sang BTMC...");
  }

  try {
    const btmcXml = await fetchWithRetry("http://api.btmc.vn/api/BTMCAPI/getpricebtmc?key=3kd8ub1llcg9t45hnoh8hmn7t5kc2v", false);
    if (btmcXml) {
      const $ = cheerio.load(btmcXml, { xmlMode: true });
      const sellStr = $('Data[row="932"]').attr('ps_932');
      if (sellStr) {
        let price = parseFloat(sellStr.replace(/,/g, ""));
        if (price > 0 && price < 1000000) price *= 1000; 
        console.log(`   🌟 Đã lấy giá SJC từ BTMC: ${price.toLocaleString('vi-VN')}`);
        return price;
      }
    }
  } catch (err) {
    console.warn("   ⚠️ BTMC cũng gặp sự cố!");
  }
  return 0; 
}

/* ===== UPDATE LOGIC (CÀO DỮ LIỆU) ===== */
async function updateData(triggerSource = "Tự động") {
  if (isUpdating) return; 
  isUpdating = true;
  try {
    console.log(`\n▶ [${triggerSource}] Bắt đầu cào dữ liệu lúc ${new Date().toLocaleTimeString('vi-VN')}`);
    
    const [usdRate, dataXAU, sjcPrice] = await Promise.all([
      getUsdRate(), 
      fetchWithRetry("https://api.gold-api.com/price/XAU", true),
      getSjcPrice() 
    ]);

    let lastRecord = latestData; 
    if (!lastRecord) {
      lastRecord = await History.findOne().select('usd xau sjc').sort({ createdAt: -1 }).lean().catch(() => null);
    }
    
    const isSjcLive = sjcPrice > 0;
    const isXauLive = !!(dataXAU && dataXAU.price);
    const isUsdLive = usdRate !== null; 

    let sjc = isSjcLive ? sjcPrice : (lastRecord ? lastRecord.sjc : 0);
    let xau = isXauLive ? dataXAU.price : (lastRecord ? lastRecord.xau : 2350);
    let usd = isUsdLive ? usdRate : (lastRecord ? lastRecord.usd : 25400); 

    if (sjc <= 0 || xau <= 0) {
        if (latestData) {
          latestData.status = "Delayed (Lỗi API nguồn)";
          const fallbackPayload = `data: ${JSON.stringify(latestData)}\n\n`;
          for (const c of clients) {
            try { c.write(fallbackPayload); if (typeof c.flush === "function") c.flush(); } 
            catch (err) { clients.delete(c); }
          }
        }
        return; 
    }

    const worldVND = xau * usd * (37.5 / 31.1035);
    const diff = sjc - worldVND;
    const currentGap = Math.round(diff);

    const todayStr = new Date().toDateString();
    if (cachedYesterdayDate !== todayStr || cachedYesterdaySjc === null) {
      const yesterday = new Date();
      yesterday.setDate(yesterday.getDate() - 1);
      yesterday.setHours(23, 59, 59, 999);
      const lastDayRecord = await History.findOne({ createdAt: { $lte: yesterday } })
        .select('sjc').sort({ createdAt: -1 }).lean().catch(() => null);
      cachedYesterdaySjc = lastDayRecord ? lastDayRecord.sjc : sjc;
      cachedYesterdayDate = todayStr;
    }
    const sjcChange = sjc - cachedYesterdaySjc;

    if (!lastDifferentSjc) {
      const record = await History.findOne({ sjc: { $ne: sjc } })
        .select('sjc diff').sort({ createdAt: -1 }).lean().catch(() => null);
      lastDifferentSjc = record ? { sjc: record.sjc, diff: record.diff } : { sjc: sjc, diff: currentGap };
    }
    const oldGap = lastDifferentSjc.diff;
    const gapChange = oldGap - currentGap;

    if (cachedLastSavedXau === null) {
      const latestDbRecord = await History.findOne().select('xau').sort({ createdAt: -1 }).lean().catch(() => null);
      cachedLastSavedXau = latestDbRecord ? latestDbRecord.xau : xau;
    }
    const xauChange = xau - cachedLastSavedXau;

    let failedAPIs = [];
    if (!isSjcLive) failedAPIs.push("SJC");
    if (!isXauLive) failedAPIs.push("XAU");
    if (!isUsdLive) failedAPIs.push("USD");

    let currentStatus = failedAPIs.length === 0 ? "Live" : `Delayed (Lỗi: ${failedAPIs.join(", ")})`;

    latestData = {
      updatedAt: new Date(), 
      usd, xau, xauChange, sjc, sjcChange, oldGap, gapChange, 
      worldVND: Math.round(worldVND), diff: currentGap,
      percent: ((diff / worldVND) * 100).toFixed(2) + "%",
      status: currentStatus 
    };

    console.log("----------------------------------------");
    console.log(`   ⚖️ GAP: ${latestData.diff.toLocaleString('vi-VN')} VNĐ (${latestData.percent})`);
    console.log("----------------------------------------");

    if (sjc > 0 && (!lastRecord || lastRecord.sjc !== sjc)) {
      const dbEntry = { ...latestData };
      delete dbEntry.updatedAt; 
      const savedDoc = await History.create(dbEntry);
      
      cachedLastSavedXau = xau;
      lastDifferentSjc = { sjc: sjc, diff: currentGap };
   
      const slimDoc = {
        createdAt: savedDoc.createdAt,
        xau: savedDoc.xau, sjc: savedDoc.sjc, diff: savedDoc.diff,
        percent: savedDoc.percent, _id: savedDoc._id
      };
      cachedHistory.unshift(slimDoc);
      if (cachedHistory.length > 1000) cachedHistory.pop(); 

      try {
        const overflowRecord = await History.findOne()
          .sort({ createdAt: -1 }).skip(1000).select('createdAt').lean();
        if (overflowRecord?.createdAt) {
          await History.deleteMany({ createdAt: { $lt: overflowRecord.createdAt } });
        }
      } catch (err) {}
    } 

    const ssePayload = `data: ${JSON.stringify(latestData)}\n\n`;
    for (const c of clients) {
      try { c.write(ssePayload); if (typeof c.flush === "function") c.flush(); } 
      catch (err) { clients.delete(c); }
    }
  } catch (e) {
    console.log("❌ LỖI TRONG UPDATE-DATA:", e.message);
  } finally {
    isUpdating = false;
  }
}

/* ===== API & SSE ===== */
app.get("/api/stream", (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  
  if (clients.size > 1000) {
    let i = 0;
    for (const c of clients) {
      if (i >= clients.size - 500) break;
      try { c.end(); } catch (e) {}
      clients.delete(c); i++;
    }
  }
  
  clients.add(res);
  
  if (latestData) {
      res.write(`data: ${JSON.stringify(latestData)}\n\n`);
      if (typeof res.flush === "function") res.flush();
  }

  req.on("close", () => {
    clients.delete(res);
    try { res.end(); } catch {}
  });
});

app.get("/api/gold", async (req, res) => { res.json(latestData || {}); });

app.get("/api/history", async (req, res) => {
  if (cachedHistory.length > 0) return res.json(cachedHistory);
  const data = await History.find()
    .select("createdAt xau sjc diff percent _id") 
    .sort({ createdAt: -1 }).limit(1000).lean();
  cachedHistory = data;
  res.json(data);
});

app.post("/api/history/bulk-delete", async (req, res) => {
  try {
    const { ids } = req.body;
    if (!ids || !Array.isArray(ids)) return res.status(400).json({ error: "Thiếu danh sách ID" });
    await History.deleteMany({ _id: { $in: ids } });
    cachedHistory = [];
    res.json({ ok: true });
  } catch (error) { res.status(500).json({ error: "Lỗi xóa" }); }
});

cron.schedule("*/5 * * * *", () => { updateData("Cronjob 5 phút"); });
