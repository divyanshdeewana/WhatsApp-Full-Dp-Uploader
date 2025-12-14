const express = require('express');
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const pino = require('pino');
const fs = require('fs');
const multer = require('multer');
const path = require('path');
const Jimp = require('jimp');

const app = express();
const port = process.env.PORT || 3000; // Render ka Port lena zaroori hai

// Render par disk temporary hoti hai, /tmp use karenge
const uploadDir = '/tmp/uploads';
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });

const storage = multer.diskStorage({
    destination: uploadDir,
    filename: (req, file, cb) => cb(null, Date.now() + path.extname(file.originalname))
});
const upload = multer({ storage: storage });

app.use(express.static('public'));
app.use(express.json());

app.post('/upload', upload.single('image'), (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'No file' });
    res.json({ filename: req.file.filename });
});

app.get('/connect', async (req, res) => {
    const { phoneNumber, filename } = req.query;
    if (!phoneNumber || !filename) return res.status(400).json({ error: 'Missing data' });

    const cleanNumber = phoneNumber.replace(/[^0-9]/g, '');
    const sessionFolder = `/tmp/session-${Date.now()}`;
    
    const { state, saveCreds } = await useMultiFileAuthState(sessionFolder);

    try {
        const sock = makeWASocket({
            logger: pino({ level: 'silent' }),
            printQRInTerminal: false,
            auth: state,
            browser: ["Render", "Chrome", "1.0"]
        });

        if (!sock.authState.creds.me && !sock.authState.creds.registered) {
            setTimeout(async () => {
                try {
                    const code = await sock.requestPairingCode(cleanNumber);
                    res.json({ code: code?.match(/.{1,4}/g)?.join("-") || code });
                } catch (e) {
                    if(!res.headersSent) res.status(500).json({ error: 'Failed' });
                }
            }, 3000);
        }

        sock.ev.on('connection.update', async (update) => {
            if (update.connection === 'open') {
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
                    
                    await sock.logout();
                    fs.rmSync(sessionFolder, { recursive: true, force: true });
                } catch (e) { console.error(e); }
            }
        });
        sock.ev.on('creds.update', saveCreds);
    } catch (e) { if(!res.headersSent) res.status(500).json({ error: 'Error' }); }
});

app.listen(port, () => console.log(`Server on port ${port}`));
