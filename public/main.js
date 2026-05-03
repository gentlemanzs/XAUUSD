// ============================================================================
// PHẦN 1: KHỞI TẠO BIẾN, DOM ELEMENTS VÀ CẤU HÌNH FORMAT
// ============================================================================
const API = "/api/gold";
const HIST_API = "/api/history";

// Gom nhóm tất cả các phần tử DOM để tránh gọi document.getElementById nhiều lần
const elements = {
  usd: document.getElementById("usd"),
  xauValue: document.getElementById("xauValue"), xauChange: document.getElementById("xauChange"),
  sjcValue: document.getElementById("sjcValue"), sjcChange: document.getElementById("sjcChange"),
  diff: document.getElementById("diff"), percent: document.getElementById("percent"),
  gapChange: document.getElementById("gapChange"), lastTime: document.getElementById("lastTime"),
  historyTable: document.getElementById("history"), filterBox: document.getElementById("filterBox"),
  startDate: document.getElementById("startDate"), endDate: document.getElementById("endDate"),
  toggleBtn: document.getElementById("toggleBtn"),
  pagination: document.getElementById("pagination")
};

// Cấu hình định dạng tiền tệ (VND) và số thập phân (USD/XAU)
const fmtVND = new Intl.NumberFormat('vi-VN');
const fmtXAU = new Intl.NumberFormat('en-US', { minimumFractionDigits: 1, maximumFractionDigits: 1 });

let isFullHistoryLoaded = false; // Thêm cờ đánh dấu đã tải full data chưa
// Biến lưu trữ trạng thái RAM của Frontend
let historyData = [];       // Lưu toàn bộ lịch sử (tối đa 1000 dòng)
let currentData = [];       // Lưu dữ liệu đang hiển thị (sau khi filter)
let lastSJCValue = null;    // Lưu giá SJC lần cuối để so sánh
let myChart = null;         // Đối tượng Chart.js
let lastChartSignature = "";// Chữ ký biểu đồ để tránh render lại biểu đồ giống nhau
let isExpanded = false;     // Trạng thái mở rộng bảng History
let currentPage = 1;        // Trang hiện tại của Pagination

let evtSource = null;       // Đối tượng Server-Sent Events (SSE)
let lastFetchTime = 0;      // Chống spam gọi API liên tục

// ============================================================================
// PHẦN 2: QUẢN LÝ OBSERVER & ĐỒNG BỘ DỮ LIỆU CƠ BẢN
// ============================================================================

// Chỉ render/update biểu đồ khi người dùng cuộn tới nó (Tối ưu hiệu năng GPU)
let isChartVisible = true;
const chartObserver = new IntersectionObserver((entries) => {
  isChartVisible = entries[0].isIntersecting;
  if (isChartVisible && myChart) myChart.update('none');
}, { threshold: 0.1 });

document.addEventListener("DOMContentLoaded", () => {
  const chartEl = document.getElementById('gapChart');
  if (chartEl) chartObserver.observe(chartEl);
});

// Hàm gọi API lịch sử an toàn, có throttle (tối thiểu 5 giây mỗi lần gọi)
function safeFetchHistory(isInit = false) {
  const now = Date.now();
  if (!isInit && now - lastFetchTime < 5000) return;
  lastFetchTime = now;
  fetchHistory();
}

