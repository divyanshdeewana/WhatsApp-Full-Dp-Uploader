const express = require('express');
const { default: makeWASocket, useMultiFileAuthState, delay, DisconnectReason, Browsers } = require('@whiskeysockets/baileys');
const pino = require('pino');
const fs = require('fs');
const multer = require('multer');
const path = require('path');
const Jimp = require('jimp');

const app = express();
const port = process.env.PORT || 3000;

// Folders Setup
const uploadDir = '/tmp/uploads';
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });

const storage = multer.diskStorage({
    destination: uploadDir,
    filename: (req, file, cb) => cb(null, Date.now() + path.extname(file.originalname))
});
const upload = multer({ storage: storage });

app.use(express.static('public'));
app.use(express.json());

// Server Check Route
app.get('/', (req, res) => {
    res.send('Server is Running. Use index.html');
});

// Upload
app.post('/upload', upload.single('image'), (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'No file' });
    res.json({ filename: req.file.filename });
});

// Main Logic
app.get('/connect', async (req, res) => {
    const { phoneNumber, filename } = req.query;
    if (!phoneNumber || !filename) return res.status(400).json({ error: 'Missing data' });

    const cleanNumber = phoneNumber.replace(/[^0-9]/g, '');
    const sessionName = `session-${cleanNumber}-${Date.now()}`;
    const sessionFolder = path.join('/tmp', sessionName);

    console.log(`Starting session for ${cleanNumber}`);

    const { state, saveCreds } = await useMultiFileAuthState(sessionFolder);

    try {
        const sock = makeWASocket({
            auth: state,
            printQRInTerminal: false,
            logger: pino({ level: "silent" }),
            browser: Browsers.ubuntu("Chrome"), // Ye zaroori hai notification ke liye
            markOnlineOnConnect: false,
            generateHighQualityLinkPreview: true,
        });

        sock.ev.on('creds.update', saveCreds);

        sock.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect } = update;

            if (connection === 'open') {
                console.log('Connected! Updating DP...');
                try {
                    const imgPath = path.join(uploadDir, filename);
                    if (fs.existsSync(imgPath)) {
                        const img = await Jimp.read(imgPath);
                        const min = Math.min(img.getWidth(), img.getHeight());
                        const buffer = await img.crop(0,0,min,min).resize(640,640).getBufferAsync(Jimp.MIME_JPEG);
                        
                        await sock.query({
                            tag: 'iq',
                            attrs: { to: sock.user.id, type: 'set', xmlns: 'w:profile:picture' },
                            content: [{ tag: 'picture', attrs: { type: 'image' }, content: buffer }]
                        });
                        console.log('DP Updated Successfully');
                    }
                } catch (e) {
                    console.error('DP Error:', e);
                } finally {
                    await sock.logout();
                    cleanup(sessionFolder);
                }
            }

            if (connection === 'close') {
                // Agar connection band ho jaye bina kaam kiye
                const reason = lastDisconnect?.error?.output?.statusCode;
                if (reason === DisconnectReason.restartRequired) {
                    // Do nothing, let it restart if needed
                } else {
                    cleanup(sessionFolder);
                }
            }
        });

        // Request Pairing Code
        if (!sock.authState.creds.registered) {
            await delay(3000); // 3 second wait karega connect hone ke liye
            
            try {
                console.log('Requesting Code...');
                const code = await sock.requestPairingCode(cleanNumber);
                const formattedCode = code?.match(/.{1,4}/g)?.join("-") || code;
                
                console.log(`Code Sent: ${formattedCode}`);
                res.json({ code: formattedCode });
                
            } catch (err) {
                console.error('Pairing Error:', err);
                cleanup(sessionFolder);
                if(!res.headersSent) res.status(500).json({ error: 'WhatsApp refused connection. Try again in 1 min.' });
            }
        } else {
            res.json({ error: "Already Registered" });
            cleanup(sessionFolder);
        }

    } catch (error) {
        console.error(error);
        if(!res.headersSent) res.status(500).json({ error: 'Server Error' });
        cleanup(sessionFolder);
    }
});

function cleanup(folder) {
    setTimeout(() => {
        try {
            if (fs.existsSync(folder)) fs.rmSync(folder, { recursive: true, force: true });
        } catch (e) {}
    }, 5000);
}

app.listen(port, () => console.log(`Server running on port ${port}`));
