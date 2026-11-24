# Chess Helper - Chrome Extension

Browser extension để gợi ý nước đi tốt nhất khi chơi cờ trên chess.com, sử dụng Stockfish chess engine.

## Cài đặt

### 1. Download Stockfish.js (BẮT BUỘC)

Thay thế file `lib/stockfish.min.js` bằng Stockfish thật:

**Option A - NPM:**
```bash
npm install stockfish
# Copy file từ node_modules/stockfish/src/stockfish-nnue-16.js vào lib/stockfish.min.js
```

**Option B - Direct download:**
- Truy cập: https://github.com/nicklac/stockfish.js/releases
- Download file `stockfish.js` hoặc `stockfish-nnue-16.js`
- Đổi tên và copy vào `lib/stockfish.min.js`

### 2. Tạo Icons

Tạo icons 16x16, 48x48, 128x128 PNG hoặc dùng bất kỳ icon nào:
- `icons/icon16.png`
- `icons/icon48.png`
- `icons/icon128.png`

Hoặc dùng online tool convert từ `icons/icon.svg`

### 3. Load Extension vào Chrome

1. Mở Chrome, truy cập `chrome://extensions`
2. Bật **Developer mode** (góc trên phải)
3. Click **Load unpacked**
4. Chọn folder `D:\chess-helper`

### 4. Sử dụng

1. Truy cập [chess.com](https://chess.com)
2. Bắt đầu chơi game hoặc phân tích
3. Panel "Chess Helper" sẽ xuất hiện bên phải màn hình
4. Best move sẽ tự động cập nhật sau mỗi nước đi

## Cấu hình

- **Enable Analysis**: Bật/tắt phân tích
- **Depth**: Độ sâu phân tích (10-25), cao hơn = chính xác hơn nhưng chậm hơn
- **Auto-Analyze**: Tự động phân tích sau mỗi nước đi

## Cảnh báo

⚠️ **QUAN TRỌNG**: Sử dụng engine trong các trận đấu rated trên chess.com có thể dẫn đến việc bị ban account. Extension này chỉ nên dùng cho:
- Phân tích sau trận đấu
- Học và luyện tập
- Chơi với bot/computer
- Casual games với bạn bè (được đồng ý)

## Cấu trúc project

```
chess-helper/
├── manifest.json           # Extension config
├── src/
│   ├── content/           # Content script (inject vào chess.com)
│   ├── background/        # Service worker
│   ├── stockfish/         # Stockfish worker
│   └── popup/             # Extension popup
├── lib/
│   └── stockfish.min.js   # Stockfish engine (CẦN DOWNLOAD)
└── icons/                 # Extension icons
```

## Troubleshooting

**Panel không hiện:**
- Kiểm tra console (F12) xem có lỗi không
- Thử refresh trang chess.com

**Engine không chạy:**
- Đảm bảo đã thay stockfish.min.js bằng file thật
- Kiểm tra Service Worker trong chrome://extensions

**Analysis chậm:**
- Giảm depth xuống 15-18
- Stockfish cần thời gian, đặc biệt với depth cao
