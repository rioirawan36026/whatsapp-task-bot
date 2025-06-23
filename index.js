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
                console.log('📱 QR Code received! Please scan quickly:')
                qrcode.generate(qr, { small: true })
                console.log('⚡ SCAN IMMEDIATELY! QR expires in 20 seconds')
                connectionState = 'waiting_for_scan'
            }
            
            if(connection === 'close') {
                connectionState = 'disconnected'
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
