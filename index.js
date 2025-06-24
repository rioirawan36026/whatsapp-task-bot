const { default: makeWASocket, DisconnectReason, useMultiFileAuthState } = require('@whiskeysockets/baileys')
const { Boom } = require('@hapi/boom')
const qrcode = require('qrcode-terminal')
const express = require('express')
const bodyParser = require('body-parser')
const axios = require('axios')

const app = express()
app.use(bodyParser.json())

let sock
let connectionState = 'disconnected'
let lastQR = null
let qrRegenerateInterval = null

// N8N Webhook URL
const N8N_WEBHOOK_URL = process.env.N8N_WEBHOOK_URL || 'https://your-n8n-webhook-url.com/webhook/whatsapp-task'

// Force console output
console.log('🚀 Starting WhatsApp Task Bot...')
console.log('📅 Timestamp:', new Date().toISOString())
console.log('🌍 Environment:', process.env.NODE_ENV || 'development')

// Function to force QR regeneration
function forceQRRegeneration() {
    console.log('🔄 Forcing QR regeneration...')
    if (sock && connectionState === 'waiting_for_scan') {
        try {
            // Disconnect and reconnect to force new QR
            sock.ws.close()
        } catch (error) {
            console.log('Error closing connection for QR regen:', error.message)
            // If direct close fails, restart connection
            setTimeout(() => connectToWhatsApp(), 2000)
        }
    }
}

// Keep Railway happy with health checks
setInterval(() => {
    console.log(`🔄 Health check: ${new Date().toISOString()} - State: ${connectionState}`)
}, 30000) // Every 30 seconds

async function connectToWhatsApp() {
    try {
        console.log('🔄 Initializing WhatsApp connection...')
        connectionState = 'connecting'
        
        const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys')
        
        // Force new session debug
        console.log('🔄 Forcing new WhatsApp session...')
        if (!state.creds) {
            console.log('🆕 No existing credentials, will generate QR')
        }
        
        sock = makeWASocket({
            auth: state,
            browser: ['WhatsApp Task Bot', 'Chrome', '1.0.0']
        })

        sock.ev.on('connection.update', (update) => {
            const { connection, lastDisconnect, qr } = update
            
            if (qr) {
                lastQR = qr
                console.log('📱 QR Code received! Please scan quickly:')
                console.log('🔗 QR Data for manual generation:')
                console.log('QR_START:', qr, ':QR_END')
                console.log('='.repeat(80))
                qrcode.generate(qr, { small: false })
                console.log('='.repeat(80))
                console.log('⚡ You have 60 SECONDS to scan this QR!')
                console.log('🔄 New QR will be generated automatically after 1 minute')
                console.log('💡 If QR not scannable in logs, visit: /qr endpoint for web QR')
                console.log('🌐 Or use online QR generator with data above')
                connectionState = 'waiting_for_scan'
                
                // Clear any existing interval
                if (qrRegenerateInterval) {
                    clearTimeout(qrRegenerateInterval)
                }
                
                // Set new QR regeneration after 60 seconds
                qrRegenerateInterval = setTimeout(() => {
                    console.log('⏰ 60 seconds passed, generating new QR...')
                    forceQRRegeneration()
                }, 60000) // 60 seconds
            }
            
            if(connection === 'close') {
                connectionState = 'disconnected'
                lastQR = null
                
                // Clear QR regeneration interval
                if (qrRegenerateInterval) {
                    clearTimeout(qrRegenerateInterval)
                    qrRegenerateInterval = null
                }
                
                const shouldReconnect = (lastDisconnect?.error)?.output?.statusCode !== DisconnectReason.loggedOut
                console.log('❌ Connection closed:', lastDisconnect?.error?.message || 'Unknown error')
                
                if(shouldReconnect) {
                    console.log('🔄 Reconnecting in 10 seconds...')
                    setTimeout(() => connectToWhatsApp(), 10000)
                } else {
                    console.log('🚫 Logged out, please restart and scan QR again')
                }
            } else if(connection === 'open') {
                connectionState = 'connected'
                lastQR = null
                
                // Clear QR regeneration interval
                if (qrRegenerateInterval) {
                    clearTimeout(qrRegenerateInterval)
                    qrRegenerateInterval = null
                }
                
                console.log('✅ WhatsApp Bot Connected Successfully!')
                console.log('📞 Bot ready to receive messages')
                console.log('🎯 Bot number:', sock.user?.id || 'Unknown')
            } else if(connection === 'connecting') {
                connectionState = 'connecting'
                console.log('🔄 Connecting to WhatsApp servers...')
            }
        })

        sock.ev.on('creds.update', saveCreds)

        // Handle incoming messages
        sock.ev.on('messages.upsert', async (m) => {
            try {
                const message = m.messages[0]
                
                if (!message.key.fromMe && m.type === 'notify') {
                    const from = message.key.remoteJid
                    const messageText = message.message?.conversation || 
                                      message.message?.extendedTextMessage?.text || ''
                    
                    console.log(`📩 Message from ${from}: ${messageText}`)
                    
                    // Forward to n8n webhook
                    try {
                        const webhookData = {
                            from: from,
                            message: messageText,
                            timestamp: new Date().toISOString(),
                            messageId: message.key.id
                        }
                        
                        const response = await axios.post(N8N_WEBHOOK_URL, webhookData, {
                            timeout: 5000
                        })
                        console.log('✅ Sent to n8n:', response.status)
                        
                    } catch (error) {
                        console.error('❌ Error sending to n8n:', error.message)
                    }
                }
            } catch (error) {
                console.error('❌ Error handling message:', error.message)
            }
        })
        
    } catch (error) {
        connectionState = 'error'
        console.error('❌ WhatsApp connection error:', error.message)
        console.log('🔄 Retrying connection in 15 seconds...')
        setTimeout(() => connectToWhatsApp(), 15000)
    }
}

