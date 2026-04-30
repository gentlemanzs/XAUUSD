const express = require("express");
const cron = require("node-cron");
const cors = require("cors");
const mongoose = require("mongoose");
const cheerio = require("cheerio");
const compression = require("compression");
// TỐI ƯU BẢO MẬT: Nạp thư viện chống DDoS / Dội bom API
const rateLimit = require('express-rate-limit');
const app = express();

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
app.use(express.json());
const path = require("path");

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
      .select("createdAt xau sjc diff percent _id") // Loại bỏ usd, worldVND, status khỏi RAM lịch sử
      .sort({ createdAt: -1 })
      .limit(1000)
      .lean();
    if (historyData.length > 0) cachedHistory = historyData;

    // 2. Nạp các biến Cache tính toán (Cần đủ các trường để tính toán logic lần cào tiếp theo)
    const last = await History.findOne()
      .select('sjc diff xau usd')
      .sort({ createdAt: -1 })
      .lean();

    if (last) {
      cachedLastSavedXau = last.xau;
      // Tránh việc updateData gọi DB lấy lastRecord trong lần cào đầu tiên
      latestData = { sjc: last.sjc, xau: last.xau, usd: last.usd };
      
      // SỬA LỖI LOGIC: Phải tìm đúng dòng có SJC KHÁC VỚI SJC HIỆN TẠI để nạp Gap cũ
      const diffRecord = await History.findOne({ sjc: { $ne: last.sjc } })
        .select('sjc diff')
        .sort({ createdAt: -1 })
        .lean();
      
      lastDifferentSjc = diffRecord ? { sjc: diffRecord.sjc, diff: diffRecord.diff } : { sjc: last.sjc, diff: last.diff };
      
      console.log(`📦 Khởi động: Đã nạp (Preload) toàn bộ ${historyData.length} dòng History (tinh gọn) lên RAM!`);
    }
  } catch (e) {
    console.log("⚠️ Khởi động: Lỗi preload cache:", e.message);
  }
}

/* ===== CONNECT MONGO ===== */
// Tối ưu: Đưa logic khởi chạy vào bên trong .then để đảm bảo DB luôn sẵn sàng
mongoose.connect(process.env.MONGO_URI, { 
  serverSelectionTimeoutMS: 5000,
  maxPoolSize: 10, // TỐI ƯU: Nâng cấp Pool Tuning để ổn định khi nhiều request
  minPoolSize: 2
})
  .then(async () => { // Thêm async vào đây để gọi preload
    console.log("✅ MongoDB connected");
    await preloadCache(); // Nạp sẵn RAM trước khi mở cổng cho khách vào
    // Khởi động server và chạy cào dữ liệu ngay sau khi DB sẵn sàng
    app.listen(PORT, () => {
      console.log(`🚀 Server running on port ${PORT}`);
      updateData("Khởi động Server");
    });
  })
  .catch(err => { 
    console.error("❌ MongoDB error:", err); 
    process.exit(1); 
  });

// TỐI ƯU BỀN BỈ: Lắng nghe và báo cáo lỗi nếu Database bị rớt mạng giữa chừng (Tự chữa lành)
mongoose.connection.on('error', (err) => {
  console.error("🔥 Lỗi Mất Kết Nối MongoDB Đột Ngột:", err);
});
mongoose.connection.on('disconnected', () => {
  console.warn("⚠️ MongoDB đã ngắt kết nối. Đang thử lại (Mongoose tự động Reconnect)...");
});

/* ===== SCHEMA ===== */
const HistorySchema = new mongoose.Schema({
  usd: Number, xau: Number, sjc: Number, worldVND: Number,
  diff: Number, percent: String, status: String
}, { timestamps: true });

// TỐI ƯU: Đổi thứ tự Index (ESR Rule) giúp Mongo ưu tiên sort createdAt trước khi dùng $ne
HistorySchema.index({ createdAt: -1, sjc: 1 });
HistorySchema.index({ createdAt: -1 });
const History = mongoose.model("History", HistorySchema);