// ============================================================================
// PHẦN 3: KẾT NỐI REALTIME (SERVER-SENT EVENTS)
// ============================================================================
function initSSE() {
  // Fix rò rỉ SSE: Đóng hẳn luồng cũ nếu nó đang ở trạng thái lấp lửng (CONNECTING)
  if (evtSource) {
    // Nếu kết nối đang mở và hoạt động tốt thì giữ nguyên
    if (evtSource.readyState === EventSource.OPEN) return;

    // Nếu không, đóng hẳn để dọn dẹp trước khi tạo mới
    evtSource.close();
  }

  evtSource = new EventSource("/api/stream");

  evtSource.onmessage = (event) => {
    if (!event.data) return;
    let d;
    try { d = JSON.parse(event.data); } catch (e) {
      console.error('[SSE] JSON parse lỗi:', e);
      return;
    }
    if (!d?.updatedAt) return;

    // Hiệu ứng chớp xanh chữ "Đang kết nối..." báo hiệu có data mới
    elements.lastTime.style.color = "#10b981";
    setTimeout(() => elements.lastTime.style.color = "#64748b", 2000);

    // Xử lý cảnh báo nếu cào lỗi
    if (d.failedAPIs && d.failedAPIs.length > 0) {
      console.warn(`[XAU] ⚠️ API lỗi lúc ${d.timeStr}:`, d.failedAPIs.join(", "), "→ Đang dùng data cũ");
    } else {
      console.log(`Updated at ${new Date().toLocaleTimeString('vi-VN')}`);
    }

    renderMain(d); // Vẽ lại các thẻ Card

    // NẾU GIÁ SJC THAY ĐỔI -> Tự động kéo lịch sử mới về
    if (lastSJCValue === null || d.sjc !== lastSJCValue) {
      const isFirstLoad = lastSJCValue === null;
      lastSJCValue = d.sjc;
      safeFetchHistory(isFirstLoad);
    }
  };

  evtSource.onerror = () => {
    elements.lastTime.textContent = "🔴 Mất kết nối. Đang thử lại...";
    elements.lastTime.style.color = "var(--down-color)";
  };
}

// Hàm tải dữ liệu thủ công (Fallback khi mới vào web hoặc mất SSE)
async function load() {
  try {
    const res = await fetch(`${API}?t=${Date.now()}`);
    if (!res.ok) throw new Error("Mạng lỗi hoặc Server không phản hồi"); // Thêm dòng này
    const d = await res.json();
    if (!d?.updatedAt) throw new Error("Dữ liệu rỗng"); // Thêm dòng này
    // ... (code xử lý d giữ nguyên)
    return true; // Trả về true nếu thành công
  } catch (e) {
    console.error('[load] Lỗi:', e);
    throw e; // Ném lỗi ra ngoài để khối catch của hàm gọi bắt được
  }
}

// ============================================================================
// PHẦN 4: RENDER GIAO DIỆN (CÁC THẺ CARD DỮ LIỆU)
// ============================================================================
function renderMain(d) {
  // Lưu cache để mở app lần sau hiển thị ngay (Offline First)
  try { localStorage.setItem('xau_main_cache', JSON.stringify(d)); } catch (e) { }

  // Chỉ cập nhật DOM nếu giá trị thực sự thay đổi (Tối ưu Repaint/Reflow)
  const usdText = fmtVND.format(d.usd);
  if (elements.usd.textContent !== usdText) elements.usd.textContent = usdText;

  const diffText = fmtVND.format(d.diff);
  if (elements.diff.textContent !== diffText) elements.diff.textContent = diffText;
  if (elements.percent.textContent !== d.percent) elements.percent.textContent = d.percent;

  // Tính toán và bôi màu giá Vàng Thế Giới (XAU)
  const xChange = d.xauChange || 0;
  const isXUp = xChange >= 0;
  const xauValueStr = fmtXAU.format(d.xau);
  const xauChangeStr = `${isXUp ? '▲' : '▼'} ${fmtXAU.format(Math.abs(xChange))}`;

  if (elements.xauValue.textContent !== xauValueStr) elements.xauValue.textContent = xauValueStr;
  if (elements.xauChange.textContent !== xauChangeStr) {
    elements.xauChange.textContent = xauChangeStr;
    // Fix classList: Xóa class cũ, thêm class mới thay vì ghi đè toàn bộ
    elements.xauChange.classList.remove('xau-up', 'xau-down');
    elements.xauChange.classList.add(isXUp ? 'xau-up' : 'xau-down');
  }

  // Khối: Sự thay đổi của Market Gap
  if (elements.gapChange && d.gapChange !== undefined) {
    const gVal = d.gapChange;
    const newGapText = (gVal > 0 ? "+" : "") + fmtVND.format(gVal);
    if (elements.gapChange.textContent !== newGapText) {
      elements.gapChange.textContent = newGapText;
      elements.gapChange.style.color = gVal > 0 ? "var(--up-color)" : (gVal < 0 ? "var(--down-color)" : "var(--secondary-text)");
    }
  }

  if (!d.sjc) return;

  // Tính toán và bôi màu giá SJC
  const change = d.sjcChange || 0;
  const isUp = change >= 0;
  const sjcValueStr = fmtVND.format(d.sjc);
  const sjcChangeStr = `${isUp ? '▲' : '▼'} ${fmtVND.format(Math.abs(change))}`;

  if (elements.sjcValue.textContent !== sjcValueStr) elements.sjcValue.textContent = sjcValueStr;
  if (elements.sjcChange.textContent !== sjcChangeStr) {
    elements.sjcChange.textContent = sjcChangeStr;
    // Fix classList: Xóa class cũ, thêm class mới
    elements.sjcChange.classList.remove('change-up', 'change-down');
    elements.sjcChange.classList.add(isUp ? 'change-up' : 'change-down');
  }

  // Cập nhật dòng trạng thái cuối cùng
  const timeStr = d.timeStr || new Date().toLocaleTimeString('vi-VN');
  const newStatusText = `${d.status === "Live" ? "🟢 Live" : "🟡 " + d.status} - Cập nhật: ${timeStr}`;
  if (elements.lastTime.textContent !== newStatusText) elements.lastTime.textContent = newStatusText;
}