// QR Code endpoint dengan debug yang lebih baik
app.get('/qr', (req, res) => {
    console.log('🔍 QR endpoint accessed, lastQR:', lastQR ? 'available' : 'null')
    console.log('🔍 Connection state:', connectionState)
    
    if (lastQR) {
        res.send(`
            <!DOCTYPE html>
            <html>
                <head>
                    <title>WhatsApp QR Code</title>
                    <meta name="viewport" content="width=device-width, initial-scale=1">
                    <style>
                        body { 
                            text-align: center; 
                            font-family: Arial, sans-serif; 
                            padding: 20px;
                            background: #f0f0f0;
                        }
                        .container {
                            max-width: 400px;
                            margin: 0 auto;
                            background: white;
                            padding: 30px;
                            border-radius: 10px;
                            box-shadow: 0 4px 6px rgba(0,0,0,0.1);
                        }
                        h2 { color: #25D366; margin-bottom: 20px; }
                        #qrcode { margin: 20px 0; }
                        .instructions { 
                            color: #666; 
                            font-size: 14px; 
                            margin-top: 20px;
                        }
                        .refresh-btn {
                            background: #25D366;
                            color: white;
                            border: none;
                            padding: 10px 20px;
                            border-radius: 5px;
                            cursor: pointer;
                            margin-top: 15px;
                        }
                        .debug {
                            background: #f5f5f5;
                            padding: 10px;
                            margin: 10px 0;
                            border-radius: 5px;
                            font-size: 12px;
                            word-break: break-all;
                        }
                        .timer {
                            background: #fff3cd;
                            border: 1px solid #ffeaa7;
                            padding: 10px;
                            margin: 10px 0;
                            border-radius: 5px;
                            font-weight: bold;
                        }
                    </style>
                </head>
                <body>
                    <div class="container">
                        <h2>📱 WhatsApp QR Code</h2>
                        <div class="timer">
                            ⏰ Time remaining: <span id="countdown">60</span> seconds
                        </div>
                        <div id="qrcode">Loading QR Code...</div>
                        <div class="debug">
                            <strong>QR Data Preview:</strong><br>
                            ${lastQR.substring(0, 50)}...
                        </div>
                        <div class="instructions">
                            1. Open WhatsApp on your phone<br>
                            2. Go to Menu → Linked Devices<br>
                            3. Tap "Link a Device"<br>
                            4. Scan this QR code<br>
                            <br>
                            <strong>⚡ New QR auto-generated every 60 seconds!</strong>
                        </div>
                        <button class="refresh-btn" onclick="location.reload()">🔄 Refresh QR</button>
                        
                        <!-- Manual QR fallback -->
                        <div id="manual-qr" style="display:none; margin-top:20px;">
                            <h3>Manual QR Generation</h3>
                            <textarea id="qr-data" style="width:100%; height:100px; font-size:10px;">${lastQR}</textarea>
                            <br><br>
                            <a href="https://qr-code-generator.com" target="_blank" style="background:#25D366; color:white; padding:10px 20px; text-decoration:none; border-radius:5px;">
                                🔗 Open QR Generator
                            </a>
                        </div>
                    </div>
                    
                    <script src="https://cdn.jsdelivr.net/npm/qrcode@1.5.3/build/qrcode.min.js"></script>
                    <script>
                        const qrContainer = document.getElementById('qrcode');
                        const qrData = '${lastQR}';
                        const countdownElement = document.getElementById('countdown');
                        
                        // Countdown timer
                        let timeLeft = 60;
                        const timer = setInterval(() => {
                            timeLeft--;
                            countdownElement.textContent = timeLeft;
                            
                            if (timeLeft <= 0) {
                                clearInterval(timer);
                                location.reload(); // Auto refresh when time is up
                            }
                        }, 1000);
                        
                        // Generate QR Code
                        if (typeof QRCode !== 'undefined') {
                            QRCode.toCanvas(qrContainer, qrData, {
                                width: 256,
                                margin: 2,
                                color: {
                                    dark: '#000000',
                                    light: '#FFFFFF'
                                }
                            }, function (error) {
                                if (error) {
                                    console.error('QRCode.js failed:', error)
                                    showManualQR()
                                } else {
                                    console.log('QR Generated successfully!')
                                }
                            })
                        } else {
                            showManualQR()
                        }
                        
                        function showManualQR() {
                            qrContainer.innerHTML = '<p style="color:red;">QR generation failed. Use manual method below.</p>'
                            document.getElementById('manual-qr').style.display = 'block'
                        }
                    </script>
                </body>
            </html>
        `)
    } else {
        res.send(`
            <html>
                <head><title>WhatsApp QR Code</title></head>
                <body style="text-align:center; font-family:Arial; padding:50px;">
                    <h2>🔄 No QR Code Available</h2>
                    <p>Bot is either connected or not ready yet.</p>
                    <p>Connection State: <strong>${connectionState}</strong></p>
                    <p>Debug: lastQR is ${lastQR ? 'set' : 'null'}</p>
                    <p>Time: ${new Date().toISOString()}</p>
                    <button onclick="location.reload()" style="padding:10px 20px; background:#25D366; color:white; border:none; border-radius:5px;">
                        🔄 Refresh
                    </button>
                    <script>
                        // Auto refresh every 5 seconds
                        setTimeout(() => {
                            location.reload()
                        }, 5000)
                    </script>
                </body>
            </html>
        `)
    }
})

