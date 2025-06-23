const { default: makeWASocket, DisconnectReason, useMultiFileAuthState } = require('@whiskeysockets/baileys')
const { Boom } = require('@hapi/boom')
const qrcode = require('qrcode-terminal')
const express = require('express')
const bodyParser = require('body-parser')
const axios = require('axios')

const app = express()
app.use(bodyParser.json())

let sock

// N8N Webhook URL
const N8N_WEBHOOK_URL = process.env.N8N_WEBHOOK_URL || 'https://your-n8n-webhook-url.com/webhook/whatsapp-task'

async function connectToWhatsApp() {
    const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys')
    
    sock = makeWASocket({
        auth: state,
        browser: ['WhatsApp Task Bot', 'Chrome', '1.0.0'],
        logger: { level: 'silent' }
    })

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update
        
        // Display QR code when available
        if (qr) {
            console.log('📱 QR Code received! Scan with your WhatsApp:')
            qrcode.generate(qr, { small: true })
        }
        
        if(connection === 'close') {
            const shouldReconnect = (lastDisconnect?.error)?.output?.statusCode !== DisconnectReason.loggedOut
            console.log('❌ Connection closed:', lastDisconnect?.error, ', reconnecting:', shouldReconnect)
            
            if(shouldReconnect) {
                setTimeout(() => connectToWhatsApp(), 5000) // Delay 5 seconds
            }
        } else if(connection === 'open') {
            console.log('✅ WhatsApp Bot Connected Successfully!')
            console.log('📞 Bot number:', sock.user.id)
        }
    })

    sock.ev.on('creds.update', saveCreds)

    // Handle incoming messages
    sock.ev.on('messages.upsert', async (m) => {
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
                
                const response = await axios.post(N8N_WEBHOOK_URL, webhookData)
                console.log('✅ Sent to n8n:', response.status)
                
            } catch (error) {
                console.error('❌ Error sending to n8n:', error.message)
            }
        }
    })
}

// Endpoint untuk n8n kirim reply
app.post('/send-message', async (req, res) => {
    try {
        const { to, message } = req.body
        
        if (!sock || !sock.user) {
            return res.status(503).json({ status: 'error', message: 'WhatsApp not connected' })
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
        connected: sock?.user ? true : false,
        user: sock?.user?.id || null,
        timestamp: new Date().toISOString()
    })
})

// Keep alive endpoint
app.get('/', (req, res) => {
    res.json({ 
        message: 'WhatsApp Task Bot is running!',
        status: sock?.user ? 'connected' : 'disconnected'
    })
})

// Start server first, then connect to WhatsApp
const PORT = process.env.PORT || 3000
const server = app.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Server running on port ${PORT}`)
    console.log(`📱 Starting WhatsApp connection...`)
    
    // Connect to WhatsApp after server starts
    setTimeout(() => {
        connectToWhatsApp()
    }, 2000)
})

// Graceful shutdown
process.on('SIGTERM', async () => {
    console.log('🛑 Shutting down gracefully...')
    if (sock) {
        await sock.logout()
    }
    server.close()
    process.exit(0)
})

process.on('SIGINT', async () => {
    console.log('🛑 Shutting down...')
    if (sock) {
        await sock.logout()
    }
    server.close()
    process.exit(0)
})
