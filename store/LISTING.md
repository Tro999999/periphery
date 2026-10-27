# Chrome 線上應用程式商店：上架資料（複製貼上用）

## 基本資料

- **名稱**：Periphery 環繞延伸（會直接讀取 manifest，不用另外填）
- **類別**：娛樂（Entertainment）
- **語言**：中文（繁體）

## 簡短說明（132 字元以內，manifest 的 description 已經填好）

看影片時把主螢幕畫面延伸到左右兩側螢幕，營造類 ScreenX 的三螢幕環繞沉浸感。

## 詳細說明（繁體中文）

有三台螢幕，看電影時兩側卻只能關掉或放著干擾？

Periphery 會把主螢幕正在播放的影片，即時「延伸」到左右兩台螢幕，營造類似 ScreenX 影廳的環繞包覆感。

人的餘光本來就看不清細節，所以側螢幕不需要清楚的畫面，只要顏色、亮度和動態跟主畫面一致，大腦就會把它當成畫面的延伸。這個做法參考自 MIT Media Lab 的 Infinity-by-Nine 研究。

【特色】
• 一鍵開啟：在影片頁面按 Alt+Shift+S，左右螢幕自動全螢幕顯示延伸畫面
• 鏡頭跟隨：鏡頭搖動時，移出主畫面的物件會繼續滑到側螢幕上
• 自動去除黑邊：寬銀幕電影也能從真正的畫面邊緣取色
• 場景切換偵測：剪接時兩側立即重置，不殘留上一個場景的顏色
• 越往外越模糊、越暗：符合人眼周邊視覺，不搶走注意力
• 四種風格：標準、柔和、鮮明、純色光，也可以存成「我的設定」
• 20 多項細節調整，附即時預覽；每一項都能單獨還原，也能一鍵全部還原
• 內建本機影片播放器，電腦裡的影片檔也能用
• 全部在你的電腦上用 GPU 運算，不收集、不傳送任何資料

【使用需求】
• 三台螢幕（只有兩台也可以，會只延伸到有螢幕的一側）
• Windows 的顯示器排列要和實際擺放位置一致

【限制】
Netflix、Disney+ 等使用 DRM 版權保護的平台，瀏覽器不允許任何外掛讀取畫面，所以無法使用。YouTube、Bilibili 等一般網頁影片，以及本機影片檔都可以正常使用。

## Detailed description (English, optional second language)

Turn a three-monitor setup into a ScreenX-style wraparound cinema.

Periphery extends the video playing on your main monitor onto your left and right monitors in real time. Peripheral vision is blurry by nature, so the side screens don't need sharp detail. They only need colour, brightness and motion that match the main picture, and your brain reads them as a continuation of the image. The approach is based on MIT Media Lab's Infinity-by-Nine research.

• One shortcut (Alt+Shift+S): side monitors go fullscreen automatically
• Camera-pan following: objects leaving the frame keep sliding across the side screens
• Automatic letterbox detection, scene-cut reset, progressive blur and falloff
• 4 presets plus 20+ fine controls with live preview and one-click reset
• Built-in local video player
• Everything runs locally on your GPU. No data is collected or sent anywhere.

DRM-protected services such as Netflix and Disney+ block all extensions from reading the picture, so they are not supported.

---

## 「隱私權實務」分頁怎麼填

**單一用途說明（Single purpose）**
在使用者有多台螢幕時，將網頁中播放的影片畫面即時延伸到左右兩側螢幕，營造環繞觀影效果。

**權限說明（Permission justification）**

| 權限 | 填寫內容 |
|---|---|
| activeTab | 使用者按下工具列圖示或快捷鍵時，讀取目前分頁中的影片畫面來產生側螢幕的延伸效果。只在使用者主動開啟時才會存取。 |
| scripting | 使用者開啟環繞模式時，把繪圖程式注入目前分頁，讀取影片畫面並繪製到側邊視窗。 |
| system.display | 偵測各螢幕的位置，判斷哪一台是左側、哪一台是右側螢幕，並把側邊畫面移到正確的螢幕上。 |
| contentSettings | 側邊畫面是由影片頁面開啟的視窗。使用者開啟環繞模式時，允許該網站開啟彈出式視窗，避免側邊畫面被擋住。只會針對使用者主動開啟的網站設定。 |
| storage | 在本機儲存使用者的調整設定（亮度、清晰度等）。 |
| 選用主機權限 <all_urls> | 只有當影片位於其他網域的嵌入式播放器（iframe）裡時，才會在使用者按下「授權並開啟」後請求，用來讀取該播放器中的影片畫面。 |

**是否使用遠端程式碼**：否。所有程式碼都包含在套件裡。

**資料使用**：全部不勾選，因為不收集任何使用者資料。底下三項聲明都勾選同意。

**隱私權政策網址**：把 `privacy-policy.html` 放到網路上（作法見 PUBLISHING.md），再貼上網址。