// Endpoint untuk n8n kirim reply - ROBUST VERSION
app.post('/send-message', async (req, res) => {
    try {
        // Ambil semua kemungkinan format dari n8n atau client lain
        let { to, message, jid, text, phone, msg } = req.body
        
        console.log('📝 Raw request body:', JSON.stringify(req.body, null, 2))
        
        // Flexible parameter handling - coba berbagai nama field
        const targetJid = to || jid || phone
        const messageText = message || text || msg
        
        console.log('📝 Processed params:', { 
            targetJid: targetJid || 'MISSING', 
            messageText: messageText ? 'present' : 'MISSING',
            messageLength: messageText ? messageText.length : 0
        })
        
        // Validasi target
        if (!targetJid) {
            console.error('❌ Missing target JID from request:', req.body)
            return res.status(400).json({ 
                status: 'error', 
                message: 'Parameter "to", "jid", or "phone" is required',
                received_params: Object.keys(req.body)
            })
        }
        
        // Validasi message - allow empty string tapi tidak null/undefined
        if (messageText === null || messageText === undefined) {
            console.error('❌ Missing message from request:', req.body)
            return res.status(400).json({ 
                status: 'error', 
                message: 'Parameter "message", "text", or "msg" is required',
                received_params: Object.keys(req.body)
            })
        }
        
        // Cek koneksi WhatsApp
        if (!sock || !sock.user || connectionState !== 'connected') {
            console.error('❌ WhatsApp not connected, state:', connectionState)
            return res.status(503).json({ 
                status: 'error', 
                message: 'WhatsApp not connected',
                connectionState: connectionState,
                hasSocket: !!sock,
                hasUser: !!(sock?.user)
            })
        }
        
        // Auto-format JID - handle semua kemungkinan format
        let finalJid = String(targetJid).trim()
        
        // Hapus karakter aneh dan whitespace
        finalJid = finalJid.replace(/[^\d@.]/g, '')
        
        // Tambah @s.whatsapp.net jika belum ada
        if (!finalJid.includes('@')) {
            finalJid = finalJid + '@s.whatsapp.net'
        }
        
        // Pastikan format JID valid
        if (!finalJid.match(/^\d+@s\.whatsapp\.net$/)) {
            console.error('❌ Invalid JID format:', finalJid)
            return res.status(400).json({ 
                status: 'error', 
                message: 'Invalid phone number format',
                originalInput: targetJid,
                processedJid: finalJid
            })
        }
        
        // Sanitize message - pastikan string dan handle undefined/null
        let finalMessage = String(messageText || 'Empty message').trim()
        
        // Jika message kosong, beri default
        if (!finalMessage || finalMessage === 'undefined' || finalMessage === 'null') {
            finalMessage = 'Hello! This is an automated message.'
        }
        
        console.log('📤 Final send params:', { 
            finalJid, 
            finalMessage: finalMessage.substring(0, 100) + (finalMessage.length > 100 ? '...' : ''),
            messageLength: finalMessage.length
        })
        
        // Kirim pesan dengan error handling yang lebih baik
        try {
            await sock.sendMessage(finalJid, { text: finalMessage })
            console.log(`✅ Message sent successfully to ${finalJid}`)
        } catch (sendError) {
            console.error('❌ Baileys sendMessage error:', sendError.message)
            
            // Coba format lain jika gagal
            if (sendError.message.includes('jidDecode')) {
                console.log('🔄 Trying alternative JID format...')
                const altJid = finalJid.replace('@s.whatsapp.net', '@c.us')
                await sock.sendMessage(altJid, { text: finalMessage })
                console.log(`✅ Message sent with alternative format: ${altJid}`)
            } else {
                throw sendError
            }
        }
        
        res.json({ 
            status: 'success', 
            message: 'Message sent successfully',
            to: finalJid,
            messageLength: finalMessage.length,
            timestamp: new Date().toISOString()
        })
        
    } catch (error) {
        console.error('❌ Send message error:', {
            message: error.message,
            stack: error.stack,
            requestBody: req.body
        })
        
        res.status(500).json({ 
            status: 'error', 
            message: error.message,
            errorType: error.constructor.name,
            timestamp: new Date().toISOString()
        })
    }
})

