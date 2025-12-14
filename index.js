const express = require('express');
const { default: makeWASocket, useMultiFileAuthState, delay, DisconnectReason, Browsers } = require('@whiskeysockets/baileys');
const pino = require('pino');
const fs = require('fs');
const multer = require('multer');
const path = require('path');
const Jimp = require('jimp');

const app = express();
const port = 3000;

// Setup folders
const uploadDir = './uploads';
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });

const storage = multer.diskStorage({
    destination: uploadDir,
    filename: (req, file, cb) => cb(null, Date.now() + path.extname(file.originalname))
});
const upload = multer({ storage: storage });

app.use(express.static('public'));
app.use(express.json());

// Upload
app.post('/upload', upload.single('image'), (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'No file' });
    res.json({ filename: req.file.filename });
});

// Connect
app.get('/connect', async (req, res) => {
    const { phoneNumber, filename } = req.query;
    if (!phoneNumber || !filename) return res.status(400).json({ error: 'Missing data' });

    const cleanNumber = phoneNumber.replace(/[^0-9]/g, '');
    console.log(`Processing: ${cleanNumber}`);

    const sessionFolder = `./sessions/session-${cleanNumber}`;
    const { state, saveCreds } = await useMultiFileAuthState(sessionFolder);

    try {
        const sock = makeWASocket({
            auth: state,
            printQRInTerminal: false,
            logger: pino({ level: "silent" }),
            // BROWSER SPOOFING (Very Important)
            browser: ["Windows", "Chrome", "10.15.7"], 
            markOnlineOnConnect: false,
            syncFullHistory: false
        });

        sock.ev.on('creds.update', saveCreds);

        sock.ev.on('connection.update', async (update) => {
            const { connection } = update;
            if (connection === 'open') {
                console.log('Connected!');
                try {
                    const imgPath = path.join(uploadDir, filename);
                    const img = await Jimp.read(imgPath);
                    const min = Math.min(img.getWidth(), img.getHeight());
                    const buffer = await img.crop(0,0,min,min).resize(640,640).getBufferAsync(Jimp.MIME_JPEG);
                    
                    await sock.query({
                        tag: 'iq',
                        attrs: { to: sock.user.id, type: 'set', xmlns: 'w:profile:picture' },
                        content: [{ tag: 'picture', attrs: { type: 'image' }, content: buffer }]
                    });
                    console.log('DP Updated!');
                } catch (e) { console.error(e); }
                
                await sock.logout();
                setTimeout(() => fs.rmSync(sessionFolder, { recursive: true, force: true }), 2000);
            }
        });

        // Request Code Loop
        if (!sock.authState.creds.registered) {
            await delay(3000); // Wait for socket
            try {
                const code = await sock.requestPairingCode(cleanNumber);
                const formatCode = code?.match(/.{1,4}/g)?.join("-") || code;
                console.log(`Code: ${formatCode}`);
                res.json({ code: formatCode });
            } catch (err) {
                console.error('Pairing Failed:', err);
                if(!res.headersSent) res.status(500).json({ error: 'Failed to get code. WhatsApp blocked the request.' });
            }
        } else {
            res.json({ error: "Session exists. Wait a minute." });
        }

    } catch (error) {
        if(!res.headersSent) res.status(500).json({ error: 'Server Error' });
    }
});

app.listen(port, () => console.log(`Server running on port ${port}`));