// ============================================================================
// PHẦN 5: XỬ LÝ LỊCH SỬ (BẢNG, PHÂN TRANG VÀ BỘ LỌC)
// ============================================================================
async function fetchHistory() {
  try {
    const limit = isExpanded ? 1000 : 50; // Trạng thái đóng chỉ lấy 50 dòng cho nhẹ
    const res = await fetch(`${HIST_API}?limit=${limit}`, { cache: "no-store" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    historyData = await res.json();

    // Chuẩn hóa định dạng chuỗi ngày (YYYY-MM-DD) để tính toán filter
    for (const r of historyData) {
      if (!r.filterDateStr && r.createdAt) {
        const d = new Date(r.createdAt);
        if (!isNaN(d)) {
          r.filterDateStr = d.toLocaleDateString('en-CA', { timeZone: 'Asia/Ho_Chi_Minh' });
        }
      }
    }

    try { localStorage.setItem('xau_hist_cache', JSON.stringify(historyData)); } catch (e) { }
    currentData = historyData;

    // Nếu đang có bộ lọc thì apply luôn, nếu không thì render bình thường
    if (elements.startDate.value || elements.endDate.value) {
      applyFilter();
    } else {
      renderTable();
      updateChart(currentData);
    }
  } catch (e) {
    console.error('[fetchHistory] Lỗi:', e);
  }
}

// Render dữ liệu ra bảng HTML (Có phân trang)
function renderTable() {
  const pageSize = isExpanded ? 10 : 5;
  const startIdx = isExpanded ? (currentPage - 1) * pageSize : 0;
  const endIdx = startIdx + pageSize;
  const displayData = currentData.slice(startIdx, endIdx);

  document.getElementById('selectAll').checked = false; // Reset checkbox tổng

  // Dùng DocumentFragment để insert 1 lần thay vì dán HTML n lần
  const fragment = document.createDocumentFragment();

  displayData.forEach(r => {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td class="col-time">
        <span>${r.timeStr || '--'}</span>
        <input type="checkbox" class="log-checkbox check-action" value="${r._id}">
      </td> 
      <td>${fmtXAU.format(r.xau)}</td>
      <td>${fmtVND.format(r.sjc)}</td>
      <td>${fmtVND.format(r.diff)}</td>
      <td><span class="badge ${(r.percent || '').includes('-') ? 'badge-down' : 'badge-up'}"></span></td>
    `;
    tr.querySelector('td:last-child span').textContent = r.percent || '--';
    fragment.appendChild(tr);
  });

  if (elements.historyTable.replaceChildren) {
    elements.historyTable.replaceChildren(fragment);
  } else {
    elements.historyTable.innerHTML = "";
    elements.historyTable.appendChild(fragment);
  }

  renderPagination();
}

// Quản lý các nút phân trang (Chỉ hiện khi mở rộng bảng)
function renderPagination() {
  const pag = elements.pagination;
  if (!isExpanded || currentData.length <= 10) { pag.style.display = "none"; return; }

  pag.style.display = "flex"; pag.innerHTML = "";
  const totalPages = Math.ceil(currentData.length / 10);

  // Nút Previous
  const prevBtn = document.createElement("button");
  prevBtn.className = "page-btn"; prevBtn.innerText = "« Trước";
  prevBtn.disabled = currentPage === 1;
  prevBtn.onclick = () => { if (currentPage > 1) { currentPage--; renderTable(); } };
  pag.appendChild(prevBtn);

  // Tính toán hiển thị 5 trang gần nhất
  let startPage = Math.max(1, currentPage - 2);
  let endPage = Math.min(totalPages, startPage + 4);
  if (endPage - startPage < 4) startPage = Math.max(1, endPage - 4);

  for (let i = startPage; i <= endPage; i++) {
    const btn = document.createElement("button");
    btn.className = `page-btn ${i === currentPage ? "active" : ""}`; btn.innerText = i;
    btn.onclick = () => { currentPage = i; renderTable(); };
    pag.appendChild(btn);
  }

  // Nút Next
  const nextBtn = document.createElement("button");
  nextBtn.className = "page-btn"; nextBtn.innerText = "Sau »";
  nextBtn.disabled = currentPage === totalPages;
  nextBtn.onclick = () => { if (currentPage < totalPages) { currentPage++; renderTable(); } };
  pag.appendChild(nextBtn);
}

// Bật/tắt trạng thái mở rộng khu vực bảng điều khiển
function toggleFilterBox() {
  isExpanded = !isExpanded;

  if (isExpanded) { elements.filterBox.classList.add('show'); }
  else { elements.filterBox.classList.remove('show'); }

  elements.toggleBtn.innerText = isExpanded ? "−" : "+";

  const wrapper = document.querySelector('.table-wrapper');
  if (isExpanded) wrapper.classList.add('is-expanded');
  else wrapper.classList.remove('is-expanded');

  currentPage = 1;
  if (isExpanded) { fetchHistory(); } else { renderTable(); }
}

// Áp dụng bộ lọc ngày
// VÁ LỖI: Chuyển hàm thành async để ép kéo full 1000 dòng trước khi filter
async function applyFilter() {
  const startStr = elements.startDate.value;
  const endStr = elements.endDate.value;

  // Chỉ gọi API 1000 dòng nếu có nhập ngày VÀ chưa từng tải full DB
  if ((startStr || endStr) && !isFullHistoryLoaded) {
    elements.historyTable.innerHTML = "<tr><td colspan='5' style='text-align:center;'>Đang truy xuất dữ liệu...</td></tr>";
    try {
      const res = await fetch(`${HIST_API}?limit=1000`, { cache: "no-store" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      historyData = await res.json();
      isFullHistoryLoaded = true; // Bật cờ đánh dấu đã tải xong 1000 dòng

      for (const r of historyData) {
        if (!r.filterDateStr && r.createdAt) {
          const d = new Date(r.createdAt);
          if (!isNaN(d)) r.filterDateStr = d.toLocaleDateString('en-CA', { timeZone: 'Asia/Ho_Chi_Minh' });
        }
      }
      try { localStorage.setItem('xau_hist_cache', JSON.stringify(historyData)); } catch (e) { }
    } catch (e) {
      console.error(e);
    }
  }

  currentData = (!startStr && !endStr) ? historyData : historyData.filter(r => {
    if (!r.filterDateStr) return false;
    if (startStr && r.filterDateStr < startStr) return false;
    if (endStr && r.filterDateStr > endStr) return false;
    return true;
  });

  currentPage = 1;
  renderTable();
  updateChart(currentData);
}

// Xóa bộ lọc
function resetFilter() {
  elements.startDate.value = ""; elements.endDate.value = "";
  currentData = historyData;
  currentPage = 1;
  renderTable();
  updateChart(currentData);
}

// Hàm hỗ trợ chọn tất cả dòng lịch sử
function toggleSelectAll(source) {
  const checkboxes = document.querySelectorAll('.log-checkbox');
  checkboxes.forEach(cb => cb.checked = source.checked);
}

// Xóa các dòng lịch sử (Cần mật khẩu Admin)
async function deleteSelected() {
  const checkedBoxes = document.querySelectorAll('.log-checkbox:checked');
  if (checkedBoxes.length === 0) { alert("Vui lòng tích chọn ít nhất 1 dòng để xóa."); return; }

  const secret = prompt("Nhập mật khẩu để xác nhận xóa:");
  if (secret === null) return;

  const ids = Array.from(checkedBoxes).map(cb => cb.value);
  try {
    const res = await fetch('/api/history/bulk-delete', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids: ids, secret: secret })
    });

    if (res.ok) {
      currentPage = 1;
      const selectAllBtn = document.getElementById('selectAll');
      if (selectAllBtn) selectAllBtn.checked = false;
      await fetchHistory();
    } else {
      const data = await res.json();
      alert(data.error || "Lỗi khi xóa dữ liệu!");
    }
  } catch (e) { alert("Lỗi mạng!"); }
}

// ============================================================================
// PHẦN 6: VẼ BIỂU ĐỒ (CHART.JS)
// ============================================================================
function updateChart(fullData) {
  // Tránh lỗi nổ chart khi không đủ dữ liệu
  if (!fullData || fullData.length < 2) {
    lastChartSignature = "";
    if (myChart) {
      myChart.data.labels = []; myChart.data.datasets[0].data = [];
      myChart.update('none');
    }
    return;
  }

  // Rút gọn chỉ hiển thị tối đa 100 điểm biểu đồ cuối
  const MAX_POINTS = 100;
  const data = fullData.slice(0, MAX_POINTS);

  // So sánh Signature để tránh vẽ lại một khung hình giống hệt nhau
  const currentSignature = `${data.length}_${data[0].createdAt}_${data[data.length - 1].createdAt}`;
  if (currentSignature === lastChartSignature) return;
  lastChartSignature = currentSignature;

  const chartCanvas = document.getElementById('gapChart');
  const ctx = chartCanvas.getContext('2d');
  const totalPoints = data.length;
  const labels = []; const gaps = [];

  // Trục hoành (X) là các ngày, chỉ in nhãn nếu đổi ngày mới
  let lastDateLabel = null;
  for (let i = totalPoints - 1; i >= 0; i--) {
    const r = data[i];
    let dateLabel = null;
    if (r.filterDateStr) {
      const parts = r.filterDateStr.split('-');
      if (parts.length === 3) dateLabel = `${parts[2]}/${parts[1]}`;
    }
    if (dateLabel && dateLabel !== lastDateLabel) {
      labels.push(dateLabel); lastDateLabel = dateLabel;
    } else {
      labels.push('');
    }
    gaps.push(r.diff / 1000000); // Quy đổi ra triệu VNĐ cho dễ nhìn
  }

  // Tính toán chiều rộng động để cuộn ngang trên điện thoại
  const wrapper = chartCanvas.parentElement;
  const scrollContainer = document.querySelector('.chart-scroll-container');
  const containerWidth = scrollContainer.clientWidth || window.innerWidth;

  const maxSpacing = 55; let minSpacing = 35;
  if (totalPoints * minSpacing > 30000) minSpacing = Math.floor(30000 / totalPoints);

  // Đệm thêm null vào đầu mảng nếu dữ liệu quá ít (để biểu đồ luôn căn lề phải)
  const minPointsToFill = Math.ceil(containerWidth / maxSpacing);
  if (totalPoints > 0 && totalPoints < minPointsToFill) {
    const padCount = minPointsToFill - totalPoints;
    for (let i = 0; i < padCount; i++) {
      labels.push(' '.repeat(i + 1)); gaps.push(null);
    }
  }

// --- TÍNH TOÁN Y ĐỘNG & LÀM TRÒN SỐ CHẴN ---
  const validGaps = gaps.filter(g => g !== null);
  if (validGaps.length === 0) return;
  const minVal = Math.min(...validGaps);
  const maxVal = Math.max(...validGaps);
  
  // Ép đáy (yMin) về số chẵn nhỏ hơn hoặc bằng giá trị thực tế
  let yMin = Math.floor(minVal);
  if (yMin % 2 !== 0) yMin -= 1;

  // Ép đỉnh (yMax) lên số chẵn lớn hơn giá trị thực tế
  let yMax = Math.ceil(maxVal);
  if (yMax % 2 !== 0) yMax += 1;

  if (yMin >= yMax) { yMin -= 2; yMax += 2; }

  const calculatedWidth = totalPoints * minSpacing;

  if (wrapper._lastWidth !== calculatedWidth) {
    wrapper._lastWidth = calculatedWidth;
    if (calculatedWidth > containerWidth) {
      wrapper.style.setProperty('width', calculatedWidth + 'px', 'important');
      wrapper.style.setProperty('min-width', calculatedWidth + 'px', 'important');
    } else {
      wrapper.style.setProperty('width', '100%', 'important');
      wrapper.style.setProperty('min-width', '100%', 'important');
    }
  }

  // ====== 1. BIỂU ĐỒ CHÍNH (BÊN PHẢI) ======
  if (myChart) {
    myChart.data.labels = labels; myChart.data.datasets[0].data = gaps;
    myChart.options.scales.y.min = yMin; 
    myChart.options.scales.y.max = yMax;
    if (isChartVisible) myChart.update('none');
  } else {
    myChart = new Chart(ctx, {
      type: 'line',
      data: {
        labels: labels,
        datasets: [{
          data: gaps, borderColor: '#3b82f6', backgroundColor: 'rgba(59, 130, 246, 0.1)',
          borderWidth: 2, fill: true, tension: 0.3, pointRadius: 3
        }]
      },
      options: {
        responsive: true, maintainAspectRatio: false, animation: false,
        layout: { padding: { top: 15, bottom: 0, left: 0, right: 10 } }, 
        plugins: { legend: { display: false } },
        scales: {
          y: {
            min: yMin, max: yMax, beginAtZero: false,
            // Bước nhảy = 1 để vẽ kẻ ngang cách nhau 1M
            ticks: { display: false, stepSize: 1 }, 
            grid: { color: 'rgba(226, 232, 240, 0.6)', drawTicks: false },
            border: { display: false }
          },
          x: { 
            offset: true, 
            ticks: { autoSkip: true, minRotation: 45, maxRotation: 45, color: '#64748b', font: { size: 10 }, padding: 5 }, 
            grid: { display: false, drawTicks: false }, border: { display: false } 
          }
        }
      }
    });
  }

  // ====== 2. TRỤC Y CỐ ĐỊNH (BÊN TRÁI) ======
  const yCanvas = document.getElementById('yAxisChart');
  if (!yCanvas || typeof Chart === 'undefined') return;

  yCanvas.parentElement.style.height = '320px';
  // Ép chắc chắn thẻ chứa Y rộng 60px để không bao giờ bị cắt chữ
  yCanvas.parentElement.parentElement.style.width = '60px'; 

  const yCtx = yCanvas.getContext('2d');
  if (window.yChartFixed) {
    window.yChartFixed.data.labels = labels; // ĐÃ SỬA: Dùng 100% nhãn gốc để đồng bộ chiều cao
    window.yChartFixed.data.datasets[0].data = gaps;
    window.yChartFixed.options.scales.y.min = yMin;
    window.yChartFixed.options.scales.y.max = yMax;
    window.yChartFixed.update('none');
  } else {
    window.yChartFixed = new Chart(yCtx, {
      type: 'line',
      data: { 
        labels: labels, // ĐÃ SỬA: Đưa toàn bộ mảng labels vào để Chart.js tính chiều cao trục X khớp nhau 100%
        datasets: [{ data: gaps, borderColor: 'transparent', backgroundColor: 'transparent', borderWidth: 0, pointRadius: 0, pointHoverRadius: 0 }] 
      }, 
      options: {
        responsive: true, maintainAspectRatio: false, animation: false,
        layout: { padding: { top: 15, bottom: 0, left: 0, right: 0 } }, 
        plugins: { legend: { display: false }, tooltip: { enabled: false } },
        scales: {
          x: { 
            offset: true,
            ticks: { autoSkip: true, color: 'transparent', minRotation: 45, maxRotation: 45, font: { size: 10 }, padding: 5 },
            grid: { display: false, drawTicks: false }, border: { display: false }
          },
          y: {
            position: 'right', 
            min: yMin, max: yMax, beginAtZero: false,
            ticks: { 
              mirror: true, // ĐÃ SỬA: Ép chữ hiển thị NGƯỢC VÀO TRONG khung vẽ
              padding: 10,  // Đẩy xa lề phải 10px để chữ nằm gọn gàng giữa nền trắng
              stepSize: 1, 
              callback: (val) => {
                if (val === 0) return ''; 
                // Cứ cách 2 vạch (số chẵn) thì hiện chữ
                if (val % 2 === 0) return val + 'M'; 
                return ''; 
              },
              color: '#64748b', font: { size: 11, weight: '600' },
              z: 10
            },
            grid: { display: false, drawTicks: false }, border: { display: false } 
          }
        }
      }
    });
  }

  // Tự động cuộn đến điểm dữ liệu mới nhất
  const isAtRightEdge = scrollContainer.scrollWidth - scrollContainer.clientWidth <= scrollContainer.scrollLeft + 50;
  requestAnimationFrame(() => {
    if (isAtRightEdge || data.length <= 10) {
      scrollContainer.scrollLeft = (totalPoints < minPointsToFill) ? 0 : scrollContainer.scrollWidth;
    }
  });
}

// ============================================================================
// PHẦN 7: EVENT LISTENER VÀ PULL-TO-REFRESH
// ============================================================================

// Nút bấm ép đồng bộ trên header
async function forceSync() {
  const dot = document.getElementById('syncDot');
  if (!dot) return;
  dot.className = 'sync-dot loading';

  try {
    const res = await fetch('/api/force-sync', { method: 'POST' });
    if (res.ok) { dot.className = 'sync-dot success'; }
    else { dot.className = 'sync-dot'; }
  } catch (e) { dot.className = 'sync-dot'; }

  setTimeout(() => {
    if (dot.className.includes('success')) { dot.className = 'sync-dot'; }
  }, 3000);
}

// Khởi chạy App ban đầu
try {
  const cachedMain = localStorage.getItem('xau_main_cache');
  if (cachedMain) {
    const parsedMain = JSON.parse(cachedMain);
    renderMain(parsedMain);
    lastSJCValue = parsedMain.sjc;
  }

  const histCache = localStorage.getItem('xau_hist_cache');
  if (histCache) {
    historyData = JSON.parse(histCache); currentData = historyData;
    renderTable(); updateChart(currentData);
  } else {
    safeFetchHistory(true);
  }
} catch (e) { }

load();
initSSE();

// Quản lý SSE khi điện thoại tắt/mở màn hình (Tránh tốn pin)
document.addEventListener("visibilitychange", () => {
  if (document.hidden) {
    if (evtSource) { evtSource.close(); evtSource = null; }
  } else {
    setTimeout(() => { if (!document.hidden) { load(); initSSE(); } }, 500);
  }
});

// LOGIC: Kéo thả màn hình (Radar Spinner Theme)
let startY = 0;
let isPulling = false;
let isRefreshing = false;
const pullThreshold = 100;
const pullContainer = document.getElementById("cyberPull");
const textEl = document.getElementById("cyberText");
const radarIcon = document.getElementById("ptrIcon");

window.addEventListener("touchstart", (e) => {
  // VÁ LỖI: Chặn bắt tọa độ nếu trình duyệt đang bị hiệu ứng "nảy cao su" (bouncing)
  // Chỉ kích hoạt khi cuộn tuyệt đối bằng 0 và không có dấu hiệu nảy
  if (window.scrollY <= 0 && !isRefreshing) {
    if (e.touches[0].clientY < 0) return; // Safari đang bị kéo lố lên trên thì bỏ qua
    startY = e.touches[0].clientY;
    isPulling = true;
  }
}, { passive: false });

window.addEventListener("touchmove", (e) => {
  if (!isPulling || isRefreshing) return;

  // VÁ LỖI TĂNG CƯỜNG: Cương quyết khóa cuộn trình duyệt nếu đang thực hiện thao tác kéo màn hình xuống
  if (window.scrollY <= 0 && e.touches[0].clientY > startY) {
    if (e.cancelable) e.preventDefault();
  }

  const currentY = e.touches[0].clientY;
  const diff = currentY - startY;

  if (diff > 0 && window.scrollY <= 0) {
    const moveY = Math.min(diff * 0.4, 90);
    pullContainer.style.top = `${-80 + moveY}px`;

    const pullRatio = Math.min(diff / pullThreshold, 1);
    radarIcon.style.transform = `rotate(${pullRatio * 270}deg)`;

    if (diff > pullThreshold) {
      pullContainer.classList.add('ready');
      textEl.innerText = "Thả tay để quét!";
    } else {
      pullContainer.classList.remove('ready');
      textEl.innerText = "Kéo xuống để tải...";
    }
  }
}, { passive: false });

window.addEventListener("touchend", (e) => {
  if (!isPulling || isRefreshing) return;
  isPulling = false;
  const diff = e.changedTouches[0].clientY - startY;

  if (diff > pullThreshold) {
    isRefreshing = true;
    pullContainer.classList.remove('ready');
    pullContainer.classList.add('refreshing');
    pullContainer.style.top = "20px";
    radarIcon.style.transform = ''; // Reset để nhường CSS animation xoay tròn
    textEl.innerText = "Đang quét dữ liệu...";

    load().then(() => {
      textEl.innerText = "Cập nhật thành công!";
      pullContainer.classList.remove('refreshing');
      pullContainer.classList.add('ready');

      // Đoạn code tạo hiệu ứng chớp sáng các thẻ card
      const cards = document.querySelectorAll('.card');
      cards.forEach(card => {
        card.classList.remove('flash-update');
        void card.offsetWidth; // Trigger reflow để animation chạy lại
        card.classList.add('flash-update');
      });

      if (navigator.vibrate) navigator.vibrate(50);

      setTimeout(() => {
        pullContainer.style.top = "-80px";
        setTimeout(() => {
          isRefreshing = false;
          pullContainer.classList.remove('ready');
          // Thiếu dòng này ở code của bạn:
          cards.forEach(card => card.classList.remove('flash-update'));
        }, 300);
      }, 1200);

    }).catch(() => {
      // BẠN ĐÃ QUÊN TOÀN BỘ KHỐI CATCH NÀY:
      textEl.innerText = "Lỗi kết nối!";
      pullContainer.classList.remove('refreshing');
      pullContainer.classList.add('ready');
      textEl.style.color = "var(--down-color)"; // Báo màu đỏ

      setTimeout(() => {
        pullContainer.style.top = "-80px";
        setTimeout(() => {
          isRefreshing = false;
          pullContainer.classList.remove('ready');
          textEl.style.color = ""; // Reset màu chữ
        }, 300);
      }, 1500);
    });
  } else {
    pullContainer.style.top = "-80px";
  }
});