// Health check endpoint
app.get('/status', (req, res) => {
    res.json({ 
        status: 'running',
        whatsapp_connected: sock?.user ? true : false,
        connection_state: connectionState,
        bot_number: sock?.user?.id || null,
        qr_available: lastQR ? true : false,
        timestamp: new Date().toISOString(),
        uptime: process.uptime()
    })
})

// Keep alive endpoint
app.get('/', (req, res) => {
    res.json({ 
        message: 'WhatsApp Task Bot is running!',
        status: connectionState,
        connected: sock?.user ? true : false,
        qr_available: lastQR ? true : false,
        qr_endpoint: '/qr',
        send_endpoint: '/send-message',
        timestamp: new Date().toISOString()
    })
})

// Ping endpoint for Railway health check
app.get('/ping', (req, res) => {
    res.json({ pong: true, timestamp: new Date().toISOString() })
})

// Test endpoint untuk debugging
app.post('/test-send', async (req, res) => {
    try {
        const testTo = '6281234098714@s.whatsapp.net'
        const testMessage = 'Test message from bot'
        
        if (!sock || !sock.user || connectionState !== 'connected') {
            return res.status(503).json({ 
                status: 'error', 
                message: 'WhatsApp not connected' 
            })
        }
        
        await sock.sendMessage(testTo, { text: testMessage })
        res.json({ status: 'success', message: 'Test message sent' })
        
    } catch (error) {
        console.error('❌ Test send error:', error)
        res.status(500).json({ status: 'error', message: error.message })
    }
})

// Start server first, then connect to WhatsApp
const PORT = process.env.PORT || 3000
const server = app.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Server running on port ${PORT}`)
    console.log(`🌐 Health endpoint: http://localhost:${PORT}/`)
    console.log(`📱 QR Code endpoint: http://localhost:${PORT}/qr`)
    console.log(`📤 Send Message endpoint: http://localhost:${PORT}/send-message`)
    console.log(`🧪 Test Send endpoint: http://localhost:${PORT}/test-send`)
    console.log(`📱 Starting WhatsApp connection...`)
    
    // Start WhatsApp connection immediately
    connectToWhatsApp()
})

// Graceful shutdown
process.on('SIGTERM', async () => {
    console.log('🛑 Received SIGTERM, shutting down gracefully...')
    connectionState = 'shutting_down'
    
    // Clear QR regeneration interval
    if (qrRegenerateInterval) {
        clearTimeout(qrRegenerateInterval)
        qrRegenerateInterval = null
    }
    
    if (sock && sock.user) {
        try {
            await sock.logout()
        } catch (error) {
            console.log('Error during logout:', error.message)
        }
    }
    server.close(() => {
        console.log('✅ Server closed')
        process.exit(0)
    })
})

process.on('SIGINT', async () => {
    console.log('🛑 Received SIGINT, shutting down...')
    connectionState = 'shutting_down'
    
    // Clear QR regeneration interval
    if (qrRegenerateInterval) {
        clearTimeout(qrRegenerateInterval)
        qrRegenerateInterval = null
    }
    
    if (sock && sock.user) {
        try {
            await sock.logout()
        } catch (error) {
            console.log('Error during logout:', error.message)
        }
    }
    server.close(() => {
        console.log('✅ Server closed')
        process.exit(0)
    })
})

// Handle uncaught exceptions
process.on('uncaughtException', (error) => {
    console.error('❌ Uncaught Exception:', error.message)
    console.error('Stack:', error.stack)
})

process.on('unhandledRejection', (reason, promise) => {
    console.error('❌ Unhandled Rejection at:', promise, 'reason:', reason)
})
