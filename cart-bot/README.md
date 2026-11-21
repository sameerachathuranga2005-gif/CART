# 🤖 Batagama Public Service Roster - 24/7 WhatsApp Attendance & Reminder Bot

A 24/7 automated WhatsApp bot for the **පොදු සේවය - බටගම සභාව** roster system. Built with Node.js, `@whiskeysockets/baileys`, and **Firebase Firestore (Admin SDK)**. Designed for easy 24/7 deployment on **alwaysdata** (or any Linux VPS/server).

---

## 📋 Features

1. **WhatsApp Pairing Code Authentication**:
   - Pairs directly with phone number `+94701206001` using an 8-digit pairing code (No QR scanning needed).
   - Sessions are persisted in `./auth_info_baileys/`.
   - Auto-reconnects on temporary network drops.
2. **Real-time Firestore Integration**:
   - Reads from and writes to the `bookings` collection.
   - Synchronizes live with the Web App (`index.html`).
3. **Automated Attendance Responses**:
   - **Confirm** (`yes`, `ok`, `confirm`, `හරි`, `එනවා`): Updates status to `"Confirmed"` with timestamp.
   - **Decline** (`no`, `cant come`, `බෑ`, `එන්න බෑ` + reason): Updates status to `"Declined"` and captures decline reason.
   - **Reason** (`reason: ...` or `හේතුව: ...`): Records specific absence reason.
   - **Swap** (`swap ...` or `මාරු ...`): Updates status to `"Swapped"` and saves details.
4. **Automated Cron Jobs**:
   - **Every 30 mins (`*/30 * * * *`)**: Scans upcoming bookings (within 0–2 days). Sends initial reminder (`Sent_1`), retry after 6 hours (`Retry_1`, `Retry_2`), and marks `Not_Seen` if unacknowledged.
   - **Daily at 8:00 PM (`0 20 * * *`)**: Compiles and sends a full attendance summary to `ADMIN_PHONE` (`94701206001`) and saves it to Firestore `daily_reports`.

---

## 🚀 Setup & Deployment Guide on alwaysdata

### Step 1: Download your Firebase `serviceAccountKey.json`
1. Go to [Firebase Console](https://console.firebase.google.com/).
2. Open your project (**cart-eeb7b**).
3. Click the ⚙️ **Gear icon** (Project Settings) > **Service accounts** tab.
4. Click **Generate new private key**, then click **Generate key**.
5. Rename the downloaded file to `serviceAccountKey.json`.
6. Copy `serviceAccountKey.json` into the `cart-bot/` folder alongside `bot.js`.

---

### Step 2: Upload Files to alwaysdata
You can upload via **SSH**, **SFTP**, or the **alwaysdata Web FTP File Manager**:
1. In alwaysdata dashboard, go to **Remote access > SSH** and ensure SSH is enabled with your password.
2. Upload the `cart-bot` directory into your alwaysdata home directory (e.g. `/home/[your_account]/cart-bot`).

---

### Step 3: Install Dependencies & Initial WhatsApp Pairing via SSH
1. Connect to alwaysdata via SSH:
   ```bash
   ssh [your_account]@ssh-[your_account].alwaysdata.net
   ```
2. Navigate to the `cart-bot` folder:
   ```bash
   cd cart-bot
   ```
3. Install required packages:
   ```bash
   npm install
   ```
4. Run the bot for initial pairing:
   ```bash
   node bot.js
   ```
5. You will see output like this in your terminal:
   ```text
   ======================================================
   🔑 WHATSAPP PAIRING CODE GENERATED:
   👉 CODE: 4K8J-9XZ2
   ------------------------------------------------------
   1. Open WhatsApp on your phone (+94701206001)
   2. Tap Settings (or 3 dots) > Linked Devices
   3. Tap "Link a device"
   4. Tap "Link with phone number instead"
   5. Enter the pairing code above: 4K8J-9XZ2
   ======================================================
   ```
6. Open WhatsApp on phone `+94701206001`, link with the pairing code.
7. Once paired, you will see:
   ```text
   🚀 WHATSAPP BOT CONNECTED SUCCESSFULLY & LIVE 24/7!
   ```
8. Press `Ctrl + C` in the terminal. Your authentication is now safely saved in the `./auth_info_baileys/` folder!

---

### Step 4: Configure alwaysdata to Keep the Bot Running 24/7

You have two easy options on alwaysdata to keep `bot.js` alive 24/7 forever:

#### Option A: Using alwaysdata "Web > Sites" (Recommended)
1. In the alwaysdata admin dashboard, go to **Web > Sites**.
2. Click **Add a site**.
3. Fill in the following:
   - **Name**: `cart-bot`
   - **Domain**: Choose your default `.alwaysdata.net` subdomain or any address.
   - **Type**: Select **Node.js**.
   - **Working directory**: `/cart-bot` (or `/home/[your_account]/cart-bot`)
   - **Command**: `node bot.js`
4. Click **Submit**. alwaysdata will keep the process running 24/7, automatically restarting it if it ever stops.

#### Option B: Using PM2 via SSH
If you prefer PM2 in the command line:
```bash
cd ~/cart-bot
npx pm2 start bot.js --name "cart-bot"
npx pm2 save
```
Check status anytime with:
```bash
npx pm2 status
npx pm2 logs cart-bot
```

---

## 📱 WhatsApp Message Commands Quick Reference

### For Participants:
| Command | Keywords | Bot Action |
| :--- | :--- | :--- |
| **Confirm** | `හරි`, `එනවා`, `ok`, `yes`, `confirm` | Marks as `Confirmed`, records timestamp, replies in Sinhala. |
| **Decline** | `බෑ`, `එන්න බෑ`, `no`, `cant come` | Marks as `Declined`, records reason if provided. |
| **Give Reason** | `හේතුව: [විස්තර]` or `reason: [details]` | Updates `declineReason` in Firestore. |
| **Swap** | `swap [නම]` or `මාරු [නම]` | Marks as `Swapped` with details in Firestore. |

### For Admin (+94701206001):
| Command | Action |
| :--- | :--- |
| `summary` or `වාර්තාව` | Instantly generates and sends the current attendance summary. |
| `ping` or `test` | Checks bot health, uptime, and Firestore connectivity. |

---

## 🛠 Project Structure

```text
cart-bot/
├── bot.js                          # Main Baileys + Firestore + Cron logic
├── package.json                    # Dependencies & start script
├── serviceAccountKey.json          # Firebase Private Key (Add this file)
├── serviceAccountKey.json.example  # Example template for key
├── .gitignore                      # Protects keys & credentials
├── README.md                       # Complete guide
└── auth_info_baileys/              # Generated auto-login credentials
```

---

## 🔒 Security Notes
- **Never share or commit `serviceAccountKey.json`** to public GitHub repositories.
- Keep the `auth_info_baileys/` folder private as it stores active WhatsApp session tokens.