// Biến RAM Cache tổng
let latestData = null;
// TỐI ƯU O(1): Sử dụng Set thay vì Array để thao tác xóa Client đứt kết nối diễn ra ngay lập tức
let clients = new Set(); 
let isUpdating = false; 

// THÊM CÁC BIẾN NÀY ĐỂ LƯU CACHE TRÊN RAM
// TỐI ƯU: Sử dụng biến lastDifferentSjc cho cơ chế Hybrid thay thế cachedOldGap
let lastDifferentSjc = null; 
let cachedLastSavedXau = null; // <-- THÊM MỚI: Biến lưu giá XAU của lần ghi DB gần nhất

// --- CÁC BIẾN CACHE MỚI CHO VIỆC TỐI ƯU ---
let cachedYesterdaySjc = null;
let cachedYesterdayDate = null;
let cachedHistory = [];

// 🔥 HEARTBEAT giữ kết nối SSE không bị chết
setInterval(() => {
  // TỐI ƯU: Dùng filter kết hợp try-catch để dọn sạch "xác" client bị ngắt mạng âm thầm
  for (const c of clients) {
    try {
      c.write(":\n\n"); // ping nhẹ, client sẽ ignore
      if (typeof c.flush === "function") c.flush();
    } catch (e) {
      clients.delete(c); // Xóa ngay lập tức khỏi Set
    }
  }
}, 20000); // mỗi 20 giây

// Biến RAM Cache riêng cho USD (1 tiếng)
// Dùng null thay cho 1000 để bắt làm ép cào ngay khi khởi động
let cachedUsdRate = null; 
let lastUsdFetchTime = 0;
const USD_CACHE_DURATION = 60 * 60 * 1000; // 1 tiếng tính bằng mili-giây

/* ===== KIỂM TRA GIỜ GIAO DỊCH VN ===== */
function isVietnamTradingTime() {
  const now = new Date();
  // Lấy giờ chính xác theo múi giờ Việt Nam
  const vnTimeStr = now.toLocaleString("en-US", { timeZone: "Asia/Ho_Chi_Minh" });
  const vnTime = new Date(vnTimeStr);
  
  const day = vnTime.getDay(); // 0: CN, 1: T2, ..., 6: T7
  const hour = vnTime.getHours();
  const min = vnTime.getMinutes();
  
  // Quy đổi thời gian ra số phút để so sánh cho dễ
  const timeInMinutes = hour * 60 + min;

  // Chủ nhật: Nghỉ hoàn toàn
  if (day === 0) return false;

  // T2 đến T6: 8h30 (510) -> 17h30 (1050)
  if (day >= 1 && day <= 5) {
    return timeInMinutes >= 510 && timeInMinutes <= 1050;
  }

  // T7: 8h30 (510) -> 10h30 (630)
  if (day === 6) {
    return timeInMinutes >= 510 && timeInMinutes <= 630;
  }

  return false;
}


/* ===== FETCH HELPERS ===== */
async function fetchWithRetry(url, isJson = false, retries = 3) {
  for (let i = 0; i < retries; i++) {
    try {
      const res = await fetch(url, {
        headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36" },
        signal: AbortSignal.timeout(5000), // TỐI ƯU: Đổi 8s -> 5s để fail nhanh hơn, mượt realtime
        keepalive: true // TỐI ƯU: Giữ kết nối để gọi API nhanh hơn
      });
      if (!res.ok) throw new Error(`HTTP Error: ${res.status}`);
      return isJson ? await res.json() : await res.text();
    } catch (e) {
      if (i === retries - 1) {
        console.warn(`⚠️ Cảnh báo: Lỗi khi lấy dữ liệu từ ${url} - ${e.message}`);
        return null; 
      }
      // TỐI ƯU: Thêm Exponential Backoff nhẹ (giảm xuống 300ms) để fail nhanh hơn
      await new Promise(r => setTimeout(r, 300 * (i + 1)));
    }
  }
}

