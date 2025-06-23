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

// N8N Webhook URL
const N8N_WEBHOOK_URL = process.env.N8N_WEBHOOK_URL || 'https://your-n8n-webhook-url.com/webhook/whatsapp-task'

// Keep Railway happy with health checks
setInterval(() => {
    console.log(`🔄 Health check: ${new Date().toISOString()} - State: ${connectionState}`)
}, 30000) // Every 30 seconds

async function connectToWhatsApp() {
    try {
        console.log('🔄 Initializing WhatsApp connection...')
        connectionState = 'connecting'
        
        const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys')
        
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
                console.log(qr)
                console.log('='.repeat(80))
                qrcode.generate(qr, { small: false })
                console.log('='.repeat(80))
                console.log('⚡ SCAN IMMEDIATELY! QR expires in 20 seconds')
                console.log('💡 If QR not scannable in logs, visit: /qr endpoint for web QR')
                console.log('🌐 Or use online QR generator with data above')
                connectionState = 'waiting_for_scan'
            }
            
            if(connection === 'close') {
                connectionState = 'disconnected'
                lastQR = null
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

// QR Code endpoint untuk akses via browser
app.get('/qr', (req, res) => {
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
                    </style>
                </head>
                <body>
                    <div class="container">
                        <h2>📱 WhatsApp QR Code</h2>
                        <div id="qrcode"></div>
                        <div class="instructions">
                            1. Open WhatsApp on your phone<br>
                            2. Go to Menu → Linked Devices<br>
                            3. Tap "Link a Device"<br>
                            4. Scan this QR code<br>
                        </div>
                        <button class="refresh-btn" onclick="location.reload()">🔄 Refresh QR</button>
                    </div>
                    <script src="https://cdn.jsdelivr.net/npm/qrcode@1.5.3/build/qrcode.min.js"></script>
                    <script>
                        const qrContainer = document.getElementById('qrcode');
                        QRCode.toCanvas(qrContainer, '${lastQR}', {
                            width: 256,
                            margin: 2,
                            color: {
                                dark: '#000000',
                                light: '#FFFFFF'
                            }
                        }, function (error) {
                            if (error) {
                                console.error(error)
                                qrContainer.innerHTML = '<p>Error generating QR code</p>'
                            }
                        })
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
                    <button onclick="location.reload()" style="padding:10px 20px; background:#25D366; color:white; border:none; border-radius:5px;">
                        🔄 Refresh
                    </button>
                </body>
            </html>
        `)
    }
})

// Endpoint untuk n8n kirim reply
app.post('/send-message', async (req, res) => {
    try {
        const { to, message } = req.body
        
        if (!sock || !sock.user || connectionState !== 'connected') {
            return res.status(503).json({ 
                status: 'error', 
                message: 'WhatsApp not connected',
                connectionState: connectionState
            })
        }
        
        await sock.sendMessage(to, { text: message })
        
        console.log(`📤 Reply sent to ${to}: ${message}`)
        res.json({ status: 'success', message: 'Message sent' })
        
    } catch (error) {
        console.error('❌ Error sending message:', error)
        res.status(500).json({ status: 'error', message: error.message })
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
        timestamp: new Date().toISOString()
    })
})

// Ping endpoint for Railway health check
app.get('/ping', (req, res) => {
    res.json({ pong: true, timestamp: new Date().toISOString() })
})

// Start server first, then connect to WhatsApp
const PORT = process.env.PORT || 3000
const server = app.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Server running on port ${PORT}`)
    console.log(`🌐 Health endpoint: http://localhost:${PORT}/`)
    console.log(`📱 QR Code endpoint: http://localhost:${PORT}/qr`)
    console.log(`📱 Starting WhatsApp connection...`)
    
    // Start WhatsApp connection immediately
    connectToWhatsApp()
})

// Graceful shutdown
process.on('SIGTERM', async () => {
    console.log('🛑 Received SIGTERM, shutting down gracefully...')
    connectionState = 'shutting_down'
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
})

process.on('unhandledRejection', (reason, promise) => {
    console.error('❌ Unhandled Rejection at:', promise, 'reason:', reason)
})
