const express = require("express");
const axios = require("axios");
const cron = require("node-cron");
const cors = require("cors");
const path = require("path");
const mongoose = require("mongoose");
require("dotenv").config();

const app = express();
app.use(cors());
app.use(express.json());

/* --- CẤU HÌNH --- */
const PORT = process.env.PORT || 8080;
const MONGO_URI = process.env.MONGO_URI;

/* --- KẾT NỐI MONGODB VỚI LOG CHI TIẾT --- */
mongoose.connect(MONGO_URI, { 
    serverSelectionTimeoutMS: 5000 // Tự động ngắt sau 5s nếu không kết nối được
})
.then(() => console.log("✅ [Database] Đã kết nối MongoDB Atlas thành công!"))
.catch(err => {
    console.error("❌ [Database] LỖI KẾT NỐI:");
    console.error("   - Kiểm tra lại chuỗi MONGO_URI trên Railway.");
    console.error("   - Đảm bảo đã thay <password> và xóa dấu < >.");
    console.error("   - Đảm bảo đã mở IP 0.0.0.0/0 trên MongoDB Atlas.");
});

/* --- SCHEMA --- */
const historySchema = new mongoose.Schema({
  time: String,
  usd: Number,
  xau: Number,
  sjc: Number,
  worldVND: Number,
  diff: Number,
  percent: String,
  createdAt: { type: Date, default: Date.now }
});
const History = mongoose.model("History", historySchema);

app.use(express.static("public"));
let latestData = null;

/* --- HELPER TẢI DỮ LIỆU --- */
async function fetchWithRetry(url) {
  try {
    const res = await axios.get(url, {
      timeout: 10000,
      headers: { "User-Agent": "Mozilla/5.0" }
    });
    return res.data;
  } catch (e) {
    console.log(`⚠️ Không thể tải: ${url}`);
    return null;
  }
}

/* --- 1. LẤY TỶ GIÁ USD (CHỈ LẤY CỘT BÁN) --- */
async function getUSDRate() {
  try {
    const html = await fetchWithRetry("https://webgia.com/ty-gia/vietcombank/");
    if (!html) throw "Lỗi tải trang";

    const clean = html.replace(/\s+/g, " ");
    const usdIndex = clean.indexOf("USD");
    if (usdIndex === -1) throw "Không tìm thấy dòng USD";

    // Cắt đoạn dữ liệu quanh chữ USD
    const section = clean.substring(usdIndex, usdIndex + 300);
    const nums = section.match(/[0-9]{2}\.[0-9]{3}/g); // Tìm số dạng 25.xxx

    if (!nums || nums.length < 3) throw "Không đủ dữ liệu cột (Mua/CK/Bán)";

    // Lấy phần tử thứ 3 (nums[2]) - Đây là cột BÁN RA
    const rate = parseFloat(nums[2].replace(".", ""));
    console.log(`💵 USD (Bán): ${rate}`);
    return rate;
  } catch (e) {
    console.log("❌ Lỗi cào USD:", e);
    return 25450; 
  }
}

/* --- 2. LẤY GIÁ VÀNG THẾ GIỚI --- */
async function getWorldGoldPrice() {
  try {
    const data = await fetchWithRetry("https://api.gold-api.com/price/XAU");
    return data?.price || 2350;
  } catch { return 2350; }
}

/* --- 3. LẤY GIÁ VÀNG SJC (CÀO THẬT) --- */
async function getSJCPrice() {
  try {
    const html = await fetchWithRetry("https://webgia.com/gia-vang/sjc/");
    if (!html) throw "Lỗi tải trang";

    const clean = html.replace(/\s+/g, " ");
    const nums = clean.match(/[0-9]{2}\.[0-9]{3}\.[0-9]{3}/g); // Tìm số dạng 8x.xxx.xxx
    if (!nums) throw "Không thấy số SJC";

    const values = nums.map(n => parseInt(n.replace(/\./g, "")));
    // Lấy giá Bán ra (vị trí số 2 trong danh sách)
    const price = values[1] || values[0];
    console.log(`🧈 SJC (Bán): ${price}`);
    return price;
  } catch (e) {
    return 89000000;
  }
}

/* --- LƯU LỊCH SỬ --- */
async function saveHistory(entry) {
  try {
    // 1. Kiểm tra trạng thái kết nối Database trước
    if (mongoose.connection.readyState !== 1) {
        console.log("⚠️ Bỏ qua lưu: Chưa kết nối được Database.");
        return;
    }

    const lastEntry = await History.findOne().sort({ createdAt: -1 });

    // 2. Chỉ lưu nếu giá có thay đổi thực sự
    if (!lastEntry || lastEntry.sjc !== entry.sjc || lastEntry.xau !== entry.xau) {
      await History.create(entry);
      console.log("💾 [MongoDB] Đã ghi lịch sử mới thành công.");
    } else {
      console.log("ℹ️ [MongoDB] Giá không đổi, không ghi thêm.");
    }
  } catch (e) {
    console.error("❌ [MongoDB] Lỗi khi ghi:", e.message);
  }
}

/* --- UPDATE DATA --- */
async function updateData() {
  console.log(`\n--- ${new Date().toLocaleTimeString('vi-VN')} BẮT ĐẦU CẬP NHẬT ---`);
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
      time: new Date().toLocaleString("vi-VN", { timeZone: "Asia/Ho_Chi_Minh" }),
      usd,
      xau,
      sjc,
      worldVND: Math.round(worldVND),
      diff: Math.round(diff),
      percent: percent.toFixed(2) + "%"
    };

    await saveHistory(latestData);
    console.log("✅ HOÀN TẤT CẬP NHẬT");

  } catch (e) {
    console.log("❌ LỖI UPDATE:", e);
  }
}

/* --- CHU KỲ & ROUTE --- */
cron.schedule("*/2 * * * *", updateData);

app.get("/api/gold", (req, res) => {
  res.json(latestData || { message: "Đang khởi tạo, vui lòng đợi..." });
});

app.get("/api/history", async (req, res) => {
  try {
    const data = await History.find().sort({ createdAt: -1 }).limit(100);
    res.json(data.reverse());
  } catch (e) { res.status(500).send("Lỗi DB"); }
});

app.delete("/api/history", async (req, res) => {
  try {
    await History.deleteMany({});
    res.json({ message: "Đã xóa lịch sử DB." });
  } catch (e) { res.status(500).send("Lỗi xóa"); }
});

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public/index.html"));
});

app.listen(PORT, () => {
  console.log(`🚀 Server chạy trên port ${PORT}`);
  updateData();
});