/* ===== HÀM CÀO USD ĐỘC LẬP (CÓ CACHE 1 TIẾNG) ===== */
async function getUsdRate() {
  const now = Date.now();
  // Nếu chưa qua 1 tiếng và đã có dữ liệu trước đó -> Trả về dữ liệu cũ luôn, không cần cào mạng
  if (now - lastUsdFetchTime < USD_CACHE_DURATION && cachedUsdRate !== null) {
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

/* ===== HÀM LẤY GIÁ SJC (CHÍNH: DOJI, FALLBACK: BTMC) ===== */
async function getSjcPrice() {
  // 1. THỬ LẤY TỪ DOJI TRƯỚC
  try {
    const dojiXml = await fetchWithRetry("https://giavang.doji.vn/api/giavang/?api_key=258fbd2a72ce8481089d88c678e9fe4f", false);
    if (dojiXml) {
      const $ = cheerio.load(dojiXml, { xmlMode: true });
      const sellStr = $('Row[Key="dojihanoile"]').attr('Sell');
      
      if (sellStr) {
        let price = parseFloat(sellStr.replace(/,/g, ""));
        // API thường trả về dạng nghìn đồng (vd: 89500), cần nhân 1000 để ra giá trị thực tế (89.500.000)
        if (price > 0 && price < 1000000) price *= 1000; 
        console.log(`   🌟 Đã lấy giá SJC từ DOJI: ${price.toLocaleString('vi-VN')}`);
        return price;
      }
    }
  } catch (err) {
    console.warn("   ⚠️ DOJI gặp sự cố, đang chuyển sang API dự phòng BTMC...");
  }

  // 2. NẾU DOJI LỖI -> DÙNG FALLBACK BTMC
  try {
    const btmcXml = await fetchWithRetry("http://api.btmc.vn/api/BTMCAPI/getpricebtmc?key=3kd8ub1llcg9t45hnoh8hmn7t5kc2v", false);
    if (btmcXml) {
      const $ = cheerio.load(btmcXml, { xmlMode: true });
      const sellStr = $('Data[row="932"]').attr('ps_932');
      
      if (sellStr) {
        let price = parseFloat(sellStr.replace(/,/g, ""));
        // BTMC cũng thường trả về dạng nghìn đồng
        if (price > 0 && price < 1000000) price *= 1000; 
        console.log(`   🌟 Đã lấy giá SJC từ BTMC (Dự phòng): ${price.toLocaleString('vi-VN')}`);
        return price;
      }
    }
  } catch (err) {
    console.warn("   ⚠️ BTMC cũng gặp sự cố!");
  }

  return 0; // Trả về 0 nếu cả 2 API đều sập
}

/* ===== UPDATE LOGIC (CÀO DỮ LIỆU CHÍNH) ===== */
async function updateData(triggerSource = "Tự động") {
  if (isUpdating) {
    console.log("⏳ Skip update (đang chạy)"); 
    return; 
  }
  isUpdating = true;
  try {
    const isTrading = isVietnamTradingTime();
    
    if (isTrading) {
      console.log(`\n▶ [${triggerSource}] (Trong giờ GD) Bắt đầu cào toàn bộ dữ liệu lúc ${new Date().toLocaleTimeString('vi-VN')}`);
    } else {
      console.log(`\n▶ [${triggerSource}] (Ngoài giờ GD) Đã ngưng cào USD & SJC. Chỉ cập nhật XAU lúc ${new Date().toLocaleTimeString('vi-VN')}`);
    }
    
    // Gọi API. Nếu ngoài giờ GD, nhét null/0 vào để tự động Fallback xuống dữ liệu cũ
    const [usdRate, dataXAU, sjcPrice] = await Promise.all([
      isTrading ? getUsdRate() : Promise.resolve(null),
      fetchWithRetry("https://api.gold-api.com/price/XAU", true),
      isTrading ? getSjcPrice() : Promise.resolve(0)
    ]);

    let lastRecord = latestData; 
    if (!lastRecord) {
      // TỐI ƯU: Thêm .select('usd xau sjc') để giảm tải payload Mongo khi query lần đầu
      lastRecord = await History.findOne().select('usd xau sjc').sort({ createdAt: -1 }).lean().catch(() => null);
    }
    
        
    // --- Kiểm tra tính sẵn sàng của dữ liệu ---
    const isSjcLive = sjcPrice > 0;
    const isXauLive = !!(dataXAU && dataXAU.price);
    const isUsdLive = usdRate !== null;

    // --- Xử lý FALLBACK (Nếu ngoài giờ hoặc API sập thì dùng lastRecord) ---
    let sjc = isSjcLive ? sjcPrice : (lastRecord ? lastRecord.sjc : 0);
    let xau = isXauLive ? dataXAU.price : (lastRecord ? lastRecord.xau : 2350);
    // Nếu cả USD và Database đều null, đặt fallback cứng là 25400 để tránh sập toàn hệ thống
    let usd = isUsdLive ? usdRate : (lastRecord ? lastRecord.usd : 25400); 

    if (sjc <= 0 || xau <= 0) {
        console.log("❌ LỖI NGHIÊM TRỌNG: Không có dữ liệu cào và cũng không có bản lưu dự phòng!");
        
        if (latestData) {
          latestData.status = "Delayed (Lỗi hệ thống)";
          const fallbackPayload = `data: ${JSON.stringify(latestData)}\n\n`;
          for (const c of clients) {
            try { 
              c.write(fallbackPayload); 
              if (typeof c.flush === "function") c.flush(); 
            } catch (err) { 
              clients.delete(c); 
            }
          }
        }
        return; 
    }

    // --- TÍNH TOÁN ---
    const worldVND = xau * usd * (37.5 / 31.1035);
    const diff = sjc - worldVND;
    const currentGap = Math.round(diff);

    // --- 1. Tính SJC Change (So với hôm qua) ---
    // TỐI ƯU: Chỉ Query DB 1 lần/ngày bằng cách Cache lại
    const todayStr = new Date().toDateString();
    if (cachedYesterdayDate !== todayStr || cachedYesterdaySjc === null) {
      const yesterday = new Date();
      yesterday.setDate(yesterday.getDate() - 1);
      yesterday.setHours(23, 59, 59, 999);

      // Thêm select('sjc') để lấy nhẹ dữ liệu
      const lastDayRecord = await History.findOne({
        createdAt: { $lte: yesterday }
      }).select('sjc').sort({ createdAt: -1 }).lean().catch(() => null);

      cachedYesterdaySjc = lastDayRecord ? lastDayRecord.sjc : sjc;
      cachedYesterdayDate = todayStr;
    }
    const sjcChange = sjc - cachedYesterdaySjc;

    // --- 2. TÌM GAP CŨ (TỐI ƯU HYBRID $NE BẰNG RAM CACHE) ---
    // Chỉ hỏi DB 1 lần duy nhất khi Server start, sau đó dùng RAM hoàn toàn
    if (!lastDifferentSjc) {
      const record = await History.findOne({ sjc: { $ne: sjc } })
        .select('sjc diff')
        .sort({ createdAt: -1 })
        .lean()
        .catch(() => null);

      lastDifferentSjc = record ? { sjc: record.sjc, diff: record.diff } : { sjc: sjc, diff: currentGap };
    }

    const oldGap = lastDifferentSjc.diff;
    // Tính khoảng chênh lệch: Cũ trừ Hiện tại (Theo đúng yêu cầu của bạn)
    const gapChange = oldGap - currentGap;

    // --- 3. TÍNH XAU CHANGE (MỚI: So với lần Database được lưu gần nhất) ---
    // Nếu Server vừa bật, nạp giá XAU từ DB vào RAM 1 lần duy nhất
    if (cachedLastSavedXau === null) {
      // Thêm select('xau') để lấy nhẹ dữ liệu
      const latestDbRecord = await History.findOne().select('xau').sort({ createdAt: -1 }).lean().catch(() => null);
      cachedLastSavedXau = latestDbRecord ? latestDbRecord.xau : xau;
    }
    const xauChange = xau - cachedLastSavedXau;

    // --- XÁC ĐỊNH TRẠNG THÁI (LỖI Ở ĐÂU BÁO Ở ĐÓ) ---
    let failedAPIs = [];
    if (!isTrading) failedAPIs.push("Ngoài giờ GD");
    else {
      if (!isSjcLive) failedAPIs.push("SJC Lỗi");
      if (!isUsdLive) failedAPIs.push("USD Lỗi");
    }
    if (!isXauLive) failedAPIs.push("XAU Lỗi");

    let currentStatus = failedAPIs.length === 0 ? "Live" : `Delayed (${failedAPIs.join(", ")})`;

   // --- LƯU VÀO RAM CACHE ĐỂ GỬI XUỐNG CLIENT ---
    latestData = {
      updatedAt: new Date(), 
      usd, 
      xau, 
      xauChange: xauChange, // <-- Thêm biến này để gửi cho ô Global XAU
      sjc,
      sjcChange: sjcChange, 
      oldGap: oldGap,       
      gapChange: gapChange, 
      worldVND: Math.round(worldVND), 
      diff: currentGap,
      percent: ((diff / worldVND) * 100).toFixed(2) + "%",
      status: currentStatus 
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
      // TỐI ƯU: Gán _id cho dbEntry vừa tạo để tương thích hoàn toàn khi đẩy vào mảng cache
      const savedDoc = await History.create(dbEntry);
      console.log(`   💾 DB: Đã lưu bản ghi SJC mới là ${sjc.toLocaleString('vi-VN')}`);
      
      // CẬP NHẬT LẠI BIẾN RAM CACHE XAU VÌ DB VỪA CÓ BẢN GHI MỚI!
      cachedLastSavedXau = xau;
      // TỐI ƯU HYBRID: Cập nhật luôn mốc SJC mới vào RAM để dùng cho tính toán Gap lần sau
      lastDifferentSjc = { sjc: sjc, diff: currentGap };
   
      // Nuôi Cache tinh gọn vào RAM
      const slimDoc = {
        createdAt: savedDoc.createdAt,
        xau: savedDoc.xau,
        sjc: savedDoc.sjc,
        diff: savedDoc.diff,
        percent: savedDoc.percent,
        _id: savedDoc._id
      };
      cachedHistory.unshift(slimDoc);
      if (cachedHistory.length > 1000) cachedHistory.pop(); // Khóa chặt RAM ở 1000 dòng

      // TỐI ƯU TẬN CÙNG: Dọn rác Database tự động (Chỉ giữ lại 1000 bản ghi mới nhất)
      try {
        const count = await History.countDocuments();
        if (count > 1000) {
          // Lấy _id của bản ghi thứ 1000 (Sắp xếp từ mới đến cũ)
          const recordsToKeep = await History.find().sort({ createdAt: -1 }).skip(1000).limit(1).select('_id').lean();
          if (recordsToKeep && recordsToKeep.length > 0) {
            const thresholdId = recordsToKeep[0]._id;
            // Xóa tất cả các bản ghi CŨ HƠN bản ghi thứ 1000
            await History.deleteMany({ _id: { $lt: thresholdId } });
            console.log("   🧹 Dọn rác DB: Đã xóa các bản ghi cũ vượt quá giới hạn 1000 dòng.");
          }
        }
      } catch (err) {
        console.warn("   ⚠️ Dọn rác DB thất bại:", err.message);
      }

    } else {
      console.log(`   ⏩ DB: Giá SJC không đổi (${sjc.toLocaleString('vi-VN')}), không lưu rác.`);
    }

    // --- ĐẨY DỮ LIỆU SSE CHO CLIENT ---
    // TỐI ƯU: Tránh Stringify nhiều lần gây CPU Spike
    const ssePayload = `data: ${JSON.stringify(latestData)}\n\n`;
    
    // TỐI ƯU: Dọn rác triệt để (xóa client chết ngay lập tức bằng filter)
    for (const c of clients) {
      try {
        c.write(ssePayload);
        if (typeof c.flush === "function") c.flush();
      } catch (err) {
        clients.delete(c); // Xóa ngay khỏi Set
      }
    }
    
    console.log(`   ✅ Đã đẩy Realtime xuống ${clients.size} client(s) đang kết nối.`);

  } catch (e) {
    console.log("❌ LỖI HỆ THỐNG (TRY-CATCH) TRONG UPDATE-DATA:", e.message);
  } finally {
    isUpdating = false;
  }
}

/* ===== API & SSE ===== */

app.get("/api/stream", (req, res) => {
  // TỐI ƯU: Sửa lỗi text-event-stream thành text/event-stream chuẩn xác
  res.setHeader("Content-Type", "text-event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  
  // TỐI ƯU: Phanh khẩn cấp chống Memory Leak khi có quá nhiều kết nối rác
  if (clients.size > 1000) {
    let i = 0;
    for (const c of clients) {
      if (i >= clients.size - 500) break;
      try { c.end(); } catch (e) {}
      clients.delete(c);
      i++;
    }
    console.warn("⚠️ Đã dọn dẹp và ngắt kết nối mạng của các client cũ.");
  }
  
  clients.add(res);
  
  if (latestData) {
      res.write(`data: ${JSON.stringify(latestData)}\n\n`);
      if (typeof res.flush === "function") res.flush();
  }

  req.on("close", () => {
    clients.delete(res);
    // TỐI ƯU: Bọc try-catch để đóng kết nối an toàn tuyệt đối, tránh Zombie socket
    try { res.end(); } catch {}
  });
});

app.get("/api/gold", async (req, res) => {
    res.json(latestData || {});
});

// TỐI ƯU TẬN CÙNG: API này giờ đây được phục vụ 100% bằng RAM (Zero Database Read)
app.get("/api/history", async (req, res) => {
  // Mảng cachedHistory đã được nạp sẵn từ hàm preloadCache và luôn được cập nhật bởi hàm updateData
  if (cachedHistory.length > 0) {
    return res.json(cachedHistory);
  }

  // Khúc Fallback này chỉ để phòng ngừa rủi ro nếu có bug làm xóa rỗng mảng RAM
  const data = await History.find()
    .select("createdAt xau sjc diff percent _id") 
    .sort({ createdAt: -1 })
    .limit(1000) // Khóa giới hạn 1000 dòng
    .lean();
    
  cachedHistory = data;
  res.json(data);
});

app.post("/api/history/bulk-delete", async (req, res) => {
  try {
    const { ids } = req.body;
    if (!ids || !Array.isArray(ids)) return res.status(400).json({ error: "Thiếu danh sách ID" });
    await History.deleteMany({ _id: { $in: ids } });
    
    // Reset cache khi xóa để tải lại danh sách mới
    cachedHistory = [];
    res.json({ ok: true });
  } catch (error) { res.status(500).json({ error: "Lỗi xóa" }); }
});

/* ===== CRONJOB (QUẢN LÝ LỊCH TRÌNH) ===== */
cron.schedule("*/5 * * * *", () => {
  console.log("⏱ [Watchdog] Cron tick OK"); // TỐI ƯU: Đảm bảo tiến trình vẫn chạy
  updateData("Cronjob 5 phút");
});