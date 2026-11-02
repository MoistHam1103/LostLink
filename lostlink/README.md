# LostLink - QR lost and found for students

No installs and no internet needed. You only need **Node.js 22.5 or newer** (nodejs.org) on one computer.

## Run it as a PC app
Windows: double-click **Start-LostLink.bat**. It starts the server and opens the staff screen in its own app window
(Microsoft Edge app mode, no tabs). Keep the black window open while the app is in use; close it to stop.
Edit the PIN and school name inside the .bat file. Mac/Linux: run `./start-lostlink.sh`.
The Staff screen shows a QR so students can open LostLink on their phones.

## Run it manually
    node server.js
Optional settings: `STAFF_PIN=9876 SCHOOL_NAME="My School" PORT=3000 node server.js`
(Needs Node 22.13+. Windows PowerShell: `$env:STAFF_PIN="9876"; node server.js`)

The terminal prints an address like `http://192.168.1.23:3000`. Any phone on the **same wifi** can open it.
Data is saved in `lostlink.db` (SQLite) next to the server. Copy that file to back it up.

## How it works
1. Student opens `/register`, fills in the item and owner details, and gets a reference code (LL-0001).
2. Staff opens `/staff` (default PIN `1234`, change it), checks the student and item, and presses "Verify and issue QR".
   Then "Print QR label" and hand the paper to the student.
3. A finder scans the QR. The page shows the item, owner name and section, and lets them report where it was found.
4. Staff see a red alert, contact the owner, and mark the item Returned. Students can check status at `/check`.

## Privacy
The public scan page shows item, photo, owner name and grade/section. It never shows the student number or contact
number; only logged-in staff see those, plus the finder's details. To hide the owner name too, remove `owner_name`
from the `/api/public/item` response in `server.js` and the `.owner` block in `public/scan.html`.

## Notes
- The QR holds the wifi address of the computer. If it changes, update it on the Staff page and reprint tags.
- Give the computer a fixed IP (router DHCP reservation) so printed QR codes keep working.
- Outside the school wifi, host it on a server with HTTPS and set the base URL to your domain.

## Scanning
Open `/scan` (the Scan link at the top) to use the in-page camera, or just use the phone's normal camera app.
The in-page camera only works on `localhost` or an `https://` address, so use the phone camera app when testing on plain wifi.

## Put it online (works on any phone, any network)
The app is ready to host. Settings it understands: `STAFF_PIN` (required online), `DATA_DIR` (folder on a persistent disk), `SCHOOL_NAME`.
**Option A, free, runs on your own PC:** start the server, then use a tunnel (ngrok with its free fixed domain, or Cloudflare Tunnel)
to give it an https address. Open `/staff` through that address so QR codes use it. The PC must stay on. Use a fixed domain, or printed tags break.
**Option B, real hosting (Render, Fly.io, Railway):** push this folder to GitHub, create a Node web service, build command `npm install`,
start command `node server.js`, set `STAFF_PIN`, and attach a persistent disk at e.g. `/data` with `DATA_DIR=/data`.
Without a persistent disk the database is erased whenever the host restarts. Free plans often have no disk, so check current plans first.
